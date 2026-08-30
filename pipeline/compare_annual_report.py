# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""地図の km と道路統計年報の km の差が、何でできているかを説明する。

地図は一般国道を 70,376 km 描く。道路統計年報2025 は、同じ物であるはずの値
(総延長 − 重用延長。すなわち 実延長 + 未供用 + 渡船)を 58,512 km と述べる。
二割の開きは丸めではないが、このスクリプトができるまで、その二割が何でできて
いるかを誰も言えなかった。

二つは別々の物を数えている。答えの大半はそこにある。

  台帳    路線の中心線を数える。上下線が分かれた道も 1 本ぶんである。ランプは
          そもそも路線の延長ではない。認定は道ができる前に済むので、まだ開通して
          いない道にも延長がある(未供用)。
  地図    OSM の way を数える。上下線が分かれた道は way が 2 本あり、どちらも
          路線番号を持つので、地図は両方を描く——そのための地図である。

だから問いは、どちらが正しいかではない。地図の km のうち台帳が数えていないのは
どれで、どれだけあるか、である。以下の原因はどれも実測し、原因で説明しきれない
ぶんは、ごまかさず残りとして出す。

  海上区間        台帳の未供用には 1,953 km の海が入る。地図が持つのは、ルート
                  リレーションが含む航路の way だけである。
  工事中・未開通  OSM の `construction` は、まだ無い道を造ることだけでなく、
                  既に開通していて台帳にも載っている道を造り直すことも指す。
                  前者は二重計上で、二つは同じ番号の開通済みの道が並んで走って
                  いるかどうかで見分ける。
  ランプ・連結路  highway=*_link。ランプは附属物であって路線の延長ではない。
  上下線分離      同じ番号の way が並んで走り、どちらも一方通行である way。
                  車道が二本で道は一本である。測り方は幾何的で、
                  paired_fraction を参照。台帳は 1 本ぶん、地図は 2 本ぶんを
                  持つので、並走の長さの半分が超過ぶんになる。
  旧道            両方とも旧道を数える——台帳は実延長の中に、専用の欄として持つ
                  ——ので、これは分類の差であって延長の差ではない。台帳の旧道の
                  欄の隣に並べて報告し、計算からは外す。

このスクリプトが今のところやらないのは、都道府県別の突き合わせである。長らくそれは
できなかった。地域が矩形で隣県が食み込むので、県ごとに数えたつもりの値は bbox を
測った値にしかならなかったからである。全国計は影響を受けない——どの bbox に入って
いようと、way は id で一度だけ数えるからである。

その障害は取り除いてある。way は行政区域の面で決めた所属都道府県 `pref` を持って
いる(prefectures.py)ので、県ごとに数えられる。それでもここが全国計だけを見るのは、
国道の番号が全国で一意だからである。県別に割っても、全国計より細かい問いに答える
だけで、番号の取り違えは見つからない。県別でしか答えられないのは都道府県道のほう
で、そちらは compare_annual_report_pref.py が県ごとに突き合わせている。

使い方:  uv run pipeline/compare_annual_report.py
         uv run pipeline/compare_annual_report.py --distance 60
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict

import annual_report
from _paths import CACHE, REGIONS as REGION_DIR
from regions import REGIONS

# 1 本の道の二つの車道が、どれだけ離れていてもなお 1 本の道と見なせるか。
# 日本の上下線分離は、市街地で 5〜20 m、車道が別々の切り通しやトンネルに入る所で
# 30〜40 m である。それを超えると、どんな意味でも 1 本の道ではなくなる。40 m を
# 実務上の値として使う。--distance で別の値でも測れる。25 m と 60 m の結果は
# docs/results.md に記録してある。
PAIR_DISTANCE_M = 40.0

# way に沿って 25 m ごとに標本を取る。way は短い——70,376 km を 151,114 本で
# 割ると 1 本 466 m である——うえ、車道の対が way の途中で始まったり終わったり
# することはまず無いので、これより細かく取っても時間がかかるだけで値は動かない。
SAMPLE_M = 25.0

# 二つの way は、方位の差がこれ未満(180 度を法とする)なら平行と見なす。上下線は
# 互いに逆向きに描かれるので、符号付きの方位は約 180 度、符号を落とせば約 0 度
# 違う。
PARALLEL_DEG = 30.0

# 横方向に 4 m 以内にある物は、探りの対象から外す。二つの車道がそこまで近づく
# ことは無く、この隙間が無いと、交差点でノードを共有している相手と対になって
# しまう。
PROBE_MIN_M = 4.0

# どの区分どうしが二重に数えあうか。`ferry`・`foot`・`steps` は数えあわない。
# 海上区間の隣には何も無く、点線国道の徒歩道はそこにある唯一の物である。この
# 三つは、区分まるごとで台帳と突き合わせる。
KIND_GROUP = {
    "road": "open", "expressway": "open",
    "construction": "build", "unopened": "build",
}


# ---------------------------------------------------------------- geometry ---
def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    """a から b の向きを度で、180 度を法として返す。どちらの線かであって、
    どちら向きかではない。"""
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 180.0


def parallel(one: float, other: float) -> bool:
    """二つの方位が、向きを問わず PARALLEL_DEG 以内に収まっているか。"""
    d = abs(one - other)
    return min(d, 180.0 - d) <= PARALLEL_DEG


def probe_hit(p, v, q1, q2, reach: float) -> float | None:
    """p を通り v を横切る線が線分 q1-q2 と交わる位置を、距離として返す。

    標本の点から横方向へ、両側に `reach` まで探る。何も無ければ None を返す。
    最近傍の線分を探すのではなく横へ探るのは、道が続いていく先は横ではなく前だ
    からである。最近傍で探すと、どの交差点も車道の対に読める。長野県で測ると、
    この探りの 532 km に対して 930 km の並走を返した。
    """
    qx, qy = q2[0] - q1[0], q2[1] - q1[1]
    denom = v[0] * qy - v[1] * qx
    if denom == 0.0:
        return None
    dx, dy = q1[0] - p[0], q1[1] - p[1]
    t = (dx * qy - dy * qx) / denom      # along the probe, signed
    u = (dx * v[1] - dy * v[0]) / denom  # along the candidate segment
    if not 0.0 <= u <= 1.0:
        return None
    return abs(t) if PROBE_MIN_M <= abs(t) <= reach else None


# ------------------------------------------------------------------- input ---
def load_region(region: str) -> list[dict]:
    """1 地域のアークと、台帳との突き合わせに必要な way のタグ。

    `oneway` と `highway` は GeoJSON に無い——地図に使い道が無いためである——ので、
    build_routes.py が読んだのと同じ生のキャッシュから取る。どちらのファイルも
    1 つの .osm.pbf から書かれているので、way id はぴたりと揃う。
    build_routes.TAGS_USED が `oneway` を持つ前に切ったキャッシュにはそのタグが
    無い。一方通行の数が 0 になるようなら `mise run extract` をやり直す。

    座標は、compare_n13.py が距離を測るのと同じやり方で、局所的な正距円筒の枠の
    中の m に直す。地域は数度に及ぶので、最も背の高い bbox の上端と下端では東西方向の
    尺度が数 % ずれるが、40 m のしきい値に対しては問題にならない。
    """
    raw_path = CACHE / f"{region}.raw.json"
    if not raw_path.exists():
        raise SystemExit(f"{raw_path} is missing; run `mise run extract` first")
    gj = json.loads((REGION_DIR / f"{region}.geojson").read_text(encoding="utf-8"))
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    tags = {o["id"]: o.get("tags") or {}
            for o in (*raw["core"], *raw["candidates"]) if o["type"] == "way"}

    feats = gj["features"]
    if not feats:
        return []
    lat = sum(f["geometry"]["coordinates"][0][1] for f in feats) / len(feats)
    kx, ky = 111320.0 * math.cos(math.radians(lat)), 110540.0

    arcs = []
    for f in feats:
        p = f["properties"]
        t = tags.get(p["id"], {})
        highway = t.get("highway") or ""
        arcs.append({
            "id": p["id"],
            "refs": frozenset(p["refs_list"]),
            "kind": p["kind"],
            "former": bool(p["former"]),
            "km": p["km"],
            "designations": len(p["refs_list"]),
            "highway": highway,
            "link": highway.endswith("_link")
                    or (t.get("construction") or "").endswith("_link"),
            # `-1` は描かれた向きと逆の一方通行である。`reversible` と
            # `alternating` は車道 1 本の運用であって、道が二本あるのではない。
            "oneway": t.get("oneway") in ("yes", "-1", "1", "true"),
            "pts": [(c[0] * kx, c[1] * ky) for c in f["geometry"]["coordinates"]],
        })
    return arcs


# ----------------------------------------------------------------- pairing ---
def build_grid(arcs: list[dict], cell: float) -> dict:
    """線分の索引。セルの一辺は探りの届く距離に等しい。

    セルを届く距離と同じにしておけば、探りが触れうる物は、標本のセルを中心と
    する 3x3 の窓の中に必ず収まる。
    """
    grid = defaultdict(list)
    for ai, a in enumerate(arcs):
        pts = a["pts"]
        for si in range(len(pts) - 1):
            (x1, y1), (x2, y2) = pts[si], pts[si + 1]
            steps = max(1, int(math.dist(pts[si], pts[si + 1]) / (cell / 2)) + 1)
            for i in range(steps + 1):
                t = i / steps
                grid[(int((x1 + (x2 - x1) * t) // cell),
                      int((y1 + (y2 - y1) * t) // cell))].append((ai, si))
    return grid


def counterpart(arc: dict, ai: int, p, u, arcs: list[dict], grid, cell: float,
                reach: float) -> dict | None:
    """点 p で `arc` と並んで走る、最も近い way。無ければ返さない。

    同じ番号の物だけを見る。別々の路線が並んでいるなら道は二本で、台帳も両方を
    数える。同じ区分の物を先に選ぶ——開通済みの道の隣にある開通済みの道は、工事中
    の way がたまたま近くにあっても車道の対であり、近いほうを選ぶと、同じ距離が
    別の原因へ移ってしまう。
    """
    vx, vy = -u[1], u[0]
    best: dict[str, dict | None] = {"same": None, "other": None}
    best_d = {"same": math.inf, "other": math.inf}
    my_group = KIND_GROUP[arc["kind"]]
    my_bearing = bearing((0.0, 0.0), u)
    cx, cy = int(p[0] // cell), int(p[1] // cell)
    seen: set[tuple[int, int]] = set()
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for cand in grid.get((cx + dx, cy + dy), ()):
                if cand in seen:
                    continue
                seen.add(cand)
                bi, si = cand
                if bi == ai:
                    continue
                other = arcs[bi]
                if not (other["refs"] & arc["refs"]):
                    continue
                q1, q2 = other["pts"][si], other["pts"][si + 1]
                if not parallel(my_bearing, bearing(q1, q2)):
                    continue
                dist = probe_hit(p, (vx, vy), q1, q2, reach)
                if dist is None:
                    continue
                slot = "same" if KIND_GROUP[other["kind"]] == my_group else "other"
                if dist < best_d[slot]:
                    best_d[slot], best[slot] = dist, other
    return best["same"] or best["other"]


def paired_fraction(arc: dict, ai: int, arcs: list[dict], grid, cell: float,
                    reach: float) -> dict[tuple[str, str, bool], float]:
    """このアークのうち、同じ番号の way が並んでいる長さを m で、区分ごとに返す。

    鍵は (このアークの区分, 隣の way の群, 両方とも一方通行か) である。後から原因
    を見分けられるのはこの鍵のおかげである。開通済みの車道が二本並ぶのと、置き換え
    られる道の隣で造り直しが進むのとは別のことである。アーク自身の区分を群ではなく
    そのまま残すのは、二重計上のうちどれだけが自動車専用道路——車道が二本あるのが
    普通の区分——なのかを報告で述べられるようにするためである。
    """
    out: dict[tuple[str, str, bool], float] = defaultdict(float)
    pts = arc["pts"]
    for si in range(len(pts) - 1):
        (x1, y1), (x2, y2) = pts[si], pts[si + 1]
        seglen = math.hypot(x2 - x1, y2 - y1)
        if seglen == 0.0:
            continue
        u = ((x2 - x1) / seglen, (y2 - y1) / seglen)
        # 切り上げる。1 つの標本が SAMPLE_M より長い道を代表しないようにする
        # ためである。切り捨てると 49 m の線分が標本 1 つになり、その 1 回の
        # 探りが 49 m 全部を決めてしまう。それは 25 m ごとの計測ではない。
        n = max(1, math.ceil(seglen / SAMPLE_M))
        step = seglen / n
        for i in range(n):
            t = (i + 0.5) / n
            p = (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
            other = counterpart(arc, ai, p, u, arcs, grid, cell, reach)
            if other is not None:
                out[(arc["kind"], KIND_GROUP[other["kind"]],
                     arc["oneway"] and other["oneway"])] += step
    return out


# ----------------------------------------------------------------- measure ---
def measure(reach: float) -> dict:
    """全国の way を一度ずつ。並走の長さは、その way が属する地域の中で測る。

    地域のファイルは大きく重なる——別々の way 151,114 本が延べ 311,380 回現れる
    ——ので、way はそれを含む最初の地域のぶんとして数える。並走はその地域の中で、
    そのファイルが持つすべてを相手に測る。車道の相方は 40 m 以内にあり、定義上
    同じ bbox の中にいる。
    """
    seen: set[int] = set()
    km_by_kind: dict[str, float] = defaultdict(float)
    link_km_by_kind: dict[str, float] = defaultdict(float)
    arcs_by_kind: dict[str, int] = defaultdict(int)
    paired_km: dict[tuple[str, str, bool], float] = defaultdict(float)
    total = {"arcs": 0, "designated_km": 0.0, "former_km": 0.0,
             "former_arcs": 0, "link_arcs": 0, "oneway_arcs": 0}

    for region in REGIONS:
        arcs = load_region(region)
        own = {a["id"] for a in arcs} - seen
        seen |= own

        for a in arcs:
            if a["id"] not in own:
                continue
            total["arcs"] += 1
            total["designated_km"] += a["km"] * a["designations"]
            km_by_kind[a["kind"]] += a["km"]
            arcs_by_kind[a["kind"]] += 1
            if a["former"]:
                total["former_km"] += a["km"]
                total["former_arcs"] += 1
            if a["link"]:
                link_km_by_kind[a["kind"]] += a["km"]
                total["link_arcs"] += 1
            if a["oneway"]:
                total["oneway_arcs"] += 1

        # 台帳にとって旧道はそれ自体で 1 本の道であり(実延長の旧道の欄)、それを
        # 迂回した道の複製ではない。だから対にもならず、隣の相手にもならない。
        # ランプを外すのは裏返しの理由による。ランプ・連結路として既に丸ごと
        # 数えてあるためである。
        pool = [a for a in arcs
                if a["kind"] in KIND_GROUP and not a["former"] and not a["link"]]
        grid = build_grid(pool, reach)
        for i, a in enumerate(pool):
            if a["id"] not in own or a["km"] == 0.0:
                continue
            for key, metres in paired_fraction(a, i, pool, grid, reach, reach).items():
                paired_km[key] += metres / 1000.0
        print(f"  {region:12} {len(own):6,} ways", flush=True)

    return {**total, "km_by_kind": dict(km_by_kind),
            "link_km_by_kind": dict(link_km_by_kind),
            "arcs_by_kind": dict(arcs_by_kind), "paired_km": dict(paired_km)}


# ------------------------------------------------------------------ 引数 ---
def take_distance(args: list[str]) -> tuple[float, list[str]]:
    """`--distance` の値と、それを取り除いた残りの引数。

    都道府県道の側(compare_annual_report_pref.py)も同じ旗を同じ意味で取るので、
    読み取りはここに一つだけ置く。値を検査するのは、`--distance` を末尾に書いた
    ときや `--distance --no-pairing` と書いたときに、添字の失敗ではなく使い方の
    誤りとして落とすためである。extract_pbf.take と同じ形である。
    """
    if "--distance" not in args:
        return PAIR_DISTANCE_M, args
    i = args.index("--distance")
    if i + 1 >= len(args) or args[i + 1].startswith("--"):
        raise SystemExit("--distance needs a value")
    try:
        reach = float(args[i + 1])
    except ValueError:
        raise SystemExit(f"--distance needs a number, not {args[i + 1]!r}") from None
    # 0 も負も nan も inf も float() は受け取る。0 は build_grid のセルの一辺に
    # そのまま渡り、セルを数えるところで 0 除算になる。nan と inf はその先の
    # 整数への変換で落ちる。どれも側方の探る距離としては意味を持たないので、
    # 落ちる場所ではなくここで断る。
    if not math.isfinite(reach) or reach <= 0:
        raise SystemExit(f"--distance needs a positive finite number, not {reach}")
    return reach, args[:i] + args[i + 2:]


# ------------------------------------------------------------------ report ---
def one_timestamp(stamps: set[str]) -> str:
    """一つに定まる基準時刻。定まらなければ、混ざっている旨を名指しする。

    別々の切り出しから作った物が混ざると、全国計は意味を失うが、合計そのものは
    それを決して示さない。だから混ざった生成物は、隠さずに名指しする。読む側は
    地域の meta と build/survey の二人いるので、述べ方はここに一つだけ置く。
    """
    return stamps.pop() if len(stamps) == 1 else "mixed: " + ", ".join(sorted(stamps))


def base_timestamp() -> str:
    """地域を生成した元の OSM の切り出し時刻。平均は取らない。"""
    return one_timestamp(
        {json.loads((REGION_DIR / f"{r}.meta.json").read_text(encoding="utf-8"))
         ["osm_timestamp"] for r in REGIONS})


def row(label: str, ledger: float | None, map_km: float | None, width: int = 28) -> str:
    """突き合わせの 1 行。台帳の値、地図の値、そしてその差である。

    どちらの側も None になりうる——徒歩道には突き合わせる欄が台帳に無い。そう
    述べることは、0 と述べることとは違う。

    `width` は見出しの幅である。都道府県道の側は種別ごとに一段下げた見出しを
    持つので、そこだけ狭くする。
    """
    if ledger is None or map_km is None:
        gap = ""
    else:
        pct = f" ({(map_km - ledger) / ledger:+.1%})" if ledger else ""
        gap = f"{map_km - ledger:+12,.1f}{pct}"
    left = "" if ledger is None else f"{ledger:12,.1f}"
    right = "" if map_km is None else f"{map_km:12,.1f}"
    return f"  {label:{width}} {left:>12} {right:>12}  {gap}"


def main() -> None:
    reach, args = take_distance(sys.argv[1:])
    if args:
        raise SystemExit(f"unexpected argument: {args[0]}")

    ledger = annual_report.total(8)
    report = ledger.km
    print(f"道路統計年報2025 表8〈一般国道〉 令和6年3月31日現在 "
          f"({annual_report.REPORT_CSV.name})")
    print(f"地図 build/regions データ基準 {base_timestamp()}")
    print(f"上下線の判定: 側方 {reach:.0f} m 以内、{SAMPLE_M:.0f} m ごとに測る\n")

    m = measure(reach)
    if not m["oneway_arcs"]:
        raise SystemExit(
            "no way in build/cache carries `oneway`, so no carriageway pair can be "
            "recognised. The cache was cut before build_routes.TAGS_USED gained the "
            "tag; run `mise run extract` again.")
    kind, link = m["km_by_kind"], m["link_km_by_kind"]

    dedup_km = sum(kind.values())
    link_km = sum(link.values())
    sea_km = kind.get("ferry", 0.0)
    foot_km = kind.get("foot", 0.0) + kind.get("steps", 0.0)
    build_km = (kind.get("construction", 0.0) + kind.get("unopened", 0.0)
                - link.get("construction", 0.0) - link.get("unopened", 0.0))
    open_km = (kind.get("road", 0.0) + kind.get("expressway", 0.0)
               - link.get("road", 0.0) - link.get("expressway", 0.0))

    paired = m["paired_km"]

    def paired_sum(group: str, neighbour: str, both_oneway: bool | None = None) -> float:
        return sum(v for (mine, other, one), v in paired.items()
                   if KIND_GROUP[mine] == group and other == neighbour
                   and (both_oneway is None or one == both_oneway))

    # 半分にする。二つの車道は互いを見つけるので、1 本の道が並走の合計へ自分の
    # 長さを二度持ち込む。超過はその二つ目の写しだけである。
    dual_km = paired_sum("open", "open", True) / 2
    dual_by_kind = {mine: v / 2 for (mine, other, one), v in paired.items()
                    if other == "open" and one and KIND_GROUP[mine] == "open"}
    parallel_km = paired_sum("open", "open", False) / 2
    build_dual_km = paired_sum("build", "build") / 2
    # こちらは半分にせず、しかもこの向きだけを数える。隣の開通済みの道こそ台帳が
    # 既に数えている物なので、工事中の way は丸ごと超過である。
    rebuild_km = paired_sum("build", "open")

    comparable = report["total"] - report["concurrent"]
    sea_report = report["unopened_sea"]
    build_report = report["unopened"] - report["unopened_sea"]

    print("\n年報と地図")
    print(f"  {'項目':26} {'年報':>12} {'地図':>12}   差")
    print(row("総延長 / 指定延長", report["total"], m["designated_km"]))
    print(row("実延長+未供用+渡船 / 重複排除", comparable, dedup_km))
    print(row("重用延長", report["concurrent"], m["designated_km"] - dedup_km))
    print(row("旧道", report["former"], m["former_km"]))
    print(f"  {'路線数':26} {ledger.routes:>12} {'459':>12}")

    print("\n区分ごと(足すと上の重複排除の延長になる)")
    print(row("海上区間", sea_report, sea_km))
    print(row("工事中・未開通 / 未供用の陸上", build_report, build_km))
    print(row("ランプ・連結路", 0.0, link_km))
    print(row("徒歩道・階段", None, foot_km))
    print(row("供用中の車道 / 実延長", report["actual"], open_km))

    print("\n差の内訳")
    residual = (open_km - dual_km - parallel_km) - report["actual"]
    lines = [
        ("供用中の車道の差", open_km - report["actual"]),
        ("  上下線分離の二重計上", -dual_km),
        ("  並行する同番号の道(側道など)", -parallel_km),
        ("  説明できていない残り", -residual),
        ("工事中・未開通の差", build_km - build_report),
        ("  現道と並んで工事中(改築)", -rebuild_km),
        ("  工事中どうしの上下線分離", -build_dual_km),
        ("  説明できていない残り",
         -(build_km - rebuild_km - build_dual_km - build_report)),
        ("ランプ・連結路", link_km),
        ("徒歩道・階段", foot_km),
        ("海上区間の取りこぼし", sea_km - sea_report),
    ]
    for label, value in lines:
        print(f"  {label:34} {value:+12,.1f}")
    print(f"  {'合計':34} {dedup_km - comparable:+12,.1f}")

    # 台帳は、実延長のうち中央帯を持つ長さを独立に測っている——そもそも OSM で
    # 道が二本の車道になるのはそれが理由である。まったく同じ問いではない(中央帯は
    # 幅を持つ構造物であり、OSM は塗り分けただけの分離帯でも way を分ける。しかも
    # 表 8 のこの欄は、こちらの自動車専用道路のアークが持つ高速自動車国道との重用
    # を外している)が、二つは近い値に落ち着くはずであり、実際そうなる。
    print("\n裏取り")
    print(row("中央帯設置 / 上下線分離の実測", report["median"], dual_km))
    print("  " + "  ".join(f"うち {k} {v:,.1f} km"
                           for k, v in sorted(dual_by_kind.items(), key=lambda x: -x[1])))

    print("\n測ったもの")
    print(f"  アーク {m['arcs']:,}  重複排除 {dedup_km:,.1f} km  "
          f"指定 {m['designated_km']:,.1f} km")
    print(f"  旧道 {m['former_arcs']:,} アーク {m['former_km']:,.1f} km  "
          f"ランプ {m['link_arcs']:,} アーク {link_km:,.1f} km")
    for k in sorted(kind, key=lambda k: -kind[k]):
        print(f"    {k:13} {kind[k]:9,.1f} km  {m['arcs_by_kind'][k]:7,} アーク"
              + (f"  うちランプ {link[k]:,.1f} km" if link.get(k) else ""))
    print("  並走の測定値(半分にする前)")
    for key in sorted(paired, key=lambda k: -paired[k]):
        mine, other, one = key
        print(f"    {mine:5} と {other:5} 両方一方通行={one!s:5} "
              f"{paired[key]:9,.1f} km")


if __name__ == "__main__":
    main()
