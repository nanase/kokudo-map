# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""都道府県道かどうかと、どの県の何号かを決める。

国道の build_routes.py と同じ二つの問いに答えるが、証拠の並びが違う。国道では
リレーション・名前・`ref` の三つが互いを補い、地域ごとの保証集合が裏取りをした。
都道府県道では、その三つのうち名前が使えず、裏取りが効かない。

  名前         OSM の `name` は路線名ではなく、その場所の呼び名である。県内の
               (番号 -> 名前)13,223 組のうち 5,050 組が複数の名前を持ち、中身は
               「環状1号線」「1条通」「大網街道」「豊永橋」だった。国道の
               `国道N号` に当たる書き方は無い

  裏取り       国道の裏取りが効くのは、県内で保証される番号が 459 のうち 10〜55
               しかないからである。都道府県道では県内に 759 番(北海道)や 432 番
               (兵庫)が実在し、保証集合が番号空間を埋める。しかもリレーションが
               保証しない番号を落とすと、(県, 番号)13,247 組のうち 6,855 組——
               半分——が消える

残るのはリレーションと `ref` の二つで、その二つを和で採る。番号は県の中でしか
一意でないので、路線の同一性は (県, 番号) の組である。所属県は prefectures.py が
N03 の面で決めた物をそのまま使う(#97)。

読むのは build/survey/{region}.json である。あれは pbf を一度読んで、都道府県道に
なりうる way を県ごとに落とした物で、国道にとっての build/cache に当たる。あちらが
残す集合はここが採る集合より意図して広い——`_link` と工事中を残すのは、年報との差の
内訳を測るためである(survey_prefectural.py)。判定はここだけが持つ。

使い方:  uv run pipeline/build_prefectural.py [地域]
"""
from __future__ import annotations

import json
import sys
from collections import Counter

from _paths import PREFECTURAL, SURVEY
from build_routes import NAME_NUM, VALID
from regions import REGIONS, named_regions

# 都道府県道が持ちうる路線番号の上限。全国で測ると、都道府県道のルートリレーションが
# 保証する番号の最大値は北海道の 1,180 で、次に現れる番号は 3,504 まで飛ぶ。1,181 から
# 3,503 のあいだに (県, 番号) の組は 1 つも無い。空いているのはここだけなので、境目は
# ここにしか置けない。
#
# 上に出る 12 組は、いずれも路線番号ではなかった。
#
#   北海道 9900〜9905  札幌市道(真駒内篠路線・南十九条宮の沢線・羊ヶ丘線など)
#   大阪府 9011・9014  大阪市道(`name=市道浜口南港線`)
#   東京都 3504〜3512  都市計画道路の街路番号(`name=東京都道新宿副都心四号線`)
#   東京都 3606        国道246号の上を走る首都高速の区間
#
# 政令指定都市の市道が、県道と同じ書式で自分の番号を名乗っている形である。国道側で
# 都市高速が `ref=4` を名乗るのと同じことが、一段下の格で起きている。
MAX_REF = 1199

# 主要地方道の番号。主要地方道かどうかは政令で決まる法令上の区別で、OSM はそれを直接
# 持たない。持っているのは道の格と番号で、実測では primary の 95.5% が `ref` 100 以下、
# secondary の 99.5% が 101 以上である。
#
# 分けるのに使うのは番号のほうである。格は道の作りを述べるのであって、路線の格付けを
# 述べるのではない。しかも格で分けると、東京都で 633.8 km の一般都道が主要地方道に
# なる。県ごとに境目を実測して動かす案は、沖縄県でどの測り方でも壊れる。四つの案の
# 突き合わせは PREFECTURAL.md にある。
#
# 42 県では 1〜100 が主要地方道である。残る 5 都道県では、政令の指定が番号の付け方から
# 外れる。外れているのは番号の読み方ではなく、その都道県の番号の振り方そのものなので、
# 都道県ごとに書き下す。
#
#   北海道   主要道道は 101〜199 も持つ(道道106・118・121・123 号など)
#   東京都   特例都道の 301〜319 も主要地方道である(都道311号環八・318号環七など)
#   福岡県   151 号だけが 100 を超える主要地方道である
#   大分県   57 号は主要地方道ではない。国道57号からの指定変更で番号がそのまま残った
#   沖縄県   政令の指定が飛び飛びなので、帯ではなく番号を並べる
#
# ここは法令の写しであって、実データを測って決めた値ではない。出どころは Wikipedia
# 「主要地方道」の路線番号の節と、各都道県の県道の一覧である。測って動かしてはならない。
#
# 範囲は出典が述べるとおりに写す。北海道は「一般道道は 200 番台以降」と境目のほうが
# 述べられているので 199 まで採る。東京都は「301〜319番が特例都道である主要地方道」と
# 番号そのもので述べられているので、300 番台をすべて採るのではなく 319 で切る。次の
# 特例都道の帯(401〜484)は一般都道なので、あいだの 320〜399 を主要地方道と読む根拠は
# どこにも無い。
#
# 番号と道の格が食い違う way は、下の `rank_mismatch` が見張りに回す。
MAJOR_BAND = frozenset(range(1, 101))

MAJOR_REFS: dict[str, frozenset[int]] = {
    "hokkaido": MAJOR_BAND | frozenset(range(101, 200)),
    "tokyo": MAJOR_BAND | frozenset(range(301, 320)),
    "fukuoka": MAJOR_BAND | {151},
    "oita": MAJOR_BAND - {57},
    "okinawa": frozenset({7, 10, 23, 29, 38, *range(70, 76), *range(77, 80),
                          *range(81, 92)}),
}

MAJOR, GENERAL = "major", "general"
RANK_LABEL = {MAJOR: "主要地方道", GENERAL: "一般都道府県道"}


def rank_of(region: str, ref: int) -> str:
    """その都道府県のその番号が主要地方道か。

    番号だけでは決められない。県道57号は 47 本あり、そのうち大分県の 1 本だけが
    一般県道である。種別も路線の同一性と同じく (県, 番号) の組で決まる。
    """
    return MAJOR if ref in MAJOR_REFS.get(region, MAJOR_BAND) else GENERAL


# ------------------------------------------------------------------ 指定 ---
def national_name_numbers(name: str | None) -> set[int]:
    """way 自身の名前が `国道N号` として述べている番号。

    その番号は国道番号であって県道番号ではない。way/35610107(静岡県、
    `highway=secondary`、`ref=135`、`name=国道135号`)は、格を取り違えて描かれた
    国道135号であって、静岡県道135号ではない。

    全国で測ると、候補のうち名前が `国道N号` と述べる way は 41 本あり、その番号が
    `ref` とも一致するのは 3 本(0.17 km)である。うち 2 本は `primary_link` なので
    上の `admits_by_tag` が先に外す。この規則でしか落ちないのは静岡県の 1 本、0.03 km
    である。

    残る 38 本(4.9 km)は `name=石川県道22号金沢小松線;国道159号` のように別の番号を
    述べており、国道と県道の正当な重用である。番号を見ずに「名前が国道だから」で外すと、
    この 38 本を壊す。

    国道のリレーションに載っていることは、この検査には使えない。候補のうち国道の
    リレーションが番号を与える way は 224 本あるが、そのうち番号が一致するのは 1 本
    だけで、残る 223 本(92.6 km)は青森県道3号 弘前岳鰺ケ沢線のように国道と重用して
    いる本物の県道である。CASES.md 18 が国道側で学んだのと同じことが、こちら側でも
    そのまま起きる——「国道のリレーションに乗っている」ことと「国道として同じ番号を
    名乗っている」ことは別の情報である。
    """
    return {int(m) for m in NAME_NUM.findall(name or "") if int(m) in VALID}


def designations(doc: dict) -> tuple[set[int], set[int]]:
    """(リレーション由来, `ref` 由来) の路線番号。

    番号を読む仕事は survey_prefectural.py が済ませてあり(`rel_refs`・`tag_refs`)、
    ここがするのは規則の当てはめだけである。同じ `ref` を二つの正規表現で読み直すと、
    片方が暗黙のうちに古くなる。
    """
    from_rel = {r for r in doc["rel_refs"] if r <= MAX_REF}
    if not admits_by_tag(doc):
        return from_rel, set()
    from_tag = {r for r in doc["tag_refs"] if r <= MAX_REF}
    return from_rel, from_tag - national_name_numbers(doc["name"])


def admits_by_tag(doc: dict) -> bool:
    """way 自身のタグだけで都道府県道と認めてよい形か。

    格が primary・secondary(工事中はその `construction`)で、`ref` に数字だけの
    トークンがあることを求める。`tertiary` は入れない——数字の `ref` を持つ way は
    primary が 128,139、secondary が 152,701 に対して tertiary は 2,470 で二桁少なく、
    国道が primary を締め出したのと同じ理由で外せる。

    `_link` は格として認めない。ランプは台帳の路線延長ではないからである。国道側の
    `is_national_grade` が `trunk_link` を認めないのと同じ扱いで、リレーションが
    抱えるランプは規則 a でそのまま入る。全国の `_link` 2,770 本・424.0 km のうち
    1,429 本・215.1 km がそちらで入り、残る 1,341 本・208.9 km がここで落ちる。

    工事中は認める。国道側が `construction=primary` を締め出したのは、それが数字の
    `ref` を持つ県道を国道の裏取りへ流し込む裏口だったからである(北海道道39号が
    国道39号になった)。こちら側では、それはまさに拾いたい物である。
    """
    return doc["grade"] is not None and not doc["link"] and bool(doc["tag_refs"])


def rank_mismatch(region: str, grade: str | None, refs: list[int]) -> str | None:
    """種別と道路の格が食い違うか。食い違うならその格を返す。

    数えるのに使わなかったほうを見張りに回す。`primary` なのに番号が一般都道府県道、
    `secondary` なのに主要地方道、という way の数である。タグの誤りの数ではなく、
    二つの証拠が割れている量である。
    """
    if grade is None or not refs:
        return None
    if grade == "primary" and all(rank_of(region, r) == GENERAL for r in refs):
        return "primary"
    if grade == "secondary" and all(rank_of(region, r) == MAJOR for r in refs):
        return "secondary"
    return None


def refs_key(region: str, refs: list[int]) -> str:
    """絞り込みが読む鍵。区切り文字で囲んだ (県, 番号) の並びである。

    国道の `,18,` に当たる物だが、県道の番号は県の中でしか一意でないので、県の名前を
    番号に貼り付ける。県道18号は 47 本あり、`,18,` では、どの 18 号かを述べていない。

    貼り付ける県は way の所属県そのもの——`pref` 属性と同じ値——である。同じことを
    二度書いているように見えるが、片方は way の属性、もう片方は路線の同一性で、要る形が
    違う。この形にしておくと、画面の絞り込みは国道と同じ 1 つの式のままでいられる。

        ["in", ",tokyo-318,", ["get", "refs"]]

    県を別の属性で絞ると式が二本になり、重用の照合(`,`で囲む理由)と県の照合とで
    別々の書き方を覚えることになる。

    県は符号(13)ではなく地域名(tokyo)で書く。この repo が県を名指しするときの言葉は
    regions.py の地域名で、build/survey のファイル名も web/data/regions.json も
    `pref` 属性もそれである。ここだけ二桁の符号を持ち込むと、県の名前が二通りになる。
    """
    return "," + ",".join(f"{region}-{r}" for r in refs) + ","


def check_keys(region: str, refs: list[int]) -> None:
    """鍵が、その県の他の番号に誤って当たらないことを断定する。

    国道の `,4,` が `,14,` や `,400,` に当たらないのと同じ性質を、県を貼り付けた形
    でも保つ。紛らわしい相手——先頭が同じ番号、末尾が同じ番号、桁を伸ばした番号——を
    実際に当てて確かめる。式のほうを書き写して確かめても、確かめたことにならない。
    """
    key = refs_key(region, refs)
    present = set(refs)
    suspects = set()
    for r in refs:
        suspects |= {r * 10, r * 10 + 1, r // 10, int(f"1{r}"), int(f"{r}1")}
    for r in sorted(suspects | present):
        if r <= 0:
            continue
        hit = f",{region}-{r}," in key
        if hit != (r in present):
            raise AssertionError(
                f"{region}: refs_key({refs}) = {key!r} が {r} について "
                f"{'当たった' if hit else '当たらなかった'}")


# ------------------------------------------------------------------ main ---
def build(region: str) -> dict:
    path = SURVEY / f"{region}.json"
    if not path.exists():
        raise SystemExit(f"{path} is missing; run `mise run survey-pref` first")
    doc = json.loads(path.read_text(encoding="utf-8"))
    ways = doc["ways"]
    print(f"OSM data base: {doc['timestamp_osm_base']}   "
          f"surveyed: {doc['surveyed_at']}   N03 {doc['n03_vintage']}")
    print(f"{region}: {len(ways):,} candidate ways from the survey")

    arcs: list[dict] = []
    kinds: Counter = Counter()
    ranks: Counter = Counter()
    sources: Counter = Counter()
    n_hist: Counter = Counter()
    mismatch: Counter = Counter()
    dropped: Counter = Counter()
    rel_added = tag_added = 0
    formers = 0
    over_max: Counter = Counter()
    national_overlap = 0

    for w in ways:
        from_rel, from_tag = designations(w)
        refs = sorted(from_rel | from_tag)
        for r in set(w["rel_refs"]) | set(w["tag_refs"]):
            if r > MAX_REF:
                over_max[r] += 1
        if not refs:
            dropped["番号が残らなかった"] += 1
            continue
        if len(w["geometry"]) < 2:
            dropped["点が 2 つに満たない"] += 1
            continue

        source = "relation" if from_rel else "tag"
        if from_rel - from_tag:
            rel_added += 1
        if from_tag - from_rel:
            tag_added += 1
        # 重用するアークは種別の違う路線を同時に持ちうる。上の格を採る——
        # compare_annual_report_pref.py が実延長を表12 と表13 に割るときと同じ扱いで
        # ある。路線ごとの種別は下の `routes` が rank_of で持つ。
        rank = MAJOR if any(rank_of(region, r) == MAJOR for r in refs) else GENERAL
        bad = rank_mismatch(region, w["grade"], refs)
        if bad:
            mismatch[bad] += 1
        if w["national_relation"] or w["national_tag"]:
            national_overlap += 1
        if w["former"]:
            formers += 1
        kinds[w["kind"]] += 1
        ranks[rank] += 1
        sources[source] += 1
        n_hist[len(refs)] += 1

        check_keys(region, refs)
        arcs.append({
            "id": w["id"],
            "refs": refs,
            "refs_key": refs_key(region, refs),
            "n": len(refs),
            "kind": w["kind"],
            "rank": rank,
            "src": source,
            "former": 1 if w["former"] else 0,
            "name": w["name"],
            "km": round(w["m"] / 1000, 3),
            "coords": w["geometry"],
        })

    routes: dict[int, dict] = {}
    for a in arcs:
        for r in a["refs"]:
            e = routes.setdefault(r, {"ref": r, "rank": rank_of(region, r), "km": 0.0,
                                      "arcs": 0, "max_n": 1, "kinds": Counter()})
            e["km"] += a["km"]
            e["arcs"] += 1
            e["max_n"] = max(e["max_n"], a["n"])
            e["kinds"][a["kind"]] += 1

    # アークの実長の和。同じ道を何本の県道が指定していても 1 度しか数えない。年報の
    # 実延長 とは違う——あちらは国道と重用する区間を国道側へ寄せる。その寄せ方は
    # compare_annual_report_pref.py が持つ。
    arc_km = sum(a["km"] for a in arcs)
    # 指定延長。重用区間を指定した路線の数だけ数えた物で、年報の 総延長 に当たる。
    designated_km = sum(a["km"] * a["n"] for a in arcs)

    print(f"\narcs built: {len(arcs):,}   dropped: {dict(dropped)}")
    print(f"  admitted by: {dict(sources)}")
    print(f"  kinds: {dict(kinds)}")
    print(f"  ranks: {{{RANK_LABEL[MAJOR]}: {ranks[MAJOR]:,}, "
          f"{RANK_LABEL[GENERAL]}: {ranks[GENERAL]:,}}}")
    print(f"  concurrency histogram (n -> arcs): {dict(sorted(n_hist.items()))}")
    print(f"  designations contributed only by relations: {rel_added:,}")
    print(f"  designations contributed only by the ref tag: {tag_added:,}")
    print(f"  arcs flagged as former alignment (旧道): {formers:,}")
    print(f"  arcs a national relation or tag also claims: {national_overlap:,}")
    if over_max:
        print(f"  numbers rejected as above {MAX_REF} (市道・都市計画道路): "
              f"{dict(sorted(over_max.items()))}")
    for grade, count in sorted(mismatch.items()):
        want = GENERAL if grade == "primary" else MAJOR
        print(f"  rank mismatch: {grade} but every number is {RANK_LABEL[want]}: "
              f"{count:,} arcs")
    print(f"\nroutes present: {len(routes)}  "
          f"({sum(1 for e in routes.values() if e['rank'] == MAJOR)} 主要地方道, "
          f"{sum(1 for e in routes.values() if e['rank'] == GENERAL)} 一般都道府県道)")
    print(f"designated length: {designated_km:,.1f} km   "
          f"arc length: {arc_km:,.1f} km")

    return {
        "region": region,
        "arcs": arcs,
        "routes": routes,
        # 全国の合計はここを足す。`meta` の側は小数第 1 位に丸めてあるので、47 県ぶんを
        # 足すと 1 県あたり最大 0.05 km の誤差が積み上がり、全アークを足してから丸めた
        # 値と合わない。
        "arc_km": arc_km,
        "designated_km": designated_km,
        "meta": {
            "region": region,
            "label": REGIONS[region]["label"],
            "osm_timestamp": doc["timestamp_osm_base"],
            "surveyed_at": doc["surveyed_at"],
            "n03_vintage": doc["n03_vintage"],
            "arc_count": len(arcs),
            "arc_km": round(arc_km, 1),
            "designated_km": round(designated_km, 1),
            "sources": dict(sources),
            "kinds": dict(kinds),
            "ranks": {RANK_LABEL[MAJOR]: ranks[MAJOR],
                      RANK_LABEL[GENERAL]: ranks[GENERAL]},
            "former_arcs": formers,
            "national_overlap_arcs": national_overlap,
            "rank_mismatch": {k: v for k, v in sorted(mismatch.items())},
            "rejected_above_max": {str(k): v for k, v in sorted(over_max.items())},
            "n_histogram": {str(k): v for k, v in sorted(n_hist.items())},
            "routes": [
                {
                    "ref": r,
                    "rank": e["rank"],
                    "km": round(e["km"], 1),
                    "arcs": e["arcs"],
                    "max_n": e["max_n"],
                    "kinds": dict(e["kinds"]),
                }
                for r, e in sorted(routes.items())
            ],
        },
    }


def write(built: dict) -> None:
    region = built["region"]
    PREFECTURAL.mkdir(parents=True, exist_ok=True)
    features = [
        {
            "type": "Feature",
            "properties": {
                "id": a["id"],
                "pref": region,
                "refs": a["refs_key"],
                "refs_list": [f"{region}-{r}" for r in a["refs"]],
                "n": a["n"],
                "kind": a["kind"],
                "rank": a["rank"],
                "src": a["src"],
                "former": a["former"],
                # 国道側と同じく、ここを 1 にするのは apply_n13.py だけである。
                # 0 は「未確認」であって「現役だと確認済み」ではない。
                "revoked": 0,
                "name": a["name"],
                "km": a["km"],
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [[round(lon, 6), round(lat, 6)]
                                for lat, lon in a["coords"]],
            },
        }
        for a in built["arcs"]
    ]
    gj = PREFECTURAL / f"{region}.geojson"
    gj.write_text(
        json.dumps({"type": "FeatureCollection", "features": features},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    meta = PREFECTURAL / f"{region}.meta.json"
    meta.write_text(json.dumps(built["meta"], ensure_ascii=False,
                               separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {gj.name} ({gj.stat().st_size / 1e6:.2f} MB)")
    print(f"wrote {meta.name} ({meta.stat().st_size / 1e3:.1f} kB)")


def main() -> None:
    regions = named_regions(sys.argv[1:])
    total = Counter()
    for region in regions:
        built = build(region)
        write(built)
        total["arcs"] += built["meta"]["arc_count"]
        total["routes"] += len(built["routes"])
        total["km"] += built["arc_km"]
        total["designated_km"] += built["designated_km"]
        print()
    if len(regions) > 1:
        print(f"{len(regions)} regions: {total['arcs']:,} arcs, "
              f"{total['routes']:,} (県, 番号) pairs, "
              f"{total['designated_km']:,.1f} km designated, "
              f"{total['km']:,.1f} km of arc")


if __name__ == "__main__":
    main()
