# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Find suspicious routes mechanically — no reference data, no judgement.

A national route is a chain from 起点 to 終点. Where our data is missing a
piece, the chain breaks, and a break is a fact a script can state:

  components   how many disconnected pieces the route falls into
  loose ends   arc endpoints the route simply stops at
  gaps         distance from a loose end to the nearest piece of the same route

Gap length sorts the causes, and the buckets matter more than the raw number:

  < 50 m       the two sides are not sharing a node. Almost never a missing
               road — either an OSM authoring slip, or two carriageways that
               are correctly separate.
  50 m – 2 km  a missing short link, a bypass junction, or the boundary of an
               under-construction section (legitimately not connected yet).
  > 2 km       a missing section, or a genuine break: 点線国道, 未開通, 海上国道.

Each gap is then checked against the raw OSM objects in the cache. If a way
claiming that route number sits in the gap and is *not* in our output, our
admission rules dropped it — a rule bug, fixable once for the whole country.
If no such way exists, the road is absent from OSM and no rule change will
conjure it; only reference data (国土数値情報 N13) can find that case.

Usage:  uv run build/audit.py [region] [--route N ...] [--all]
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, defaultdict

from _paths import CACHE, REGIONS as DATA

NODE_GAP_M = 50
LINK_GAP_M = 2000
EDGE_TOL = 0.02

NAME_NUM = re.compile(r"国道\s*(\d+)\s*号")
NATIONAL_GRADE = {"trunk", "motorway", "construction"}


def haversine(a, b):
    r = 6371008.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class DSU:
    def __init__(self):
        self.p: dict = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def key(pt):
    """Node identity from a [lon, lat] pair."""
    return (round(pt[1], 7), round(pt[0], 7))


def bucket(m):
    if m < NODE_GAP_M:
        return "node"
    if m <= LINK_GAP_M:
        return "link"
    return "section"


def analyse_route(ref, feats, bbox):
    arcs = [f for f in feats if ref in f["properties"]["refs_list"]]
    if not arcs:
        return None

    dsu = DSU()
    for f in arcs:
        ks = [key(c) for c in f["geometry"]["coordinates"]]
        for k in ks[1:]:
            dsu.union(ks[0], k)

    comps: dict = defaultdict(lambda: {"km": 0.0, "nodes": set()})
    endpoint_arcs: dict = defaultdict(list)
    for f in arcs:
        cs = f["geometry"]["coordinates"]
        ks = [key(c) for c in cs]
        c = comps[dsu.find(ks[0])]
        c["km"] += f["properties"]["km"]
        c["nodes"].update(ks)
        endpoint_arcs[ks[0]].append(f["properties"])
        endpoint_arcs[ks[-1]].append(f["properties"])

    loose = [k for k, v in endpoint_arcs.items() if len(v) == 1]

    west, south, east, north = bbox

    def on_edge(lat, lon):
        return (lat - south < EDGE_TOL or north - lat < EDGE_TOL
                or lon - west < EDGE_TOL or east - lon < EDGE_TOL)

    loose_inner = [k for k in loose if not on_edge(k[0], k[1])]

    gaps = []
    for k in loose_inner:
        home = dsu.find(k)
        best = None
        for root, c in comps.items():
            if root == home:
                continue
            for n in c["nodes"]:
                d = haversine(k, n)
                if best is None or d < best[0]:
                    best = (d, n)
        if best:
            kinds = {p["kind"] for p in endpoint_arcs[k]}
            gaps.append({
                "from": k, "to": best[1], "m": best[0],
                "bucket": bucket(best[0]),
                "kinds": kinds,
                "name": endpoint_arcs[k][0].get("name"),
            })
    # Both ends of one gap show up as two entries; keep the shorter view first.
    gaps.sort(key=lambda g: g["m"])
    seen = set()
    uniq = []
    for g in gaps:
        pair = tuple(sorted([g["from"], g["to"]]))
        if pair in seen:
            continue
        seen.add(pair)
        uniq.append(g)

    return {
        "ref": ref,
        "km": sum(f["properties"]["km"] for f in arcs),
        "arcs": len(arcs),
        "components": len(comps),
        "component_km": sorted((c["km"] for c in comps.values()), reverse=True),
        "loose_inner": len(loose_inner),
        "gaps": uniq,
        "kinds": Counter(f["properties"]["kind"] for f in arcs),
        "srcs": Counter(f["properties"]["src"] for f in arcs),
        "former": sum(1 for f in arcs if f["properties"].get("former")),
    }


def load_cache(region):
    p = CACHE / f"{region}.raw.json"
    if not p.exists():
        return None
    raw = json.loads(p.read_text(encoding="utf-8"))
    ways = {}
    for src in ("core", "candidates"):
        for e in raw[src]:
            if e["type"] == "way" and e.get("geometry"):
                ways.setdefault(e["id"], e)
    return {"ways": ways, "pref": set(raw["prefectural_way_ids"])}


def claims(tags):
    """Route numbers a way asserts about itself, by any means."""
    out = {int(x) for x in (tags.get("ref") or "").split(";") if x.strip().isdigit()}
    blob = " ".join(tags.get(k, "") for k in ("name", "name:ja", "official_name"))
    out |= {int(m) for m in NAME_NUM.findall(blob)}
    return out


def why_excluded(wid, tags, cache, corroborated):
    reasons = []
    c = claims(tags)
    if not (c & corroborated):
        reasons.append(f"claims {sorted(c)}, none corroborated by a relation here")
    if wid in cache["pref"]:
        reasons.append("a prefectural route relation claims this way")
    hw = tags.get("highway")
    if hw not in NATIONAL_GRADE:
        reasons.append(f"highway={hw} is below national grade")
    if not tags.get("ref") and not NAME_NUM.search(
            " ".join(tags.get(k, "") for k in ("name", "name:ja"))):
        reasons.append("no ref and no 国道N号 in name/name:ja")
    return reasons or ["unclear — investigate"]


def missing_ways_in_gap(cache, out_ids, ref, gap, corroborated):
    """OSM ways claiming this route inside the gap that our output lacks."""
    lo, hi = gap["from"], gap["to"]
    mid = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
    radius = max(gap["m"], 150)
    hits = []
    for wid, w in cache["ways"].items():
        if wid in out_ids:
            continue
        t = w.get("tags", {})
        if ref not in claims(t):
            continue
        for p in w["geometry"]:
            if haversine(mid, (p["lat"], p["lon"])) <= radius:
                hits.append((wid, t))
                break
    return hits


def main():
    args = list(sys.argv[1:])
    show_all = "--all" in args
    args = [a for a in args if a != "--all"]
    focus = []
    if "--route" in args:
        i = args.index("--route")
        focus = [int(x) for x in args[i + 1:]]
        args = args[:i]
    region = args[0] if args else "nagano"

    meta = json.loads((DATA / f"{region}.meta.json").read_text(encoding="utf-8"))
    gj = json.loads((DATA / f"{region}.geojson").read_text(encoding="utf-8"))
    feats = gj["features"]
    out_ids = {f["properties"]["id"] for f in feats}
    corroborated = set(meta["corroborated_refs"])
    cache = load_cache(region)

    refs = focus or [r["ref"] for r in meta["routes"]]
    reports = [r for r in (analyse_route(ref, feats, bbox=meta["bbox"]) for ref in refs) if r]

    def counts(r):
        b = Counter(g["bucket"] for g in r["gaps"])
        return b["node"], b["link"], b["section"]

    print("=" * 80)
    print("routes with a broken chain — gaps bucketed by what they can mean")
    print("=" * 80)
    print(f"{'route':>6} {'km':>8} {'parts':>6} {'<50m':>5} {'50m-2km':>8} "
          f"{'>2km':>5} {'旧道':>5}  largest part")
    flagged = 0
    for r in sorted(reports, key=lambda r: (-sum(counts(r)[:2]), -r["components"])):
        node, link, section = counts(r)
        if not show_all and not focus and r["components"] == 1:
            continue
        flagged += 1
        share = (r["component_km"][0] / r["km"] * 100) if r["km"] else 0
        print(f"{r['ref']:>6} {r['km']:>8.1f} {r['components']:>6} {node:>5} {link:>8} "
              f"{section:>5} {r['former']:>5}  {share:>5.0f}%")

    single = [r for r in reports if r["components"] == 1]
    print(f"\n{len(single)} of {len(reports)} routes form a single connected chain")
    tot = Counter()
    for r in reports:
        for g in r["gaps"]:
            tot[g["bucket"]] += 1
    print(f"gaps across all routes: {dict(tot)}")

    detail = focus or [r["ref"] for r in
                       sorted(reports, key=lambda r: -sum(counts(r)[:2]))[:3]]
    for ref in detail:
        r = next((x for x in reports if x["ref"] == ref), None)
        if not r:
            continue
        print()
        print("=" * 80)
        print(f"国道{ref}号  {r['km']:.1f} km / {r['arcs']} arcs / {r['components']} components"
              + (f" / {r['former']} 旧道" if r["former"] else ""))
        print("=" * 80)
        print(f"  kinds: {dict(r['kinds'])}   admitted by: {dict(r['srcs'])}")
        print(f"  component lengths (km): "
              f"{', '.join(f'{k:.1f}' for k in r['component_km'][:10])}")
        if not r["gaps"]:
            print("  no gaps")
            continue
        for g in r["gaps"][:14]:
            kinds = "/".join(sorted(g["kinds"]))
            note = ""
            if "construction" in g["kinds"]:
                note = "  (construction boundary — expected)"
            elif g["bucket"] == "node":
                note = "  (nodes not shared)"
            print(f"\n  [{g['bucket']:>7}] {g['m']:>8.0f} m  "
                  f"{g['from'][0]:.5f},{g['from'][1]:.5f} -> "
                  f"{g['to'][0]:.5f},{g['to'][1]:.5f}")
            print(f"            end arc: {kinds} {g['name']!r}{note}")
            if not cache:
                continue
            hits = missing_ways_in_gap(cache, out_ids, ref, g, corroborated)
            if hits:
                print(f"            OSM has {len(hits)} way(s) claiming 国道{ref}号 here "
                      f"that we excluded:")
                for wid, t in hits[:4]:
                    print(f"              way/{wid} ref={t.get('ref')!r} "
                          f"name={t.get('name')!r} highway={t.get('highway')!r}")
                    for why in why_excluded(wid, t, cache, corroborated):
                        print(f"                - {why}")
            else:
                print(f"            no excluded OSM way claims 国道{ref}号 here — "
                      f"the road is absent from OSM itself")


if __name__ == "__main__":
    main()
