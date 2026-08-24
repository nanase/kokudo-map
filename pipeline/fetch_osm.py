# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
"""Fetch the raw OSM objects for one region from Overpass and cache them.

Three separate queries, because they answer three different questions and
because one combined query is both slower and impossible to de-merge (a way
returned by two `out` statements arrives twice, and the ids-only copy is
indistinguishable from the copy with geometry):

  1. national-route relations (+ their child relations) and every way they
     contain — the trusted core;
  2. national-grade ways carrying a numeric `ref` or a 国道N号 name, whether or
     not any relation contains them — route relations are maintained far less
     diligently than the ways themselves, so bypasses that have been open for
     years are routinely absent from them;
  3. *competing* route relations, tags and members — a negative signal, since
     都道府県道 use the same bare numeric `ref` format as national routes, and
     an operator-branded route numbering scheme (首都高速道路 etc.) makes the
     identical kind of claim under a `network` that just isn't `JP:`-prefixed
     (CASES.md 20). Kept as whole relations (not a flat way-id set) so a
     way's own claim can be checked against the specific number a competing
     relation makes for it, rather than being disqualified by mere membership
     in one.

Freshness matters and is not automatic: public Overpass mirrors can fall
badly behind. We probe every endpoint, pick the freshest, and record its
`timestamp_osm_base` so the map can state which day it is showing.

Usage:  uv run pipeline/fetch_osm.py [region]
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone

import requests

from _paths import CACHE
from regions import for_region

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# Warn if the freshest mirror we can reach is older than this.
STALE_AFTER_DAYS = 7

# Grades a general national route is plausibly mapped at. `primary` is
# deliberately excluded: in this region 3,305 relation-less `primary` ways carry
# a numeric ref and *none* is named 国道, so admitting them would drag in
# thousands of 主要地方道 for no gain.
NATIONAL_GRADES = "trunk|motorway|construction"

UA = {"User-Agent": "NationalRouteMap/0.2 (build pipeline)"}


def probe(ep: str, tries: int = 3) -> tuple[str | None, str | None]:
    """Return (timestamp_osm_base, error) for an endpoint.

    Public mirrors answer 429/504 under load even for a trivial query, so a
    single failure says nothing about availability.
    """
    last = "unknown"
    for i in range(tries):
        try:
            r = requests.post(ep, data={"data": "[out:json][timeout:60];node(1);out ids;"},
                              headers=UA, timeout=90)
            r.raise_for_status()
            return r.json().get("osm3s", {}).get("timestamp_osm_base"), None
        except Exception as e:
            last = str(e)[:90]
            if i < tries - 1:
                time.sleep(15)
    return None, last


def pick_endpoint() -> tuple[str, str]:
    print("probing Overpass mirrors for data freshness")
    now = datetime.now(timezone.utc)
    best: tuple[str, str, float] | None = None
    for ep in ENDPOINTS:
        ts, err = probe(ep)
        host = ep.split("/")[2]
        if not ts:
            print(f"  {host:28} unreachable: {err}")
            continue
        age = (now - datetime.fromisoformat(ts.replace("Z", "+00:00"))).total_seconds()
        print(f"  {host:28} base={ts}  age={age/86400:.1f} days")
        if best is None or age < best[2]:
            best = (ep, ts, age)

    if best is None:
        raise SystemExit("no Overpass mirror is reachable")

    ep, ts, age = best
    print(f"  -> using {ep.split('/')[2]} (data of {ts})")
    if age > STALE_AFTER_DAYS * 86400:
        print(f"  WARNING: freshest available data is {age/86400:.1f} days old; "
              f"recent road openings will be missing.")
    return ep, ts


def run(ep: str, query: str, label: str, tries: int = 4) -> dict:
    last: Exception | None = None
    for i in range(tries):
        try:
            print(f"  [{label}] attempt {i + 1}", flush=True)
            r = requests.post(ep, data={"data": query}, headers=UA, timeout=900)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            print(f"    failed: {str(e)[:120]}", flush=True)
            last = e
            if i < tries - 1:
                time.sleep(20)
    raise SystemExit(f"query {label!r} failed after {tries} attempts: {last}")


def main() -> None:
    region = sys.argv[1] if len(sys.argv) > 1 else "nagano"
    spec = for_region(region)
    bb = ",".join(str(v) for v in spec["bbox"])

    ep, base_ts = pick_endpoint()
    print(f"\nfetching {region} ({bb})")

    # 1. the trusted core: national route relations and their member ways.
    #
    # `network=JP:national` is not the only evidence a relation is a 国道 route.
    # Measured over the whole country, 582 route=road relations named 国道N号
    # carry that network and 43 carry no `network` at all — and for 国道478号 the
    # untagged one is the only relation there is. Name is the same evidence
    # RULES.md 問1 規則 b accepts from a way, so it is accepted here too, unless
    # a 都道府県道 network says otherwise.
    core = run(ep, f"""
[out:json][timeout:900];
(
  relation["type"="route"]["route"="road"]["network"~"^JP:national"]({bb});
  relation["type"="route"]["route"="road"]["name"~"^国道[0-9]+号"]
          ["network"!~"^JP:prefectural"]({bb});
)->.parents;
relation(r.parents)->.kids;
(.parents; .kids;)->.rels;
.rels out body;
way(r.rels)({bb});
out meta geom;
""", "national relations + members")

    # 2. candidates the relations may have missed
    cand = run(ep, f"""
[out:json][timeout:900];
(
  way["highway"~"^({NATIONAL_GRADES})$"]["ref"~"^[0-9]+(;[0-9]+)*$"]({bb});
  way["highway"]["name"~"^国道[0-9]+号"]({bb});
);
out meta geom;
""", "candidate ways")

    # 3. negative signal: which routes competing relations claim, and which
    # ways they hold. `out body` (tags + member list, no geometry — the ways'
    # own coordinates are irrelevant here) instead of the old ids-only member
    # dump: a bare way-id set couldn't distinguish 広島県道243号広島港線
    # claiming way X from 国道2号 also holding way X for its own reasons,
    # so build_routes.py had to treat "any competing relation touches this
    # way" as disqualifying — which throws out 広島南道路 (real 国道2号, only
    # incidentally still listed on an unrelated old 県道 relation) exactly
    # like it throws out a genuine 都道府県道 number collision. Keeping the
    # claimed *number* per relation lets the guard compare numbers instead of
    # just presence.
    #
    # `network~"^JP:prefectural"` catches 都道府県道. `network` present but not
    # `JP:`-prefixed catches an operator naming its own route numbers instead
    # (首都高速道路, 阪神高速道路, …) — 首都高速都心環状線 (`ref=1`, no `高速N号`
    # in its name for CASES.md 9's guard to match) sits on exactly such a
    # relation. See CASES.md 20.
    competing = run(ep, f"""
[out:json][timeout:900];
(
  relation["type"="route"]["route"="road"]["network"~"^JP:prefectural"]({bb});
  relation["type"="route"]["route"="road"]["network"]["network"!~"^JP:"]({bb});
)->.pr;
.pr out body;
""", "competing relations")

    doc = {
        "region": region,
        "label": spec["label"],
        "bbox": spec["bbox"],
        "endpoint": ep,
        "timestamp_osm_base": base_ts,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "core": core["elements"],
        "candidates": cand["elements"],
        "competing_relations": [
            {
                "id": e["id"],
                "tags": e.get("tags", {}),
                "members": [m["ref"] for m in e.get("members", []) if m["type"] == "way"],
            }
            for e in competing["elements"] if e["type"] == "relation"
        ],
    }

    rels = sum(1 for e in doc["core"] if e["type"] == "relation")
    ways = sum(1 for e in doc["core"] if e["type"] == "way")
    competing_ways = {w for r in doc["competing_relations"] for w in r["members"]}
    print(f"\n  national relations: {rels}")
    print(f"  member ways:        {ways}")
    print(f"  candidate ways:     {sum(1 for e in doc['candidates'] if e['type'] == 'way')}")
    print(f"  competing relations: {len(doc['competing_relations'])}")
    print(f"  competing ways:     {len(competing_ways)}")

    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"{region}.raw.json"
    out.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    print(f"\n  data base: {base_ts}")
    print(f"  cached -> {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
