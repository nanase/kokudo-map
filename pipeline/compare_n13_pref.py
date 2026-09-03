# /// script
# requires-python = ">=3.12"
# dependencies = ["requests", "pyshp", "shapely>=2.0", "numpy"]
# ///
"""都道府県道について、OSM に無い道を国土数値情報 N13 から探す。

compare_n13.py が国道について答えている問いを、道路分類 都道府県道(rdCtg=2)へ
広げた物である。N13 の読み方、距離の測り方、被覆率の測り方は、あちらから写さずに
そのまま読み込む。写した時点で、検証は検証でなくなる。

年報との突き合わせ(compare_annual_report_pref.py)は、地図が年報より短いことを
言えても、その短さがどこにあるかは言えない。N13 は地理院地図と出どころを共有する
独立した資料で、路線番号は持たないが「ここに都道府県道が在る」ことは示す。だから
「OSM に無い都道府県道」の量を、こちらが測れる唯一の出どころである。

向きは一つだけである。近くに候補が何も無い N13 のレコード、すなわち gap の側で
ある。逆向き(orphan。旧道フラグが古いままの候補)は生成物の `former` を必要と
するので、判定(#98)より後にしか立てられない。

県ごとに分ける方法。N13 のレコードは県を持たないので、way に所属都道府県を
与えているのと同じ N03 の面(prefectures.py)に訊く。両側を同じ面で分けるので、
県別の割合は矩形の食み込みを含まない。

進め方は 1 次メッシュごとである。メッシュ 1 つぶんの N13 を読み、そのメッシュに
触れる候補だけで格子を組む。全国ぶんの N13 を一度に持つと数 GB になるが、
こうすれば持つのは候補の形(約 470 万点)と、メッシュ 1 つぶんだけで済む。

使い方:  uv run pipeline/compare_n13_pref.py [--refresh]
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict

import annual_report
from _paths import SURVEY
from compare_annual_report_pref import is_national
from compare_annual_report import one_timestamp
from compare_n13 import (
    GAP_THRESHOLD_M,
    build_segment_grid,
    coverage_ratio,
    load_mesh,
    mesh_codes_for_bbox,
)
from geo import line_length
from prefectures import Prefectures
from regions import REGIONS

# N13 の道路分類種別コード。1 が国道、2 が都道府県道である。符号の出どころと
# 確かめ方は compare_n13.RDCTG_LABELS にある。
RDCTG_PREFECTURAL = "2"

# 候補をメッシュへ振り分けるとき、その way の bbox をこれだけ広げる。度である。
#
# 広げないと、メッシュの縁で系統的な取りこぼしが出る。縁のすぐ内側にある N13 の
# レコードにとって最も近い候補が、縁のすぐ外で終わっている way だと、その way は
# このメッシュに登録されず、レコードは「候補が無い」と読まれる。誤差は覆えて
# いないほうへしか倒れないので、丸めではなく偏りである。
#
# 0.02 度は約 2.2 km で、判定に使う 100 m より広く、compare_n13 の格子が探る
# 範囲(CELL 0.01 度の 3x3、約 1.1 km)より広い。これだけ広げれば、縁の向こうから
# 見つかりうる候補は全部このメッシュに入る。
MESH_MARGIN_DEG = 0.02


# --------------------------------------------------------------------- 入力 ---
def bbox_of(geometry: list[list[float]]) -> tuple[float, float, float, float]:
    lats = [p[0] for p in geometry]
    lons = [p[1] for p in geometry]
    return min(lats), min(lons), max(lats), max(lons)


def load_candidates() -> tuple[list[list[tuple[float, float]]], set[str],
                              dict[str, list[int]]]:
    """候補の形と、それが触れる 1 次メッシュ。

    国道でもある way は外す。N13 はその区間を 道路分類=国道 として持つので、
    都道府県道のレコードと突き合わせる相手ではない。

    候補に所属県を持たせないのは、県別に分けるのが候補の側ではなく N13 の側
    だからである。N13 のレコードがどの県に在るかを、両側で同じ N03 の面に訊く。
    """
    lines: list[list[tuple[float, float]]] = []
    by_mesh: dict[str, list[int]] = defaultdict(list)
    stamps: set[str] = set()
    for region in REGIONS:
        path = SURVEY / f"{region}.json"
        if not path.exists():
            raise SystemExit(f"{path} is missing; run `mise run survey-pref` first")
        doc = json.loads(path.read_text(encoding="utf-8"))
        stamps.add(doc["timestamp_osm_base"])
        for way in doc["ways"]:
            if not way["refs"] or is_national(way):
                continue
            i = len(lines)
            lines.append([(lat, lon) for lat, lon in way["geometry"]])
            south, west, north, east = bbox_of(way["geometry"])
            m = MESH_MARGIN_DEG
            for mesh in mesh_codes_for_bbox(
                    [west - m, south - m, east + m, north + m]):
                by_mesh[mesh].append(i)
        print(f"  {region:12} {len(lines):8,} lines", flush=True)
    return lines, stamps, by_mesh


# ------------------------------------------------------------------- main ---
def main() -> None:
    args = sys.argv[1:]
    refresh = "--refresh" in args
    if refresh:
        args.remove("--refresh")
    if args:
        raise SystemExit(f"unexpected argument: {args[0]}")

    print("reading build/survey")
    lines, stamps, by_mesh = load_candidates()
    stamp = one_timestamp(stamps)
    print(f"候補 {len(lines):,} 本  データ基準 {stamp}")

    print("\nreading N03 municipal boundaries", flush=True)
    prefs = Prefectures()
    print(f"  {prefs.polygon_count:,} polygons", flush=True)

    # 見るメッシュは、47 の bbox が覆う物と、候補が触れる物の和である。
    # 前者だけでは足りない。東京都の bbox は本土だけなので、三宅島と小笠原の
    # 都道が落ちる。後者だけでも足りない。候補が 1 本も無い所こそ、探している
    # 欠落だからである。
    meshes = set(by_mesh)
    for region in REGIONS:
        south, west, north, east = REGIONS[region]["bbox"]
        meshes.update(mesh_codes_for_bbox([west, south, east, north]))

    # それでも、N03 が陸だと述べるメッシュの全部にはならない。この二つの和は
    # どちらも道のデータから来ているので、道が 1 本も無い島は入らない。分母から
    # 落ちるほうへしか効かない差なので、隠さずに数えて名指しする。
    #
    # 2026-08-30 に実測した。差は 21 メッシュで、沖ノ鳥島・南鳥島・硫黄島・
    # 鳥島などの無人島と北方領土である。KSJ が配っているのはそのうち 8 メッシュ
    # で、都道府県道のレコードは 1 件も無く 0.00 km だった。残る 13 は 404 を
    # 返す。だから今のところ、この差は被覆率を 1 km も動かさない。動き始めたら
    # 下の行がそう述べる。
    land: set[str] = set()
    for west, south, east, north in prefs.bounds:
        land.update(mesh_codes_for_bbox([west, south, east, north]))
    unexamined = sorted(land - meshes)
    meshes = sorted(meshes)
    if unexamined:
        print(f"  N03 が陸だと述べるのに候補も bbox も触れないメッシュ "
              f"{len(unexamined)}: {' '.join(unexamined)}")
        print("    このメッシュの N13 は読まない。分母に入らないので、被覆率は"
              "そのぶん高く出る。")

    n13_km: dict[str, float] = defaultdict(float)
    covered_km: dict[str, float] = defaultdict(float)
    records = 0
    outside = 0.0

    print(f"\n{len(meshes)} meshes, {GAP_THRESHOLD_M} m threshold", flush=True)
    for n, mesh in enumerate(meshes, 1):
        raw = [line for line in load_mesh(mesh, refresh).lines(RDCTG_PREFECTURAL)
               if len(line) >= 2]
        if not raw:
            continue
        records += len(raw)
        grid = build_segment_grid([lines[i] for i in by_mesh.get(mesh, ())])
        assigned = prefs.assign_ways(
            [p[0] for line in raw for p in line],
            [p[1] for line in raw for p in line],
            [len(line) for line in raw])
        for line, a in zip(raw, assigned, strict=True):
            km = line_length(line) / 1000
            if a.region is None:
                outside += km
                continue
            n13_km[a.region] += km
            matched, total, _ = coverage_ratio(line, grid, GAP_THRESHOLD_M)
            covered_km[a.region] += km * (matched / total if total else 0.0)
        print(f"  {n:3}/{len(meshes)} mesh {mesh}  {len(raw):7,} records", flush=True)

    ledger = annual_report.prefectures(11)
    total_n13 = sum(n13_km.values())
    total_cov = sum(covered_km.values())
    if not total_n13:
        raise SystemExit(
            "N13 は都道府県道のレコードを 1 件も返さなかった。build/n13 の"
            "キャッシュが空か、道路分類の符号が変わっている。")

    print("\nN13 都道府県道 と候補の突き合わせ")
    print(f"  N13 のレコード {records:,} 件  {total_n13:,.1f} km")
    print(f"  {GAP_THRESHOLD_M} m 以内に候補がある  {total_cov:,.1f} km "
          f"({total_cov / total_n13:.1%})")
    print(f"  無い                    {total_n13 - total_cov:,.1f} km")
    if outside:
        print(f"  どの県の面にも入らなかった N13 {outside:,.1f} km")

    print("\n県別")
    print(f"  {'県':6} {'N13':>10} {'覆えた':>10} {'割合':>7} {'年報 実延長':>12}")
    rows = []
    for region in REGIONS:
        p = ledger[region]
        n13, cov = n13_km[region], covered_km[region]
        ratio = cov / n13 if n13 else 0.0
        print(f"  {p.name:6} {n13:10,.1f} {cov:10,.1f} {ratio:7.1%} "
              f"{p.km['actual']:12,.1f}")
        rows.append((ratio, p.name, n13, cov))

    print("\n覆えていない割合が大きい県")
    for ratio, name, n13, cov in sorted(rows)[:8]:
        print(f"  {name:6} {ratio:6.1%}  N13 {n13:,.1f} km のうち {cov:,.1f} km")


if __name__ == "__main__":
    main()
