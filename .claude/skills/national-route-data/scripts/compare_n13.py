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

Both directions reuse the same grid: a region's own arcs are short OSM ways,
N13 records are shorter still (cut at every attribute change, not just every
junction), so nearest-*segment* distance is measured with a local
equirectangular projection rather than nearest-vertex — vertex spacing on
either side would otherwise read as false disagreement.

Distances are not proof. A gap can be a real absence, an OSM tagging exclusion
(check `why` — reused from audit.py's exclusion reasoning), or two independent
digitisations of the same painted line. Only a human with 地理院地図 open
decides which, and which route number applies — TRIAGE.md's "N13 は路線番号を
持たないので…ここが人の出番です" is the load-bearing sentence in this file.

Usage:  uv run scripts/compare_n13.py [region] [--refresh]

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


def ensure_mesh(mesh: str, refresh: bool) -> Path:
    """Download and unzip one mesh's SHP bundle if not already cached."""
    out_dir = N13 / mesh
    shp = out_dir / f"N13-24_{mesh}_SHP" / f"N13-24_{mesh}.shp"
    if shp.exists() and not refresh:
        return shp
    out_dir.mkdir(parents=True, exist_ok=True)
    url = f"{BASE_URL}/N13-24_{mesh}_SHP.zip"
    print(f"  downloading {url}", flush=True)
    r = requests.get(url, headers=UA, timeout=120)
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


def load_kokudo(mesh: str, bbox: list[float], refresh: bool) -> list[list[tuple[float, float]]]:
    """This mesh's 国道-classified records as (lat, lon) point lists, kept
    only if inside the region's bbox (meshes routinely spill past it — see
    regions.py on rectangles spilling into neighbours)."""
    cache_path = N13 / f"{mesh}.kokudo.json"
    if cache_path.exists() and not refresh:
        return json.loads(cache_path.read_text(encoding="utf-8"))

    shp_path = ensure_mesh(mesh, refresh)
    west, south, east, north = bbox
    sf = shapefile.Reader(str(shp_path), encoding="utf-8")
    out: list[list[tuple[float, float]]] = []
    for i, rec in enumerate(sf.iterRecords()):
        if rec[RDCTG_FIELD] != RDCTG_KOKUDO:
            continue
        pts = sf.shape(i).points
        # A record with any point inside the bbox is kept whole (not clipped)
        # — a midpoint-only test would drop a record that straddles the
        # boundary even though part of it is inside. Records are 2-3 points
        # (see module docstring), so the sliver a kept-whole record adds
        # outside the bbox is a few tens of metres at most.
        if not any(west <= lon <= east and south <= lat <= north for lon, lat in pts):
            continue
        out.append([(lat, lon) for lon, lat in pts])
    N13.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(out), encoding="utf-8")
    return out


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


# --------------------------------------------------------------- clustering --
def node_key(pt):
    return (round(pt[0], 6), round(pt[1], 6))


def cluster_gaps(gap_lines: list[list[tuple[float, float]]]):
    """Merge gap records that share an endpoint — N13 cuts a continuous road
    into many short records at every attribute change, so one real gap is
    routinely dozens of consecutive records, not one."""
    dsu = DSU()
    for line in gap_lines:
        a, b = node_key(line[0]), node_key(line[-1])
        dsu.union(a, b)
    groups: dict = {}
    for line in gap_lines:
        root = dsu.find(node_key(line[0]))
        groups.setdefault(root, []).append(line)
    clusters = []
    for lines in groups.values():
        km = sum(haversine(l[i], l[i + 1]) for l in lines for i in range(len(l) - 1)) / 1000
        mid_line = lines[len(lines) // 2]
        clusters.append({"lines": lines, "km": km, "sample": mid_line[len(mid_line) // 2]})
    return sorted(clusters, key=lambda c: -c["km"])


# ------------------------------------------------------------------- report --
# Calibrated against mesh 5438 (長野県中心部): point-to-vertex distances came
# back with a 6.6 m median and a 31.6 m 90th percentile against N13's own
# claimed 25 m positional stddev. Point-to-segment tightens that further.
# 100 m gives real digitisation slack on both sides room without hiding a
# short missing link the way audit.py's own 50 m/2 km split would.
GAP_THRESHOLD_M = 100
ORPHAN_THRESHOLD_M = 100


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


def main() -> None:
    # Windows terminals default stdout to cp932, which lacks glyphs this
    # script prints (em dash, 一部の記号). build_all.py hits the same wall.
    sys.stdout.reconfigure(errors="replace")
    args = [a for a in sys.argv[1:] if a != "--refresh"]
    refresh = "--refresh" in sys.argv[1:]
    region = args[0] if args else "nagano"

    meta = json.loads((DATA / f"{region}.meta.json").read_text(encoding="utf-8"))
    gj = json.loads((DATA / f"{region}.geojson").read_text(encoding="utf-8"))
    bbox = meta["bbox"]
    feats = gj["features"]
    out_ids = {f["properties"]["id"] for f in feats}

    meshes = mesh_codes_for_bbox(bbox)
    print(f"{region}: bbox {bbox} -> {len(meshes)} mesh(es): {', '.join(meshes)}")

    kokudo: list[list[tuple[float, float]]] = []
    for mesh in meshes:
        recs = load_kokudo(mesh, bbox, refresh)
        print(f"  {mesh}: {len(recs)} N13 国道 record(s) inside bbox")
        kokudo.extend(recs)
    print(f"total N13 国道 records in {region}: {len(kokudo)}")

    our_lines = [
        [(lat, lon) for lon, lat in f["geometry"]["coordinates"]] for f in feats
    ]
    our_grid = build_segment_grid(our_lines)
    n13_grid = build_segment_grid(kokudo)

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
    former_arcs = [f for f in feats if f["properties"].get("former")]
    orphans = []
    for f in former_arcs:
        coords = [(lat, lon) for lon, lat in f["geometry"]["coordinates"]]
        mid = coords[len(coords) // 2]
        d = nearest_segment(mid, n13_grid)
        if d is None or d > ORPHAN_THRESHOLD_M:
            orphans.append((f, d))

    print("\n" + "=" * 80)
    print(f"our former arcs ({len(former_arcs)} total) with no N13 国道 within "
          f"{ORPHAN_THRESHOLD_M} m - candidates for a stale former flag "
          "(地理院地図 may already show this as 指定解除 outright)")
    print("=" * 80)
    for f, d in sorted(orphans, key=lambda x: -(x[0]["properties"]["km"]))[:20]:
        p = f["properties"]
        dist = "no N13 nearby at all" if d is None else f"nearest N13 国道 {d:.0f} m away"
        print(f"  way/{p['id']}  国道{'・'.join(map(str, p['refs_list']))}  "
              f"{p['km']} km  {p.get('name') or ''}  ({dist})")
    if not orphans:
        print("  none")

    print(f"\n{len(orphans)}/{len(former_arcs)} former arcs flagged")


if __name__ == "__main__":
    main()
