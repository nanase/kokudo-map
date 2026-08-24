# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Compare two builds of the same region, arc by arc.

Changing where the OSM objects come from is the kind of change that can look
fine and be wrong: fewer arcs, a lost tag, a designation that quietly stopped
being read. The way to know is to build the same prefecture both ways and
require the answers to match.

That is what this is for. 長野県 and 新潟県 were built from Overpass before the
move to the .osm.pbf, and those outputs are kept as the baseline. A difference
here is either a real defect in the new path or a genuine edit to OSM between
the two moments the data was cut — and the script separates the two by
reporting *what* differs, not just how many.

Usage:  uv run pipeline/compare_sources.py nagano
        uv run pipeline/compare_sources.py nagano --baseline build/overpass-baseline
"""
from __future__ import annotations

import json
import sys
from collections import Counter

from _paths import REGIONS, ROOT

# Properties that describe the road. `updated` is excluded on purpose: it is the
# way's own last-edit date and differs legitimately whenever a mapper touches
# the road between the two cuts.
COMPARED = ("refs", "n", "kind", "src", "former", "name")


def load(path):
    gj = json.loads(path.read_text(encoding="utf-8"))
    return {f["properties"]["id"]: f for f in gj["features"]}


def main() -> None:
    args = sys.argv[1:]
    baseline = ROOT / "build" / "overpass-baseline"
    if "--baseline" in args:
        i = args.index("--baseline")
        baseline = ROOT / args[i + 1]
        args = args[:i] + args[i + 2:]
    region = args[0] if args else "nagano"

    old_path = baseline / f"{region}.geojson"
    new_path = REGIONS / f"{region}.geojson"
    if not old_path.exists():
        raise SystemExit(f"no baseline at {old_path}")

    old, new = load(old_path), load(new_path)
    old_meta = json.loads((baseline / f"{region}.meta.json").read_text(encoding="utf-8"))
    new_meta = json.loads((REGIONS / f"{region}.meta.json").read_text(encoding="utf-8"))

    print(f"{region}")
    print(f"  baseline {old_meta['osm_timestamp']}  "
          f"{old_meta['arc_count']:,} arcs  {old_meta['total_km']:,.1f} km  "
          f"{len(old_meta['routes'])} routes  ({old_meta['endpoint'].split('/')[2]})")
    print(f"  current  {new_meta['osm_timestamp']}  "
          f"{new_meta['arc_count']:,} arcs  {new_meta['total_km']:,.1f} km  "
          f"{len(new_meta['routes'])} routes  ({new_meta['endpoint'].split('/')[2]})")

    only_old = sorted(set(old) - set(new))
    only_new = sorted(set(new) - set(old))
    both = set(old) & set(new)

    changed: dict[str, list[int]] = {k: [] for k in COMPARED}
    moved = 0
    for wid in both:
        a, b = old[wid]["properties"], new[wid]["properties"]
        for k in COMPARED:
            if a.get(k) != b.get(k):
                changed[k].append(wid)
        if old[wid]["geometry"]["coordinates"] != new[wid]["geometry"]["coordinates"]:
            moved += 1

    agree = len(both) - len({w for v in changed.values() for w in v})
    print(f"\n  shared arcs: {len(both):,}   identical on every compared property: "
          f"{agree:,} ({agree / max(len(both), 1) * 100:.3f}%)")
    print(f"  geometry differs on {moved:,} (a mapper moved the road)")
    print(f"  only in baseline: {len(only_old):,}   only in current: {len(only_new):,}")

    for k, ids in changed.items():
        if not ids:
            continue
        print(f"\n  {k} differs on {len(ids)} arc(s):")
        for wid in ids[:8]:
            print(f"    way/{wid}  {old[wid]['properties'][k]!r} -> "
                  f"{new[wid]['properties'][k]!r}   "
                  f"{new[wid]['properties'].get('name') or ''}")

    for label, ids, src in (("only in baseline", only_old, old),
                            ("only in current", only_new, new)):
        if not ids:
            continue
        kinds = Counter(src[w]["properties"]["kind"] for w in ids)
        srcs = Counter(src[w]["properties"]["src"] for w in ids)
        km = sum(src[w]["properties"]["km"] for w in ids)
        print(f"\n  {label}: {len(ids)} arcs, {km:.1f} km, kinds {dict(kinds)}, "
              f"admitted by {dict(srcs)}")
        for wid in ids[:8]:
            p = src[wid]["properties"]
            print(f"    way/{wid}  国道{'・'.join(map(str, p['refs_list']))}  "
                  f"{p['kind']}/{p['src']}  {p.get('name') or ''}")

    routes_old = {r["ref"] for r in old_meta["routes"]}
    routes_new = {r["ref"] for r in new_meta["routes"]}
    if routes_old != routes_new:
        print(f"\n  routes only in baseline: {sorted(routes_old - routes_new)}")
        print(f"  routes only in current:  {sorted(routes_new - routes_old)}")
    else:
        print(f"\n  the same {len(routes_new)} routes are present in both")


if __name__ == "__main__":
    main()
