"""way がどの都道府県に属するかを、矩形ではなく行政区域の面で決める。

矩形は県の輪郭に沿わない。国道ではそれで足りていた。路線番号が全国で一意なので、
隣県が食み込んでも番号を取り違えないためである。都道府県道はそうはいかない。
番号は県の中でしか一意でなく、県道18号は 47 本ある。

矩形がどれだけ決められないかは測ってある。`ref` を持つ primary/secondary
278,756 本の中央ノードを 47 の bbox に当てると、県が一意に決まるのは 30.2% だけ
で、12 県は 1 本も決まらない。富山県の bbox は石川県の bbox に丸ごと包まれて
いる。

面は国土数値情報 N03(行政区域)から作る。県ごとに配られる市区町村の多角形を、
その県の物としてまとめて持つ。溶かして 1 つの輪郭にする必要は無い。ある点が
その県に在ることと、その県のどれかの市区町村に在ることは同じである。

判定は中央の 1 点ではなく線で行う。全国で測るとこうなる。

    1 県に収まる        278,052
    県境を跨ぐ             690    0.25%。3 県以上に跨る物は無い
    どの県にも入らない      14

跨ぐ way は、長さの過半が入る県に寄せる。690 本の全長は 1,115.5 km で、その
少数側は 244.0 km ある。県境で切れば way とアークが 1 対 1 でなくなり、両方に
持たせれば県道18号が二つの県に出る。どちらもこの 244 km のために払う代償として
大きい。跨いだという事実そのものは `regions` に残るので、後の段が別の扱いを
選びたくなったときに読める。

どの県にも入らない way は、最も近い県へ寄せて距離を報告する。14 本はすべて
埋立地・桟橋・渡船で、最も遠い物でも面から 116 m しかない。海岸線の描き方が
N03 と OSM で少しずれているだけであって、どの県か分からないわけではない。
それでも `NEAREST_LIMIT_M` を超えたら寄せず、所属なしとして報告する。海の
真ん中に在る way に県を与えるより、県が無いと述べるほうが正しい。
"""
from __future__ import annotations

import io
from collections.abc import Iterable, Sequence
from typing import NamedTuple

import numpy as np
import shapefile
import shapely
from shapely.geometry import shape as to_shape

from geo import line_length
from n03 import PREF_CODES, VINTAGES, archive
from regions import PREF_CODE

# 面の外に在る way を、それでも最も近い県の物と述べてよい距離。実測では最も
# 遠い物でも 116 m で、海岸線・埋立地の描き方の差で説明が付く。これを超える
# 隔たりは描き方の差では説明できないので、県を与えずに報告する。
NEAREST_LIMIT_M = 500.0


class Assignment(NamedTuple):
    """way 1 本の所属。

    region   主たる所属の地域名。決まらなければ None
    regions  触れた地域を、その way を占める長さの多い順に並べた物。
             `region` はその先頭である。跨いでいなければ 1 つだけ
    how      inside(1 県に収まる)、majority(跨いだので過半の県へ寄せた)、
             nearest(面の外なので最寄りの県へ寄せた)、off-map(どの県からも遠い)
    metres   majority なら少数側の長さ、nearest と off-map なら面までの距離。
             inside は 0。どれも「この判定がどれだけ危ういか」を長さで述べる
    """

    region: str | None
    regions: tuple[str, ...]
    how: str
    metres: float


def _metres(geom) -> float:
    """幾何の長さを m で返す。

    shapely は経緯度をそのまま平面として測るので、その長さは緯度によって
    伸び縮みする。ここでは点を取り出して geo.py に渡す。地球上の距離に
    答えるのはあちらの仕事である。
    """
    if geom.is_empty:
        return 0.0
    if geom.geom_type == "LineString":
        return line_length([(y, x) for x, y in geom.coords])
    if hasattr(geom, "geoms"):
        return sum(_metres(g) for g in geom.geoms)
    # 交わりが点だけなら長さは無い。県境の 1 点で接している way がこれである。
    return 0.0


class Prefectures:
    """N03 の面を読み、線に所属都道府県を与える。"""

    def __init__(self) -> None:
        # VINTAGES は新しい順である。所属を決めるのに必要なのは現行の
        # 年版だけで、decree.py が読む 2000 年版は、平成の大合併で消えた
        # 市区町村の名前のためにある。県の輪郭はその合併で動いていない。
        self.vintage, url, _ = VINTAGES[0]
        self.regions = tuple(PREF_CODE[code] for code in PREF_CODES)
        geoms: list = []
        owner: list[int] = []
        for i, code in enumerate(PREF_CODES):
            z, base = archive(self.vintage, url, code)
            # DBF は読まない。配布物は県ごとに分かれているので、このファイルに
            # 在る多角形はすべてこの県の物である。市区町村の名前が必要なのは
            # decree.py であって、ここではない。所属未定地も県の一部なので、
            # あちらのように除きもしない。
            sf = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")),
                                  shx=io.BytesIO(z.read(base + ".shx")))
            for shape in sf.iterShapes():
                # __geo_interface__ が外環と穴を組み立てる。湖と飛地はそれで
                # 正しく出る。
                geoms.append(to_shape(shape.__geo_interface__))
                owner.append(i)
        self._geoms = geoms
        self._owner = np.array(owner, dtype=np.int16)
        self._tree = shapely.STRtree(geoms)

    @property
    def polygon_count(self) -> int:
        return len(self._geoms)

    @property
    def bounds(self) -> list[tuple[float, float, float, float]]:
        """面ごとの外接矩形。西・南・東・北の順(shapely の並び)である。

        「日本のどこに陸があるか」を、道のデータとは独立に述べられる唯一の物が
        この面である。N13 と突き合わせる側(compare_n13_pref.py)が、候補の有無と
        無関係に見るべき範囲を数えるのに使う。候補が 1 本も無い島こそ、探して
        いる欠落だからである。
        """
        return [g.bounds for g in self._geoms]

    def assign_ways(
        self,
        lat: Sequence[float],
        lon: Sequence[float],
        counts: Sequence[int],
    ) -> list[Assignment]:
        """way ごとの所属を、渡された順に返す。

        `lat`・`lon` は way の順に繋げた座標、`counts` は way ごとの点の数で
        ある。(緯度, 経度) の tuple の列を求めないのは、全国で 460 万点あり、
        それを Python の物として組み直すだけで数百 MB になるためである。
        """
        n = len(counts)
        if n == 0:
            return []
        size = np.asarray(counts, dtype=np.int64)
        if size.min() < 2:
            raise ValueError("way は 2 点以上でなければ線にならない")
        if int(size.sum()) != len(lat) or len(lat) != len(lon):
            raise ValueError("座標の数が counts の合計と合わない")
        lines = shapely.linestrings(
            np.column_stack([np.asarray(lon, dtype=np.float64),
                             np.asarray(lat, dtype=np.float64)]),
            indices=np.repeat(np.arange(n, dtype=np.int64), size),
        )

        # 触れた面をまとめて訊く。way ごとに集合を持たせると、35 万本ぶんの
        # set だけで数十 MB になる。必要なのは「最初に当たった県」と「二つ目に
        # 別の県が当たったか」の二つだけである。
        hit_line, hit_poly = self._tree.query(lines, predicate="intersects")
        first = np.full(n, -1, dtype=np.int16)
        crossed = np.zeros(n, dtype=bool)
        for li, own in zip(hit_line.tolist(), self._owner[hit_poly].tolist(),
                           strict=True):
            if first[li] < 0:
                first[li] = own
            elif first[li] != own:
                crossed[li] = True

        out: list[Assignment] = []
        for i in range(n):
            if crossed[i]:
                out.append(self._crossing(lines[i]))
            elif first[i] >= 0:
                region = self.regions[first[i]]
                out.append(Assignment(region, (region,), "inside", 0.0))
            else:
                out.append(self._outside(lines[i]))
        return out

    def _crossing(self, line) -> Assignment:
        """県境を跨いだ way を、長さの過半が入る県へ寄せる。"""
        metres: dict[int, float] = {}
        for j in self._tree.query(line, predicate="intersects").tolist():
            own = int(self._owner[j])
            metres[own] = metres.get(own, 0.0) + _metres(
                shapely.intersection(line, self._geoms[j]))
        ranked = sorted(metres.items(), key=lambda kv: -kv[1])
        regions = tuple(self.regions[own] for own, _ in ranked)
        minority = sum(m for _, m in ranked[1:])
        return Assignment(regions[0], regions, "majority", minority)

    def _outside(self, line) -> Assignment:
        """どの面にも入らなかった way を、最も近い県へ寄せる。"""
        j = int(self._tree.nearest(line))
        gap = _metres(shapely.shortest_line(line, self._geoms[j]))
        region = self.regions[int(self._owner[j])]
        if gap <= NEAREST_LIMIT_M:
            return Assignment(region, (region,), "nearest", gap)
        return Assignment(None, (), "off-map", gap)


def write_pref(doc: dict, assignment: Assignment) -> None:
    """way の辞書に所属を書く。書き方を二箇所に持たないための一箇所である。

    `prefs` を持つのは県境を跨いだ way だけである。1 県に収まる way にも書けば、
    `pref` と同じことを二度述べることになる。
    """
    doc["pref"] = assignment.region
    if len(assignment.regions) > 1:
        doc["prefs"] = list(assignment.regions)


def assign_docs(index: Prefectures, docs: Iterable[dict]) -> list[tuple[int, Assignment]]:
    """`geometry` を持つ way の辞書すべてに所属を書き、id と対にして返す。

    Overpass の応答も extract_pbf.py が組む way も、`geometry` が
    `{"lat": …, "lon": …}` の列である点は同じなので、書き込み方は 1 つでよい。
    """
    ways = []
    for d in docs:
        if d.get("type") != "way":
            continue
        if len(d.get("geometry") or ()) >= 2:
            ways.append(d)
        else:
            # 点が 1 つも無い、あるいは 1 つしかない way。線にならないので面とは
            # 交われない。key は置く。way の辞書を読む側に、有る無しと null の
            # 二通りを見分けさせないためである。
            d["pref"] = None
    lat = [p["lat"] for d in ways for p in d["geometry"]]
    lon = [p["lon"] for d in ways for p in d["geometry"]]
    assigned = index.assign_ways(lat, lon, [len(d["geometry"]) for d in ways])
    out = []
    for doc, a in zip(ways, assigned, strict=True):
        write_pref(doc, a)
        out.append((doc["id"], a))
    return out


def report(rows: Iterable[tuple[int, Assignment]], vintage: str, limit: int = 20) -> None:
    """所属の内訳を、extract_pbf.py の取りこぼし検査と同じ形で出す。"""
    rows = list(rows)
    crossing = [r for r in rows if r[1].how == "majority"]
    nearest = [r for r in rows if r[1].how == "nearest"]
    off = [r for r in rows if r[1].how == "off-map"]
    shorter = sum(a.metres for _, a in crossing) / 1000
    print(f"\nprefecture by N03 {vintage} boundaries: {len(rows):,} ways")
    print(f"  crossing a boundary, kept by the longer side: {len(crossing):,} "
          f"({shorter:.1f} km lies on the shorter side)")
    print(f"  outside every boundary, snapped to the nearest: {len(nearest)}")
    for wid, a in nearest[:limit]:
        print(f"    way/{wid} -> {a.region}, {a.metres:.0f} m away")
    print(f"  no prefecture within {NEAREST_LIMIT_M:.0f} m: {len(off)}")
    for wid, a in off[:limit]:
        print(f"    way/{wid} nearest boundary {a.metres:.0f} m away")
    if off:
        print("  These ways carry no prefecture. A prefectural route number "
              "cannot be told from the same number in another prefecture.")
