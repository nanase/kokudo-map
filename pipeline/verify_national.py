# /// script
# requires-python = ">=3.12"
# dependencies = ["pmtiles>=3.4"]
# ///
"""結合後の全国の生成物を検査する。地域では答えられない二つの問いである。

verify.py が見るのは一度に 1 つの矩形である。だから二つのことが見えない。地図が
全国を覆うようになると、効いてくるのはその二つである。

  番号が国の反対側へ漏れていないか
      裏取りは設計として地域ごとである(build_routes.py)。それが切れ味を保って
      いるが、同時に、国道372号が兵庫県(本来の場所)と長野県の両方に出たことを、
      地域ごとの実行では誰も見られないという意味でもある。長野県に出た実例は
      CASES.md 1 にある。見られるのは結合後のデータだけで、路線ごとにアークが
      実際にどこに在るかを訊いて確かめる。

  ブラウザが落としてくる物は、こちらが作った物か
      地域ごとの検査が通るのは、もう配っていない GeoJSON に対してである。ここで
      アーカイブを開いて読み戻す。

使い方:  uv run pipeline/verify_national.py
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter
from itertools import combinations
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

# --- 集計は帳尻が合わねばならない。画面はもうそれしか出さない --------------
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

# --- 延長の内訳も、その延長に足し合わねばならない --------------------------
# 「国道152号のうち走れるのはどれだけか」には、走れる区分を足し、残りを外して
# 答える。だから内訳が自分の延長に届かない行は、精度が粗いのではなく誤って
# 答える。語彙はここで定義し直さない。行が名指しできる区分は、地域ごとの生成物が
# アークを分類した先である。
KINDS = {k for m in metas for r in m["routes"] for k in r["kinds"]}
kinds_of = {k for c in combos for k in c.get("kinds", {})}

check(all("kinds" in c for c in combos), "every combination carries a kind breakdown")
check(kinds_of <= KINDS,
      f"the breakdown names only kinds the build produces ({sorted(kinds_of - KINDS)})")
empty = [c["refs"] for c in combos if any(v <= 0 for v in c.get("kinds", {}).values())]
check(not empty, f"no kind is written out at zero length ({empty[:3]})")

# 内訳はそれぞれ 10 m 単位に丸め、5 m 未満は落とすので、七つの区分を持つ行は
# 自分の合計から 40 m ずれうる。それを超えるずれは、アークが誤った区分に数え
# られたか、どこにも数えられなかったかである。
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

# 旧道は区分ではなく、同じ道に対する二つ目の軸である(#26)。だから行に足すのでは
# なく、行に収まることを見る。延長より旧道のほうが長い行は、どこかで二つの軸が
# 一つに畳まれた印である。
over = [c["refs"] for c in combos if c.get("former_km", 0) > c["km"] + 0.01]
check(not over, f"no combination is more 旧道 than it is long ({over[:3]})")
former_km = sum(c.get("former_km", 0) for c in combos)
check(0 < former_km < meta["total_km"],
      f"旧道 is part of the total and not all of it ({former_km:,.1f} km)")

invalid = set(routes) - VALID
check(not invalid, f"no impossible route numbers ({sorted(invalid)})")

# 全国には新潟市の六重用があり、路線番号は 507 まである。どちらも 1 つの県に
# ついては成り立たないので、断定する場所はここである。
check(combos[0]["n"] >= 6,
      f"the deepest concurrency in Japan is {combos[0]['n']}x {combos[0]['refs']}")
check(len(routes) >= 400, f"most of the 459 route numbers are on the map ({len(routes)})")

# --- 路線がどこに在るか。CASES.md 1 と 2 を見られる唯一の検査 --------------
# 路線の広がりは、その路線が現れる組み合わせの広がりの和である。遠くの県へ漏れた
# 番号があれば、その範囲は一気に広がる。
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

# --- 裏取りが地域ごとのままか ----------------------------------------------
# 取得を全国にしたときに判定まで一緒に全国へ移っていたなら、それが現れるのはここ
# である。保証された集合がどれも 459 に近づく。
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

# --- どこかに在る路線は、そこで保証されている ------------------------------
vouched = {r for m in metas for r in m["corroborated_refs"]}
check(set(routes) <= vouched,
      f"every route on the map is vouched for by some region ({sorted(set(routes) - vouched)})")

# --- 政令自身の起終点 ------------------------------------------------------
# 別表は決まった一覧である。一般国道 1 路線につき 1 行、計 459 行で、その
# 一覧のままであることがこの欄の眼目である。行に載る座標が作られることは無い。
# decree.py が返してよいのは、その路線が既に持っている端点だけである。その主張は
# 信用せずここで確かめる。「座標から路線のアークまでの距離」が 0 になるのは、
# そのためである。
decree = meta["decree"]
rows = decree["routes"]
refs = [r["ref"] for r in rows]
check(len(rows) == 459, f"the decree table has all 459 routes ({len(rows)})")
check(len(set(refs)) == len(refs),
      f"no route appears twice in the decree table ({len(refs) - len(set(refs))} repeats)")
check(set(refs) == VALID,
      f"the decree's route numbers are the general national ones "
      f"({sorted(set(refs) ^ VALID)})")

LOCATED = {"sole", "junction", "farthest"}
UNLOCATED = {"no-boundary", "no-endpoint", "ring"}
sides = [(r["ref"], s) for r in rows for s in (r["start"], r["end"])]
check(all(s["name"] for _, s in sides), "every decree terminus keeps its place name")
check(all(s["how"] in LOCATED | UNLOCATED for _, s in sides),
      "every decree terminus says how it was located")
mismatched = [ref for ref, s in sides if ("lat" in s) != (s["how"] in LOCATED)]
check(not mismatched,
      f"a decree terminus has a coordinate exactly when it was located "
      f"({sorted(set(mismatched))})")

own = {(t["ref"], t["lat"], t["lon"]) for t in meta["termini"]}
stray = [ref for ref, s in sides
         if "lat" in s and (ref, s["lat"], s["lon"]) not in own]
check(not stray,
      f"every decree coordinate is one of that route's own endpoints, so it sits "
      f"on the route's arcs ({sorted(set(stray))})")

located = sum(1 for _, s in sides if "lat" in s)
both = sum(1 for r in rows if "lat" in r["start"] and "lat" in r["end"])
print(f"NOTE  decree termini located {located}/{len(sides)}, "
      f"both ends on {both}/{len(rows)} routes; "
      + ", ".join(f"{k} {sum(1 for _, s in sides if s['how'] == k)}"
                  for k in sorted(LOCATED | UNLOCATED)))

# --- 交差する路線 ----------------------------------------------------------
# 詳細パネルは、画面に出ている路線がどの路線と出会うかを述べるのにこれを読む。
# 生成物の中でこれに反論できる物は無い。交差の表はこれ 1 つだからである。
# 確かめられるのは、これが交差の表であり続けることである。1 行に別々の実在する
# 路線番号が二つ、同じ行は一度だけ、そしてアークを共有する組は決して入らない。
# 最後の一つが、この表が引こうとしている区別そのものである。同じアークに載る組は
# 重用であり、それは組み合わせ表が既に持ち、パネルも別の節で出している。両方に
# 出る行は、同じ事実を、食い違いうる二箇所で二度述べることになる。
crossings = meta.get("crossings", [])
check(bool(crossings), f"the crossing table is present and not empty ({len(crossings)} pairs)")
check(all(len(p) == 2 and p[0] < p[1] for p in crossings),
      "every crossing row is a sorted pair of two distinct routes")
unknown = sorted({r for p in crossings for r in p} - set(routes))
check(not unknown, f"every crossing names a route the map draws ({unknown})")
repeats = len(crossings) - len({tuple(p) for p in crossings})
check(not repeats, f"each crossing pair appears once ({repeats} duplicates)")

concurrent_pairs = {
    (a, b) for c in combos for a, b in combinations(c["refs"], 2)
}
both = sorted({tuple(p) for p in crossings} & concurrent_pairs)
check(not both,
      f"no pair is both concurrent and crossing ({len(both)}: {both[:5]})")
crossing_routes = {r for p in crossings for r in p}
print(f"NOTE  crossings {len(crossings):,} pairs over {len(crossing_routes)} routes; "
      f"concurrent pairs {len(concurrent_pairs):,}")

# --- 新しさ ----------------------------------------------------------------
check(
    bool(meta.get("osm_timestamp")),
    f"OSM data timestamp is recorded ({meta.get('osm_timestamp')})",
)
if meta.get("osm_timestamp"):
    age = (datetime.now(timezone.utc)
           - datetime.fromisoformat(meta["osm_timestamp"].replace("Z", "+00:00"))).days
    check(age <= 7, f"OSM data is {age} days old (threshold 7)")

# --- ブラウザが落としてくるアーカイブ --------------------------------------
# アーカイブの何箇所にタイルを求めるか。読み戻して何も無いアーカイブを捕まえる
# だけなら 1 箇所で足りるが、索引の中に散らした数箇所を訊けば、隣り合っていない
# タイルも見つけられることまで言える。
PROBES = 5


def tile_at(z: int, lat: float, lon: float) -> tuple[int, int]:
    """その点を覆うタイルを、アーカイブ自身の番号で返す。"""
    n = 2**z
    rad = math.radians(lat)
    return (
        int((lon + 180) / 360 * n),
        int((1 - math.log(math.tan(rad) + 1 / math.cos(rad)) / math.pi) / 2 * n),
    )


path = DATA / "national-routes.pmtiles"
check(path.exists(), f"{path.name} exists")
if path.exists():
    # 最も深いズームのタイルが実際に返ってこなければ、ヘッダがどれだけ妥当でも
    # 地図には何も描かれない。訊く場所は起終点、つまり道そのものの上の点である。
    # かつては全国の外接矩形の中心(北緯 34.93 度、東経 134.87 度、播磨灘の海上)
    # を訊いていた。z14 のタイルは 2.4 km 四方なので、国道が 1 本も無い正方形を
    # 求めていたことになる。空のタイルは設計としてアーカイブに入らないので、
    # 正しいアーカイブに対して検査が落ちていた。
    #
    # 先頭と末尾を必ず含む等間隔の 5 点。等間隔だけを見て末尾を落とすと、途中で
    # 切れたアーカイブが検査を素通りする。末尾は最後に書かれる場所なので、書き
    # きれなかったときに最初に欠ける。全国の 5,706 点では 0・1426・2852・4279・
    # 5705 番目を引く(3 点目は 2852.5 で、round() が偶数側へ丸める)。
    termini = meta["termini"]
    if PROBES < 2 or len(termini) <= PROBES:
        probes = termini[:PROBES]
    else:
        last = len(termini) - 1
        probes = [termini[round(i * last / (PROBES - 1))] for i in range(PROBES)]
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
