# /// script
# requires-python = ">=3.12"
# dependencies = ["pmtiles>=3.4"]
# ///
"""Check the merged nationwide product — the two questions no region can answer.

verify.py sees one rectangle at a time. Two things are therefore invisible to
it, and both are the ones that matter once the map covers the country:

  did a number leak into the wrong end of Japan?
      The corroboration guard is regional by design (see build_routes.py). That
      keeps it sharp, but it also means no per-region run can see that 国道372号
      turned up in both 兵庫県 — where it belongs — and 長野県, where CASES.md 1
      says it once did. Only the merged data can, and it does it by asking
      where each route's arcs actually are.

  is the thing the browser downloads the thing we built?
      The per-region checks pass over GeoJSON that is no longer served. The
      archive is opened here and read back.

Usage:  uv run pipeline/verify_national.py
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter
from datetime import datetime, timezone

from pmtiles.reader import MmapSource, Reader

from _paths import DATA, REGIONS
from expectations import ROUTE_EXTENTS

VALID = (set(range(1, 59)) | set(range(101, 508))) - {109, 110, 111, 214, 215, 216}

meta = json.loads((DATA / "national.meta.json").read_text(encoding="utf-8"))
index = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))
metas = [
    json.loads((REGIONS / f"{r['region']}.meta.json").read_text(encoding="utf-8"))
    for r in index
]

fails: list[str] = []
notes: list[str] = []


def check(ok: bool, msg: str) -> None:
    (notes if ok else fails).append(("PASS  " if ok else "FAIL  ") + msg)


combos = meta["combinations"]
routes = sorted({r for c in combos for r in c["refs"]})

# --- the aggregate has to add up, because the panel now shows nothing else ---
check(sum(c["arcs"] for c in combos) == meta["arc_count"],
      f"combination arcs sum to the arc count "
      f"({sum(c['arcs'] for c in combos):,} vs {meta['arc_count']:,})")
km = sum(c["km"] for c in combos)
check(abs(km - meta["total_km"]) < 1,
      f"combination lengths sum to the total ({km:,.1f} vs {meta['total_km']:,.1f} km)")
check(all(c["n"] == len(c["refs"]) for c in combos), "every combination's n is its size")
check(all(c["refs"] == sorted(c["refs"]) for c in combos), "combination refs are sorted")
dupes = len(combos) - len({tuple(c["refs"]) for c in combos})
check(not dupes, f"each combination appears once ({dupes} duplicates)")
check(all(combos[i]["n"] >= combos[i + 1]["n"] for i in range(len(combos) - 1)),
      "combinations are ordered deepest first")

# --- and the parts of a length have to add up to it --------------------------
# "How much of 国道152号 can you drive" is answered by adding the driveable kinds
# and leaving out the rest, so a row whose parts miss its own length answers it
# wrongly rather than imprecisely. The vocabulary is not restated here: the
# kinds a row may name are the ones the regional builds classified arcs into.
KINDS = {k for m in metas for r in m["routes"] for k in r["kinds"]}
kinds_of = {k for c in combos for k in c.get("kinds", {})}

check(all("kinds" in c for c in combos), "every combination carries a kind breakdown")
check(kinds_of <= KINDS,
      f"the breakdown names only kinds the build produces ({sorted(kinds_of - KINDS)})")
empty = [c["refs"] for c in combos if any(v <= 0 for v in c.get("kinds", {}).values())]
check(not empty, f"no kind is written out at zero length ({empty[:3]})")

# Each part is rounded to 10 m and the ones under 5 m are dropped, so a row of
# seven kinds can sit 40 m from its own total. Anything past that is an arc
# counted into the wrong bucket, or into none.
off, refs = max((abs(sum(c.get("kinds", {}).values()) - c["km"]), c["refs"]) for c in combos)
check(off <= 0.05,
      f"every combination's kinds add up to its own length "
      f"(worst {refs}, off by {off * 1000:.0f} m)")

kind_km: Counter[str] = Counter()
for c in combos:
    kind_km.update(c.get("kinds", {}))
check(abs(sum(kind_km.values()) - meta["total_km"]) < 1,
      f"the kinds add up to the nationwide total "
      f"({sum(kind_km.values()):,.1f} vs {meta['total_km']:,.1f} km)")

# 旧道 is not a kind but a second axis over the same road (#26), so it is bounded
# by the row rather than added to it. A row more 旧道 than long means the two
# axes were folded into one somewhere.
over = [c["refs"] for c in combos if c.get("former_km", 0) > c["km"] + 0.01]
check(not over, f"no combination is more 旧道 than it is long ({over[:3]})")
former_km = sum(c.get("former_km", 0) for c in combos)
check(0 < former_km < meta["total_km"],
      f"旧道 is part of the total and not all of it ({former_km:,.1f} km)")

invalid = set(routes) - VALID
check(not invalid, f"no impossible route numbers ({sorted(invalid)})")

# The country has a six-fold concurrency in 新潟市 and route numbers up to 507.
# Neither is true of any single prefecture, so this is the place to assert them.
check(combos[0]["n"] >= 6,
      f"the deepest concurrency in Japan is {combos[0]['n']}x {combos[0]['refs']}")
check(len(routes) >= 400, f"most of the 459 route numbers are on the map ({len(routes)})")

# --- where each route is: the only check that can see CASES.md 1 and 2 -------
# A route's extent is the union of the extents of the combinations it appears
# in. A number that leaked into a distant prefecture blows the box open.
extent: dict[int, list[float]] = {}
for c in combos:
    for r in c["refs"]:
        b = extent.setdefault(r, [180.0, 90.0, -180.0, -90.0])
        b[0] = min(b[0], c["bbox"][0])
        b[1] = min(b[1], c["bbox"][1])
        b[2] = max(b[2], c["bbox"][2])
        b[3] = max(b[3], c["bbox"][3])

for ref, ((s, w, n, e), where) in sorted(ROUTE_EXTENTS.items()):
    got = extent.get(ref)
    check(got is not None, f"route {ref} ({where}) is on the map")
    if not got:
        continue
    out = got[0] < w or got[1] < s or got[2] > e or got[3] > n
    check(not out,
          f"route {ref} ({where}) stays inside its itinerary — "
          f"arcs span {got[1]:.2f}..{got[3]:.2f}N {got[0]:.2f}..{got[2]:.2f}E, "
          f"allowed {s}..{n}N {w}..{e}E")

# --- the guard stayed regional ----------------------------------------------
# If acquisition going nationwide had quietly taken adjudication with it, this
# is where it would show: the corroborated sets would all be near 459.
sizes = {m["region"]: len(m["corroborated_refs"]) for m in metas}
worst = max(sizes.values())
union = len({r for m in metas for r in m["corroborated_refs"]})
check(worst < 153,
      f"no region vouches for more than a third of the 459 numbers "
      f"(worst: {max(sizes, key=sizes.get)} with {worst})")
check(union > worst,
      f"the union across regions ({union}) exceeds any single region ({worst}) — "
      f"the sets really are boxed")
rejected = sum(sum(m.get("rejected_refs", {}).values()) for m in metas)
check(rejected > 0, f"the guard rejected uncorroborated ref tokens ({rejected:,} ways)")

# --- every route present somewhere is vouched for there ----------------------
vouched = {r for m in metas for r in m["corroborated_refs"]}
check(set(routes) <= vouched,
      f"every route on the map is vouched for by some region ({sorted(set(routes) - vouched)})")

# --- freshness ---------------------------------------------------------------
check(
    bool(meta.get("osm_timestamp")),
    f"OSM data timestamp is recorded ({meta.get('osm_timestamp')})",
)
if meta.get("osm_timestamp"):
    age = (datetime.now(timezone.utc)
           - datetime.fromisoformat(meta["osm_timestamp"].replace("Z", "+00:00"))).days
    check(age <= 7, f"OSM data is {age} days old (threshold 7)")

# --- the archive the browser downloads ---------------------------------------
# How many places in the archive are asked for a tile. One is enough to catch an
# archive that reads back as nothing; a handful spread through the index also
# says the reader can find tiles that are not next to each other.
PROBES = 5


def tile_at(z: int, lat: float, lon: float) -> tuple[int, int]:
    """The tile covering a point, in the archive's own numbering."""
    n = 2**z
    rad = math.radians(lat)
    return (
        int((lon + 180) / 360 * n),
        int((1 - math.log(math.tan(rad) + 1 / math.cos(rad)) / math.pi) / 2 * n),
    )


path = DATA / "national-routes.pmtiles"
check(path.exists(), f"{path.name} exists")
if path.exists():
    # A tile at the deepest zoom must actually come back, or the map draws
    # nothing however valid the header is. The places asked are termini, which
    # are points on the roads themselves. The probe used to be the centre of
    # the country's bounding rectangle — 34.93N 134.87E, open water in the
    # 播磨灘 — and a z14 tile is 2.4 km wide, so it asked for a square with no
    # 国道 in it. An empty tile is absent from the archive by design, so the
    # check failed on an archive that was correct.
    probes = meta["termini"][:: max(1, len(meta["termini"]) // PROBES)][:PROBES]
    with open(path, "r+b") as f:
        reader = Reader(MmapSource(f))
        header = reader.header()
        pm_meta = reader.metadata()
        z = header["max_zoom"]
        at = [tile_at(z, t["lat"], t["lon"]) for t in probes]
        missing = [f"{z}/{x}/{y}" for x, y in at if reader.get(z, x, y) is None]
    layers = [v["id"] for v in pm_meta.get("vector_layers", [])]
    check(layers == ["routes"], f"the archive declares one layer, routes ({layers})")
    check(header["max_zoom"] >= 12,
          f"tiles go to z{header['max_zoom']} (z{header['min_zoom']}-{header['max_zoom']})")
    check(header["clustered"], "the archive is clustered, so a range request can find a tile")
    check(bool(probes) and not missing,
          f"a z{z} tile comes back at each of {len(probes)} termini ({missing})")
    print(f"NOTE  archive {path.stat().st_size / 1e6:.1f} MB, "
          f"{header['addressed_tiles_count']:,} tiles, probed {len(probes)} termini")

print("\n".join(notes))
if fails:
    print("\n" + "\n".join(fails))
print(f"\narcs {meta['arc_count']:,} | {meta['total_km']:,.0f} km | "
      f"routes {len(routes)} | combinations {len(combos):,} | "
      f"termini {len(meta['termini']):,} (shared {len(meta['shared_termini']):,})")
print("kinds " + " | ".join(f"{k} {v:,.0f}" for k, v in kind_km.most_common())
      + f" | 旧道 {former_km:,.0f} km")
print(f"regions {len(metas)} | corroborated per region "
      f"{min(sizes.values())}..{worst} | union {union}")
print(f"\n{len(notes)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
