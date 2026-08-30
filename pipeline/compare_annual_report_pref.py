# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""都道府県道について、地図の km と道路統計年報の km の差が何でできているかを説明する。

国道の compare_annual_report.py と同じ問いを、13,334 路線について訊く。違うのは
二つある。

  1. 期待値が手で書けない。459 路線なら expectations.py に「確実に通る路線」を
     並べられたが、13,334 では並べられない。だから独立した出どころ——年報の県別の
     表と N13——との突き合わせだけが物差しになる
  2. 判定がまだ無い。判定(#98)より先にこの段を立てる。判定が終わってから検証を
     作ると、判定に合わせた検証になる。だからここが読むのは生成物ではなく、
     survey_prefectural.py が OSM から測ったそのままの値である

台帳の定義を、そのまま計算の骨にする。年報はどの表でも
実延長 = 総延長 - 重用延長 - 未供用延長 - 渡船延長 と述べる。
総延長は路線ごとの延長の和で、重用区間はその路線の数だけ数えられる。実延長は
道そのものの長さで、重なりは一度しか数えない。

道路法では、重なった区間は格の高い路線の実延長に入り、低いほうの重用延長に入る。
だからこう置ける。

  ある way の指定が n 個あるとき
    その way が国道でもあるなら  n 個すべてが重用。実延長には入らない
    国道でないなら              1 個が実延長、残る n-1 個が重用

これは年報の定義そのものであって、こちらが考えた近似ではない。この置き方だと
表11 = 表12 + 表13 が計算のうえでも成り立つ。

種別は番号帯で分ける。主要地方道か一般都道府県道かは、政令で決まる法令上の区別である。OSM はそれを
直接持たない。持っているのは道の格(primary・secondary)と番号で、実測では
primary の 95.5% が `ref` 100 以下、secondary の 99.5% が 101 以上である。

分けるのに使うのは番号帯のほうである。格は道の作りを述べるのであって、路線の
格付けを述べるのではない。二つが食い違う way は、下の「番号帯と道路の格」で
そのまま報告する。数えるのに使わなかった側を、代わりに見張りに使う。

県別の突き合わせでは、年報は県の行と政令指定都市の行を分ける。地図は道路管理者を区別しないので、
突き合わせる相手は両方の和である(annual_report.Prefecture)。

県境を跨ぐ way は、長さの過半が入る県に寄せてある(prefectures.py)。寄せた結果
はみ出す少数側の長さは、県別の差にそのまま現れる。だから県ごとの表にその量を
並べる。差がそれより小さい県について、差を論じても意味がない。

県ごとの差は、そのままでは上下線分離を含んだままである。都市部の県はそこが
大きい——東京都の +25.6% は、引くと -1.8% になる——ので、引いた後の残りも並べる。
県ごとの原因を見分けられるのは、この列があるからである。

使い方:  uv run pipeline/compare_annual_report_pref.py
         uv run pipeline/compare_annual_report_pref.py --distance 60
         uv run pipeline/compare_annual_report_pref.py --no-pairing
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict

import annual_report
from _paths import SURVEY
from compare_annual_report import (
    KIND_GROUP,
    SAMPLE_M,
    build_grid,
    one_timestamp,
    paired_fraction,
    row,
    take_distance,
)
from regions import REGIONS

# 主要地方道の番号帯の上限。実測では primary の 95.5% が 100 以下、secondary の
# 99.5% が 101 以上である。境目はこの二つの分布が交わる所にあり、好みで決めた値
# ではない。
MAJOR_MAX = 100

MAJOR, GENERAL = "major", "general"
RANKS = (MAJOR, GENERAL)
RANK_LABEL = {MAJOR: "主要地方道", GENERAL: "一般都道府県道"}
RANK_TABLE = {MAJOR: 12, GENERAL: 13}


# --------------------------------------------------------------------- 種別 ---
def rank_of(ref: int) -> str:
    return MAJOR if ref <= MAJOR_MAX else GENERAL


def is_national(doc: dict) -> bool:
    """その way は国道でもあるか。台帳が実延長として数えない側かどうかである。

    根拠は二つある。国道のルートリレーションが抱えていること、そして way 自身の
    タグが国道だと述べていること(extract_pbf.is_candidate が答える問いで、答えは
    survey_prefectural.py が書いてある)である。

    タグの側は、その way が都道府県道の格を持たないときにだけ効かせる。
    is_candidate は `highway=construction` を国道の格に数える——国道の工事中区間
    を拾うためである——ので、`construction=secondary`・`ref=34` の県道もそのまま
    通ってしまう。県道の工事中区間が国道として外れると、その延長は説明できない
    残りへ紛れ込む。primary・secondary は国道が使わない格なので、格が付いている
    way はタグでは国道にしない。

    判定そのもの(build_routes.py)ではない。判定はまだ都道府県道を知らないので、
    ここで判定を呼ぶと、検証が判定に依存する。
    """
    return doc["national_relation"] or (doc["grade"] is None and doc["national_tag"])


# --------------------------------------------------------------------- 集計 ---
class Tally:
    """1 県ぶん、あるいは全国ぶんの集計。

    `region` は、見つけた路線番号に県を添えるためにある。番号は県の中でしか一意
    でないので、全国の路線数は番号の数ではなく(県, 番号)の組の数である。県を
    添えずに足すと、47 県ぶんの番号が 1 つの集合へ潰れる。
    """

    def __init__(self, region: str | None = None) -> None:
        self.region = region
        self.designated_km: dict[str, float] = dict.fromkeys(RANKS, 0.0)
        self.actual_km: dict[str, float] = dict.fromkeys(RANKS, 0.0)
        self.km_by_kind: dict[str, float] = defaultdict(float)
        self.link_km_by_kind: dict[str, float] = defaultdict(float)
        self.arcs_by_kind: dict[str, int] = defaultdict(int)
        self.numbers: dict[str, set[tuple[str | None, int]]] = {r: set() for r in RANKS}
        # リレーションの網羅。#95 と #98 は way の本数で 59.8% / 40.8% と記録して
        # いる。復元率は延長で出るので、同じ集合について本数と延長の両方を測る。
        self.grade_ways: dict[str, int] = defaultdict(int)
        self.grade_km: dict[str, float] = defaultdict(float)
        self.held_ways: dict[str, int] = defaultdict(int)
        self.held_km: dict[str, float] = defaultdict(float)
        self.ways = 0
        self.dedup_km = 0.0
        self.former_km = 0.0
        self.former_arcs = 0
        self.link_arcs = 0
        self.national_km = 0.0
        self.national_arcs = 0
        self.national_designated_km = 0.0
        self.cross_arcs = 0
        self.cross_km = 0.0
        self.paired_km: dict[tuple[str, str, bool], float] = defaultdict(float)

    def add(self, doc: dict) -> None:
        refs = doc["refs"]
        if not refs:
            return
        km = doc["m"] / 1000
        self.ways += 1
        for ref in refs:
            self.designated_km[rank_of(ref)] += km
            self.numbers[rank_of(ref)].add((self.region, ref))
        if doc["grade"]:
            self.grade_ways[doc["grade"]] += 1
            self.grade_km[doc["grade"]] += km
            if doc["rel_refs"]:
                self.held_ways[doc["grade"]] += 1
                self.held_km[doc["grade"]] += km
        if doc.get("cross"):
            self.cross_arcs += 1
            self.cross_km += doc["cross_m"] / 1000
        if is_national(doc):
            self.national_km += km
            self.national_arcs += 1
            self.national_designated_km += km * len(refs)
            return
        # ここから先は、台帳が実延長として数える側である。
        self.dedup_km += km
        self.actual_km[MAJOR if any(r <= MAJOR_MAX for r in refs) else GENERAL] += km
        self.km_by_kind[doc["kind"]] += km
        self.arcs_by_kind[doc["kind"]] += 1
        if doc["link"]:
            self.link_km_by_kind[doc["kind"]] += km
            self.link_arcs += 1
        if doc["former"]:
            self.former_km += km
            self.former_arcs += 1

    def merge(self, other: Tally) -> None:
        for rank in RANKS:
            self.designated_km[rank] += other.designated_km[rank]
            self.actual_km[rank] += other.actual_km[rank]
            self.numbers[rank] |= other.numbers[rank]
        for src, dst in ((other.km_by_kind, self.km_by_kind),
                         (other.link_km_by_kind, self.link_km_by_kind),
                         (other.paired_km, self.paired_km)):
            for k, v in src.items():
                dst[k] += v
        for src, dst in ((other.arcs_by_kind, self.arcs_by_kind),
                         (other.grade_ways, self.grade_ways),
                         (other.grade_km, self.grade_km),
                         (other.held_ways, self.held_ways),
                         (other.held_km, self.held_km)):
            for k, v in src.items():
                dst[k] += v
        for name in ("ways", "dedup_km", "former_km", "former_arcs", "link_arcs",
                     "national_km", "national_arcs", "national_designated_km",
                     "cross_arcs", "cross_km"):
            setattr(self, name, getattr(self, name) + getattr(other, name))

    @property
    def designated_total(self) -> float:
        return sum(self.designated_km.values())

    def concurrent_km(self, rank: str | None = None) -> float:
        """復元できた重用延長。指定の延長から、実延長として数えた側を引いた残り。"""
        if rank is None:
            return self.designated_total - self.dedup_km
        return self.designated_km[rank] - self.actual_km[rank]

    def paired_sum(self, group: str, neighbour: str,
                   both_oneway: bool | None = None) -> float:
        return sum(v for (mine, other, one), v in self.paired_km.items()
                   if KIND_GROUP[mine] == group and other == neighbour
                   and (both_oneway is None or one == both_oneway))

    @property
    def dual_km(self) -> float:
        """上下線分離の二重計上。半分にする——二つの車道は互いを見つけるので、
        1 本の道が並走の合計へ自分の長さを二度持ち込む。超過はその二つ目だけで
        ある。"""
        return self.paired_sum("open", "open", True) / 2


# ----------------------------------------------------------------- 入力 ---
def load_region(region: str) -> tuple[dict, list[dict]]:
    path = SURVEY / f"{region}.json"
    if not path.exists():
        raise SystemExit(
            f"{path} is missing; run `mise run survey-pref` first")
    doc = json.loads(path.read_text(encoding="utf-8"))
    return doc, doc["ways"]


def to_arcs(docs: list[dict]) -> list[dict]:
    """並走の測定が読む形。compare_annual_report.paired_fraction が要求する鍵に
    そのまま合わせる。あちらの測り方をここへ書き写さないための変換である。

    座標は局所的な正距円筒の枠の中の m に直す。あちらの load_region と同じ扱い
    である。
    """
    if not docs:
        return []
    lat = sum(d["geometry"][0][0] for d in docs) / len(docs)
    kx, ky = 111320.0 * math.cos(math.radians(lat)), 110540.0
    return [{
        "id": d["id"],
        "refs": frozenset(d["refs"]),
        "kind": d["kind"],
        "former": d["former"],
        "km": d["m"] / 1000,
        "oneway": d["oneway"],
        "pts": [(lon * kx, lat_ * ky) for lat_, lon in d["geometry"]],
    } for d in docs]


def measure_pairs(docs: list[dict], reach: float) -> dict[tuple[str, str, bool], float]:
    """1 県の中で、同じ番号の way が並んで走る長さ。

    国道でもある way は外す。台帳がその区間を都道府県道の実延長として数えて
    いないので、二重計上の量にも入らない。旧道とランプを外す理由は
    compare_annual_report.measure と同じである。
    """
    pool = to_arcs([d for d in docs
                    if d["refs"] and not is_national(d) and d["kind"] in KIND_GROUP
                    and not d["former"] and not d["link"]])
    if not pool:
        return {}
    grid = build_grid(pool, reach)
    out: dict[tuple[str, str, bool], float] = defaultdict(float)
    for i, arc in enumerate(pool):
        if arc["km"] == 0.0:
            continue
        for key, metres in paired_fraction(arc, i, pool, grid, reach, reach).items():
            out[key] += metres / 1000.0
    return out


# ----------------------------------------------------------------- 報告 ---
# 見出しの幅。compare_annual_report.row の既定より狭い。こちらは種別ごとに一段
# 下げた見出しを持つので、同じ幅だと右の列が押し出される。
LABEL_WIDTH = 26


def report_mismatched_band(rows: list[tuple], limit: int = 10) -> None:
    """番号帯と道路の格が食い違う way。

    どちらかが誤りである。番号が誤っていればその路線は別の県道になり、格が誤って
    いれば地図の線の太さと配信の分け方が変わる。どちらであるかはここでは決めない
    ——決めれば判定になる。量と、上から順の実例を出す。
    """
    print("\n番号帯と道路の格")
    for grade, expect in (("primary", GENERAL), ("secondary", MAJOR)):
        bad = [r for r in rows if r[0] == grade and r[1] == expect]
        km = sum(r[2] for r in bad)
        print(f"  {grade:10} なのに {RANK_LABEL[expect]:8} の番号帯: "
              f"{len(bad):6,} ways  {km:9,.1f} km")
        for _, _, way_km, region, refs, wid in sorted(bad, key=lambda r: -r[2])[:limit]:
            print(f"    {REGIONS[region]['label']:6} {refs!s:14} "
                  f"way/{wid:<12} {way_km:6.1f} km")


def report_number_range(per_region: dict[str, Tally],
                        ledger: dict[str, annual_report.Prefecture]) -> None:
    """番号が県内で妥当か。県ごとの番号の数を、年報の路線数の幅と突き合わせる。

    番号は県の中でしか一意でないので、番号が妥当かどうかは県を決めてからでないと
    訊けない。台帳の側は数え上げなので足せず、幅でしか持てない——県の行が下限、
    県と政令指定都市の和が上限である(annual_report.Prefecture)。

    幅の上を超えた県は、その県に無い番号を地図が持っている。`ref` の打ち間違い、
    市町村道への県道番号の付与、県境を跨いだ way の寄せ間違いのどれかである。
    幅の下に届かない県は、路線が丸ごと地図に無い。どちらであるかは判定と N13 の
    仕事なので、ここでは量だけを出す。
    """
    over, under = [], []
    for region, t in per_region.items():
        p = ledger[region]
        found = sum(len(t.numbers[r]) for r in RANKS)
        if found > p.routes_max:
            over.append((found - p.routes_max, p.name, found, p.routes_max))
        elif found < p.routes_min:
            under.append((p.routes_min - found, p.name, found, p.routes_min))
    print("\n番号が県内で妥当か(地図の番号の数と、年報の路線数の幅)")
    print(f"  幅の中に収まる県 {47 - len(over) - len(under)}")
    print(f"  上限を超えた県 {len(over)}(その県に無い番号を持っている)")
    for excess, name, found, limit in sorted(over, reverse=True):
        print(f"    {name:6} {found:5,} > {limit:5,}  +{excess}")
    print(f"  下限に届かない県 {len(under)}(路線が丸ごと地図に無い)")
    for missing, name, found, limit in sorted(under, reverse=True):
        print(f"    {name:6} {found:5,} < {limit:5,}  -{missing}")


def main() -> None:
    args = sys.argv[1:]
    pairing = True
    if "--no-pairing" in args:
        pairing = False
        args.remove("--no-pairing")
    reach, args = take_distance(args)
    if args:
        raise SystemExit(f"unexpected argument: {args[0]}")

    ledger = {t: annual_report.total(t) for t in annual_report.PREFECTURAL_TABLES}
    by_pref = annual_report.prefectures(11)

    nation = Tally()
    per_region: dict[str, Tally] = {}
    band_rows: list[tuple] = []
    base: set[str] = set()

    print(f"道路統計年報2025 表11・表12・表13〈都道府県道〉 令和6年3月31日現在 "
          f"({annual_report.REPORT_CSV.name})")
    if pairing:
        print(f"上下線の判定: 側方 {reach:.0f} m 以内、{SAMPLE_M:.0f} m ごとに測る")
    else:
        print("上下線の判定: 測らない(--no-pairing)")
    print()

    for region in REGIONS:
        meta, docs = load_region(region)
        base.add(meta["timestamp_osm_base"])
        tally = Tally(region)
        for d in docs:
            tally.add(d)
            if d["grade"] and d["refs"]:
                band = {rank_of(r) for r in d["refs"]}
                if d["grade"] == "primary" and band == {GENERAL}:
                    band_rows.append(("primary", GENERAL, d["m"] / 1000, region,
                                      d["refs"], d["id"]))
                elif d["grade"] == "secondary" and band == {MAJOR}:
                    band_rows.append(("secondary", MAJOR, d["m"] / 1000, region,
                                      d["refs"], d["id"]))
        if pairing:
            tally.paired_km.update(measure_pairs(docs, reach))
        per_region[region] = tally
        nation.merge(tally)
        print(f"  {region:12} {len(docs):7,} ways", flush=True)

    stamp = one_timestamp(base)
    print(f"\n測ったもの build/survey  データ基準 {stamp}")

    # ---- 全国 --------------------------------------------------------------
    whole = ledger[11].km
    comparable = whole["total"] - whole["concurrent"]
    print("\n年報と地図(全国)")
    print(f"  {'項目':26} {'年報':>12} {'地図':>12}   差")
    print(row("総延長 / 指定延長", whole["total"], nation.designated_total, LABEL_WIDTH))
    print(row("実延長+未供用+渡船 / 重複排除", comparable, nation.dedup_km, LABEL_WIDTH))
    print(row("重用延長 / 復元できた重用", whole["concurrent"], nation.concurrent_km(),
              LABEL_WIDTH))
    print(row("旧道", whole["former"], nation.former_km, LABEL_WIDTH))
    print(f"  {'路線数':26} {ledger[11].routes:>12} "
          f"{sum(len(nation.numbers[r]) for r in RANKS):>12}"
          "   ※ 地図は(県, 番号)の組の数")

    print("\n種別ごと(番号帯で分ける)")
    for rank in RANKS:
        t = ledger[RANK_TABLE[rank]]
        print(f"  表{RANK_TABLE[rank]} {RANK_LABEL[rank]}")
        print(row("  総延長 / 指定延長", t.km["total"], nation.designated_km[rank],
                  LABEL_WIDTH))
        print(row("  実延長+未供用+渡船 / 重複排除",
                  t.km["total"] - t.km["concurrent"], nation.actual_km[rank], LABEL_WIDTH))
        print(row("  重用延長 / 復元できた重用", t.km["concurrent"],
                  nation.concurrent_km(rank), LABEL_WIDTH))

    # ---- 重用の復元 --------------------------------------------------------
    # 年報の重用延長 11,563 km が、重用をどれだけ復元できたかの物差しである。
    # 国道と重用する区間は OSM の way のタグに何も残らないので、リレーションが
    # 唯一の根拠になる。だから復元率はリレーションの整備状況が上限であって、
    # 推測ではなくここで測る。
    restored = nation.concurrent_km()
    with_national = nation.national_designated_km
    print("\n重用の復元")
    print(f"  年報の重用延長          {whole['concurrent']:12,.1f} km")
    print(f"  復元できた重用          {restored:12,.1f} km  "
          f"({restored / whole['concurrent']:.1%})")
    print(f"    国道と重用する区間    {with_national:12,.1f} km  "
          f"(way {nation.national_arcs:,} 本、実長 {nation.national_km:,.1f} km)")
    print(f"    県道どうしの重用      {restored - with_national:12,.1f} km")
    for rank in RANKS:
        t = ledger[RANK_TABLE[rank]]
        got = nation.concurrent_km(rank)
        print(f"  {RANK_LABEL[rank]:8} {got:12,.1f} / {t.km['concurrent']:,.1f} km  "
              f"({got / t.km['concurrent']:.1%})")

    # 復元率(延長)と、issue #95・#98 が上限として記録している網羅率(way の本数)は
    # 分母が違う。同じ集合について両方を出し、並べて読めるようにする。
    print("  リレーションの網羅(候補のうち、都道府県道のリレーションが抱える割合)")
    for grade in ("primary", "secondary"):
        ways, km = nation.grade_ways[grade], nation.grade_km[grade]
        held_w, held_k = nation.held_ways[grade], nation.held_km[grade]
        if not ways:
            print(f"    {grade:10} 候補が 1 本も無い")
            continue
        print(f"    {grade:10} way {held_w:7,}/{ways:7,} ({held_w / ways:5.1%})  "
              f"延長 {held_k:9,.1f}/{km:9,.1f} km ({held_k / km:5.1%})")

    # ---- 区分ごと ----------------------------------------------------------
    kind, link = nation.km_by_kind, nation.link_km_by_kind
    sea_km = kind.get("ferry", 0.0)
    foot_km = kind.get("foot", 0.0) + kind.get("steps", 0.0)
    build_km = (kind.get("construction", 0.0) + kind.get("unopened", 0.0)
                - link.get("construction", 0.0) - link.get("unopened", 0.0))
    open_km = (kind.get("road", 0.0) + kind.get("expressway", 0.0)
               - link.get("road", 0.0) - link.get("expressway", 0.0))
    link_km = sum(link.values())
    build_report = whole["unopened"] - whole["unopened_sea"]

    print("\n区分ごと(足すと上の重複排除の延長になる)")
    print(row("海上区間", whole["unopened_sea"] + whole["ferry"], sea_km, LABEL_WIDTH))
    print(row("工事中・未開通 / 未供用の陸上", build_report, build_km, LABEL_WIDTH))
    print(row("ランプ・連結路", 0.0, link_km, LABEL_WIDTH))
    print(row("徒歩道・階段", None, foot_km, LABEL_WIDTH))
    print(row("供用中の車道 / 実延長", whole["actual"], open_km, LABEL_WIDTH))

    # ---- 差の内訳 ----------------------------------------------------------
    paired = nation.paired_km
    dual_km = nation.dual_km
    parallel_km = nation.paired_sum("open", "open", False) / 2
    build_dual_km = nation.paired_sum("build", "build") / 2
    rebuild_km = nation.paired_sum("build", "open")

    # 符号は「地図が年報より多く持っている量」で揃える。字下げした行は、その上の
    # 見出しの行に足し合わさる。残りが負なら、原因を引いたあとも地図のほうが短い
    # ——都道府県道ではそうなる——という意味である。国道の内訳(compare_annual_
    # report.py)は「引く量」として符号を反転して出すが、あちらは差が一方向にしか
    # 出ないので読み違えようがない。こちらは両方向に出る。
    residual = (open_km - dual_km - parallel_km) - whole["actual"]
    build_residual = build_km - rebuild_km - build_dual_km - build_report
    print("\n差の内訳(字下げした行は、その上の見出しに足し合わさる)")
    for label, value in (
        ("供用中の車道の差", open_km - whole["actual"]),
        ("  上下線分離の二重計上", dual_km),
        ("  並行する同番号の道(側道など)", parallel_km),
        ("  説明できていない残り", residual),
        ("工事中・未開通の差", build_km - build_report),
        ("  現道と並んで工事中(改築)", rebuild_km),
        ("  工事中どうしの上下線分離", build_dual_km),
        ("  説明できていない残り", build_residual),
        ("ランプ・連結路", link_km),
        ("徒歩道・階段", foot_km),
        ("海上区間の差", sea_km - (whole["unopened_sea"] + whole["ferry"])),
    ):
        print(f"  {label:34} {value:+12,.1f}")
    print(f"  {'合計(見出しの行だけを足す)':34} {nation.dedup_km - comparable:+12,.1f}")

    print("\n裏取り")
    print(row("中央帯設置 / 上下線分離の実測", whole["median"], dual_km, LABEL_WIDTH))

    # ---- 県別 --------------------------------------------------------------
    # 県別の差は、そのままでは上下線分離を含んだままである。都市部の県はそこが
    # 大きいので、引いた後の残りも並べる。路線数は数え上げなので足せず、県の行
    # (下限)と県+政令指定都市(上限)の幅で持つ——annual_report.Prefecture を参照。
    print("\n県別(実延長+未供用+渡船。年報は県と政令指定都市の和)")
    print(f"  {'県':6} {'年報':>10} {'地図':>10} {'差':>10} {'':>7} "
          f"{'上下線分離':>10} {'引いた残り':>11} {'':>7} "
          f"{'県境の少数側':>12} {'路線数(年報)':>14} {'番号(地図)':>10}")
    worst = []
    for region in REGIONS:
        t = per_region[region]
        p = by_pref[region]
        want = p.km["total"] - p.km["concurrent"]
        got = t.dedup_km
        gap = got - want
        rest = gap - t.dual_km
        found = sum(len(t.numbers[r]) for r in RANKS)
        print(f"  {p.name:6} {want:10,.1f} {got:10,.1f} {gap:+10,.1f} "
              f"{gap / want:+7.1%} {t.dual_km:10,.1f} {rest:+11,.1f} "
              f"{rest / want:+7.1%} {t.cross_km:12,.1f} "
              f"{p.routes_min:6,}–{p.routes_max:<7,} {found:10,}")
        worst.append((abs(rest / want), p.name, rest, want))
    surveyed_km = nation.dedup_km + nation.national_km
    print(f"  県境を跨ぐ way {nation.cross_arcs:,} 本。少数側の合計 "
          f"{nation.cross_km:,.1f} km"
          f"(測った way の総延長 {surveyed_km:,.1f} km の {nation.cross_km / surveyed_km:.2%})")

    print("\n上下線分離を引いても差が大きい県")
    for _, name, rest, want in sorted(worst, reverse=True)[:8]:
        print(f"  {name:6} {rest:+10,.1f} km / {want:,.1f} km  ({rest / want:+.1%})")

    report_number_range(per_region, by_pref)

    report_mismatched_band(band_rows)

    print("\n測ったもの")
    print(f"  way {nation.ways:,}  重複排除 {nation.dedup_km:,.1f} km  "
          f"指定 {nation.designated_total:,.1f} km")
    print(f"  国道でもある way {nation.national_arcs:,} 本 {nation.national_km:,.1f} km  "
          f"旧道 {nation.former_arcs:,} 本 {nation.former_km:,.1f} km  "
          f"ランプ {nation.link_arcs:,} 本 {link_km:,.1f} km")
    for k in sorted(kind, key=lambda k: -kind[k]):
        print(f"    {k:13} {kind[k]:9,.1f} km  {nation.arcs_by_kind[k]:7,} ways"
              + (f"  うちランプ {link[k]:,.1f} km" if link.get(k) else ""))
    if pairing:
        print("  並走の測定値(半分にする前)")
        for key in sorted(paired, key=lambda k: -paired[k]):
            mine, other, one = key
            print(f"    {mine:5} と {other:5} 両方一方通行={one!s:5} "
                  f"{paired[key]:9,.1f} km")


if __name__ == "__main__":
    main()
