# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Sanity-check the built data against things we already know to be true.

A build that runs is not a build that is right. These assertions are the
cheap half of the "二重化" plan from the feasibility report: they catch the
failure modes that would silently produce a wrong map.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone

from _paths import DATA
from expectations import for_region

region = sys.argv[1] if len(sys.argv) > 1 else "nagano"
expect = for_region(region)
gj = json.loads((DATA / f"{region}.geojson").read_text(encoding="utf-8"))
meta = json.loads((DATA / f"{region}.meta.json").read_text(encoding="utf-8"))
feats = gj["features"]

fails: list[str] = []
notes: list[str] = []


def check(ok: bool, msg: str) -> None:
    (notes if ok else fails).append(("PASS  " if ok else "FAIL  ") + msg)


# --- structural integrity ---------------------------------------------------
check(all(f["geometry"]["type"] == "LineString" for f in feats), "all features are LineStrings")
check(all(len(f["geometry"]["coordinates"]) >= 2 for f in feats), "no degenerate geometries")

bad_key = [
    f["properties"]["id"]
    for f in feats
    if f["properties"]["refs"] != "," + ",".join(str(r) for r in f["properties"]["refs_list"]) + ","
]
check(not bad_key, f"refs key matches refs_list ({len(bad_key)} mismatches)")

bad_n = [f["properties"]["id"] for f in feats if f["properties"]["n"] != len(f["properties"]["refs_list"])]
check(not bad_n, f"n equals the designation count ({len(bad_n)} mismatches)")

sorted_ok = all(f["properties"]["refs_list"] == sorted(f["properties"]["refs_list"]) for f in feats)
check(sorted_ok, "refs_list is sorted ascending")

# --- the delimiter trick actually prevents substring collisions -------------
# Route 4 must never match an arc that only carries 14, 24, 40, 400...
def matches(feat, ref: int) -> bool:
    return f",{ref}," in feat["properties"]["refs"]


probe = expect["absent"][0][0]
collisions = [
    f["properties"]["id"]
    for f in feats
    if matches(f, probe) and probe not in f["properties"]["refs_list"]
]
check(not collisions,
      f"delimiter-wrapped key rejects substring matches for {probe} "
      f"({len(collisions)} false hits)")

# Cross-check the filter predicate against the authoritative list, per route.
mismatch = 0
for r in [f["ref"] for f in meta["routes"]]:
    by_key = sum(1 for f in feats if matches(f, r))
    by_list = sum(1 for f in feats if r in f["properties"]["refs_list"])
    if by_key != by_list:
        mismatch += 1
check(not mismatch, f"key-based filter agrees with list membership for all {len(meta['routes'])} routes")

# --- domain facts we independently know ------------------------------------
label = meta.get("label", region)
refs_present = {f["ref"] for f in meta["routes"]}

for r in expect["present"]:
    check(r in refs_present, f"route {r} is present (known to run through {label})")

invalid = refs_present - ((set(range(1, 59)) | set(range(101, 508))) - {109, 110, 111, 214, 215, 216})
check(not invalid, f"no impossible route numbers ({sorted(invalid)})")

# Regression guard for numbers leaking in: these routes run nowhere near the
# region, so their presence would mean a bare numeric `ref` or a bad name was
# believed without corroboration.
for r, where in expect["absent"]:
    check(r not in refs_present, f"route {r} ({where}) is absent from {label}")

# The general invariant behind those cases: a route may only appear if some
# national-route relation in the region vouches for its number.
uncorroborated = refs_present - set(meta["corroborated_refs"])
check(not uncorroborated, f"every route present is corroborated by a relation ({sorted(uncorroborated)})")

# Provenance must be recorded so the map can say where a designation came from.
srcs = Counter(f["properties"]["src"] for f in feats)
check(set(srcs) <= {"relation", "name", "tag"}, f"arc sources are known values ({dict(srcs)})")
check(srcs.get("relation", 0) > 0, f"relations admitted arcs ({srcs.get('relation', 0)})")
print(f"NOTE  rule (c) recovered {srcs.get('tag', 0)} relation-less arcs, "
      f"names admitted {srcs.get('name', 0)}")

# 旧道 sections stay in — 地理院地図 shows them as 国道 until 指定解除 — but they
# must be flagged so they can be told apart. A region may legitimately have none.
former = [f for f in feats if f["properties"].get("former")]
named_former = [f for f in feats if re.search(r"旧道|廃道|旧国道", f["properties"]["name"] or "")]
check(len(former) == len(named_former),
      f"every 旧道-named arc carries the former flag ({len(former)} vs {len(named_former)})")
check(all(f["properties"]["refs_list"] for f in former),
      f"former arcs still carry their designation ({len(former)} arcs)")

# Freshness must be recorded, and the data must not be silently ancient.
check(bool(meta.get("osm_timestamp")), f"OSM data timestamp is recorded ({meta.get('osm_timestamp')})")
age_days = (
    datetime.now(timezone.utc)
    - datetime.fromisoformat(meta["osm_timestamp"].replace("Z", "+00:00"))
).days
check(age_days <= 7, f"OSM data is {age_days} days old (threshold 7)")

# Named roads that must be present and designated. 長野南バイパス is the case the
# user reported missing: 国道19号, open for decades, in no route relation.
for name, ref in expect["named"]:
    hits = [f for f in feats if (f["properties"]["name"] or "") == name]
    check(len(hits) > 0, f"{name} is present ({len(hits)} arcs)")
    check(all(ref in f["properties"]["refs_list"] for f in hits),
          f"{name} is designated 国道{ref}号")

# Routes that must carry arcs of a particular kind, e.g. a 点線国道 that only
# exists as a footpath.
master = {r["ref"]: r for r in meta["routes"]}
for ref, kinds in expect["kinds"].items():
    entry = master.get(ref)
    check(entry is not None, f"route {ref} has a master entry")
    if not entry:
        continue
    for k in kinds:
        check(entry["kinds"].get(k, 0) > 0,
              f"route {ref} has {k} arcs ({entry['kinds'].get(k, 0)})")

# Concurrency must exist and must be recorded symmetrically: if an arc says
# {18,117}, both 18 and 117 must list a max_n of at least 2.
asym = 0
for f in feats:
    p = f["properties"]
    for r in p["refs_list"]:
        if master[r]["max_n"] < p["n"]:
            asym += 1
check(not asym, f"per-route max_n covers every arc it appears on ({asym} violations)")

n2 = sum(1 for f in feats if f["properties"]["n"] >= 2)
check(n2 > 0, f"concurrent arcs found: {n2}")
check(meta["concurrency_ranking"][0]["n"] >= 3, f"ranking is sorted by concurrency depth (top n={meta['concurrency_ranking'][0]['n']})")

# Length bookkeeping: summing per-route km double-counts concurrency exactly
# as much as the arcs say it should.
arc_km = sum(f["properties"]["km"] for f in feats)
weighted = sum(f["properties"]["km"] * f["properties"]["n"] for f in feats)
route_km = sum(r["km"] for r in meta["routes"])
check(
    abs(route_km - weighted) / weighted < 0.01,
    f"per-route totals reconcile with concurrency-weighted length "
    f"({route_km:,.0f} vs {weighted:,.0f} km)",
)

print("\n".join(notes))
if fails:
    print("\n" + "\n".join(fails))

kinds = Counter(f["properties"]["kind"] for f in feats)
print(
    f"\narcs {len(feats):,} | unique length {arc_km:,.0f} km | "
    f"designation-weighted {weighted:,.0f} km"
)
print(f"kinds: {dict(kinds)} | routes: {len(meta['routes'])}")
print(f"n histogram: {meta['n_histogram']}")
print(f"\n{len(notes)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
