# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""アークごとに、上下線とランプのぶんを測って配信の集計へ渡す。

地図は OSM の way を描き、その長さを延長として足す。上下線が分かれた道は way が
2 本あるので、延長も 2 本ぶんになる。台帳は 1 本ぶんしか数えない。国道174号は
公式に 187.1 m だが、way を足すと 312 m になる。重なるのは国道 2 号側の約 100 m
で、そこが上下 2 本の way である。

画面が路線の延長を台帳の数え方で述べるには、どの way がどれだけ二重かを知る
必要がある。それを決めるのは compare_annual_report.py の上下線の判定である。
ここはその判定を読み込んで当てるだけで、測り方を持たない。二つ目の測り方を
置くと、年報との突き合わせと画面の値が食い違う。

アークごとに書くのは二つである。

  link    ランプ・連結路(`highway=*_link`)。台帳は路線の延長に数えない
  twin_m  上下線の片側として二重に数えている長さ(m)。並走している長さの半分で
          ある。二つの車道は互いを見つけるので、並走の長さを両方に半分ずつ
          持たせると、足したときにちょうど 1 本ぶんが残る

上下線と見なすのは compare_annual_report.py が「上下線分離」と呼ぶ二つである。
供用中の車道どうしで両方が一方通行のもの、工事中どうしで並ぶもの。供用中の道の
隣で工事中の道が並ぶのは造り直しであって上下線ではないので、ここでは引かない。

way は地域の重なりで二度現れる。pack_web.mjs は regions.json の順に読んで最初の
写しを採るので、ここも同じ順で最初の写しを測る。並走の相手はその地域のファイル
の中で探す。車道の相方は 40 m 以内に在り、定義上同じ bbox の中にいる。

書き先は build/regions/carriageways.json である。0 の way は書かない。

使い方:  uv run pipeline/carriageways.py
"""
from __future__ import annotations

import json
import sys
import time

from _paths import REGIONS, write_atomic
from compare_annual_report import (
    KIND_GROUP,
    PAIR_DISTANCE_M,
    build_grid,
    load_region,
    paired_fraction,
)

OUT = REGIONS / "carriageways.json"


def is_twin(kind: str, neighbour: str, both_oneway: bool) -> bool:
    """compare_annual_report.py の差の内訳で「上下線分離」に入る並走か。

    供用中どうしは両方が一方通行のときだけである。片方が対面通行なら、並んで
    いるのは側道で、台帳も別の道として数える。工事中どうしは一方通行を問わない。
    向きが付く前の道が多いからで、あちらの `paired_sum("build", "build")` も
    問わない。
    """
    group = KIND_GROUP[kind]
    if group != neighbour:
        return False
    return both_oneway if group == "open" else True


def measure_region(region: str, seen: set[int]) -> tuple[list[int], dict[int, float]]:
    """1 地域ぶんの、まだ測っていない way のランプと上下線。"""
    arcs = load_region(region)
    own = {a["id"] for a in arcs} - seen
    seen |= own

    links = [a["id"] for a in arcs if a["id"] in own and a["link"]]

    # 測る相手の集め方は compare_annual_report.measure と同じである。旧道は
    # 迂回した道の写しではなく、ランプはランプとして数えてあるので、どちらも
    # 対にならない。
    pool = [a for a in arcs
            if a["kind"] in KIND_GROUP and not a["former"] and not a["link"]]
    grid = build_grid(pool, PAIR_DISTANCE_M)
    twins: dict[int, float] = {}
    for i, a in enumerate(pool):
        if a["id"] not in own or a["km"] == 0.0:
            continue
        metres = sum(
            m for (kind, neighbour, one), m in paired_fraction(
                a, i, pool, grid, PAIR_DISTANCE_M, PAIR_DISTANCE_M).items()
            if is_twin(kind, neighbour, one))
        if metres > 0:
            twins[a["id"]] = round(metres / 2, 1)
    return links, twins


def main() -> None:
    # 地域名の表示に日本語を使う。cp932 のコンソールでも落ちないようにする
    # (decree.py と同じ)。
    sys.stdout.reconfigure(errors="replace")
    started = time.time()
    index = json.loads((REGIONS / "regions.json").read_text(encoding="utf-8"))
    seen: set[int] = set()
    links: list[int] = []
    twins: dict[int, float] = {}
    for entry in index:
        region = entry["region"]
        ramps, pairs = measure_region(region, seen)
        links += ramps
        twins.update(pairs)
        print(f"  {region:12} ランプ {len(ramps):5,}  上下線 {len(pairs):6,}",
              flush=True)

    write_atomic(OUT, json.dumps({
        "reach_m": PAIR_DISTANCE_M,
        "link": sorted(links),
        "twin_m": {str(k): v for k, v in sorted(twins.items())},
    }, ensure_ascii=False))
    print(f"ランプ {len(links):,} 本、上下線 {len(twins):,} 本、"
          f"二重計上 {sum(twins.values()) / 1000:,.1f} km "
          f"({time.time() - started:.0f}s) -> {OUT}")


if __name__ == "__main__":
    main()
