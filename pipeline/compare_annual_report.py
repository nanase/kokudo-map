# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Account for the gap between the map's kilometres and 道路統計年報's.

The map draws 70,376 km of 一般国道. 道路統計年報2025 says 58,512 km of what
ought to be the same thing (総延長 - 重用延長, that is 実延長 + 未供用 + 渡船).
Twenty percent apart is not rounding, and until this script existed nobody could
say what the twenty percent was made of.

The two count different objects, and that is most of the answer:

  the ledger  counts a route's centreline. A divided road is one length. A ramp
              is not route length at all. 認定 comes before the road exists, so a
              road not yet open still has a length (未供用).
  the map     counts OSM ways. A divided road is two ways, each carrying the
              route number, and the map draws both — that is what it is for.

So the question is not who is right. It is which of the map's kilometres the
ledger does not count, and how many. Every cause below is measured, and what
the causes fail to explain is printed as a residual rather than waved at.

  海上区間        the ledger's 未供用 includes 1,953 km of sea. The map has only
                  the ferry ways its route relations contain.
  工事中・未開通  OSM's `construction` covers rebuilding a road that is open and
                  in the ledger already as well as building one that is not. The
                  first is a double count; the two are told apart by whether an
                  open, same-numbered road runs alongside.
  ランプ・連結路  highway=*_link. A ramp is 附属物, not route length.
  上下線分離      a way with a same-numbered way running alongside, both one-way:
                  two carriageways, one road. Measured geometrically — see
                  paired_fraction. The ledger holds one length and the map two,
                  so half the paired length is the excess.
  旧道            both sides count 旧道 — the ledger inside 実延長, as its own
                  column — so this is a classification difference, not a length
                  one. It is reported next to the ledger's 旧道 column and left
                  out of the arithmetic.

What this script deliberately does not do is compare prefecture by prefecture.
The regions are rectangles and neighbours spill in, so a per-prefecture figure
would be measuring the boxes. Nationwide totals are unaffected: every way is
counted once, by id, whichever boxes hold it.

Usage:  uv run pipeline/compare_annual_report.py
        uv run pipeline/compare_annual_report.py --distance 60
"""
from __future__ import annotations

import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

from _paths import CACHE, REGIONS as REGION_DIR
from regions import REGIONS

REPORT_CSV = Path(__file__).with_name("annual_report_2025.csv")

# How far apart two carriageways of one road may be and still be one road.
# Japanese divided roads sit 5-20 m apart in town and 30-40 m apart where the
# carriageways take separate cuttings or tunnels. Past that they stop being one
# road in any useful sense. 40 m is the working figure; --distance re-measures
# with another, and docs/results.md records what 25 m and 60 m give.
PAIR_DISTANCE_M = 40.0

# A sample every 25 m along each way. Ways are short — 70,376 km over 151,114 of
# them is 466 m each — and a carriageway pair rarely begins or ends inside one,
# so finer sampling costs time and moves nothing.
SAMPLE_M = 25.0

# Two ways are parallel if their bearings differ by less than this, modulo 180°.
# Carriageways are drawn in opposite directions, so their signed bearings differ
# by ~180° and their unsigned ones by ~0°.
PARALLEL_DEG = 30.0

# The probe ignores anything within 4 m sideways. Two carriageways are never
# that close, and without the gap a way would pair with the one it shares a
# node with at a junction.
PROBE_MIN_M = 4.0

# Which kinds can double-count each other. `ferry`, `foot` and `steps` cannot:
# a sea section has nothing beside it, and a 点線国道 footpath is the only thing
# there is. They are compared to the ledger as whole categories instead.
KIND_GROUP = {
    "road": "open", "expressway": "open",
    "construction": "build", "unopened": "build",
}

LENGTH_COLUMNS = ("total_m", "concurrent_m", "unopened_m", "unopened_sea_m",
                  "ferry_m", "actual_m", "current_m", "former_m", "new_m",
                  "median_m")


# ------------------------------------------------------------------ ledger ---
def load_report() -> dict[str, float]:
    """The transcribed 表8 rows, summed, in kilometres.

    kind=pref and kind=city are disjoint: a 政令指定都市 administers its own
    national routes and does not sit inside its prefecture's row. Both are
    added. The sheet's own 合計 row is transcribed as well and checked against
    that sum, which is the only mechanical guard against a transcription slip.
    """
    lines = [ln for ln in REPORT_CSV.read_text(encoding="utf-8").splitlines()
             if not ln.startswith("#")]
    rows = list(csv.DictReader(lines))
    parts = [r for r in rows if r["kind"] in ("pref", "city")]
    stated = [r for r in rows if r["kind"] == "total"]
    if len(stated) != 1:
        raise SystemExit(f"{REPORT_CSV}: expected exactly one kind=total row")
    for col in LENGTH_COLUMNS:
        summed, total = sum(int(r[col]) for r in parts), int(stated[0][col])
        if summed != total:
            raise SystemExit(
                f"{REPORT_CSV}: the 47+20 rows sum to {summed:,} for {col}, but the "
                f"sheet's 合計 row says {total:,}")
    out = {col.removesuffix("_m"): int(stated[0][col]) / 1000 for col in LENGTH_COLUMNS}
    out["routes"] = int(stated[0]["routes"])
    return out


# ---------------------------------------------------------------- geometry ---
def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 180.0


def parallel(one: float, other: float) -> bool:
    d = abs(one - other)
    return min(d, 180.0 - d) <= PARALLEL_DEG


def probe_hit(p, v, q1, q2, reach: float) -> float | None:
    """Where the line through p across v crosses segment q1-q2, as a distance.

    Sideways from the sample point, both ways, out to `reach`; None if nothing
    is there. A sideways probe rather than a nearest-segment search because the
    way a road continues into is *ahead* of it, not beside it. Nearest-segment
    reads every junction as a carriageway pair: measured over 長野県 it returned
    930 km of paired length against this probe's 532 km.
    """
    qx, qy = q2[0] - q1[0], q2[1] - q1[1]
    denom = v[0] * qy - v[1] * qx
    if denom == 0.0:
        return None
    dx, dy = q1[0] - p[0], q1[1] - p[1]
    t = (dx * qy - dy * qx) / denom      # along the probe, signed
    u = (dx * v[1] - dy * v[0]) / denom  # along the candidate segment
    if not 0.0 <= u <= 1.0:
        return None
    return abs(t) if PROBE_MIN_M <= abs(t) <= reach else None


# ------------------------------------------------------------------- input ---
def load_region(region: str) -> list[dict]:
    """One region's arcs, with the way tags the ledger comparison needs.

    `oneway` and `highway` are not in the GeoJSON — the map has no use for them
    — so they come from the same raw cache build_routes.py read. Both files are
    written from one .osm.pbf, so the way ids line up exactly. A cache cut before
    build_routes.TAGS_USED gained `oneway` has no such tag; run `mise run
    extract` again if the one-way figures come out at zero.

    Coordinates become metres in a local equirectangular frame, the same way
    compare_n13.py measures distance. A region spans a few degrees, so the
    east-west scale is a couple of percent out at the top and bottom of the
    tallest box — immaterial against a 40 m threshold.
    """
    raw_path = CACHE / f"{region}.raw.json"
    if not raw_path.exists():
        raise SystemExit(f"{raw_path} is missing; run `mise run extract` first")
    gj = json.loads((REGION_DIR / f"{region}.geojson").read_text(encoding="utf-8"))
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    tags = {o["id"]: o.get("tags") or {}
            for o in (*raw["core"], *raw["candidates"]) if o["type"] == "way"}

    feats = gj["features"]
    if not feats:
        return []
    lat = sum(f["geometry"]["coordinates"][0][1] for f in feats) / len(feats)
    kx, ky = 111320.0 * math.cos(math.radians(lat)), 110540.0

    arcs = []
    for f in feats:
        p = f["properties"]
        t = tags.get(p["id"], {})
        highway = t.get("highway") or ""
        arcs.append({
            "id": p["id"],
            "refs": frozenset(p["refs_list"]),
            "kind": p["kind"],
            "former": bool(p["former"]),
            "km": p["km"],
            "designations": len(p["refs_list"]),
            "highway": highway,
            "link": highway.endswith("_link")
                    or (t.get("construction") or "").endswith("_link"),
            # `-1` is one-way against the drawn direction. `reversible` and
            # `alternating` are single-carriageway arrangements, not two roads.
            "oneway": t.get("oneway") in ("yes", "-1", "1", "true"),
            "pts": [(c[0] * kx, c[1] * ky) for c in f["geometry"]["coordinates"]],
        })
    return arcs


# ----------------------------------------------------------------- pairing ---
def build_grid(arcs: list[dict], cell: float) -> dict:
    """Segment index, cell side = the probe's reach.

    With the cell equal to the reach, whatever the probe can touch is inside the
    3x3 window around the sample's own cell.
    """
    grid = defaultdict(list)
    for ai, a in enumerate(arcs):
        pts = a["pts"]
        for si in range(len(pts) - 1):
            (x1, y1), (x2, y2) = pts[si], pts[si + 1]
            steps = max(1, int(math.dist(pts[si], pts[si + 1]) / (cell / 2)) + 1)
            for i in range(steps + 1):
                t = i / steps
                grid[(int((x1 + (x2 - x1) * t) // cell),
                      int((y1 + (y2 - y1) * t) // cell))].append((ai, si))
    return grid


def counterpart(arc: dict, ai: int, p, u, arcs: list[dict], grid, cell: float,
                reach: float) -> dict | None:
    """The nearest way running alongside `arc` at point `p`, if there is one.

    Same-numbered only: two *different* routes side by side are two roads and
    the ledger counts both. Of its own kind first — an open road beside an open
    road is a carriageway pair even when a way under construction happens to be
    nearer, and taking the nearer one would move the same metres into a
    different cause.
    """
    vx, vy = -u[1], u[0]
    best: dict[str, dict | None] = {"same": None, "other": None}
    best_d = {"same": math.inf, "other": math.inf}
    my_group = KIND_GROUP[arc["kind"]]
    my_bearing = bearing((0.0, 0.0), u)
    cx, cy = int(p[0] // cell), int(p[1] // cell)
    seen: set[tuple[int, int]] = set()
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for cand in grid.get((cx + dx, cy + dy), ()):
                if cand in seen:
                    continue
                seen.add(cand)
                bi, si = cand
                if bi == ai:
                    continue
                other = arcs[bi]
                if not (other["refs"] & arc["refs"]):
                    continue
                q1, q2 = other["pts"][si], other["pts"][si + 1]
                if not parallel(my_bearing, bearing(q1, q2)):
                    continue
                dist = probe_hit(p, (vx, vy), q1, q2, reach)
                if dist is None:
                    continue
                slot = "same" if KIND_GROUP[other["kind"]] == my_group else "other"
                if dist < best_d[slot]:
                    best_d[slot], best[slot] = dist, other
    return best["same"] or best["other"]


def paired_fraction(arc: dict, ai: int, arcs: list[dict], grid, cell: float,
                    reach: float) -> dict[tuple[str, str, bool], float]:
    """Metres of this arc with a same-numbered way alongside, by what kind.

    Keyed by (this arc's kind, the neighbour's group, both are one-way), which
    is what lets the causes be told apart afterwards: two open carriageways are
    one thing, a road being rebuilt beside the one it replaces is another. The
    arc's own kind is kept rather than its group so the report can say how much
    of the doubling is 自動車専用道路, where two carriageways are the norm.
    """
    out: dict[tuple[str, str, bool], float] = defaultdict(float)
    pts = arc["pts"]
    for si in range(len(pts) - 1):
        (x1, y1), (x2, y2) = pts[si], pts[si + 1]
        seglen = math.hypot(x2 - x1, y2 - y1)
        if seglen == 0.0:
            continue
        u = ((x2 - x1) / seglen, (y2 - y1) / seglen)
        n = max(1, int(seglen / SAMPLE_M))
        step = seglen / n
        for i in range(n):
            t = (i + 0.5) / n
            p = (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
            other = counterpart(arc, ai, p, u, arcs, grid, cell, reach)
            if other is not None:
                out[(arc["kind"], KIND_GROUP[other["kind"]],
                     arc["oneway"] and other["oneway"])] += step
    return out


# ----------------------------------------------------------------- measure ---
def measure(reach: float) -> dict:
    """Every way once, nationwide, with paired length measured inside its region.

    Region files overlap heavily — 151,114 distinct ways appear 311,380 times —
    so a way is counted for the first region whose file holds it. Pairing is
    still measured within that region against everything that file contains: a
    carriageway's twin is 40 m away and therefore in the same box by definition.
    """
    seen: set[int] = set()
    km_by_kind: dict[str, float] = defaultdict(float)
    link_km_by_kind: dict[str, float] = defaultdict(float)
    arcs_by_kind: dict[str, int] = defaultdict(int)
    paired_km: dict[tuple[str, str, bool], float] = defaultdict(float)
    total = {"arcs": 0, "designated_km": 0.0, "former_km": 0.0,
             "former_arcs": 0, "link_arcs": 0, "oneway_arcs": 0}

    for region in REGIONS:
        arcs = load_region(region)
        own = {a["id"] for a in arcs} - seen
        seen |= own

        for a in arcs:
            if a["id"] not in own:
                continue
            total["arcs"] += 1
            total["designated_km"] += a["km"] * a["designations"]
            km_by_kind[a["kind"]] += a["km"]
            arcs_by_kind[a["kind"]] += 1
            if a["former"]:
                total["former_km"] += a["km"]
                total["former_arcs"] += 1
            if a["link"]:
                link_km_by_kind[a["kind"]] += a["km"]
                total["link_arcs"] += 1
            if a["oneway"]:
                total["oneway_arcs"] += 1

        # A 旧道 is a road in its own right to the ledger (実延長's 旧道 column),
        # not a duplicate of the road that bypassed it, so it neither pairs nor
        # serves as a neighbour. Ramps are held out for the mirror-image reason:
        # they are counted whole already, under ランプ・連結路.
        pool = [a for a in arcs
                if a["kind"] in KIND_GROUP and not a["former"] and not a["link"]]
        grid = build_grid(pool, reach)
        for i, a in enumerate(pool):
            if a["id"] not in own or a["km"] == 0.0:
                continue
            for key, metres in paired_fraction(a, i, pool, grid, reach, reach).items():
                paired_km[key] += metres / 1000.0
        print(f"  {region:12} {len(own):6,} ways", flush=True)

    return {**total, "km_by_kind": dict(km_by_kind),
            "link_km_by_kind": dict(link_km_by_kind),
            "arcs_by_kind": dict(arcs_by_kind), "paired_km": dict(paired_km)}


# ------------------------------------------------------------------ report ---
def base_timestamp() -> str:
    """The OSM cut the regions were built from, refusing to average.

    Regions built from different cuts would make the nationwide total mean
    nothing in a way the total itself could never show, so a mixed build is
    named instead of hidden.
    """
    stamps = {json.loads((REGION_DIR / f"{r}.meta.json").read_text(encoding="utf-8"))
              ["osm_timestamp"] for r in REGIONS}
    return stamps.pop() if len(stamps) == 1 else "mixed: " + ", ".join(sorted(stamps))


def row(label: str, ledger: float | None, map_km: float | None) -> str:
    if ledger is None or map_km is None:
        gap = ""
    else:
        pct = f" ({(map_km - ledger) / ledger:+.1%})" if ledger else ""
        gap = f"{map_km - ledger:+12,.1f}{pct}"
    left = "" if ledger is None else f"{ledger:12,.1f}"
    right = "" if map_km is None else f"{map_km:12,.1f}"
    return f"  {label:28} {left:>12} {right:>12}  {gap}"


def main() -> None:
    args = sys.argv[1:]
    reach = PAIR_DISTANCE_M
    if "--distance" in args:
        i = args.index("--distance")
        reach = float(args[i + 1])
        args = args[:i] + args[i + 2:]
    if args:
        raise SystemExit(f"unexpected argument: {args[0]}")

    report = load_report()
    print(f"道路統計年報2025 表8〈一般国道〉 令和6年3月31日現在 ({REPORT_CSV.name})")
    print(f"地図 build/regions データ基準 {base_timestamp()}")
    print(f"上下線の判定: 側方 {reach:.0f} m 以内、{SAMPLE_M:.0f} m ごとに測る\n")

    m = measure(reach)
    if not m["oneway_arcs"]:
        raise SystemExit(
            "no way in build/cache carries `oneway`, so no carriageway pair can be "
            "recognised. The cache was cut before build_routes.TAGS_USED gained the "
            "tag; run `mise run extract` again.")
    kind, link = m["km_by_kind"], m["link_km_by_kind"]

    dedup_km = sum(kind.values())
    link_km = sum(link.values())
    sea_km = kind.get("ferry", 0.0)
    foot_km = kind.get("foot", 0.0) + kind.get("steps", 0.0)
    build_km = (kind.get("construction", 0.0) + kind.get("unopened", 0.0)
                - link.get("construction", 0.0) - link.get("unopened", 0.0))
    open_km = (kind.get("road", 0.0) + kind.get("expressway", 0.0)
               - link.get("road", 0.0) - link.get("expressway", 0.0))

    paired = m["paired_km"]

    def paired_sum(group: str, neighbour: str, both_oneway: bool | None = None) -> float:
        return sum(v for (mine, other, one), v in paired.items()
                   if KIND_GROUP[mine] == group and other == neighbour
                   and (both_oneway is None or one == both_oneway))

    # Halved: both carriageways see each other, so one road contributes its
    # length twice to the paired total and only the second copy is the excess.
    dual_km = paired_sum("open", "open", True) / 2
    dual_by_kind = {mine: v / 2 for (mine, other, one), v in paired.items()
                    if other == "open" and one and KIND_GROUP[mine] == "open"}
    parallel_km = paired_sum("open", "open", False) / 2
    build_dual_km = paired_sum("build", "build") / 2
    # Not halved, and only in this direction: the open road beside it is the one
    # the ledger already counts, so the whole of the construction way is extra.
    rebuild_km = paired_sum("build", "open")

    comparable = report["total"] - report["concurrent"]
    sea_report = report["unopened_sea"]
    build_report = report["unopened"] - report["unopened_sea"]

    print("\n年報と地図")
    print(f"  {'項目':26} {'年報':>12} {'地図':>12}   差")
    print(row("総延長 / 指定延長", report["total"], m["designated_km"]))
    print(row("実延長+未供用+渡船 / 重複排除", comparable, dedup_km))
    print(row("重用延長", report["concurrent"], m["designated_km"] - dedup_km))
    print(row("旧道", report["former"], m["former_km"]))
    print(f"  {'路線数':26} {report['routes']:>12} {'459':>12}")

    print("\n区分ごと(足すと上の重複排除の延長になる)")
    print(row("海上区間", sea_report, sea_km))
    print(row("工事中・未開通 / 未供用の陸上", build_report, build_km))
    print(row("ランプ・連結路", 0.0, link_km))
    print(row("徒歩道・階段", None, foot_km))
    print(row("供用中の車道 / 実延長", report["actual"], open_km))

    print("\n差の内訳")
    residual = (open_km - dual_km - parallel_km) - report["actual"]
    lines = [
        ("供用中の車道の差", open_km - report["actual"]),
        ("  上下線分離の二重計上", -dual_km),
        ("  並行する同番号の道(側道など)", -parallel_km),
        ("  説明できていない残り", -residual),
        ("工事中・未開通の差", build_km - build_report),
        ("  現道と並んで工事中(改築)", -rebuild_km),
        ("  工事中どうしの上下線分離", -build_dual_km),
        ("  説明できていない残り",
         -(build_km - rebuild_km - build_dual_km - build_report)),
        ("ランプ・連結路", link_km),
        ("徒歩道・階段", foot_km),
        ("海上区間の取りこぼし", sea_km - sea_report),
    ]
    for label, value in lines:
        print(f"  {label:34} {value:+12,.1f}")
    print(f"  {'合計':34} {dedup_km - comparable:+12,.1f}")

    # The ledger measures, independently, how much of its 実延長 has a central
    # reservation — which is what makes a road two carriageways in OSM in the
    # first place. It is not the same question (a 中央帯 is a structure with a
    # width; OSM splits a way for a painted separator too, and 表8's column
    # leaves out the 高速自動車国道 concurrency that our expressway arcs carry),
    # but the two ought to land in the same place, and they do.
    print("\n裏取り")
    print(row("中央帯設置 / 上下線分離の実測", report["median"], dual_km))
    print("  " + "  ".join(f"うち {k} {v:,.1f} km"
                           for k, v in sorted(dual_by_kind.items(), key=lambda x: -x[1])))

    print("\n測ったもの")
    print(f"  アーク {m['arcs']:,}  重複排除 {dedup_km:,.1f} km  "
          f"指定 {m['designated_km']:,.1f} km")
    print(f"  旧道 {m['former_arcs']:,} アーク {m['former_km']:,.1f} km  "
          f"ランプ {m['link_arcs']:,} アーク {link_km:,.1f} km")
    for k in sorted(kind, key=lambda k: -kind[k]):
        print(f"    {k:13} {kind[k]:9,.1f} km  {m['arcs_by_kind'][k]:7,} アーク"
              + (f"  うちランプ {link[k]:,.1f} km" if link.get(k) else ""))
    print("  並走の測定値(半分にする前)")
    for key in sorted(paired, key=lambda k: -paired[k]):
        mine, other, one = key
        print(f"    {mine:5} と {other:5} 両方一方通行={one!s:5} "
              f"{paired[key]:9,.1f} km")


if __name__ == "__main__":
    main()
