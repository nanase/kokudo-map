# /// script
# requires-python = ">=3.12"
# dependencies = ["requests", "pyshp"]
# ///
"""Compare a region's output against 国土数値情報 N13 (道路), the one reference
that shares an origin with 地理院地図.

audit.py finds breaks in a route's own chain, but it can only reason about
roads that already have *some* trace in our OSM cache. A road entirely absent
from OSM leaves no trace to reason about, and only an independent source can
find that case — see TRIAGE.md. N13 is that source: same origin as 地理院地図
(電子国土基本図), covers every 一般国道 in the country, but carries no route
number, only a 道路分類 flag (国道 / 都道府県道 / 市区町村道等 / …). It cannot
tell us *which* number is missing, only *where* something is.

Two comparisons, both point-in-the-other-direction of the same question:

  gap        an N13 国道 segment with nothing of ours nearby — a candidate for
             "OSM doesn't have this road at all", the TRIAGE.md case audit.py
             cannot reach.
  orphan     one of our own `former`-flagged arcs with no N13 国道 segment
             nearby — a candidate for "地理院地図 has already delisted this,
             our former flag is stale". Checking former arcs against N13
             *directly* (is this arc, current or former, near an N13 line at
             all) is the useful signal; checking whether N13 agrees an arc is
             specifically "former" is not, because N13 has no former/current
             distinction of its own — every legally-designated 旧道 still
             carries 道路分類=国道 until 指定解除, exactly like a live one, so
             that comparison would flag every correctly-tagged 旧道 as a
             "mismatch" and mean nothing.

The orphan direction is rated by coverage, not one point (issue #27): each
arc is resampled every SAMPLE_INTERVAL_M along its length, and the ratio of
samples within ORPHAN_THRESHOLD_M of N13 is the arc's coverage. A single
midpoint (the old rule) or its own endpoint vertices (which sit near N13 by
construction — a former arc reconnects to the current road) both mean
something different from "how much of this road is still N13-backed".
Contiguous arcs — one physical road split into many short OSM ways, or one
still split by a prefecture-adjacent duplicate before dedup — are merged into
one cluster (cluster_former_arcs, sharing cluster_by_endpoint with the gap
direction's cluster_gaps) with one length-weighted ratio, so triage happens
per road, not per way. `region all` additionally dedups the same way id
across every prefecture whose padded bbox includes it before rating anything
— see national_orphan_report.

A low-coverage cluster only says "not much 国道 nearby" — it does not say
what, if anything, N13 draws in its place. This script also looks up the
nearest N13 line of *any* 道路分類 for each cluster's sample point and reports
its classification and distance. A definite non-国道 classification (都道府県
道 / 市区町村道等 / 高速自動車国道等 / その他) sitting within a tight distance
is a stronger signal than absence alone: it means N13 draws something
specific, not-国道, exactly where our road runs, which is what 指定解除 (a
road handed down to a lower category, not simply erased) looks like from this
source. 不明 does not count toward this — it asserts nothing to corroborate
with.

Both directions reuse the same grid: a region's own arcs are short OSM ways,
N13 records are shorter still (cut at every attribute change, not just every
junction), so nearest-*segment* distance is measured with a local
equirectangular projection rather than nearest-vertex — vertex spacing on
either side would otherwise read as false disagreement.

Distances are not proof by themselves. A gap can be a real absence, an OSM
tagging exclusion (check `why` — reused from audit.py's exclusion reasoning),
or two independent digitisations of the same painted line — a human with
地理院地図 open still decides which, and which route number applies, for gaps
and for clusters this script cannot classify. TRIAGE.md's "N13 は路線番号を
持たないので…ここが人の出番です" is still the load-bearing sentence for those.
A confirmed cluster (marked in the report) is the one place that manual step
is no longer needed to establish *that* 指定解除 happened; which number the
road used to carry is still a human's call. Whether to bake this confirmation
into build data (making N13 a build dependency) is a separate decision,
deliberately left open — see issue #9.

Usage:  uv run scripts/compare_n13.py [region|all] [--refresh]

`all` runs the orphan direction only, nationwide, deduped by way id.
`--refresh` re-downloads and re-parses every mesh even if a cache exists.
"""
from __future__ import annotations

import json
import math
import sys
import zipfile
from pathlib import Path

import requests
import shapefile

from _paths import N13, REGIONS as DATA
from audit import DSU, claims, haversine, load_cache, why_excluded
from regions import REGIONS as PREFECTURES

# https://nlftp.mlit.go.jp/ksj/gml/data/N13/N13-24/N13-24_<mesh>_SHP.zip serves
# a shapefile per 1次メッシュ (~80 km square). The site also offers GML, but
# the shapefile schema is smaller and pyshp is pure Python — no GDAL, no new
# system dependency, in keeping with every other script here.
BASE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/N13/N13-24"
UA = {"User-Agent": "NationalRouteMap/0.2 (build pipeline)"}

# The shapefile's own field names are opaque (N13_001..N13_008, per the KSJ
# encoding convention, not the product-spec's Japanese names). Verified by
# downloading mesh 5438 and reading record #0 by hand against the product
# spec (KS-PS-N13-v1_1.pdf ×4.1.3.2): index 0 is 整備データ登録日, 1 is 種別,
# 2 is 道路分類(rdCtg), 3 is 道路状態, 4 is 階層順, 5 is 幅員区分, 6 is 有料区分,
# 7 is 2次メッシュ番号. Only the one this script needs gets a name. Confirmed
# Character-type in the DBF (sf.fields), so it always reads back as str — not
# a Numeric field that would silently compare unequal to "1".
RDCTG_FIELD = 2
RDCTG_KOKUDO = "1"

# 道路分類種別コードの全区分。KS-PS-N13-v1_1.pdf(2026-03, 国土交通省)4.1.3.2
# の応用スキーマ文書と付属資料-2 の符号化仕様(XSD の enumeration/description)
# の両方で確認済み — 推定ではない。低被覆率クラスタの直下に国道以外の何が
# 描かれているかを言うのに使う。不明(6)は「何かは分からない」という情報しか
# 持たないので、指定解除の裏付けにはならない。
RDCTG_LABELS = {
    "1": "国道",
    "2": "都道府県道",
    "3": "市区町村道等",
    "4": "高速自動車国道等",
    "5": "その他",
    "6": "不明",
}

# 1次メッシュ code: p = floor(lat*1.5) (2 digits), q = floor(lon)-100 (2
# digits), concatenated. Standard 地域メッシュ統計 first-level mesh, unrelated
# to N13 specifically. Measured against 長野県's bbox this returns the same 8
# codes TRIAGE.md already names, which is the cross-check that the formula
# (not just the memorised list) is right.
def mesh_codes_for_bbox(bbox: list[float]) -> list[str]:
    west, south, east, north = bbox
    p_lo, p_hi = math.floor(south * 1.5), math.floor(north * 1.5)
    q_lo, q_hi = math.floor(west) - 100, math.floor(east) - 100
    return [f"{p}{q:02d}" for p in range(p_lo, p_hi + 1) for q in range(q_lo, q_hi + 1)]


def mesh_code_for_point(pt: tuple[float, float]) -> str:
    """Same p/q formula as mesh_codes_for_bbox, for a single (lat, lon) point
    instead of a bbox — see classify_clusters_beneath, which needs the one
    mesh a cluster's sample point falls in, not every mesh a region touches."""
    lat, lon = pt
    return f"{math.floor(lat * 1.5)}{math.floor(lon) - 100:02d}"


# Mesh codes confirmed by hand to 404 — KSJ publishes no N13 shapefile for
# them at all, because they hold no land and N13 covers roads only. This is
# every 404 that turned up touching all 47 regions.py prefectures on
# 2026-08-22 (272 unique meshes; 125 of them here) — cross-checked against
# build/n13/ on disk (a mesh with a cached kokudo.raw.json but no extracted
# .shp directory only ever got there via the 404 branch below), not just
# grepped from run logs, after an initial hand-collected list missed 5 meshes
# whose confirming run never got redirected to a file. A 404 for a mesh NOT in
# this set is not assumed to be more of the same — see ensure_mesh. Confirming
# a new one belongs here means checking it by hand (the KSJ URL 404s, and the
# mesh is open ocean on a map), the same way these were confirmed, then adding
# it — not extending the reasoning to every future 404 unseen.
KNOWN_OCEAN_MESHES = frozenset({
    "3522", "3523", "3524", "3525", "3526", "3527", "3528", "3529", "3530", "3531",
    "3625", "3626", "3627", "3628", "3629", "3630", "3722", "3723", "3726", "3727",
    "3728", "3729", "3730", "3731", "3822", "3823", "3824", "3825", "3826", "3827",
    "3828", "3829", "3830", "3922", "3923", "3924", "3925", "3929", "3930", "3931",
    "4022", "4023", "4024", "4025", "4026", "4029", "4030", "4031", "4122", "4123",
    "4124", "4125", "4126", "4127", "4130", "4131", "4222", "4223", "4224", "4225",
    "4226", "4227", "4228", "4231", "4328", "4330", "4331", "4428", "4430", "4431",
    "4528", "4628", "4632", "4727", "4732", "4827", "4832", "4833", "4834", "4927",
    "4935", "4936", "5027", "5028", "5037", "5127", "5128", "5140", "5141", "5227",
    "5228", "5230", "5241", "5331", "5341", "5431", "5434", "5441", "5642", "5736",
    "5737", "5742", "5842", "6042", "6142", "6143", "6144", "6145", "6242", "6244",
    "6245", "6344", "6345", "6539", "6639", "6640", "6739", "6740", "6743", "6744",
    "6745", "6839", "6843", "6844", "6845",
})


def ensure_mesh(mesh: str, refresh: bool) -> Path | None:
    """Download and unzip one mesh's SHP bundle if not already cached.

    Returns None for a mesh in KNOWN_OCEAN_MESHES that 404s — confirmed
    no-shapefile-published, not a transient failure; the caller treats it the
    same as a shapefile with zero 国道 records, and the print below keeps it
    visible per mesh rather than swallowing it. A 404 for any other mesh
    raises instead of guessing: nothing here can tell an all-ocean mesh apart
    from a KSJ outage or a renamed URL, so an unrecognised 404 is a reason to
    stop and check by hand, not a reason to cache an empty result.
    """
    out_dir = N13 / mesh
    shp = out_dir / f"N13-24_{mesh}_SHP" / f"N13-24_{mesh}.shp"
    if shp.exists() and not refresh:
        return shp
    out_dir.mkdir(parents=True, exist_ok=True)
    url = f"{BASE_URL}/N13-24_{mesh}_SHP.zip"
    print(f"  downloading {url}", flush=True)
    r = requests.get(url, headers=UA, timeout=120)
    if r.status_code == 404:
        if mesh in KNOWN_OCEAN_MESHES:
            print(f"  {mesh}: no shapefile published (known all-ocean mesh) - treating as 0 records")
            return None
        raise SystemExit(
            f"{mesh}: 404 from KSJ and this mesh is not in KNOWN_OCEAN_MESHES. "
            "Confirm by hand whether it is genuinely an all-ocean mesh (check "
            "the URL and look the mesh up on a map) before adding it to the "
            "set — do not assume."
        )
    r.raise_for_status()
    zip_path = out_dir / "shp.zip"
    zip_path.write_bytes(r.content)
    with zipfile.ZipFile(zip_path) as z:
        # The zip already contains a top-level N13-24_<mesh>_SHP/ folder —
        # extracting into out_dir directly (not into a same-named subfolder)
        # avoids doubling it.
        z.extractall(out_dir)
    zip_path.unlink()
    if not shp.exists():
        raise SystemExit(f"{mesh}: expected {shp} after unzip, not found")
    return shp


def segment_intersects_bbox(p0, p1, west: float, south: float, east: float,
                             north: float) -> bool:
    """Liang-Barsky test: true if segment p0-p1 (lon, lat) touches the
    rectangle at all, including a chord that crosses it with both endpoints
    outside — the case a per-vertex "is either endpoint inside" test misses.
    """
    x0, y0 = p0
    x1, y1 = p1
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - west), (dx, east - x0),
                 (-dy, y0 - south), (dy, north - y0)):
        if p == 0:
            if q < 0:
                return False
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return False
            t0 = max(t0, r)
        else:
            if r < t0:
                return False
            t1 = min(t1, r)
    return t0 <= t1


def line_touches_bbox(line: list[tuple[float, float]], west: float, south: float,
                       east: float, north: float) -> bool:
    """line is (lat, lon) points, kept whole (not clipped) if any of its
    segments touches the bbox — a per-vertex test would still drop a short
    chord that crosses a bbox edge with both endpoints outside. Records are
    2-3 points (see module docstring), so the sliver a kept-whole record adds
    outside the bbox is a few tens of metres at most."""
    pts = [(lon, lat) for lat, lon in line]
    if not pts:
        return False
    pairs = list(zip(pts, pts[1:])) or [(pts[0], pts[0])]
    return any(segment_intersects_bbox(a, b, west, south, east, north) for a, b in pairs)


def load_classified_raw(mesh: str, refresh: bool
                         ) -> list[tuple[str, list[tuple[float, float]]]]:
    """This mesh's full record set — every 道路分類, not just 国道 — uncut by
    any bbox.

    One cache per mesh covers every classification, rather than one cache per
    (mesh, classification we happen to want): the shapefile parse is the
    expensive part (~8 s per mesh), and a second cache keyed on a filtered
    subset would mean re-parsing the same shapefile to answer a question
    ("what's the *other* classification here") this cache already has the
    answer to.

    The cache holds the mesh's raw, unfiltered records and is keyed by mesh
    alone — a 1次メッシュ regularly spans a border between two regions (see
    regions.py on rectangles spilling into neighbours), and keying by mesh
    only while filtering at write time meant the *second* region to touch a
    shared mesh would silently reuse the *first* region's bbox-filtered
    subset instead of its own. Filtering (by bbox, or to 国道 alone) is left
    to the call site, same as load_kokudo_raw below.
    """
    cache_path = N13 / f"{mesh}.classified.raw.json"
    if cache_path.exists() and not refresh:
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
        return [(rdctg, [tuple(p) for p in line]) for rdctg, line in raw]

    shp_path = ensure_mesh(mesh, refresh)
    records: list[tuple[str, list[tuple[float, float]]]] = []
    if shp_path is not None:
        sf = shapefile.Reader(str(shp_path), encoding="utf-8")
        for i, rec in enumerate(sf.iterRecords()):
            pts = sf.shape(i).points
            records.append((rec[RDCTG_FIELD], [(lat, lon) for lon, lat in pts]))
    N13.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(records), encoding="utf-8")
    return records


def load_kokudo_raw(mesh: str, refresh: bool) -> list[list[tuple[float, float]]]:
    """The 国道-only subset of load_classified_raw, uncut by any bbox — see
    that function's docstring for the caching rationale, which this shares."""
    return [line for rdctg, line in load_classified_raw(mesh, refresh)
            if rdctg == RDCTG_KOKUDO]


# ---------------------------------------------------------------- geometry ---
# haversine and DSU are audit.py's own — imported rather than restated, so a
# fix to either propagates here instead of the two copies quietly diverging.
def point_segment_distance_m(p, a, b) -> float:
    """Distance from p to segment a-b, via a local equirectangular projection
    centred on p. Accurate to centimetres at the scale of one arc (tens of
    metres to a few km) — no need for anything heavier."""
    r = 6371008.8

    def xy(pt):
        x = math.radians(pt[1] - p[1]) * math.cos(math.radians(p[0])) * r
        y = math.radians(pt[0] - p[0]) * r
        return x, y

    ax, ay = xy(a)
    bx, by = xy(b)
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(ax, ay)
    t = max(0.0, min(1.0, (-ax * dx - ay * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(cx, cy)


# Calibrated against mesh 5438 (長野県中心部): point-to-vertex distances came
# back with a 6.6 m median and a 31.6 m 90th percentile against N13's own
# claimed 25 m positional stddev. Point-to-segment tightens that further.
# 100 m gives real digitisation slack on both sides room without hiding a
# short missing link the way audit.py's own 50 m/2 km split would.
GAP_THRESHOLD_M = 100
ORPHAN_THRESHOLD_M = 100

# A single sample per arc (the old rule used the midpoint) lets a road whose
# only near-N13 stretch is its junction with the current road read as fully
# orphaned, and lets one with a real gap in the middle read as fully backed
# — see issue #27, which measured 45/804 candidates under the old rule as
# "more than half N13-covered" despite being flagged as orphans outright.
# 50 m is fine enough to catch either without over-sampling a road this
# short.
SAMPLE_INTERVAL_M = 50

# Below this, a former arc is a candidate for a stale former flag; at or
# above it, it is left alone. Issue #27 measured the layered distribution as
# clearly bimodal — 501 arcs at exactly 0%, 104 more under 20%, then a
# 20-80% grey band a human has to look at either way, then 746 at 80-100%
# that 地理院地図 already draws as national — so 20% is the low edge of that
# grey band, not an arbitrary round number. Arcs at or above this line are
# excluded from clustering entirely (see cluster_by_endpoint's caller in
# national_orphan_report/main), mirroring how the gap direction only ever
# clusters unmatched N13 records, never matched ones.
ORPHAN_CANDIDATE_RATIO = 0.2

# Same calibration as ORPHAN_THRESHOLD_M above — this is the distance within
# which "some other classification sits right where our cluster's sample
# point falls" is a real match and not two unrelated lines that happen to be
# close. 国道(1) and 不明(6) are excluded: a nearby 国道 does not fit here
# (the cluster is already a low-coverage candidate), and 不明 asserts nothing
# to confirm with.
CONFIRM_THRESHOLD_M = 100
CONFIRMABLE_RDCTG = {"2", "3", "4", "5"}

CELL = 0.01  # ~1 km at these latitudes — see audit.py's own grid for precedent


def cell_of(pt: tuple[float, float]) -> tuple[float, float]:
    return (round(pt[0], 2), round(pt[1], 2))


def cells_for_segment(a: tuple[float, float], b: tuple[float, float]) -> set:
    """Every grid cell a-b passes through, not just its midpoint's.

    N13 records are short enough that midpoint-only registration would have
    been fine for them, but our own arcs are plain OSM ways — a mountain-pass
    stretch between two sparse nodes can run several km, well past one
    CELL. A query point near the far end of such a segment would then search
    around a midpoint cell it was never registered in and come back empty.
    Sampling roughly every CELL along the segment is enough to catch every
    cell it crosses; anything finer buys nothing since `nearest_segment`
    already re-checks the true distance for every candidate it finds.
    """
    steps = max(1, math.ceil(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / CELL))
    return {
        cell_of((a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps))
        for i in range(steps + 1)
    }


def build_segment_grid(lines: list[list[tuple[float, float]]]) -> dict:
    grid: dict = {}
    for line in lines:
        for i in range(len(line) - 1):
            a, b = line[i], line[i + 1]
            for cell in cells_for_segment(a, b):
                grid.setdefault(cell, []).append((a, b))
    return grid


def nearest_segment(pt, grid, radius=1):
    c = cell_of(pt)
    best = None
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            key = (round(c[0] + dx * CELL, 2), round(c[1] + dy * CELL, 2))
            for a, b in grid.get(key, []):
                d = point_segment_distance_m(pt, a, b)
                if best is None or d < best:
                    best = d
    return best


def build_classified_grid(records: list[tuple[str, list[tuple[float, float]]]]) -> dict:
    """Same grid as build_segment_grid, but each entry keeps the rdCtg of the
    line it came from — build_segment_grid's entries are plain (a, b) pairs
    because every caller so far only ever grouped lines of one classification
    (国道) at a time and never needed to ask "a match, but a match to what?"."""
    grid: dict = {}
    for rdctg, line in records:
        for i in range(len(line) - 1):
            a, b = line[i], line[i + 1]
            for cell in cells_for_segment(a, b):
                grid.setdefault(cell, []).append((rdctg, a, b))
    return grid


def nearest_classified_segment(pt, grid, radius=1):
    """nearest_segment, but returns (distance, rdCtg) of the winning segment
    instead of just the distance."""
    c = cell_of(pt)
    best = None
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            key = (round(c[0] + dx * CELL, 2), round(c[1] + dy * CELL, 2))
            for rdctg, a, b in grid.get(key, []):
                d = point_segment_distance_m(pt, a, b)
                if best is None or d < best[0]:
                    best = (d, rdctg)
    return best


def classify_beneath(sample: tuple[float, float], grid) -> tuple[str, bool]:
    """One-line description of what N13 draws directly under a cluster's
    sample point, plus whether that's a mechanical 指定解除 confirmation —
    see the module docstring's paragraph on this. Shared by main()'s
    single-region report and national_orphan_report so the two never drift
    on what "confirmed" means."""
    nearest = nearest_classified_segment(sample, grid)
    if nearest is None:
        return "N13分類なし", False
    dist, rdctg = nearest
    label = RDCTG_LABELS.get(rdctg, f"コード{rdctg!r}")
    confirmed = dist <= CONFIRM_THRESHOLD_M and rdctg in CONFIRMABLE_RDCTG
    mark = " [指定解除を機械確認]" if confirmed else ""
    return f"直下 {dist:.0f}m に{label}{mark}", confirmed


def classify_clusters_beneath(clusters: list[dict], refresh: bool) -> None:
    """Attach "beneath" (str) and "confirmed" (bool) to every cluster in
    place, by classify_beneath on each cluster's sample point.

    One mesh's classified (全分類, not just 国道) record set runs 30-50x
    larger than its 国道-only subset — measured at 74k-137k records per mesh
    against 2-3k 国道 (issue #28) — so combining every mesh a caller's
    clusters might span into one grid, the way the 国道-only grid safely
    does, holds tens of millions of line records at once for a nationwide
    call and exhausted memory in practice. Grouping clusters by the one mesh
    their sample point falls in (mesh_code_for_point), then building and
    discarding one mesh's classified grid at a time, keeps peak memory to a
    single mesh's worth regardless of how many meshes the full cluster list
    spans — the tradeoff is doing the classification pass separately from
    the coverage_ratio pass (which does still read every mesh's 国道-only
    subset into one grid; that one stays small enough to be fine, see
    load_kokudo_raw's callers) rather than in the same mesh loop.

    Every cluster's sample point falls inside a mesh the caller already
    resolved and validated (region's own `meshes`, or `all_meshes` for the
    nationwide report) — the arc the sample comes from was read from that
    region's own data in the first place — so this never requests a mesh
    ensure_mesh hasn't already confirmed to exist.
    """
    by_mesh: dict[str, list[dict]] = {}
    for c in clusters:
        by_mesh.setdefault(mesh_code_for_point(c["sample"]), []).append(c)
    for mesh, mesh_clusters in by_mesh.items():
        grid = build_classified_grid(load_classified_raw(mesh, refresh))
        for c in mesh_clusters:
            c["beneath"], c["confirmed"] = classify_beneath(c["sample"], grid)
        # `grid` (and the mesh's raw records inside it) is dropped here, before
        # the next mesh's grid is built — this loop never holds two meshes'
        # classified data at once.


# ----------------------------------------------------------------- coverage --
def resample_line(coords: list[tuple[float, float]],
                   interval_m: float = SAMPLE_INTERVAL_M) -> list[tuple[float, float]]:
    """coords, resampled to one point every interval_m along its length, plus
    both endpoints. A line shorter than interval_m still yields its two
    endpoints, so coverage_ratio never divides by zero."""
    if len(coords) < 2:
        return list(coords)
    points = [coords[0]]
    dist_so_far = 0.0
    next_mark = interval_m
    for a, b in zip(coords, coords[1:]):
        seg_len = haversine(a, b)
        if seg_len == 0:
            continue
        while dist_so_far + seg_len >= next_mark:
            t = (next_mark - dist_so_far) / seg_len
            points.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            next_mark += interval_m
        dist_so_far += seg_len
    if points[-1] != coords[-1]:
        points.append(coords[-1])
    return points


def coverage_ratio(coords: list[tuple[float, float]], grid,
                    threshold_m: float) -> tuple[int, int, float | None]:
    """(matched, total, min_dist) for coords resampled every SAMPLE_INTERVAL_M.

    Not the arc's own vertices, and not one midpoint (the old rule): a
    former arc reconnects to the current road at both ends by construction,
    so its two endpoint vertices sit inside threshold_m of N13 regardless of
    whether the road itself still does, and its midpoint alone can land
    anywhere along a road that is only partly still N13-backed. Sampling
    along the whole length is what makes the ratio mean "how much of this
    road" rather than "does one arbitrary point on it".

    min_dist is the closest any sample came to N13, even when that is past
    threshold_m — a CodeRabbit review on issue #27's own PR caught that
    ratio == 0 does not mean "no N13 nearby": an N13 line sitting just
    outside threshold_m of every 50 m sample still reads as 0% coverage, but
    it is not "N13 なし". Only min_dist being None — no sample found
    anything within nearest_segment's own search radius — means that.
    """
    points = resample_line(coords)
    matched = 0
    min_dist = None
    for p in points:
        d = nearest_segment(p, grid)
        if d is None:
            continue
        if min_dist is None or d < min_dist:
            min_dist = d
        if d <= threshold_m:
            matched += 1
    return matched, len(points), min_dist


def ratio_of(arc: dict) -> float:
    return arc["matched"] / arc["total"] if arc["total"] else 0.0


def coverage_label(cluster: dict) -> str:
    """"N13 なし" only when min_dist is None — no sample found anything
    within nearest_segment's own search radius. 0% coverage on its own does
    not mean that: an N13 line just past ORPHAN_THRESHOLD_M of every sample
    still reads as 0% covered but is not absent (see coverage_ratio)."""
    if cluster["min_dist"] is None:
        return "N13 なし"
    label = f"被覆率 {cluster['ratio'] * 100:.0f}%"
    if cluster["ratio"] == 0:
        label += f"(最寄N13 {cluster['min_dist']:.0f}m)"
    return label


# --------------------------------------------------------------- clustering --
def node_key(pt):
    return (round(pt[0], 6), round(pt[1], 6))


def cluster_by_endpoint(lines: list[list[tuple[float, float]]]) -> list[list[int]]:
    """Indices into lines, grouped by shared start/end point via a DSU over
    endpoints. N13 cuts a continuous road into many short records at every
    attribute change, and a former route is routinely split into many short
    OSM ways too, so one real road is routinely dozens of consecutive
    records/arcs, not one — shared by both the gap and orphan directions
    (issue #27 added the orphan side; the gap side already had it)."""
    dsu = DSU()
    for line in lines:
        dsu.union(node_key(line[0]), node_key(line[-1]))
    groups: dict = {}
    for i, line in enumerate(lines):
        root = dsu.find(node_key(line[0]))
        groups.setdefault(root, []).append(i)
    return list(groups.values())


def cluster_gaps(gap_lines: list[list[tuple[float, float]]]):
    clusters = []
    for idxs in cluster_by_endpoint(gap_lines):
        lines = [gap_lines[i] for i in idxs]
        km = sum(haversine(l[i], l[i + 1]) for l in lines for i in range(len(l) - 1)) / 1000
        mid_line = lines[len(lines) // 2]
        clusters.append({"lines": lines, "km": km, "sample": mid_line[len(mid_line) // 2]})
    return sorted(clusters, key=lambda c: -c["km"])


def cluster_former_arcs(arcs: list[dict]):
    """Group former arcs sharing an endpoint into one triage unit, with a
    length-weighted coverage ratio for the merged whole.

    Each arc dict needs id, feature, coords, matched, total (see
    coverage_ratio). Grouping first and rating second — rather than rating
    each arc and grouping the ratings — is what lets a cluster whose
    individual arcs sample unevenly (a short arc contributes as few as 2
    points) still add up to one honest ratio for the road as a whole.
    """
    lines = [a["coords"] for a in arcs]
    clusters = []
    for idxs in cluster_by_endpoint(lines):
        members = [arcs[i] for i in idxs]
        km = sum(haversine(m["coords"][j], m["coords"][j + 1])
                  for m in members for j in range(len(m["coords"]) - 1)) / 1000
        matched = sum(m["matched"] for m in members)
        total = sum(m["total"] for m in members)
        dists = [m["min_dist"] for m in members if m["min_dist"] is not None]
        mid = members[len(members) // 2]
        clusters.append({
            "members": members,
            "km": km,
            "ratio": matched / total if total else 0.0,
            "min_dist": min(dists) if dists else None,
            "sample": mid["coords"][len(mid["coords"]) // 2],
            "ids": sorted({m["id"] for m in members}),
            "refs": sorted({r for m in members for r in m["feature"]["properties"]["refs_list"]}),
        })
    return sorted(clusters, key=lambda c: -c["km"])


# ------------------------------------------------------------------- report --
def nearby_osm_ways(cache, out_ids, point, radius_m):
    hits = []
    for wid, w in cache["ways"].items():
        if wid in out_ids:
            continue
        t = w.get("tags", {})
        if not claims(t):
            continue
        # Distance to the way's segments, not just its vertices — a way with
        # widely-spaced nodes could otherwise pass right by `point` without
        # any single vertex landing inside radius_m, and get reported as
        # "absent from OSM" when it is really just excluded.
        geometry = [(p["lat"], p["lon"]) for p in w["geometry"]]
        if len(geometry) < 2:
            hit = geometry and haversine(point, geometry[0]) <= radius_m
        else:
            hit = any(point_segment_distance_m(point, a, b) <= radius_m
                      for a, b in zip(geometry, geometry[1:]))
        if hit:
            hits.append((wid, t))
    return hits


def national_orphan_report(refresh: bool) -> None:
    """former 孤立候補を全国横断・重複排除・被覆率・クラスタ単位で出す — issue #27。

    A single region's own run can't dedup: the same way turns up once per
    prefecture whose padded bbox happens to include it (issue #27 measured
    3,546 raw listings from #9 collapsing to 1,644 unique way ids, 1,301 of
    them duplicated across 2+ prefectures). Only a run that has every
    region's output in hand at once can tell "the same arc, listed twice"
    from "two different arcs".
    """
    per_way: dict[int, dict] = {}
    raw_count = 0
    all_meshes: set[str] = set()
    for region in PREFECTURES:
        meta = json.loads((DATA / f"{region}.meta.json").read_text(encoding="utf-8"))
        gj = json.loads((DATA / f"{region}.geojson").read_text(encoding="utf-8"))
        all_meshes |= set(mesh_codes_for_bbox(meta["bbox"]))
        for f in gj["features"]:
            if not f["properties"].get("former"):
                continue
            raw_count += 1
            per_way.setdefault(f["properties"]["id"], f)
    print(f"former arcs: {raw_count} raw across {len(PREFECTURES)} region(s), "
          f"{len(per_way)} unique way id(s) after dedup by way id")

    print(f"loading {len(all_meshes)} N13 mesh(es) nationwide (mesh-wide, no bbox cut — "
          "see load_kokudo_raw)...")
    # Only the 国道-only subset is accumulated across every mesh at once —
    # nationwide that stays small enough for one grid (issue #27 already
    # proved this out). The 全分類 (all classifications) reads used for
    # classify_clusters_beneath below are deliberately *not* held here too;
    # see that function's docstring for why combining every mesh's full
    # classification set nationwide exhausts memory.
    kokudo_raw: list[list[tuple[float, float]]] = []
    for mesh in sorted(all_meshes):
        kokudo_raw.extend(load_kokudo_raw(mesh, refresh))
    print(f"N13 国道 records nationwide: {len(kokudo_raw)}")
    grid = build_segment_grid(kokudo_raw)

    arcs = []
    for wid, f in per_way.items():
        coords = [(lat, lon) for lon, lat in f["geometry"]["coordinates"]]
        matched, total, min_dist = coverage_ratio(coords, grid, ORPHAN_THRESHOLD_M)
        arcs.append({"id": wid, "feature": f, "coords": coords, "matched": matched,
                      "total": total, "min_dist": min_dist})

    def bucket(ratio: float) -> str:
        pct = ratio * 100
        if pct == 0:
            return "0%"
        if pct < 20:
            return "0-20%"
        if pct < 80:
            return "20-80%"
        return "80-100%"

    counts = {"0%": 0, "0-20%": 0, "20-80%": 0, "80-100%": 0}
    for a in arcs:
        counts[bucket(ratio_of(a))] += 1
    print("\narc-level coverage distribution:")
    for k in ("0%", "0-20%", "20-80%", "80-100%"):
        print(f"  {k}: {counts[k]}")

    # Cluster only candidate arcs (ratio_of < ORPHAN_CANDIDATE_RATIO) — an
    # arc that is itself well N13-backed never joins a cluster, the same way
    # cluster_gaps only ever sees N13 records already classified as
    # unmatched, never matched ones.
    candidates = [a for a in arcs if ratio_of(a) < ORPHAN_CANDIDATE_RATIO]
    clusters = cluster_former_arcs(candidates)
    print(f"\nclassifying what N13 draws beneath {len(clusters)} cluster(s), "
          "one mesh's 全分類 records at a time (see classify_clusters_beneath)...")
    classify_clusters_beneath(clusters, refresh)
    print(f"{len(clusters)} cluster(s) from {len(candidates)} candidate arc(s) "
          f"(< {ORPHAN_CANDIDATE_RATIO * 100:.0f}% coverage) - candidates for a "
          "stale former flag (地理院地図 may already show this as 指定解除 outright)")
    print("=" * 80)
    confirmed_clusters = 0
    confirmed_arcs = 0
    for c in clusters:
        lat, lon = c["sample"]
        label = coverage_label(c)
        if c["confirmed"]:
            confirmed_clusters += 1
            confirmed_arcs += len(c["members"])
        id_list = ", ".join(f"way/{i}" for i in c["ids"][:5])
        if len(c["ids"]) > 5:
            id_list += f", 他{len(c['ids']) - 5}件"
        print(f"  国道{'・'.join(map(str, c['refs']))}  {c['km']:.2f} km  "
              f"{len(c['members']):>3} arc(s)  {label}  sample {lat:.5f},{lon:.5f}  "
              f"({c['beneath']})")
        print(f"    {id_list}")

    print(f"\n{confirmed_clusters}/{len(clusters)} cluster(s) mechanically confirmed as "
          f"指定解除 ({confirmed_arcs} arc(s)) — 非国道の N13 分類が "
          f"{CONFIRM_THRESHOLD_M} m 以内の直下にある")


def main() -> None:
    # Windows terminals default stdout to cp932, which lacks glyphs this
    # script prints (em dash, 一部の記号). build_all.py hits the same wall.
    sys.stdout.reconfigure(errors="replace")
    args = [a for a in sys.argv[1:] if a != "--refresh"]
    refresh = "--refresh" in sys.argv[1:]
    region = args[0] if args else "nagano"

    if region == "all":
        national_orphan_report(refresh)
        return

    meta = json.loads((DATA / f"{region}.meta.json").read_text(encoding="utf-8"))
    gj = json.loads((DATA / f"{region}.geojson").read_text(encoding="utf-8"))
    bbox = meta["bbox"]
    feats = gj["features"]
    out_ids = {f["properties"]["id"] for f in feats}

    meshes = mesh_codes_for_bbox(bbox)
    print(f"{region}: bbox {bbox} -> {len(meshes)} mesh(es): {', '.join(meshes)}")

    west, south, east, north = bbox
    kokudo: list[list[tuple[float, float]]] = []       # bbox-filtered: gap direction
    kokudo_raw: list[list[tuple[float, float]]] = []   # mesh-wide: orphan direction
    # 全分類 (all 道路分類, not just 国道) is *not* accumulated across meshes
    # here — see classify_clusters_beneath's docstring on why holding every
    # mesh's full classification set at once is the thing that exhausted
    # memory. classify_clusters_beneath re-reads it later, one mesh at a
    # time, from load_classified_raw's on-disk cache instead.
    for mesh in meshes:
        raw = load_kokudo_raw(mesh, refresh)
        filtered = [line for line in raw if line_touches_bbox(line, west, south, east, north)]
        print(f"  {mesh}: {len(filtered)} N13 国道 record(s) inside bbox ({len(raw)} in mesh)")
        kokudo.extend(filtered)
        kokudo_raw.extend(raw)
    print(f"total N13 国道 records in {region}: {len(kokudo)} bbox-filtered, "
          f"{len(kokudo_raw)} mesh-wide")

    our_lines = [
        [(lat, lon) for lon, lat in f["geometry"]["coordinates"]] for f in feats
    ]
    our_grid = build_segment_grid(our_lines)
    n13_grid_raw = build_segment_grid(kokudo_raw)

    # ---- gaps: N13 国道 with nothing of ours nearby -----------------------
    gap_lines = []
    matched = 0
    for line in kokudo:
        mid = line[len(line) // 2]
        d = nearest_segment(mid, our_grid)
        if d is None or d > GAP_THRESHOLD_M:
            gap_lines.append(line)
        else:
            matched += 1
    print(f"\nmatched within {GAP_THRESHOLD_M} m: {matched}/{len(kokudo)}")

    clusters = cluster_gaps(gap_lines)
    total_gap_km = sum(c["km"] for c in clusters)
    print(f"gap clusters: {len(clusters)}, {total_gap_km:.1f} km total")

    cache = load_cache(region)
    corroborated = set(meta["corroborated_refs"])

    print("\n" + "=" * 80)
    print("N13 国道 with nothing of ours within "
          f"{GAP_THRESHOLD_M} m - candidates for TRIAGE.md's "
          "\"OSM 自体に無い\" case")
    print("=" * 80)
    for c in clusters[:20]:
        lat, lon = c["sample"]
        print(f"\n  {c['km']:.2f} km  {len(c['lines']):>3} record(s)  "
              f"sample {lat:.5f},{lon:.5f}")
        if not cache:
            continue
        hits = nearby_osm_ways(cache, out_ids, c["sample"], max(GAP_THRESHOLD_M, 150))
        if hits:
            print(f"    OSM has {len(hits)} way(s) here that we excluded:")
            for wid, t in hits[:3]:
                print(f"      way/{wid} ref={t.get('ref')!r} name={t.get('name')!r} "
                      f"highway={t.get('highway')!r}")
                for why in why_excluded(wid, t, cache, corroborated):
                    print(f"        - {why}")
        else:
            print("    no excluded OSM way here - absent from OSM itself")

    # ---- orphans: our former arcs with no N13 backing nearby --------------
    # Uses n13_grid_raw (mesh-wide, not bbox-filtered) — a single region's
    # own former arcs can still sit near this region's own border, and
    # cutting N13 to the bbox here would reproduce the false "N13 なし" this
    # script now avoids nationally. For cross-region dedup of the same way
    # id, run with region "all" instead — see national_orphan_report.
    former_arcs = [f for f in feats if f["properties"].get("former")]
    arcs = []
    for f in former_arcs:
        coords = [(lat, lon) for lon, lat in f["geometry"]["coordinates"]]
        matched, total, min_dist = coverage_ratio(coords, n13_grid_raw, ORPHAN_THRESHOLD_M)
        arcs.append({"id": f["properties"]["id"], "feature": f, "coords": coords,
                      "matched": matched, "total": total, "min_dist": min_dist})
    candidates = [a for a in arcs if ratio_of(a) < ORPHAN_CANDIDATE_RATIO]
    clusters = cluster_former_arcs(candidates)
    classify_clusters_beneath(clusters, refresh)

    print("\n" + "=" * 80)
    print(f"our former arcs ({len(former_arcs)} total) - {len(clusters)} cluster(s) "
          f"from {len(candidates)} candidate arc(s) (< {ORPHAN_CANDIDATE_RATIO * 100:.0f}% "
          "N13 coverage) - candidates for a stale former flag (地理院地図 may already "
          "show this as 指定解除 outright)")
    print("=" * 80)
    confirmed_clusters = 0
    confirmed_arcs = 0
    for c in clusters:
        lat, lon = c["sample"]
        label = coverage_label(c)
        if c["confirmed"]:
            confirmed_clusters += 1
            confirmed_arcs += len(c["members"])
        print(f"  国道{'・'.join(map(str, c['refs']))}  {c['km']:.2f} km  "
              f"{len(c['members']):>3} arc(s)  {label}  sample {lat:.5f},{lon:.5f}  "
              f"({c['beneath']})")
    if not clusters:
        print("  none")

    print(f"\n{len(clusters)} cluster(s) flagged, from {len(candidates)}/{len(former_arcs)} arc(s)")
    print(f"{confirmed_clusters}/{len(clusters)} cluster(s) mechanically confirmed as "
          f"指定解除 ({confirmed_arcs} arc(s)) — 非国道の N13 分類が "
          f"{CONFIRM_THRESHOLD_M} m 以内の直下にある")


if __name__ == "__main__":
    main()
