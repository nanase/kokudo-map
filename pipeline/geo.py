"""地球上の距離に、一度だけ答える。

この構成では四つのファイルが二点間の距離を測っており、同じ 8 行の写しを四つ
持っていた。compare_n13.py は既にそれに気付いて、五つ目を書く代わりに audit.py
の写しを import していた。ここでの移動もそれと同じで、監査の実行一式を引きずり
込まずに済む場所へ置き直しただけである。

このモジュールは、ファイルを読まず、引数を取らず、何も出力しない。ただの計算
なので、順序を気にせずパイプラインのどこからでも import できる。
"""
from __future__ import annotations

import math

# IUGG の平均半径。どの半径を使うかは本当に選択である——赤道半径と極半径は
# 21 km、約 0.3 % 違う——うえに、どこでも同じ答えでなければ、同じ道を測った二つの
# ファイルが 4 桁目で食い違う。誰も選び直さずに済むよう、ここで一度述べる。
EARTH_RADIUS_M = 6371008.8


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    """(緯度, 経度) の 2 点間の距離を m で返す。"""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def line_length(coords: list[tuple[float, float]]) -> float:
    """(緯度, 経度) を繋いだ折れ線の長さを m で返す。"""
    return sum(haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
