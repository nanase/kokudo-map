# /// script
# requires-python = ">=3.12"
# dependencies = ["osmium>=4.0"]
# ///
"""全国 1 つの .osm.pbf から、地域ごとの生の OSM の物を切り出す。

全国を生成するとき、これが Overpass からの取得の代わりになる。地域ごとにまったく
同じ三つの問いに答え、まったく同じキャッシュファイルを書くので、build_routes.py
も verify.py も audit.py も違いに気付かない。

  1. core        — bbox に触れる国道のルートリレーション、その子リレーション、
                   そして bbox の中にあるメンバーの way
  2. candidates  — bbox の中の、国道の格を持ち数字だけの `ref` を持つ way と、
                   国道N号 という名前の way
  3. competing   — bbox に触れる、国道でない route=road のリレーションと、その
                   タグとメンバー。負の証拠である。大半は都道府県道のリレーション
                   だが、事業者が自分の番号を名乗る物(network=首都高速道路 など)
                   も同じ理由で同じ証拠になる——CASES.md 20 を参照。

Overpass を使い続けない理由。47 都道府県は約 140 件の問い合わせと約 1 GB の応答
になり、公開ミラーから何時間もかけて取ることになる。2.5 GB のファイルを一度
落とすほうが速く、しかもミラーの用途にも合う。

意図して変えていないこと。作業の単位は地域のままである。build_routes.py の裏取り
が濾せるのは、その地域のリレーションが保証する路線番号の集合が小さいからである。
全国でまとめて判定するとその集合は 459 番すべてに近づき、裏取りは何も濾さなくなる
——長野県道372号がふたたび国道372号として戻る。取得は全国、判定は bbox の中の
ままである。RULES.md 裏取り と CASES.md 1・2 を参照。

使い方:  uv run pipeline/extract_pbf.py [地域 ...]   (既定: 全地域)
         uv run pipeline/extract_pbf.py --pbf path/to/japan-latest.osm.pbf
"""
from __future__ import annotations

import json
import re
import sys
from array import array
from datetime import datetime, timezone

import osmium

from _paths import CACHE, PBF
from regions import REGIONS, named_regions

# 生成が読む way のタグはこれだけで、他は読まない。残りを保つと、何の役にも
# 立たないままこの処理の使うメモリが三倍になる。正典は build_routes.TAGS_USED で
# ある。書き写さず import するので、二つが離れていくことはない。
#
# `tokens` を import するのも同じ理由である。`ref` が国道番号を持つかどうかは
# build_routes.py が一度だけ答えており、二つ目の正規表現で答え直すのではなく、
# ここではその答えを読む。二つ目の正規表現こそ、第二神明道路(`ref=E93;2`、国道2号
# のリレーションが無い)と神戸淡路鳴門自動車道(`ref=E28;28`、リレーションが 1 つも
# 無い)が全国から消えた原因である。全体一致の `^[0-9]+(;[0-9]+)*$` は、セミコロン
# で区切られたトークンの 1 つが E ナンバーの接頭辞を持った瞬間に `ref` 全体を
# 拒否した。だからその道は候補にすらならず、build_routes.py は裏取りの前にそれを
# 見ることが無かった。`tokens()` は元からトークンごとに検査する——`ref=4;6;14;17`
# を受け入れるにはそうするしかない——ので、同じ理由で `E93;2` も受け入れる。
# accepts `2;28;250`.
from build_routes import TAGS_USED, tokens

SOURCE_URL = "https://download.geofabrik.de/asia/japan-latest.osm.pbf"

# Overpass の問い合わせが使うのと同じ形。二つの経路が同じ way を認めるように。
CANDIDATE_GRADES = {"trunk", "motorway", "construction"}
NAME_KOKUDO = re.compile(r"^国道[0-9]+号")

# リレーションの名前についても同じ形だが、全角数字を許す——実際に
# 「国道３２５号（阿蘇大橋）の応急的な迂回路」という名前のリレーションがある。
REL_KOKUDO = re.compile(r"^国道\s*\d+\s*号")

NATIONAL = "JP:national"
PREFECTURAL = "JP:prefectural"

# libosmium はメンバーの種別を 'n'・'w'・'r' と綴る。キャッシュは build_routes.py
# が読むので Overpass の綴りにする。ここで訳しておけば、あちらに手を入れずに済む。
MEMBER_TYPE = {"n": "node", "w": "way", "r": "relation"}


# ------------------------------------------------------------------ storage ---
class Ways:
    """全国ぶんの way の形を、ノードごとの Python オブジェクトを作らずに持つ。

    絞り込みを抜けてくる座標は約 800 万点ある。リストに入れた tuple では 1 GB を
    大きく超えるが、平らな浮動小数の配列 2 本なら 128 MB で済む。
    """

    def __init__(self) -> None:
        self.lat = array("d")
        self.lon = array("d")
        self.start: dict[int, int] = {}
        self.count: dict[int, int] = {}
        self.tags: dict[int, dict[str, str]] = {}
        self.ts: dict[int, str] = {}
        # way ごとの bbox。地域の判定に使う。
        self.box: dict[int, tuple[float, float, float, float]] = {}

    def add(self, wid: int, tags: dict[str, str], ts: str, pts: list[tuple[float, float]]) -> None:
        self.start[wid] = len(self.lat)
        self.count[wid] = len(pts)
        self.tags[wid] = tags
        self.ts[wid] = ts
        lats = [p[0] for p in pts]
        lons = [p[1] for p in pts]
        self.lat.extend(lats)
        self.lon.extend(lons)
        self.box[wid] = (min(lats), min(lons), max(lats), max(lons))

    def geometry(self, wid: int) -> list[dict[str, float]]:
        i, n = self.start[wid], self.count[wid]
        return [{"lat": self.lat[j], "lon": self.lon[j]} for j in range(i, i + n)]

    def in_box(self, wid: int, box: tuple[float, float, float, float]) -> bool:
        """way のノードが 1 つでも bbox の中にあれば真。

        Overpass 自身の bbox の絞り込みも同じ判定なので、下の安価な矩形による
        除外が飛ばすのは、あちらでも飛ばされていた way だけである。
        """
        south, west, north, east = box
        ws, ww, wn, we = self.box[wid]
        if wn < south or ws > north or we < west or ww > east:
            return False
        i, n = self.start[wid], self.count[wid]
        for j in range(i, i + n):
            if south <= self.lat[j] <= north and west <= self.lon[j] <= east:
                return True
        return False


def kept_tags(tags) -> dict[str, str]:
    return {k: v for k, v in tags if k in TAGS_USED}


# -------------------------------------------------------------------- passes ---
def read_header(path: str) -> str:
    """切り出した時刻を、OSM の基準時刻として返す。

    verify.py はデータが 1 週間以内であることを求め、ページはそれを データ基準
    として出す。pbf も Overpass のミラーと同じことを述べねばならない。
    """
    header = osmium.io.Reader(path, osmium.osm.osm_entity_bits.NOTHING).header()
    ts = header.get("osmosis_replication_timestamp") or header.get("timestamp")
    if not ts:
        raise SystemExit(
            f"{path} carries no osmosis_replication_timestamp; its base time is "
            "unknown and verify.py could not check freshness"
        )
    return ts


def pass_relations(path: str) -> tuple[dict[int, dict], set[int]]:
    """道路のルートリレーションすべてと、それが抱えるリレーションの id。

    二度読む。子リレーションは自分がルートだとタグ付けされているとは限らないので、
    どれが効くかは親を読み終えて初めて分かる。
    """
    rels: dict[int, dict] = {}
    wanted: set[int] = set()

    def take(r) -> None:
        rels[r.id] = {
            "type": "relation",
            "id": r.id,
            "tags": dict(r.tags),
            "members": [
                {"type": MEMBER_TYPE[m.type], "ref": m.ref, "role": m.role}
                for m in r.members
                if m.type in MEMBER_TYPE
            ],
        }

    print("  pass 1/3: road route relations", flush=True)
    for r in osmium.FileProcessor(path, osmium.osm.osm_entity_bits.RELATION):
        if r.tags.get("type") == "route" and r.tags.get("route") == "road":
            take(r)
    for rel in rels.values():
        for m in rel["members"]:
            if m["type"] == "relation":
                wanted.add(m["ref"])

    missing = wanted - set(rels)
    if missing:
        print(f"  pass 2/3: {len(missing)} child relations that are not road routes",
              flush=True)
        for r in osmium.FileProcessor(path, osmium.osm.osm_entity_bits.RELATION):
            if r.id in missing:
                take(r)
    else:
        print("  pass 2/3: skipped, every child relation is itself a road route",
              flush=True)
    return rels, wanted


def pass_ways(path: str, member_ways: set[int], member_nodes: set[int], idx: str):
    """メンバーと候補の way の形、そしてメンバーのノードの位置。"""
    ways = Ways()
    nodes: dict[int, tuple[float, float]] = {}
    print("  pass 3/3: node locations and way geometry", flush=True)

    # 日本には約 2 億 7000 万のノードがある。位置のキャッシュはその全部を見る
    # 必要があるが、それは C++ の中で起きる。1 つずつ Python 側へ渡して捨てると、
    # この処理の残り全部を合わせたより高く付く。この絞り込みはキャッシュを残した
    # まま受け渡しだけを飛ばす。メンバーのノードは、後からキャッシュに読みに行く。
    proc = (
        osmium.FileProcessor(
            path, osmium.osm.osm_entity_bits.NODE | osmium.osm.osm_entity_bits.WAY
        )
        .with_locations(idx)
        .with_filter(osmium.filter.EntityFilter(osmium.osm.osm_entity_bits.WAY))
    )
    seen = 0
    for o in proc:
        seen += 1
        if seen % 2_000_000 == 0:
            print(f"    {seen:,} ways scanned, {len(ways.start):,} kept", flush=True)

        tags = o.tags
        keep = o.id in member_ways
        if not keep:
            hw = tags.get("highway")
            if hw is None:
                continue
            ref = tags.get("ref")
            keep = (hw in CANDIDATE_GRADES and bool(tokens(ref))) or bool(
                NAME_KOKUDO.match(tags.get("name") or "")
            )
        if not keep:
            continue
        try:
            pts = [(n.location.lat, n.location.lon) for n in o.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            continue
        if len(pts) < 2:
            continue
        ways.add(o.id, kept_tags(tags), o.timestamp.strftime("%Y-%m-%dT%H:%M:%SZ"), pts)

    # リレーションはノードをメンバーに持つことがある——路線が通る交差点などで
    # ある。数は少ないが、bbox の中に在る物がそのノードだけであっても、その
    # リレーションはそこに在ると数える。Overpass もそう数えていた。
    store = proc.node_location_storage
    for nid in member_nodes:
        try:
            loc = store.get(nid)
        except (osmium.InvalidLocationError, KeyError, IndexError):
            continue
        if loc.valid():
            nodes[nid] = (loc.lat, loc.lon)
    return ways, nodes


# -------------------------------------------------------------- 地域ごと ---
def write_region(region: str, box, rels, national, competing, ways, nodes, base_ts, fetched):
    """三つの Overpass の問い合わせを、メモリ上の全国に対して再現する。"""
    # どの way がこの bbox に触れるかを、一度だけ訊く。
    #
    # `in_box` は way のノードを、1 つが中に落ちるまで辿る。下の三つの問い合わせ
    # は同じ way に同じ問いを四、五回ずつ訊いていた——その way を抱える国道の
    # リレーションごとに 1 回、core の一覧でもう 1 回、競合するリレーションで
    # さらに 2 回である。1 つの地域の中で答えが変わることはないので、ここで一度
    # だけ取り、後は引くだけにする。
    #
    # 355,570 本すべてに真偽を持たせるのではなく、中に在る way の集合を持つ。
    # 1 県の bbox に入るのは数万本なので、こちらのほうが小さく、読みやすくもある。
    # `wid in inside` は、呼ぶ側が持っていた `wid in ways.start` の判定も畳み
    # 込む。ways.start に無い物がここに入ることはないからである。
    inside_box = {wid for wid in ways.start if ways.in_box(wid, box)}

    # 問い合わせ 1。bbox に触れる国道のリレーションと、その子。
    parents = [
        rid for rid in national
        if any(m["type"] == "way" and m["ref"] in inside_box
               for m in rels[rid]["members"])
        or any(m["type"] == "node" and m["ref"] in nodes and inside(nodes[m["ref"]], box)
               for m in rels[rid]["members"])
    ]
    kids = {m["ref"] for rid in parents for m in rels[rid]["members"]
            if m["type"] == "relation" and m["ref"] in rels}
    rel_ids = sorted(set(parents) | kids)

    core_way_ids = sorted({
        m["ref"] for rid in rel_ids for m in rels[rid]["members"]
        if m["type"] == "way" and m["ref"] in inside_box
    })

    # 問い合わせ 2。候補。リレーションが抱えているかどうかは問わない。Overpass の
    # 問い合わせにこの除外は無いが、二つの `out` が返した way はどのみち
    # build_routes.py が重複排除するので、ここで飛ばせばキャッシュが半分になる。
    # 競合するリレーションだけが抱えている way は、今も候補である。
    core_set = set(core_way_ids)
    cand_ids = sorted(
        wid for wid in inside_box
        if wid not in core_set and is_candidate(ways.tags[wid])
    )

    # 問い合わせ 3。負の証拠。平らな way id の集合ではなく、リレーションのまま
    # (タグとメンバー)保つ——ただ所属していることが失格の証拠になり得ない理由は
    # build_routes.resolve_competing_claims を参照。
    competing_relations = [
        rel for rel in (
            {
                "id": rid,
                "tags": rels[rid]["tags"],
                "members": [
                    m["ref"] for m in rels[rid]["members"]
                    if m["type"] == "way" and m["ref"] in inside_box
                ],
            }
            for rid in competing
        )
        if rel["members"]
    ]

    def way_doc(wid: int) -> dict:
        return {
            "type": "way",
            "id": wid,
            "timestamp": ways.ts[wid],
            "tags": ways.tags[wid],
            "geometry": ways.geometry(wid),
        }

    doc = {
        "region": region,
        "label": REGIONS[region]["label"],
        "bbox": list(box),
        "endpoint": SOURCE_URL,
        "timestamp_osm_base": base_ts,
        "fetched_at": fetched,
        "core": [rels[rid] for rid in rel_ids] + [way_doc(w) for w in core_way_ids],
        "candidates": [way_doc(w) for w in cand_ids],
        "competing_relations": competing_relations,
    }
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"{region}.raw.json"
    out.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    competing_way_count = len({w for r in competing_relations for w in r["members"]})
    print(f"  {region:12} {REGIONS[region]['label']:6} rel {len(rel_ids):5}  "
          f"core ways {len(core_way_ids):6}  cand {len(cand_ids):6}  "
          f"competing {competing_way_count:6}  {out.stat().st_size / 1e6:6.1f} MB", flush=True)


def is_national_relation(tags: dict[str, str]) -> bool:
    """このルートリレーションは国道のリレーションか。

    ふつうの証拠は `network=JP:national` である。それが唯一の証拠ではない。全国で
    測ると、国道N号 という名前の route=road のリレーションのうち 582 がその
    network を持ち、43 は `network` タグを 1 つも持たない。43 の大半は、他の
    リレーションが既に保証している路線の旧道・バイパス・支線だが、二つの路線番号
    には他に何も無い——国道478号(京都縦貫自動車道)については、タグの無い
    リレーションが唯一の存在なので、路線が丸ごと京都府から欠けていた。

    だから 国道N号 という名前のリレーションは、その名前で認める。RULES.md 問 1
    規則 b が way について既に認めているのと同じ証拠である。名前を読むのは `name`
    と `name:ja` だけで、`official_name` は決して読まない——三重県の路線番号を
    山梨県へ持ち込んだのがその欄である(CASES.md 2)。
    """
    net = tags.get("network") or ""
    if net.startswith(NATIONAL):
        return True
    if net.startswith(PREFECTURAL):
        return False
    return any(
        REL_KOKUDO.match((tags.get(k) or "").strip()) for k in ("name", "name:ja")
    )


# 本物の国道と共有する way の下で、競合する番号を主張しうる route=road の
# リレーション。大半は都道府県道のリレーションだが、それだけではない。
# way/560259106(首都高速都心環状線、`ref=1`)は relation/4256244 に載っており、
# そちらは `network=首都高速道路`、`ref=1` である。way 自身の名前は 高速N号 と
# 述べていない(CASES.md 9 の見張りはその文字列を必要とし、都心環状線は持たない)
# ので、国道1号との衝突は捕まらずに通っていた。`network` が在って `JP:` で
# 始まらない形は、県道の `JP:prefectural` と同じ形である——ある主体が自分の路線
# 番号の体系を名乗っており、それが日本の行政区画の体系ではない、というだけである。
#
# 全国で測ると、`network` タグが空でなく `JP:` で始まらない route=road の
# リレーションは 34 件ある(首都高速道路、阪神高速道路、名古屋高速道路など)。
# そのうち 33 件が、日本のどこかに実在する JP:national の路線番号と衝突する `ref`
# を主張しており、メンバーの way は 1,009 本に及ぶ——ほぼすべて都市高速の路線群
# である(首都高速の 1〜11、阪神高速の 33〜46 など)。CASES.md 20 を参照。
def is_competing_relation(tags: dict[str, str]) -> bool:
    net = tags.get("network") or ""
    if net.startswith(PREFECTURAL):
        return True
    return bool(net) and not net.startswith("JP:")


def inside(pt, box) -> bool:
    south, west, north, east = box
    return south <= pt[0] <= north and west <= pt[1] <= east


def is_candidate(tags: dict[str, str]) -> bool:
    if "highway" not in tags:
        return False
    if tags["highway"] in CANDIDATE_GRADES and tokens(tags.get("ref")):
        return True
    return bool(NAME_KOKUDO.match(tags.get("name") or ""))


# -------------------------------------------------------------------- main ---
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
    wanted = named_regions(args)

    base_ts = read_header(path)
    age = (datetime.now(timezone.utc)
           - datetime.fromisoformat(base_ts.replace("Z", "+00:00"))).total_seconds()
    print(f"pbf: {path}")
    print(f"data base: {base_ts}  age={age / 86400:.1f} days")
    if age > 7 * 86400:
        print("  WARNING: over 7 days old; verify.py will fail on freshness.")

    rels, _ = pass_relations(path)
    national = [rid for rid, r in rels.items() if is_national_relation(r["tags"])]
    competing = [rid for rid, r in rels.items() if is_competing_relation(r["tags"])]
    by_name = sum(1 for rid in national
                  if not (rels[rid]["tags"].get("network") or "").startswith(NATIONAL))
    print(f"  road route relations: {len(rels):,}  "
          f"national {len(national):,}  competing {len(competing):,}")
    print(f"  national admitted on their name alone (no network tag): {by_name}")

    member_ways = {m["ref"] for r in rels.values() for m in r["members"] if m["type"] == "way"}
    member_nodes = {m["ref"] for r in rels.values() for m in r["members"] if m["type"] == "node"}
    print(f"  ways held by a road route relation: {len(member_ways):,}")

    # 日本には約 1 億 5000 万のノードの位置がある。メモリに載せれば 2〜3 GB で、
    # この処理は pbf の入出力だけで頭打ちになる。ディスクに置けば 2.4 GB の索引
    # ファイルになり、数倍遅くなる。メモリを割けない機械では
    # --index sparse_file_array,build/pbf/nodes.idx を渡す。
    PBF.mkdir(parents=True, exist_ok=True)
    ways, nodes = pass_ways(path, member_ways, member_nodes, node_index)
    print(f"  ways kept: {len(ways.start):,}  coordinates: {len(ways.lat):,}")

    fetched = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"\nwriting {len(wanted)} region cache file(s)")
    for region in wanted:
        write_region(region, REGIONS[region]["bbox"], rels, national, competing,
                     ways, nodes, base_ts, fetched)

    # 網羅の確認。どの地域の bbox も覆わない way は、地図が出せない way である。
    # 手で引いた矩形の組であれば隠してしまう類の失敗が、これである。
    #
    # 数えるのは国道のメンバーだけである。都道府県道が外へ落ちるのは想定どおりで
    # ある。東京都の bbox は本土だけで、三宅島と小笠原の都道は、設計としてどの
    # bbox の外にもある。取りこぼしが国道であれば、bbox のほうが誤っている。
    boxes = [REGIONS[r]["bbox"] for r in REGIONS]
    national_ways = {
        m["ref"] for rid in national for m in rels[rid]["members"] if m["type"] == "way"
    }
    covered = set(ways.start)

    def orphans(ids: set[int]) -> list[int]:
        return [w for w in ids & covered if not any(ways.in_box(w, b) for b in boxes)]

    orphan = orphans(national_ways)
    other = orphans(member_ways - national_ways)
    print(f"\nnational-route ways outside every region box: {len(orphan)}")
    print(f"  (prefectural ways outside, expected: {len(other)})")
    if orphan:
        print("  " + ", ".join(f"way/{w}" for w in orphan[:20]))
        print("  A national route is outside every box. Fix regions.py before building.")

    (CACHE / "pbf_source.json").write_text(json.dumps({
        "path": path, "url": SOURCE_URL,
        "timestamp_osm_base": base_ts, "extracted_at": fetched,
        "ways_kept": len(ways.start), "orphan_ways": len(orphan),
    }, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
