# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""生成物を、既に真だと分かっていることに照らして確かめる。

走った生成物が正しい生成物とは限らない。ここでの断定は、実現可能性の報告に
あった「二重化」の安いほうの半分である。誤った地図を暗黙のうちに作る壊れ方を
捕まえる。
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone

from _paths import CACHE, REGIONS
from expectations import for_region
from regions import REGIONS as REGION_BOXES

region = sys.argv[1] if len(sys.argv) > 1 else "nagano"
expect = for_region(region)
gj = json.loads((REGIONS / f"{region}.geojson").read_text(encoding="utf-8"))
meta = json.loads((REGIONS / f"{region}.meta.json").read_text(encoding="utf-8"))
feats = gj["features"]

fails: list[str] = []
notes: list[str] = []


def check(ok: bool, msg: str) -> None:
    (notes if ok else fails).append(("PASS  " if ok else "FAIL  ") + msg)


# --- 構造の整合性 -----------------------------------------------------------
check(all(f["geometry"]["type"] == "LineString" for f in feats), "all features are LineStrings")
check(all(len(f["geometry"]["coordinates"]) >= 2 for f in feats), "no degenerate geometries")

bad_key = [
    f["properties"]["id"]
    for f in feats
    if f["properties"]["refs"] != "," + ",".join(str(r) for r in f["properties"]["refs_list"]) + ","
]
check(not bad_key, f"refs key matches refs_list ({len(bad_key)} mismatches)")

bad_n = [
    f["properties"]["id"]
    for f in feats
    if f["properties"]["n"] != len(f["properties"]["refs_list"])
]
check(not bad_n, f"n equals the designation count ({len(bad_n)} mismatches)")

sorted_ok = all(f["properties"]["refs_list"] == sorted(f["properties"]["refs_list"]) for f in feats)
check(sorted_ok, "refs_list is sorted ascending")

# --- 所属都道府県 -----------------------------------------------------------
# 生成物には所属県が出てこない。国道の番号は全国で一意なので、地図には
# 不要である。必要なのは都道府県道である。番号は県の中でしか一意でなく、県道18
# 号は 47 本ある。判定がそれを読むより先に、切り出しが正しく書けているかをここで
# 見る。
#
# 「(県, 番号)の組が県内で妥当か」には、ここでは答えられない。国道の生成物はその
# 組を持たない。答えるのは compare_annual_report_pref.py で、県ごとに見つかった
# 番号の数を年報の路線数と突き合わせる。
raw = json.loads((CACHE / f"{region}.raw.json").read_text(encoding="utf-8"))
cache_ways = [o for o in (*raw["core"], *raw["candidates"]) if o["type"] == "way"]

missing_pref = [w["id"] for w in cache_ways if "pref" not in w]
check(not missing_pref,
      f"every way in the cache carries a prefecture ({len(missing_pref)} without)")

unknown_pref = sorted({w["pref"] for w in cache_ways
                       if w.get("pref") is not None and w["pref"] not in REGION_BOXES})
check(not unknown_pref, f"every prefecture is a known region name ({unknown_pref})")

# `prefs` を持つのは県境を跨いだ way だけで、その先頭は `pref` と同じである
# (prefectures.write_pref)。1 つしか持たない `prefs` は、同じことを
# 二度述べている。
bad_prefs = [w["id"] for w in cache_ways if "prefs" in w
             and (len(w["prefs"]) < 2 or w["prefs"][0] != w.get("pref")
                  or any(p not in REGION_BOXES for p in w["prefs"]))]
check(not bad_prefs,
      f"prefs lists two or more known regions, led by pref ({len(bad_prefs)} broken)")


def boxes_touch(one, other) -> bool:
    """二つの bbox が重なるか。順は南・西・北・東である。"""
    return not (one[2] < other[0] or one[0] > other[2]
                or one[3] < other[1] or one[1] > other[3])


# 面の索引が壊れれば、長野県の切り出しに沖縄県の way が現れる。この地域の矩形に
# 触れる県の集合を超えた所属は、そういう壊れ方でしか出ない。
#
# 主たる所属だけでなく、跨いだ先も見る。`pref` が長野で `prefs` が長野と沖縄と
# いう way は、上の三つの検査をすべて通ってしまう。跨いだ先も所属であり、後の段
# はそれを読む。
touching = {r for r, spec in REGION_BOXES.items()
            if boxes_touch(spec["bbox"], REGION_BOXES[region]["bbox"])}
claimed = {p for w in cache_ways for p in (w.get("prefs") or [w.get("pref")]) if p}
stray = sorted(claimed - touching)
check(not stray, f"prefectures found are ones this bbox can touch ({stray})")

own = sum(1 for w in cache_ways if w.get("pref") == region)
crossing = sum(1 for w in cache_ways if "prefs" in w)
homeless = sum(1 for w in cache_ways if w.get("pref") is None)
print(f"NOTE  cache ways {len(cache_ways):,}: {own:,} in {region}, "
      f"{crossing:,} crossing a boundary, {homeless:,} with no prefecture")

# --- 区切り文字の工夫が、部分文字列の衝突を実際に防いでいるか --------------
# 4 号は、14・24・40・400 号しか持たないアークに当たってはならない。
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

# 絞り込みの述語を、路線ごとに正典の一覧と突き合わせる。
mismatch = 0
for r in [f["ref"] for f in meta["routes"]]:
    by_key = sum(1 for f in feats if matches(f, r))
    by_list = sum(1 for f in feats if r in f["properties"]["refs_list"])
    if by_key != by_list:
        mismatch += 1
check(
    not mismatch,
    f"key-based filter agrees with list membership for all {len(meta['routes'])} routes",
)

# --- 独立に分かっている、この分野の事実 ------------------------------------
label = meta.get("label", region)
refs_present = {f["ref"] for f in meta["routes"]}

for r in expect["present"]:
    check(r in refs_present, f"route {r} is present (known to run through {label})")

invalid = refs_present - (
    (set(range(1, 59)) | set(range(101, 508))) - {109, 110, 111, 214, 215, 216}
)
check(not invalid, f"no impossible route numbers ({sorted(invalid)})")

# 番号の漏れが再発しないための見張り。この路線はどれも地域の近くを走らないので、
# 出てきたなら、数字だけの `ref` か誤った名称を裏取り無しで信じたことになる。
for r, where in expect["absent"]:
    check(r not in refs_present, f"route {r} ({where}) is absent from {label}")

# その事例の背後にある一般則。路線が出てよいのは、その番号を保証する国道リレー
# ションが地域の中に在るときだけである。
uncorroborated = refs_present - set(meta["corroborated_refs"])
check(
    not uncorroborated,
    f"every route present is corroborated by a relation ({sorted(uncorroborated)})",
)

# さらにその背後にある一般則。保証する集合は地域ぶんである。一般国道の番号は
# 1〜58 と 101〜507 から、廃止された 6 つの番号を除いた 459 個である。全国で
# まとめて判定するとそのすべてがどこかで保証され、裏取りは何も濾さなくなり、
# 長野県道372号がふたたび国道372号になる。裏取りが裏取りでいられるのは、この集合
# が小さいあいだだけである。47 都道府県で測ると最大でも 459 の三分の一を大きく
# 下回る。しきい値はその計測から決めてあり、好みで決めた物ではない。
corroborated = set(meta["corroborated_refs"])
check(len(corroborated) < 153,
      f"the corroborated set is regional, not national "
      f"({len(corroborated)} of 459 possible numbers)")

# 裏取りがこの地域で実際に捨てた物。数字だけの `ref` は都道府県道も
# 使う書式なので、実在するどの県でもここは空にならない。
rejected = meta.get("rejected_refs", {})
print(f"NOTE  corroborated {len(corroborated)} numbers; rejected "
      f"{len(rejected)} uncorroborated ref tokens "
      f"({sum(rejected.values())} ways)")

# 判定の根拠は記録されていなければならない。指定がどこから来たかを
# 地図が述べるためである。
srcs = Counter(f["properties"]["src"] for f in feats)
check(set(srcs) <= {"relation", "name", "tag"}, f"arc sources are known values ({dict(srcs)})")
check(srcs.get("relation", 0) > 0, f"relations admitted arcs ({srcs.get('relation', 0)})")
print(f"NOTE  rule (c) recovered {srcs.get('tag', 0)} relation-less arcs, "
      f"names admitted {srcs.get('name', 0)}")

# 旧道の区間は残す(地理院地図も指定解除まで国道として描く)が、見分けが付く
# ようフラグを立てねばならない。1 本も持たない地域が在っても正当である。
#
# is_former() は `historic:highway` にも反応する(RULES.md 旧道)。出力の形は
# そのタグを持たないので、名前が旧道のアークは `former` と一致するのではなく、
# その部分集合でなければならない。way/152895667 が `historic:highway` だけで
# 通るようになった日に、一致を求める検査は破れた(CASES.md 21)。
former = [f for f in feats if f["properties"].get("former")]
former_ids = {f["properties"]["id"] for f in former}
named_former = [f for f in feats if re.search(r"旧道|廃道|旧国道", f["properties"]["name"] or "")]
missing = [f["properties"]["id"] for f in named_former if f["properties"]["id"] not in former_ids]
check(not missing, f"every 旧道-named arc carries the former flag ({len(missing)} missing)")
check(all(f["properties"]["refs_list"] for f in former),
      f"former arcs still carry their designation ({len(former)} arcs)")

# revoked(issue #9)は former とは独立だが、former より広くなることは無い。
# apply_n13.py が revoked=1 を立てるのは、既に former のアークだけである。
revoked_not_former = [
    f["properties"]["id"] for f in feats
    if f["properties"].get("revoked") and not f["properties"].get("former")
]
check(not revoked_not_former,
      f"revoked arcs are a subset of former ({len(revoked_not_former)} counterexamples)")

# 新しさは記録されていなければならず、データが気付かれないまま古びていても
# ならない。
check(
    bool(meta.get("osm_timestamp")),
    f"OSM data timestamp is recorded ({meta.get('osm_timestamp')})",
)
if meta.get("osm_timestamp"):
    age_days = (
        datetime.now(timezone.utc)
        - datetime.fromisoformat(meta["osm_timestamp"].replace("Z", "+00:00"))
    ).days
    check(age_days <= 7, f"OSM data is {age_days} days old (threshold 7)")

# 名前を持ち、在って指定もされていなければならない道。長野南バイパスは、無いと
# 報告のあった事例である。国道19号で、開通から数十年経つのに、どのルートリレー
# ションにも入っていない。
for name, ref in expect["named"]:
    hits = [f for f in feats if (f["properties"]["name"] or "") == name]
    check(len(hits) > 0, f"{name} is present ({len(hits)} arcs)")
    check(all(ref in f["properties"]["refs_list"] for f in hits),
          f"{name} is designated 国道{ref}号")

# ある区分のアークを必ず持つ路線。徒歩道としてしか存在しない点線国道など。
master = {r["ref"]: r for r in meta["routes"]}
for ref, kinds in expect["kinds"].items():
    entry = master.get(ref)
    check(entry is not None, f"route {ref} has a master entry")
    if not entry:
        continue
    for k in kinds:
        check(entry["kinds"].get(k, 0) > 0,
              f"route {ref} has {k} arcs ({entry['kinds'].get(k, 0)})")

# 重用は在らねばならず、対称に記録されていなければならない。アークが {18,117}
# と述べるなら、18 も 117 も max_n が 2 以上でなければならない。
asym = 0
for f in feats:
    p = f["properties"]
    for r in p["refs_list"]:
        if master[r]["max_n"] < p["n"]:
            asym += 1
check(not asym, f"per-route max_n covers every arc it appears on ({asym} violations)")

n2 = sum(1 for f in feats if f["properties"]["n"] >= 2)
check(n2 > 0, f"concurrent arcs found: {n2}")
# 三重用が在ることは全国についての事実であって、県ごとの事実ではない。香川県と
# 沖縄県に三重用が無くてよい。より深い重なりは、それが本当に分かる結合後のデータ
# に対して verify_national.py が断定する。
ranking = meta["concurrency_ranking"]
check(bool(ranking) and ranking[0]["n"] >= 2,
      f"ranking is sorted by concurrency depth (top n={ranking[0]['n'] if ranking else 0})")
check(all(ranking[i]["n"] >= ranking[i + 1]["n"] for i in range(len(ranking) - 1)),
      "ranking is ordered deepest first")

# 延長の帳尻。路線ごとの km を足すと重用が二重に数えられるが、その量はアークが
# 述べるとおりでなければならない。
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
