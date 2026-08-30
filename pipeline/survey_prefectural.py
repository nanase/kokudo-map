# /// script
# requires-python = ">=3.12"
# dependencies = ["osmium>=4.0", "pyshp", "requests", "shapely>=2.0"]
# ///
"""都道府県道になりうる way を全国から一度だけ測り、県ごとに書き出す。

これは判定(issue #98)ではない。判定より先に立てる検証の土台である。判定が
終わってから検証を作ると、判定に合わせた検証になる。だからここは、判定が何を
選ぶかを知らないまま、OSM が持っている物をそのまま測る。

`build/cache` では足りない。あちらが運ぶ way は国道のリレーションのメンバーと
国道の候補で、都道府県道の候補(primary・secondary で数字の `ref`)は入っていない
——それを入れるのは #98 の仕事である。都道府県道のリレーションについても、
`competing_relations` が持つのはメンバーの id だけで、形は持たない。長さを測る
には形が要る。

だから pbf をもう一度読む。読むのは一度きりで、結果は `build/survey/` に残る。
突き合わせ(compare_annual_report_pref.py と compare_n13_pref.py)はそちらを読む
ので、突き合わせを何度やり直しても pbf は読み直さない。

## 何を残すか

  1. `highway` が primary・secondary(と、その _link・construction)で、数字だけの
     `ref` を持つ way。#98 が候補にする集合を含む
  2. `network=JP:prefectural` のルートリレーションが抱える way。国道と重用する
     区間は、way 自身のタグには何も残らない——OSM は `highway=trunk`・
     `ref=国道番号` で描く——ので、リレーションだけが根拠である

1 と 2 の和を残す。1 だけでは重用が測れず、2 だけではリレーションの無い路線が
丸ごと落ちる。

所属都道府県は prefectures.py が N03 の行政区域の面で決める。番号は県の中でしか
一意でないので、(県, 番号)の組が路線の同一性である。

長さは geo.py が測る。区分(road・construction・ferry など)と旧道の判定は
build_routes.py の物をそのまま読む。道の状態についての問いは、国道でも都道府県道
でも同じ問いだからである。

## 番号の読み方

`build_routes.tokens()` は使えない。あれは一般国道の 459 番だけを通す。
都道府県道の番号はその外にも実在する(北海道道759号、兵庫県道432号)ので、ここは
数字だけを見る。上限も置かない。置けば、置いた値そのものが判定になってしまう。

使い方:  uv run pipeline/survey_prefectural.py
         uv run pipeline/survey_prefectural.py --pbf path/to/japan-latest.osm.pbf
"""
from __future__ import annotations

import json
import sys
from array import array
from datetime import datetime, timezone

import osmium

from _paths import PBF, SURVEY
from build_routes import classify, is_former
from extract_pbf import (
    is_candidate,
    is_national_relation,
    kept_tags,
    pass_relations,
    read_header,
)
from geo import line_length
from prefectures import Prefectures, report
from regions import REGIONS

# 都道府県道の候補になる道の格。#98 の候補は primary と secondary である。
# _link と construction も残すのは、判定に加えるためではなく、年報との差の内訳で
# 「ランプ・連結路」と「工事中」がいくらあるかを測るためである。測らずに外すと、
# その量は説明できない残りへ紛れ込む。
PREFECTURAL_GRADES = frozenset({"primary", "secondary"})

PREFECTURAL_NETWORK = "JP:prefectural"


def numbers(ref: str | None) -> list[int]:
    """`ref` に入っている都道府県道の番号。トークンごとに読む。

    `ref=18;30` は二つの指定であって 1 つの文字列ではない。値の全体で照合すると
    重用区間が消える。build_routes.tokens() と同じ理由で同じ形にするが、通す番号
    の集合は違う——あちらは一般国道の 459 番だけを通す。
    """
    out = []
    for tok in (ref or "").split(";"):
        tok = tok.strip()
        if tok.isdigit() and int(tok) > 0:
            out.append(int(tok))
    return sorted(set(out))


def grade_of(tags: dict[str, str]) -> tuple[str | None, bool]:
    """その way の実質的な格と、連結路かどうか。

    工事中の way は `highway=construction`・`construction=secondary` の形を取る
    ので、格は `construction` の側にある。
    """
    hw = tags.get("highway") or ""
    if hw == "construction":
        hw = tags.get("construction") or ""
    link = hw.endswith("_link")
    base = hw.removesuffix("_link")
    return (base if base in PREFECTURAL_GRADES else None), link


def is_prefectural_relation(tags: dict[str, str]) -> bool:
    return (tags.get("network") or "").startswith(PREFECTURAL_NETWORK)


def relation_numbers(rels: dict[int, dict], prefectural: list[int]) -> dict[int, list[int]]:
    """都道府県道のリレーションごとの路線番号。親から継承する。

    バイパスや支線のリレーションは `ref` を持たないことがある。番号は、それを
    メンバーとして抱える親から来るしかない。build_routes.resolve_relation_routes
    と同じ考え方だが、あちらは国道番号だけを通すので、ここでは使えない。
    """
    own = {rid: numbers(rels[rid]["tags"].get("ref")) for rid in prefectural}
    members = {rid: [m["ref"] for m in rels[rid]["members"] if m["type"] == "relation"]
               for rid in prefectural}
    # 親から子へ配る。実測では 2 周で落ち着く。落ち着かないまま打ち切ると、番号を
    # 継承しそこねた子が黙って残るので、その場合は報告する。
    rounds = 8
    for _ in range(rounds):
        changed = False
        for rid in prefectural:
            for kid in members[rid]:
                if kid in own and not set(own[rid]) <= set(own[kid]):
                    own[kid] = sorted(set(own[kid]) | set(own[rid]))
                    changed = True
        if not changed:
            break
    else:
        print(f"  WARNING: relation numbers did not settle in {rounds} rounds; "
              f"some child relations may be missing an inherited number", flush=True)
    return own


class Ways:
    """全国ぶんの way の形を、ノードごとの Python オブジェクトを作らずに持つ。

    extract_pbf.Ways と同じ理由で同じ形にしてあるが、あちらは bbox を持ち、
    こちらは長さを持つ。残す way も相手も違うので、共有すると両方が要らない物を
    運ぶことになる。
    """

    def __init__(self) -> None:
        self.order: list[int] = []
        self.lat = array("d")
        self.lon = array("d")
        self.start: dict[int, int] = {}
        self.count: dict[int, int] = {}
        self.tags: dict[int, dict[str, str]] = {}

    def add(self, wid: int, tags: dict[str, str], pts: list[tuple[float, float]]) -> None:
        self.order.append(wid)
        self.start[wid] = len(self.lat)
        self.count[wid] = len(pts)
        self.tags[wid] = tags
        self.lat.extend(p[0] for p in pts)
        self.lon.extend(p[1] for p in pts)

    def points(self, wid: int) -> list[tuple[float, float]]:
        i, n = self.start[wid], self.count[wid]
        return [(self.lat[j], self.lon[j]) for j in range(i, i + n)]


def pass_ways(path: str, wanted: set[int], index: str) -> Ways:
    """候補と、都道府県道のリレーションが抱える way の形。"""
    ways = Ways()
    print("  pass: way geometry", flush=True)
    proc = (
        osmium.FileProcessor(
            path, osmium.osm.osm_entity_bits.NODE | osmium.osm.osm_entity_bits.WAY
        )
        .with_locations(index)
        .with_filter(osmium.filter.EntityFilter(osmium.osm.osm_entity_bits.WAY))
    )
    seen = 0
    for o in proc:
        seen += 1
        if seen % 5_000_000 == 0:
            print(f"    {seen:,} ways scanned, {len(ways.order):,} kept", flush=True)
        keep = o.id in wanted
        if not keep and "highway" not in o.tags:
            continue
        tags = kept_tags(o.tags)
        if not keep:
            grade, _ = grade_of(tags)
            keep = grade is not None and bool(numbers(tags.get("ref")))
        if not keep:
            continue
        try:
            pts = [(n.location.lat, n.location.lon) for n in o.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            continue
        if len(pts) < 2:
            continue
        ways.add(o.id, tags, pts)
    return ways


def main() -> None:
    args = sys.argv[1:]
    path = str(PBF / "japan-latest.osm.pbf")
    node_index = "flex_mem"

    def take(flag: str, current: str) -> str:
        nonlocal args
        if flag not in args:
            return current
        i = args.index(flag)
        if i + 1 >= len(args) or args[i + 1].startswith("--"):
            raise SystemExit(f"{flag} needs a value")
        value = args[i + 1]
        args = args[:i] + args[i + 2:]
        return value

    path = take("--pbf", path)
    node_index = take("--index", node_index)
    if args:
        raise SystemExit(f"unexpected argument: {args[0]}")

    base_ts = read_header(path)
    print(f"pbf: {path}")
    print(f"data base: {base_ts}")

    rels, _ = pass_relations(path)
    prefectural = [rid for rid, r in rels.items() if is_prefectural_relation(r["tags"])]
    national = [rid for rid, r in rels.items() if is_national_relation(r["tags"])]
    rel_refs = relation_numbers(rels, prefectural)
    numberless = sum(1 for rid in prefectural if not rel_refs[rid])
    print(f"  prefectural route relations: {len(prefectural):,} "
          f"({numberless:,} carry no number even after inheriting)")

    claimed: dict[int, set[int]] = {}
    for rid in prefectural:
        for m in rels[rid]["members"]:
            if m["type"] == "way":
                claimed.setdefault(m["ref"], set()).update(rel_refs[rid])
    national_ways = {m["ref"] for rid in national for m in rels[rid]["members"]
                     if m["type"] == "way"}
    print(f"  ways held by a prefectural relation: {len(claimed):,}")
    print(f"  ways held by a national relation:    {len(national_ways):,}")

    ways = pass_ways(path, set(claimed), node_index)
    print(f"  ways kept: {len(ways.order):,}  coordinates: {len(ways.lat):,}")

    # 所属都道府県。ノードの位置の索引を手放した後に読む。全国のノード位置は数 GB
    # を占め、行政区域の面はさらに 0.7 GB 要る。二つを同時に持つ必要は無い。
    print("\nreading N03 municipal boundaries", flush=True)
    prefs = Prefectures()
    print(f"  {prefs.polygon_count:,} polygons", flush=True)
    assigned = prefs.assign_ways(
        ways.lat, ways.lon, [ways.count[w] for w in ways.order])
    report(list(zip(ways.order, assigned, strict=True)), prefs.vintage)

    surveyed = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    by_region: dict[str, list[dict]] = {r: [] for r in REGIONS}
    unassigned: list[int] = []
    for wid, a in zip(ways.order, assigned, strict=True):
        tags = ways.tags[wid]
        if a.region is None:
            unassigned.append(wid)
            continue
        grade, link = grade_of(tags)
        tag_refs = numbers(tags.get("ref")) if grade is not None else []
        rel = sorted(claimed.get(wid, ()))
        doc = {
            "id": wid,
            "grade": grade,
            "link": link,
            "kind": classify(tags),
            "former": is_former(tags),
            "oneway": tags.get("oneway") in ("yes", "-1", "1", "true"),
            "name": tags.get("name"),
            "tag_refs": tag_refs,
            "rel_refs": rel,
            "refs": sorted(set(tag_refs) | set(rel)),
            "national_relation": wid in national_ways,
            "national_tag": is_candidate(tags),
            "m": line_length(ways.points(wid)),
            "how": a.how,
            "geometry": [[round(lat, 7), round(lon, 7)]
                         for lat, lon in ways.points(wid)],
        }
        if len(a.regions) > 1:
            doc["cross"] = list(a.regions)
            doc["cross_m"] = a.metres
        by_region[a.region].append(doc)

    SURVEY.mkdir(parents=True, exist_ok=True)
    print(f"\nwriting {len(by_region)} region files to {SURVEY}")
    for region, docs in by_region.items():
        out = SURVEY / f"{region}.json"
        out.write_text(json.dumps({
            "region": region,
            "label": REGIONS[region]["label"],
            "timestamp_osm_base": base_ts,
            "surveyed_at": surveyed,
            "n03_vintage": prefs.vintage,
            "ways": docs,
        }, ensure_ascii=False), encoding="utf-8")
        km = sum(d["m"] for d in docs) / 1000
        print(f"  {region:12} {REGIONS[region]['label']:6} ways {len(docs):7,}  "
              f"{km:9,.1f} km  {out.stat().st_size / 1e6:6.1f} MB", flush=True)

    summary = {
        "timestamp_osm_base": base_ts,
        "surveyed_at": surveyed,
        "n03_vintage": prefs.vintage,
        "prefectural_relations": len(prefectural),
        "relations_without_number": numberless,
        "ways_claimed_by_relation": len(claimed),
        "ways_kept": len(ways.order),
        "ways_without_prefecture": unassigned,
    }
    (SURVEY / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    if unassigned:
        print(f"\n{len(unassigned)} ways carry no prefecture and are in no region file. "
              f"They are listed in summary.json.")


if __name__ == "__main__":
    main()
