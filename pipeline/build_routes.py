# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""キャッシュした OSM の物を、地図のデータファイルにする。

この段の眼目は、道のひと切れごとに、ふつうの地図が答えない問いへ答えることで
ある。その上にどの国道が指定されているか、番号の若い物だけでなく全部である。

判定は二つに分かれ、それぞれ別の証拠を必要とする。

  そもそも国道か     次のいずれかを満たせばよい。
      (a) 国道のルートリレーションが含んでいる
      (b) 名前が 国道N号 で、その番号を地域のリレーションが保証している。
          ただし、その way を含むリレーションが番号を与えておらず、格も通行
          規制も通り抜けできない生活道路と同じ物は除く
          (names_a_closed_residential_road)
      (c) 国道の格(trunk・motorway・それらの construction)で描かれており、
          競合するルートリレーションが同じ番号をその way について主張していない
    (c) が在るのは、ルートリレーションの整備が way に大きく遅れるからである。
    長野南バイパス(国道19号。開通から数十年)は 22 本の trunk で、どの
    リレーションにも入っていない。数字だけの `ref` は何も証明しない。都道府県道
    も同じ書式を使う。

  何号か             次の和集合である。
      - その way を含むリレーションすべての番号(親から継承する)
      - 名前から読んだ 国道N号。ただし、その地域の国道リレーションが独立に
        保証している番号に限る
      - way 自身の `ref` を ; で区切ったトークン。こちらも保証されている番号に
        限り、かつ、競合するリレーションがその way について同じ番号を主張して
        いない物だけを採用する。競合するリレーションは大半が都道府県道だが、
        事業者が自分の路線番号を名乗る体系(首都高速道路 など)も同じ形の主張を
        する。resolve_competing_claims と CASES.md 20 を参照

使い方:  uv run pipeline/build_routes.py [地域]
         uv run pipeline/build_routes.py --index-only  (索引だけ書き直す)
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict

from _paths import CACHE, REGIONS as OUT, write_atomic
from geo import haversine, line_length
from regions import for_region

# 一般国道が法令上持ちうる路線番号。1〜58 と 101〜507 から、廃止または編入され
# た 6 つの番号(109・110・111・214・215・216)を除く。
ABOLISHED = {109, 110, 111, 214, 215, 216}
VALID = (set(range(1, 59)) | set(range(101, 508))) - ABOLISHED

NAME_NUM = re.compile(r"国道\s*(\d+)\s*号")

FOOT_HIGHWAYS = {"path", "footway", "steps", "track", "cycleway", "bridleway"}
NATIONAL_GRADE = {"trunk", "motorway"}

# まだ造っている道についての同じ格。かつては `primary` も入っており、それが
# primary を締め出す規則の唯一の裏口だった。RULES.md が primary を外すのは、
# primary に付いた数字だけの `ref` が何も証明しないからである。長野県では、
# リレーションに属さない primary の way 3,305 本がそれを持ち、国道 と名乗る物は
# 1 本も無い。`construction=primary` はその一群を通していた。北海道道39号
# 奥尻島線が、国道39号の走る場所から 292 km 離れた所で国道39号になり、京都府の
# 山手幹線と岩屋バイパスが国道2号になった。全国で正しく入ったのは 5 アーク
# (栗東水口道路、国道1号の 1.6 km)だけである。その道は、開通してタグが付け直され
# れば戻る。
NATIONAL_GRADE_UNDER_CONSTRUCTION = {"trunk", "motorway"}

# bbox の縁の許容差(度)。本物の端点ではなく、地域を切ったせいで生じた端点を
# 抑えるのに使う。
EDGE_TOL = 0.02

# 二つの路線の端点が同じ交差点だと見なせる隔たりの上限。1 つの交差点は流入方向
# ごとの複数の OSM ノードでできているので、そこで出会う路線の端点は交差点の上に
# 散らばる。decree.py もこれを読み、法令上の起終点と OSM の切れ目を見分ける。
TERMINI_CLUSTER_M = 150


# ------------------------------------------------------------------ 指定 ---
def tokens(ref: str | None) -> set[int]:
    """`ref` の値に入っている国道番号を、トークンごとに読む。

    `ref=4;6;14;17` は四つの指定であって 1 つの文字列ではない。値の全体で照合
    すると(重用区間が消える誤りがこれである)、四つを全部落とす。
    """
    out: set[int] = set()
    for tok in (ref or "").split(";"):
        tok = tok.strip()
        if tok.isdigit() and int(tok) in VALID:
            out.add(int(tok))
    return out


# この用途に `official_name` は信用できない。way/263470309(精進ブルーライン。
# `ref=358` で国道358号のリレーションに入っている)は
# `official_name=一般国道368号` を持つ。三重県の路線番号を山梨県へ持ち込んだ、
# OSM 側の打ち間違いである。読むのは主たる名前の欄だけで、それも下で裏取りする。
NAME_FIELDS = ("name", "name:ja")

# way が海上区間だと述べうる欄。投稿者はおよそ半分を名前に、残り半分を
# `description` に書く。二つの半分は別々の路線で、同じ物を二度述べているのでは
# ない(下の SEA_SECTION)。
SEA_FIELDS = (*NAME_FIELDS, "description", "note")

# このファイルの規則が参照する way のタグの全部で、全国の切り出しが運べばよい
# 唯一の集合でもある。extract_pbf.py はこれを書き写さず import する。新しいタグ
# を読み始める規則は、この集合を広げねばならない。さもないと、あちらが作る
# キャッシュからそのタグが暗黙のうちに欠ける。
#
# `oneway` は例外である。ここのどの規則も読まないし、読むべきでもない。どちらの
# 車道かは、国道かどうかにも何号かにも関わらない。読むのは
# compare_annual_report.py で、上下線分離の二つの車道(OSM では way 2 本、
# 台帳では 1 本ぶんの延長)と、ただ並んで走る側道とを見分けるのに使う。ここに
# 並べてあるのは、この集合が切り出しの運ぶ物だからである。
TAGS_USED = frozenset({
    *SEA_FIELDS, "ref", "highway", "construction", "route", "access", "motor_vehicle",
    "proposed", "planned",
    "historic:highway", "oneway",
})

# 新しい線形に迂回された区間。意図して残す。旧道は指定解除まで法令上は国道の
# ままで、解除はバイパスの開通から何年も遅れる。地理院地図が国道として描き
# 続けるのも同じ理由による。OSM の投稿者はむしろ実態を記録する(`ref` を外し、
# `highway` の格を下げ、ルートリレーションから外す)ので、これはタグ付けの偶発
# ではなく系統的な食い違いである。濾さずにフラグを立てるのは、地図が旧道を
# 区別して出せるようにするためである。
FORMER_ALIGNMENT = re.compile(r"旧道|廃道|旧国道")


def name_numbers(tags: dict[str, str], fields: tuple[str, ...] = NAME_FIELDS) -> set[int]:
    blob = " ".join(tags.get(k, "") for k in fields)
    return {int(m) for m in NAME_NUM.findall(blob) if int(m) in VALID}


# way/152895667(長野・静岡県境にある 19 m の橋)は、名前で旧道と述べたことが
# 一度も無い。`name` を持たず、`old_name=国道152号`、`highway=residential`、
# `route=hiking`・`tourism=yes` だけを持つ。OSM が記録する実態は「今はハイキング
# ルートである」で、旧道・廃道 の語ではなく OSM の書き方で書かれている。しかも
# 今も現行の国道152号のリレーションに載っている(規則 a は、古いままの所属と
# 生きた所属を区別しない)ので、これが無ければふつうの国道として描かれた。
# `historic:highway` は「かつてこの格の道だった。今は違う」を述べる OSM の書き方
# で、名前の欄とは独立である。国道リレーションが保証する way 全部に対して全国で
# 測ると、名前で旧道と述べないままこれを持つ way は 1 本である。CASES.md 21。
def is_former(tags: dict[str, str]) -> bool:
    blob = " ".join(tags.get(k, "") for k in NAME_FIELDS)
    if FORMER_ALIGNMENT.search(blob):
        return True
    return "historic:highway" in tags


def resolve_relation_routes(rels: dict[int, dict]) -> dict[int, set[int]]:
    """リレーションごとに、それが表す路線番号。親から継承する。

    バイパスのリレーション(`name=長野バイパス`)は `ref` を持たないことが多い。
    番号は、それをメンバーとして抱えるリレーションから来るしかない。
    """
    own: dict[int, set[int]] = {}
    for rid, rel in rels.items():
        tags = rel.get("tags", {})
        own[rid] = tokens(tags.get("ref")) or name_numbers(tags)

    children: dict[int, list[int]] = defaultdict(list)
    for rid, rel in rels.items():
        for m in rel.get("members", []):
            if m["type"] == "relation" and m["ref"] in rels:
                children[rid].append(m["ref"])

    # 何も決まらなかった子へ、親の番号を降ろす。実際の深さは 2〜3 なので、
    # 変化が止まるまで繰り返し、回数に上限を置く。
    for _ in range(5):
        changed = False
        for rid, kids in children.items():
            if not own[rid]:
                continue
            for kid in kids:
                if not own[kid]:
                    own[kid] = set(own[rid])
                    changed = True
        if not changed:
            break
    return own


def resolve_competing_claims(competing_relations: list[dict]) -> dict[int, set[int]]:
    """メンバーの way ごとに、国道でないどの番号で主張されているか。

    way がある県道のリレーションに載っている理由は、その way の指定と無関係な
    ことがある。広島南道路(国道2号)は今も、たまたま広島県道243号広島港線の
    メンバーである。リレーションが主張する番号を way ごとに記録しておけば、
    下の裏取りは、競合するリレーションに載っていること自体を失格の理由にせず、
    その番号と way 自身の主張とを比べられる。

    `competing_relations` の大半は都道府県道のリレーションだが、事業者が自分の
    路線番号を名乗る体系も同じ形の主張をする。way/560259106(首都高速都心環状線、
    `ref=1`)は `network=首都高速道路`、`ref=1` のリレーションに載っている。県道
    との衝突と同じ形で、番号を名乗る主体が違うだけである。CASES.md 20 を参照。
    """
    claims: dict[int, set[int]] = defaultdict(set)
    for rel in competing_relations:
        nums = tokens(rel["tags"].get("ref")) or name_numbers(rel["tags"])
        if not nums:
            continue
        for wid in rel["members"]:
            claims[wid] |= nums
    return claims


# 国道の海上区間。下に道が無いまま、指定だけが水面を渡る。大半は `route=ferry`
# を持たない。全国で 20 アーク、1,390 km ぶんの外洋が車道として分類され、実線で
# 描かれていた。航路としてタグ付けされていたのは 2 アーク、63 km である。
# 走れそうに見える 295 km の直線こそ、破線の海上国道の層が防ごうとしている
# 取り違えなので、海上区間 の語を見たままの証拠として読む。
#
# その語はいつも名前にあるとは限らない。日本で 海上区間 と述べている 34 本の
# うち、20 本は `name` に書き、14 本は `description` か `note` にしか書いて
# いない。その 14 本は別の路線である。名前だけを読む規則が効いていたあいだ、
# 16・28・30・42・57・259・317・324 号が、東京湾・明石海峡・備讃瀬戸・伊勢湾・
# 有明海を実線の道として渡っていた。二つの欄で 1 つの証拠である。
SEA_SECTION = re.compile(r"海上区間")

# 指定はされているが道がまだ無い区間。ルートリレーションを繋ぐために OSM の
# 投稿者が引いた直線で、走れる物ではない。全国で 86 アーク、173.3 km(`proposed`
# が 76、`planned` が 10)。最長は国道360号の 16.4 km(白山白川郷ホワイトロードが
# 代替路)、次いで国道274号の 16.1 km(`description=国道274号不通区間`)である。
# `road` のままにすると実線で描かれ、CASES.md 8 と 12 の「何も無い所に直線を
# 引くと走れる道に読める」誤りが、今度は陸で起きる。
#
# この判定は上の海上区間の判定より後に置く。全国で 海上区間 と述べている 34 本
# のうち 32 本が `highway=planned` を持つ(CASES.md 12)ので、`hw` を先に見ると
# 実線の道へ戻り、あの修正が帳消しになる。
UNOPENED_HIGHWAYS = {"planned", "proposed"}

# 同じことを逆向きにタグ付けした形。`highway` のキーを持たず、`proposed=trunk`
# や `planned=*` だけを持つ way である。「造ればこの格になる」であって「これは道
# である」ではない。way/743758644(岐阜県、layer=-5)は国道257号のリレーションの
# メンバーだが、下に道が無い。トンネルも無く、航空写真にも何も無い。峠を貫く直線
# があるだけである。`hw` が `None` なので上の UNOPENED_HIGHWAYS をすり抜けて
# ふつうの `road` に読める。国道リレーションが保証する way 全部に対して全国で
# 測ると、該当はこの 1 本だけである。CASES.md 22 を参照。
UNOPENED_TAGS = {"proposed", "planned"}

# 高速道路として指定された国道。平面交差も平面からの出入りも無く、
# `highway=motorway` で描かれる。国道番号のうえに高速道路の路線番号を自分で持つ
# (第二神明道路は `ref=E93;2`、東海環状自動車道は `ref=C3;475`)。走り方も
# 平面国道とは違う。そもそもこの道が `ref=E93;2` の形の不具合の陰に隠れた
# 理由がそれである(extract_pbf.py が `tokens` を import する理由)。走れる本物の
# 車道なので、上の破線の区分には加えず実線のままにする。凡例と表示の切り替えを
# 自分で持つのは、この区分そのものが別種の道だからである。
#
# 手掛かりは `highway=motorway` だけで、E で始まる `ref` の有無ではない。全国で
# 測ると、候補の way のうち両方を持つ物が 6,321 本、別の接頭辞(C3、A1 など)で
# motorway の格を持つ物が 6,619 本ある。高速道路番号を持ちながら motorway でない
# 物は 199 本しかなく、すべて `construction=motorway` で、上の `construction` の
# 区分が既に引き取っている。`ref` の書式で照合すると C・A で始まる道を取りこぼす
# うえ、OSM がこの区分のために付けている格で照合するのに比べて得る物が無い。


def classify(tags: dict[str, str]) -> str:
    """その道のひと切れが、どの凡例に属するか。"""
    if tags.get("route") == "ferry":
        return "ferry"
    if SEA_SECTION.search(" ".join(tags.get(k, "") for k in SEA_FIELDS)):
        return "ferry"
    hw = tags.get("highway")
    if hw == "construction" or "construction" in tags:
        return "construction"
    if hw in UNOPENED_HIGHWAYS:
        return "unopened"
    if hw is None and UNOPENED_TAGS & tags.keys():
        return "unopened"
    if hw == "steps":
        return "steps"
    if hw in FOOT_HIGHWAYS:
        return "foot"
    if hw == "motorway":
        return "expressway"
    return "road"


# 都市高速道路は自分の路線に番号を付けており、その番号は国道番号と同じ見た目で
# `ref` に載る。首都高速4号新宿線は `ref=4` を持つが、国道4号は青森へ向かう道で
# ある。全国では、これが 303 アーク、208 km の都市高速を十一の国道の上に載せて
# いた。裏取りはこれを見つけられない。国道4号は実際に同じ都県を通っているからで
# ある。
#
# これを参照するのは規則 c だけである。リレーションが保証する way と、自分の
# 名前で 国道N号 と述べている way は影響を受けない。都市高速の一部は本当に指定
# を受けており、その場合は名前がそう述べている。
URBAN_EXPRESSWAY = re.compile(r"高速\s*\d+\s*号")


def names_an_expressway_route(tags: dict[str, str]) -> bool:
    blob = " ".join(tags.get(k, "") for k in NAME_FIELDS)
    return bool(URBAN_EXPRESSWAY.search(blob)) and not NAME_NUM.search(blob)


def is_national_grade(tags: dict[str, str]) -> bool:
    hw = tags.get("highway")
    if hw in NATIONAL_GRADE:
        return True
    if hw == "construction":
        return tags.get("construction") in NATIONAL_GRADE_UNDER_CONSTRUCTION
    return False


# ルートリレーションが抱えるのは道路の way だけのはずだが、記入の誤りで別の物も
# 載る。レッドバロン川口南(小売店の建物の輪郭)は、`highway` タグを持たないまま
# 国道122号のリレーションに載っており、指定されたアークとして描かれていた。
# 全国で測ると、`highway` タグを持たないリレーションのメンバーは 124 件ある。
# そのうち閉じた環(建物の外形線や、トンネル・橋の輪郭を別に記録した物)は
# 数件しかない。残りは `国道352号` のような名前を持ち、実際に道の形をしていて、
# たまたまタグが抜けているだけなので残す。`route=ferry` をこの検査から外すのは、
# 海上区間の way が `highway` を持たないのは正当だからである。
def is_building_like(tags: dict[str, str], geometry: list[dict]) -> bool:
    if "highway" in tags or tags.get("route") == "ferry":
        return False
    return len(geometry) >= 2 and geometry[0] == geometry[-1]


# 主張が名前(国道6号)しかなく、格と通行規制のタグが、通り抜けできない生活道路を
# 述べている way。way/497559205(highway=residential、access=no、
# motor_vehicle=no)は福島県の内陸深くにあり、国道6号の太平洋岸の経路からは
# 大きく外れている。地理院地図もただの市道として描く。
#
# `highway` の格だけでは決められない。全国で、規則 b が名前だけで認める way は
# 10,810 本あり、そのうち `residential` は 33 本である。他の 32 本は、正当に
# 指定された旧道・側道か、`ref` を持ちふつうに車が通る本物の国道である。
# residential であることと自動車が通れないことの両方に絞ると、全国で当たるのは
# この way 1 本だけである。
def names_a_closed_residential_road(tags: dict[str, str]) -> bool:
    return (
        tags.get("highway") == "residential"
        and tags.get("access") == "no"
        and tags.get("motor_vehicle") == "no"
    )


# ------------------------------------------------------------------ main ---
def write_index() -> list[dict]:
    """build/regions/ に在る meta から regions.json を作り直す。

    閲覧側が地域を選べるようにするためである。読むのは decree.py と pack_web.mjs
    で、どちらも全県が揃ってから走る段である。

    1 県の話ではなく揃っている物すべての話なので、県ごとの判定はここを呼ばない。
    呼ぶのは、県の集合を回し終えた build_all.py と pipeline.py が `--index-only`
    で 1 度だけである。かつては判定の最後にここが走っていたが、県を並列にすると
    47 本が同じ 1 ファイルを置き換えに来る。Windows の os.replace は、その相手を
    誰かが開いているあいだ PermissionError(WinError 5)で落ちる。並列度 4 で実際
    に落ちた(issue #103)。書く人を 1 人にすれば競争そのものが無くなる。
    """
    index = []
    for p in sorted(OUT.glob("*.meta.json")):
        m = json.loads(p.read_text(encoding="utf-8"))
        index.append({
            "region": m["region"],
            "label": m.get("label", m["region"]),
            "bbox": m["bbox"],
            "arc_count": m["arc_count"],
            "total_km": m["total_km"],
            "routes": len(m["routes"]),
        })
    write_atomic(OUT / "regions.json",
                 json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    return index


def main() -> None:
    args = sys.argv[1:]
    if "--index-only" in args:
        index = write_index()
        print(f"wrote regions.json ({len(index)} region(s): "
              f"{', '.join(e['label'] for e in index)})")
        return
    region = args[0] if args else "nagano"
    raw_path = CACHE / f"{region}.raw.json"
    if not raw_path.exists():
        raise SystemExit(f"no cache for {region!r}; run pipeline/fetch_osm.py {region} first")

    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    if "core" not in raw:
        raise SystemExit("cache is in the old single-query format; re-run pipeline/fetch_osm.py")
    if "competing_relations" not in raw:
        raise SystemExit(
            "cache predates per-number competing claims; re-run pipeline/fetch_osm.py")

    base_ts = raw["timestamp_osm_base"]
    bbox = raw["bbox"]
    print(f"OSM data base: {base_ts}   fetched: {raw['fetched_at']}")

    rels = {e["id"]: e for e in raw["core"] if e["type"] == "relation"}
    ways: dict[int, dict] = {}
    for src in ("core", "candidates"):
        for e in raw[src]:
            if e["type"] == "way" and e.get("geometry") and not is_building_like(
                    e.get("tags", {}), e["geometry"]):
                ways.setdefault(e["id"], e)
    competing_claims = resolve_competing_claims(raw["competing_relations"])
    competing_ids = set(competing_claims)
    print(f"loaded {len(rels)} relations, {len(ways)} distinct ways, "
          f"{len(competing_ids)} competing-claimed ways")

    rel_routes = resolve_relation_routes(rels)
    unresolved = [r for r, v in rel_routes.items() if not v]
    print(f"relations resolved to a route number: {len(rels) - len(unresolved)}/{len(rels)}")

    # どの way を、どの番号の国道リレーションが含んでいるか。
    by_relation: dict[int, set[int]] = defaultdict(set)
    vouched: set[int] = set()
    for rid, rel in rels.items():
        nums = rel_routes[rid]
        for m in rel.get("members", []):
            if m["type"] != "way":
                continue
            vouched.add(m["ref"])
            if nums:
                by_relation[m["ref"]] |= nums

    # way の `ref` から読んだ番号は、その地域のどれかのリレーションが、その
    # 国道がここに在ると独立に主張しているときだけ信じる。これが無いと、
    # way/31660216 (長野県道372号三才大豆島中御所線、`ref=372`)が、京都から
    # 兵庫の路線である国道372号を長野に置く。
    corroborated: set[int] = set()
    for nums in rel_routes.values():
        corroborated |= nums

    arcs = []
    kinds = Counter()
    n_hist = Counter()
    sources = Counter()
    rejected: Counter = Counter()
    dropped: list[int] = []
    rel_added = 0
    tag_added = 0
    name_added = 0
    formers = 0

    for wid, w in ways.items():
        tags = w.get("tags", {})
        from_rel = by_relation.get(wid, set())
        # way 自身の主張は、名前由来も `ref` 由来も裏取りの対象である。この
        # 地域にどの路線が在るかを定めるのはリレーションだけである。
        raw_name = name_numbers(tags)
        raw_tag = tokens(tags.get("ref"))
        from_name = raw_name & corroborated
        # この way の `ref` が主張する番号は、競合するリレーションがその way に
        # ついて同じ番号を主張しているとき信じない。規則 b が止める長野の 372 号
        # の衝突がこれで、首都高速都心環状線(事業者名のリレーションの下の
        # `ref=1`。CASES.md 20)も同じ形である。無関係な別の番号のリレーションに
        # 載っているだけなら信じる。広島南道路(国道2号)は今も広島県道243号
        # 広島港線のメンバーで、巴橋(国道375号;433号;434号)は広島県道39号の
        # メンバーだが、どちらも way 自身が主張する番号との衝突ではない。
        from_tag = (raw_tag & corroborated) - competing_claims.get(wid, set())
        for n in (raw_tag | raw_name) - corroborated:
            rejected[n] += 1

        # --- そもそも国道か ---------------------------------------------
        if from_rel or from_name:
            if from_rel:
                source = "relation"
            elif names_a_closed_residential_road(tags):
                # 名前は 国道N号 だが、格も通行規制も通り抜けできない生活道路と
                # 同じで、裏付けるリレーションも無い
                # (names_a_closed_residential_road)。
                dropped.append(wid)
                continue
            else:
                source = "name"
        elif (from_tag and not names_an_expressway_route(tags)
              and (wid in vouched or is_national_grade(tags))):
            # 番号を述べるリレーションが無く、`ref` 由来の番号だけが残った way。
            # 番号を解決できないリレーションに属するか、どのリレーションにも
            # 属さず国道の格で描かれているかで、その番号を主張する競合する路線も
            # 無い。バイパスの場合がこれである。
            source = "tag"
        else:
            dropped.append(wid)
            continue

        refs = from_rel | from_name | from_tag
        if not refs:
            dropped.append(wid)
            continue

        if from_rel - (from_tag | from_name):
            rel_added += 1
        if from_tag - (from_rel | from_name):
            tag_added += 1
        if from_name - (from_rel | from_tag):
            name_added += 1

        coords = [(p["lat"], p["lon"]) for p in w["geometry"]]
        if len(coords) < 2:
            dropped.append(wid)
            continue

        kind = classify(tags)
        kinds[kind] += 1
        n_hist[len(refs)] += 1
        sources[source] += 1
        former = is_former(tags)
        if former:
            formers += 1

        arcs.append({
            "id": wid,
            "former": former,
            "refs": sorted(refs),
            # 区切り文字で囲む。絞り込みが、4 を 14・24・400 の中に当てずに
            # 所属を検査できるようにするためである。
            "refs_key": "," + ",".join(str(r) for r in sorted(refs)) + ",",
            "n": len(refs),
            "kind": kind,
            "src": source,
            "name": tags.get("name"),
            "updated": (w.get("timestamp") or "")[:10],
            "length_m": line_length(coords),
            "coords": coords,
        })

    print(f"\narcs built: {len(arcs)}   dropped: {len(dropped)}")
    print(f"  admitted by: {dict(sources)}")
    print(f"  kinds: {dict(kinds)}")
    print(f"  concurrency histogram (n -> arcs): {dict(sorted(n_hist.items()))}")
    print(f"  designations contributed only by relations: {rel_added}")
    print(f"  designations contributed only by the ref tag: {tag_added}")
    print(f"  designations contributed only by the name:    {name_added}")
    print(f"  arcs flagged as former alignment (旧道):        {formers}")
    if rejected:
        print(f"  ref tokens rejected as uncorroborated (likely 都道府県道): "
              f"{dict(sorted(rejected.items()))}")

    # 規則 c が実際に何を足したか。ここに出るのが、今まで欠けていた道である。
    tag_only = [a for a in arcs if a["src"] == "tag"]
    by_name = Counter((tuple(a["refs"]), a["name"]) for a in tag_only)
    print(f"\n  relation-less roads recovered by rule (c): {len(tag_only)} arcs, "
          f"{sum(a['length_m'] for a in tag_only) / 1000:.1f} km")
    for (refs, name), c in by_name.most_common(14):
        print(f"    国道{'・'.join(map(str, refs)):<12} {name!s:<24} x{c}")

    # ---- 路線ごとの台帳 --------------------------------------------------
    routes: dict[int, dict] = {}
    for a in arcs:
        for r in a["refs"]:
            e = routes.setdefault(
                r, {"ref": r, "length_m": 0.0, "arcs": 0, "max_n": 1, "kinds": Counter()}
            )
            e["length_m"] += a["length_m"]
            e["arcs"] += 1
            e["max_n"] = max(e["max_n"], a["n"])
            e["kinds"][a["kind"]] += 1

    print(f"\nroutes present in region: {len(routes)}")
    print("  " + ", ".join(str(r) for r in sorted(routes)))

    # ---- 起終点。路線自身の部分グラフの中で次数 1 のノード ---------------
    south, west, north, east = bbox

    def on_edge(lat: float, lon: float) -> bool:
        return (
            lat - south < EDGE_TOL
            or north - lat < EDGE_TOL
            or lon - west < EDGE_TOL
            or east - lon < EDGE_TOL
        )

    # 点ごとに、その路線のアークの端が幾つ集まるか。1 回しか触れられない点は、
    # その路線がそこで終わる場所である。2 回以上なら通り抜けている。
    #
    # アークを 1 回だけ辿り、路線ごとに辿り直さない。かつては路線の繰り返しが
    # 外にあり、13,000 本のアークを読み直しては、自分の物でない 12,000 本を
    # 飛ばしていた。アークは属する路線を名指ししているので、通りがかりにその
    # 全部へ渡せばよい。丸め方も、端を数える順も、路線が出てくる
    # 順も変えていないので、作る一覧は同じ物である。
    ends_of: dict[int, Counter] = defaultdict(Counter)
    for a in arcs:
        ends = [
            (round(p[0], 7), round(p[1], 7))
            for p in (a["coords"][0], a["coords"][-1])
        ]
        for r in a["refs"]:
            for p in ends:
                ends_of[r][p] += 1

    endpoints = []
    for r in sorted(routes):
        for (lat, lon), d in ends_of[r].items():
            if d == 1 and not on_edge(lat, lon):
                endpoints.append({"ref": r, "lat": lat, "lon": lon})

    print(f"\ncandidate termini inside the region: {len(endpoints)}")

    clusters: list[dict] = []
    for e in endpoints:
        for c in clusters:
            if haversine((e["lat"], e["lon"]), (c["lat"], c["lon"])) < TERMINI_CLUSTER_M:
                c["refs"].add(e["ref"])
                break
        else:
            clusters.append({"lat": e["lat"], "lon": e["lon"], "refs": {e["ref"]}})
    shared = [c for c in clusters if len(c["refs"]) > 1]
    print(f"  clusters: {len(clusters)}, shared by 2+ routes: {len(shared)}")

    # ---- 重用ランキング(地図が隠している物を出す機能) --------------------
    combos: dict[tuple[int, ...], dict] = {}
    for a in arcs:
        if a["n"] < 2:
            continue
        key = tuple(a["refs"])
        e = combos.setdefault(
            key, {"refs": list(key), "n": a["n"], "length_m": 0.0, "arcs": 0, "names": Counter()}
        )
        e["length_m"] += a["length_m"]
        e["arcs"] += 1
        if a["name"]:
            e["names"][a["name"]] += 1
    ranking = sorted(combos.values(), key=lambda e: (-e["n"], -e["length_m"]))
    for e in ranking:
        e["names"] = [n for n, _ in e["names"].most_common(3)]

    print("\ntop concurrency combinations:")
    for e in ranking[:8]:
        nm = " / ".join(e["names"][:2]) or "—"
        print(f"  {e['n']}x {e['refs']}  {e['length_m'] / 1000:6.1f} km  {nm}")

    # ---- write ----------------------------------------------------------
    OUT.mkdir(parents=True, exist_ok=True)

    features = [
        {
            "type": "Feature",
            "properties": {
                "id": a["id"],
                "refs": a["refs_key"],
                "refs_list": a["refs"],
                "n": a["n"],
                "kind": a["kind"],
                "src": a["src"],
                "former": 1 if a["former"] else 0,
                # これを 1 にするのは apply_n13.py だけである(issue #9)。
                # `former` とは独立で、旧道のアークは former=1 のままである。
                # 指定解除(revoked)は OSM のタグ付けより何年も
                # 遅れうるからである(RULES.md 旧道)。0 は「未確認」であって
                # 「現役だと確認済み」ではない。
                "revoked": 0,
                "name": a["name"],
                "updated": a["updated"],
                "km": round(a["length_m"] / 1000, 3),
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [[round(lon, 6), round(lat, 6)] for lat, lon in a["coords"]],
            },
        }
        for a in arcs
    ]
    gj_path = OUT / f"{region}.geojson"
    write_atomic(
        gj_path,
        json.dumps({"type": "FeatureCollection", "features": features},
                   ensure_ascii=False, separators=(",", ":")),
    )

    edits = sorted(a["updated"] for a in arcs if a["updated"])
    total_km = sum(a["length_m"] for a in arcs) / 1000
    meta = {
        "region": region,
        "label": for_region(region)["label"],
        "bbox": [west, south, east, north],
        "osm_timestamp": base_ts,
        "fetched_at": raw["fetched_at"],
        "endpoint": raw["endpoint"],
        # その地域のリレーションが保証する路線番号の全部。`routes` の中身がこの
        # 集合から外れてはならない(pipeline/verify.py)。
        #
        # 裏取りを裏取りたらしめているのがこの集合で、効くのは
        # 地域ごとだからである。全国でまとめて判定すれば 459 番すべてに近づいて
        # 何も濾さなくなり、長野県道372号が国道372号として地図へ戻る。この集合が
        # そこまで大きくならないことは verify.py が断定する。
        "corroborated_refs": sorted(corroborated),
        # way が自分について主張したが、この地域のどのリレーションも
        # 保証しなかった番号と、それぞれを主張した way の数。ほとんどは、
        # 数字だけの `ref` の書式を共有する都道府県道である。裏取りの効果を
        # 実測した数として記録する。
        "rejected_refs": {str(k): v for k, v in sorted(rejected.items())},
        "oldest_edit": edits[0] if edits else None,
        "newest_edit": edits[-1] if edits else None,
        "total_km": round(total_km, 1),
        "arc_count": len(arcs),
        "sources": dict(sources),
        "former_arcs": formers,
        "routes": [
            {
                "ref": r,
                "km": round(v["length_m"] / 1000, 1),
                "arcs": v["arcs"],
                "max_n": v["max_n"],
                "kinds": dict(v["kinds"]),
            }
            for r, v in sorted(routes.items())
        ],
        "concurrency_ranking": [
            {
                "refs": e["refs"],
                "n": e["n"],
                "km": round(e["length_m"] / 1000, 2),
                "arcs": e["arcs"],
                "names": e["names"],
            }
            for e in ranking
        ],
        "termini": [
            {"lat": round(e["lat"], 6), "lon": round(e["lon"], 6), "ref": e["ref"]}
            for e in endpoints
        ],
        "shared_termini": [
            {"lat": round(c["lat"], 6), "lon": round(c["lon"], 6), "refs": sorted(c["refs"])}
            for c in sorted(shared, key=lambda c: -len(c["refs"]))
        ],
        "n_histogram": {str(k): v for k, v in sorted(n_hist.items())},
    }
    meta_path = OUT / f"{region}.meta.json"
    write_atomic(
        meta_path, json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
    )

    print(f"\ntotal arc length: {total_km:,.0f} km")
    print(f"way last-edit range: {meta['oldest_edit']} .. {meta['newest_edit']}")
    print(f"wrote {gj_path.name} ({gj_path.stat().st_size / 1e6:.2f} MB)")
    print(f"wrote {meta_path.name} ({meta_path.stat().st_size / 1e3:.1f} kB)")


if __name__ == "__main__":
    main()
