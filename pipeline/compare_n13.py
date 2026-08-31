# /// script
# requires-python = ">=3.12"
# dependencies = ["requests", "pyshp", "numpy"]
# ///
"""地域の生成物を、国土数値情報 N13(道路)と突き合わせる。地理院地図と出どころを
共有する唯一の参照データである。

audit.py は路線自身の連なりの切れ目を見つけるが、こちらの OSM のキャッシュに何らか
の痕跡がある道についてしか推論できない。OSM に丸ごと無い道は推論する痕跡を残さず、
その場合を見つけられるのは独立した出どころだけである——TRIAGE.md を参照。N13 が
その出どころである。地理院地図と同じ電子国土基本図に由来し、国内の一般国道をすべて
覆うが、路線番号は持たず、道路分類の区分(国道 / 都道府県道 / 市区町村道等 / …)しか
持たない。だから、どの番号が欠けているかは言えない。何かがどこに在るかだけを言える。

突き合わせは二つあり、同じ問いを互いに逆向きから指している。

  gap        近くにこちらの物が何も無い N13 の国道の線分——「その道は OSM に
             そもそも無い」の候補で、audit.py が届かない TRIAGE.md の場合である。
  orphan     近くに N13 の国道の線分が無い、こちらの旧道フラグ付きのアーク——
             「地理院地図は既に指定解除しており、こちらの旧道フラグが古い」の
             候補である。旧道のアークを N13 と直接突き合わせること(現道であれ旧道
             であれ、そのアークが N13 の線の近くに在るか)が使える手掛かりである。
             N13 が「旧道である」ことに同意するかを見ても意味は無い。N13 は現道と
             旧道の区別を持たず、法令上指定されている旧道は、指定解除まで現道と
             まったく同じく 道路分類=国道 を持つからである。それでは、正しくタグ
             付けされた旧道が残らず「食い違い」として挙がるだけである。

orphan の側は、1 点ではなく被覆率で評価する(issue #27)。アークを長さに沿って
SAMPLE_INTERVAL_M ごとに取り直し、N13 から ORPHAN_THRESHOLD_M 以内にある標本の
割合を、そのアークの被覆率とする。中点 1 点(旧来の規則)も、アーク自身の端点の頂点
(旧道は現道と繋がり直すので、作りからして N13 の近くに在る)も、「この道のどれだけ
が今も N13 に裏付けられているか」とは別のことを述べてしまう。繋がったアーク——
1 本の道が短い OSM の way に分かれている場合や、重複排除の前で県境の写しに分かれて
いる場合——は 1 つのクラスタにまとめ(cluster_former_arcs。gap 側の cluster_gaps と
cluster_by_endpoint を共有する)、長さで重み付けした 1 つの割合を持たせる。仕分けを
way ごとではなく道ごとに行うためである。`region all` はさらに、余白を付けた bbox が
その way を含むすべての県について、同じ way id を評価の前に重複排除する——
national_orphan_report を参照。

被覆率の低いクラスタが述べるのは「近くに国道があまり無い」ことだけで、その代わりに
N13 が何を描いているかは述べない。そこでこのスクリプトは、クラスタの標本の点に
最も近い N13 の線を、道路分類を問わず引き、その分類と距離も報告する。国道でないと
はっきり分かる分類(都道府県道 / 市区町村道等 / 高速自動車国道等 / その他)が近くに
在ることは、単に無いことより強い手掛かりである。こちらの道が走るまさにその場所に、
N13 が国道でない特定の物を描いている、という意味だからである。指定解除——道が単に
消されるのではなく、下位の区分へ移されること——は、この出どころからはそう見える。
不明 はここに数えない。裏付ける物を何も主張していないためである。

どちらの向きも同じ格子を使う。地域のアークは短い OSM の way で、N13 のレコードは
さらに短い(交差点ごとではなく、属性が変わるたびに切られている)ので、最近傍の頂点
ではなく最近傍の線分までの距離を、局所的な正距円筒で測る。頂点だけを見ると、どちら
の側の頂点の間隔も、そのまま偽の食い違いに読めてしまう。

距離だけでは証明にならない。隙間は、本物の欠落かもしれないし、OSM のタグによる
除外(`why` を参照。audit.py の除外の理由をそのまま使う)かもしれないし、同じ 1 本の
線を二つの出どころが別々に描いただけかもしれない。どれなのか、そしてどの路線番号
なのかは、隙間についても、このスクリプトが分類しきれないクラスタについても、
地理院地図を開いた人が決める。TRIAGE.md の「N13 は路線番号を持たないので…ここが
人の出番です」は、今もその部分を支える一文である。確認済みと印の付いたクラスタは、
指定解除が起きたこと自体を述べるのに、その手作業がもう不要な唯一の場所である。
その道がかつて何号だったかは、今も人が決める。この確認を生成データに焼き込むか
(N13 を生成の依存に加えるか)は別の判断で、意図して開いたままにしてある——issue #9
を参照。

使い方:  uv run pipeline/compare_n13.py [地域|all] [--refresh]

`all` は orphan の向きだけを、way id で重複排除しながら全国で走らせる。
`--refresh` は、キャッシュが在ってもすべてのメッシュを取り直して解析し直す。
"""
from __future__ import annotations

import itertools
import json
import math
import os
import shutil
import sys
import zipfile
from array import array
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import numpy as np
import requests
import shapefile

from _paths import N13, REGIONS as DATA
from audit import DSU, claims, load_cache, why_excluded
from geo import EARTH_RADIUS_M, haversine
from regions import REGIONS as PREFECTURES

# https://nlftp.mlit.go.jp/ksj/gml/data/N13/N13-24/N13-24_<mesh>_SHP.zip serves
# 1 次メッシュ(約 80 km 四方)ごとの shapefile を配る。GML も置いてあるが、
# shapefile のほうがスキーマが小さく、pyshp は純 Python である——GDAL も不要で、
# 新しいシステム依存も増えない。ここの他のスクリプトと同じ方針である。
BASE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/N13/N13-24"
UA = {"User-Agent": "NationalRouteMap/0.2 (build pipeline)"}

# shapefile 自身の欄の名前は意味を伝えない(KSJ の符号化の約束に従った
# N13_001..N13_008 であって、製品仕様の日本語名ではない)。メッシュ 5438 を落とし、
# 0 番のレコードを製品仕様(KS-PS-N13-v1_1.pdf 4.1.3.2)と手で突き合わせて確かめた。
# 0 番が整備データ登録日、1 番が種別、2 番が道路分類(rdCtg)、3 番が道路状態、
# 4 番が階層順、5 番が幅員区分、6 番が有料区分、7 番が 2 次メッシュ番号である。
# 名前を付けるのは、このスクリプトが使う物だけである。DBF では Character 型で
# あることも確認済み(sf.fields)なので、必ず文字列として読み戻る——"1" と何も
# 言わずに不一致になる Numeric ではない。
RDCTG_FIELD = 2
RDCTG_KOKUDO = "1"

# 道路分類種別コードの全区分。KS-PS-N13-v1_1.pdf(2026-03, 国土交通省)4.1.3.2
# の応用スキーマ文書と付属資料-2 の符号化仕様(XSD の enumeration/description)
# の両方で確認済み — 推定ではない。低被覆率クラスタの直下に国道以外の何が
# 描かれているかを言うのに使う。不明(6)は「何かは分からない」という情報しか
# 持たないので、指定解除の裏付けにはならない。
RDCTG_LABELS = {
    "1": "国道",
    "2": "都道府県道",
    "3": "市区町村道等",
    "4": "高速自動車国道等",
    "5": "その他",
    "6": "不明",
}

# 1 次メッシュの符号。p = floor(緯度 * 1.5)(2 桁)と q = floor(経度) - 100
# (2 桁)を繋いだ物である。地域メッシュ統計の標準の 1 次メッシュであって、N13 に
# 固有の物ではない。長野県の bbox に対して測ると、TRIAGE.md が既に挙げているのと
# 同じ 8 個の符号を返す。式そのもの(覚えた一覧ではなく)が正しいことは、それで
# 裏が取れる。
def mesh_codes_for_bbox(bbox: list[float]) -> list[str]:
    west, south, east, north = bbox
    p_lo, p_hi = math.floor(south * 1.5), math.floor(north * 1.5)
    q_lo, q_hi = math.floor(west) - 100, math.floor(east) - 100
    return [f"{p}{q:02d}" for p in range(p_lo, p_hi + 1) for q in range(q_lo, q_hi + 1)]


def neighbor_mesh_codes(pt: tuple[float, float]) -> list[str]:
    """mesh_codes_for_bbox と同じ p/q の式で、(緯度, 経度) の 1 点が落ちる
    メッシュと、p/q の格子の上でその 8 近傍を返す。

    道は 1 次メッシュの境界ごとに切られているので、境界から CONFIRM_THRESHOLD_M
    以内にある標本の点は、本当に最も近い N13 の線が自分のメッシュではなく隣の
    メッシュに在ることがある——含んでいるメッシュだけを見ると(この関数の以前の版が
    そうだった)、縁の近くで確認済みのクラスタを数え落とす。ここが返すメッシュの
    うち、既に知っている物をすべて見る classify_clusters_beneath を参照。"""
    lat, lon = pt
    p, q = math.floor(lat * 1.5), math.floor(lon) - 100
    return [f"{p + dp}{q + dq:02d}" for dp in (-1, 0, 1) for dq in (-1, 0, 1)]


# 404 になることを手で確認したメッシュの符号——KSJ はそのメッシュの N13
# shapefile を配っていない。陸が無く、N13 は道路しか覆わないためである。2026-08-22
# に regions.py の 47 都道府県すべてに触れて出た 404 の全部である(相異なるメッシュ
# 272 個のうち、ここに 125 個)。実行時のログを grep しただけでなく、ディスクの
# build/n13/ とも突き合わせてある(メッシュのキャッシュはあるのに展開した
# .shp のディレクトリが無いメッシュは、下の 404 の分岐を通ってしかそうならない)。
# 最初に手で集めた一覧は、確認の実行がファイルへ流れていなかったメッシュを 5 つ
# 取り落としていた。この集合に無いメッシュの 404 は、同類だとは仮定しない——
# ensure_mesh を参照。新しい符号をここへ加えてよいと確かめるには、これらを確かめた
# のと同じように手で見る(KSJ の URL が 404 を返し、そのメッシュが地図の上で外洋で
# ある)しかない。これから出る 404 すべてへ、見ないまま理屈を広げてはいけない。
KNOWN_OCEAN_MESHES = frozenset({
    "3522", "3523", "3524", "3525", "3526", "3527", "3528", "3529", "3530", "3531",
    "3625", "3626", "3627", "3628", "3629", "3630", "3722", "3723", "3726", "3727",
    "3728", "3729", "3730", "3731", "3822", "3823", "3824", "3825", "3826", "3827",
    "3828", "3829", "3830", "3922", "3923", "3924", "3925", "3929", "3930", "3931",
    "4022", "4023", "4024", "4025", "4026", "4029", "4030", "4031", "4122", "4123",
    "4124", "4125", "4126", "4127", "4130", "4131", "4222", "4223", "4224", "4225",
    "4226", "4227", "4228", "4231", "4328", "4330", "4331", "4428", "4430", "4431",
    "4528", "4628", "4632", "4727", "4732", "4827", "4832", "4833", "4834", "4927",
    "4935", "4936", "5027", "5028", "5037", "5127", "5128", "5140", "5141", "5227",
    "5228", "5230", "5241", "5331", "5341", "5431", "5434", "5441", "5642", "5736",
    "5737", "5742", "5842", "6042", "6142", "6143", "6144", "6145", "6242", "6244",
    "6245", "6344", "6345", "6539", "6639", "6640", "6739", "6740", "6743", "6744",
    "6745", "6839", "6843", "6844", "6845",
})


def ensure_mesh(mesh: str, refresh: bool) -> Path | None:
    """メッシュ 1 つの SHP 一式を、キャッシュに無ければ落として展開する。

    KNOWN_OCEAN_MESHES にあるメッシュが 404 を返したときは None を返す——
    shapefile が配られていないことを確認済みであって、一時的な失敗ではない。呼ぶ側
    は、国道のレコードが 0 件の shapefile と同じに扱う。下の print はそれをメッシュ
    ごとに見せ、握りつぶさない。それ以外のメッシュの 404 は、推測せずに例外を投げる。
    全部が海のメッシュと、KSJ の障害や URL の変更とを、ここでは見分けられない。
    だから見覚えの無い 404 は、空の結果をキャッシュする理由ではなく、止まって手で
    確かめる理由である。
    """
    out_dir = N13 / mesh
    shp = out_dir / f"N13-24_{mesh}_SHP" / f"N13-24_{mesh}.shp"
    if shp.exists() and not refresh:
        return shp
    out_dir.mkdir(parents=True, exist_ok=True)
    url = f"{BASE_URL}/N13-24_{mesh}_SHP.zip"
    print(f"  downloading {url}", flush=True)
    r = requests.get(url, headers=UA, timeout=120)
    if r.status_code == 404:
        if mesh in KNOWN_OCEAN_MESHES:
            print(
                f"  {mesh}: no shapefile published (known all-ocean mesh) - treating as 0 records"
            )
            return None
        raise SystemExit(
            f"{mesh}: 404 from KSJ and this mesh is not in KNOWN_OCEAN_MESHES. "
            "Confirm by hand whether it is genuinely an all-ocean mesh (check "
            "the URL and look the mesh up on a map) before adding it to the "
            "set — do not assume."
        )
    r.raise_for_status()
    # 展開先を横の一時ディレクトリにしてから名前を付け替える。out_dir へ直に展開
    # すると、展開の途中で止まったとき(Ctrl-C、強制終了)、`.shp` は在るのに `.dbf`
    # が無い組が残り、次の実行はそれを「キャッシュ済み」と読んでしまう。上の
    # `shp.exists()` はファイルが 1 つ在ることしか見ていないためである。
    staging = out_dir.with_name(out_dir.name + f".{os.getpid()}.tmp")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    zip_path = staging / "shp.zip"
    zip_path.write_bytes(r.content)
    with zipfile.ZipFile(zip_path) as z:
        # zip は最上位に N13-24_<mesh>_SHP/ のフォルダを既に持っている——
        # 同じ名前の下位ディレクトリを作らず直接展開すれば、二重にならずに済む。
        z.extractall(staging)
    zip_path.unlink()
    if not (staging / shp.parent.name / shp.name).exists():
        shutil.rmtree(staging, ignore_errors=True)
        raise SystemExit(f"{mesh}: expected {shp} after unzip, not found")
    shutil.rmtree(out_dir, ignore_errors=True)
    try:
        os.replace(staging, out_dir)
    except OSError:
        # 同じメッシュを同時に取りに行った別のプロセスが先に置いた。落としてくる
        # 物は同じなので、自分の展開結果を捨てて相手の物を使う。
        shutil.rmtree(staging, ignore_errors=True)
    if not shp.exists():
        raise SystemExit(f"{mesh}: expected {shp} after unzip, not found")
    return shp


def segment_intersects_bbox(p0, p1, west: float, south: float, east: float,
                             north: float) -> bool:
    """Liang-Barsky の判定。線分 p0-p1(経度, 緯度)が矩形に少しでも触れていれば
    真を返す。両端とも外にありながら矩形を横切る弦も含む——頂点ごとに「どちらかの
    端が中にあるか」を見る判定が取り落とす場合である。
    """
    x0, y0 = p0
    x1, y1 = p1
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - west), (dx, east - x0),
                 (-dy, y0 - south), (dy, north - y0)):
        if p == 0:
            if q < 0:
                return False
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return False
            t0 = max(t0, r)
        else:
            if r < t0:
                return False
            t1 = min(t1, r)
    return t0 <= t1


def line_touches_bbox(line: list[tuple[float, float]], west: float, south: float,
                       east: float, north: float) -> bool:
    """line は (緯度, 経度) の点の並びである。線分のどれかが bbox に触れていれば、
    切らずに丸ごと残す——頂点ごとの判定では、両端とも外にありながら bbox の辺を
    横切る短い弦を落としてしまう。レコードは 2〜3 点なので(モジュールの docstring
    を参照)、丸ごと残したレコードが bbox の外へはみ出す長さは、せいぜい数十 m で
    ある。"""
    pts = [(lon, lat) for lat, lon in line]
    if not pts:
        return False
    pairs = list(itertools.pairwise(pts)) or [(pts[0], pts[0])]
    return any(segment_intersects_bbox(a, b, west, south, east, north) for a, b in pairs)


@dataclass
class Mesh:
    """そのメッシュのレコード全部——国道だけでなくすべての道路分類——を、bbox で
    切らずに持った物。

    座標は Python のオブジェクトの木ではなく、numpy の配列 1 本である。1 点を
    tuple で持つと、生の 16 バイトが何倍にも膨らむ。最大のメッシュ 5339(190 万
    レコード、749 万点)で実測すると、生の座標 114 MB に対して常駐 2,323 MB——
    20.3 倍だった。issue #103 が測ったピーク 2,466 MB の正体はこれである。同じ物
    を (点数, 2) の float64 の配列と区切りの添字で持てば、ディスクで 124 MB、
    mmap で開くので常駐にはほとんど乗らない。

    読み取り専用の写像であることには、常駐を増やさない以上の意味がある。同時に
    走る何本ものプロセスが同じ物理ページを共有するので、県ごとの段を並列にしても、
    N13 のぶんのメモリが並列度に比例して増えない。

    pts     (点数, 2) float64 — (緯度, 経度)。レコードの順に繋げてある
    starts  (レコード数 + 1,) int32 — pts への区切り。レコード i の座標は
            pts[starts[i]:starts[i + 1]] である
    rdctg   (レコード数,) S2 — 道路分類(rdCtg)。DBF の N13_003 は幅 2 の
            Character なので、2 バイトで元の値をそのまま持てる
    """
    pts: np.ndarray
    starts: np.ndarray
    rdctg: np.ndarray

    def lines(self, code: str) -> list[list[tuple[float, float]]]:
        """道路分類 `code` のレコードだけを、list[list[(緯度, 経度)]] にして返す。

        絞った後だけを Python のオブジェクトにするのが要点である。1 メッシュの
        全分類は最大 190 万件あるが、国道はそのうち 2 万件ほどしかない(issue #28)。
        呼ぶ側が線分の格子に積むのはその 2 万件だけで、残りは配列のまま触らずに
        済む。

        返すのは tuple であって、numpy の行でもリストでもない。resample_line が
        `points[-1] != coords[-1]` で端点の重複を避けており、tuple とリストは
        中身が同じでも等しくならない。ここで形を変えると、被覆率が静かに変わる。
        """
        want = code.encode("utf-8")
        out: list[list[tuple[float, float]]] = []
        starts = np.asarray(self.starts)
        for i in np.nonzero(np.asarray(self.rdctg) == want)[0]:
            lo, hi = int(starts[i]), int(starts[i + 1])
            out.append([(lat, lon) for lat, lon in self.pts[lo:hi].tolist()])
        return out

    @cached_property
    def segments(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """線分ごとの (本物の線分か, 裏付けになる分類か, 道路分類) の 3 本。

        pts は全レコードを繋げた 1 本なので、隣り合う 2 点が必ず 1 本の線分だとは
        限らない。レコード k の最初の点の 1 つ手前の線分は、前のレコードの最後の点
        と結んでしまう。starts がその境目を持っているので、そこだけ落とす。

        分類のほうは点ごとに広げてから 1 つずらす。線分 j はレコード内に収まって
        いるので(上で境目を落としてある)、始点の分類がその線分の分類である。
        広げた物をそのまま持つのは、線分 1 本の分類を引くたびに starts を二分探索
        するより安いからである——最大のメッシュで 1 本あたり 3.6 ms かかっていた
        (memmap への searchsorted である)。線分ごとに 2 バイトなので、いちばん
        大きいメッシュでも 12 MB に収まる。
        """
        starts = np.asarray(self.starts)
        n = len(self.pts)
        real = np.ones(max(n - 1, 0), dtype=bool)
        # 空のレコード(starts[k] == starts[k + 1])があると 0 が現れる。0 - 1 は
        # 最後の線分を指してしまうので、0 は境目に数えない。
        bnd = starts[1:-1]
        real[bnd[bnd > 0] - 1] = False
        code = np.repeat(np.asarray(self.rdctg), np.diff(starts))[:-1]
        # np.isin ではなく等値の論理和にする。数バイトの文字列 4 つに対する
        # np.isin は並べ替えを通るので、700 万要素では等値 4 回よりずっと重い。
        confirmable = np.zeros(len(code), dtype=bool)
        for want in sorted(CONFIRMABLE_RDCTG):
            confirmable |= code == want.encode("utf-8")
        return real, confirmable, code


# DBF の N13_003(道路分類)の幅。sf.fields で確認した値である。ここを超える値が
# 来たら、年版が変わって欄が広がったということなので、黙って切り詰めずに止まる。
RDCTG_WIDTH = 2


def mesh_cache_paths(mesh: str) -> tuple[Path, Path, Path]:
    """そのメッシュの packed キャッシュ 3 本。pts を最後に書く——下を参照。"""
    return (N13 / f"{mesh}.starts.npy", N13 / f"{mesh}.rdctg.npy",
            N13 / f"{mesh}.pts.npy")


def pack_mesh(mesh: str, refresh: bool) -> None:
    """そのメッシュの shapefile を解析し、Mesh の 3 本の配列としてキャッシュへ書く。

    「メッシュとそのとき欲しい分類」ごとではなく、メッシュごとに 1 つのキャッシュ
    で全分類を覆う。高く付くのは shapefile の解析であり、絞った後の物を鍵にした
    二つ目のキャッシュを持つと、このキャッシュが既に答えを持っている問い(「では
    ここに在る国道以外は何か」)に答えるために、同じ shapefile を解析し直すことに
    なる。

    キャッシュはメッシュの生の、絞っていないレコードを保ち、鍵はメッシュだけで
    ある——1 次メッシュは二つの地域の境をまたぐことが珍しくない(矩形が隣県へ食み
    込むことは regions.py を参照)。鍵をメッシュだけにしたまま書き込み時に絞ると、
    共有するメッシュに二番目に触れた地域が、自分の bbox ではなく最初の地域の bbox
    で絞った物を、何も言われないまま使い回すことになっていた。絞り込み(bbox でも、
    分類でも)は呼ぶ側に任せる。Mesh.lines を参照。

    座標は array("d") へ積む。Python のリストへ float を積むと、1 点あたり
    float オブジェクト 24 バイトと参照 8 バイトが残る。array は生の倍精度をその
    まま並べるので、解析中の山も座標のバイト数のままである。
    """
    shp_path = ensure_mesh(mesh, refresh)
    coords = array("d")
    starts = array("i", [0])
    codes = bytearray()
    if shp_path is not None:
        sf = shapefile.Reader(str(shp_path), encoding="utf-8")
        try:
            for i, rec in enumerate(sf.iterRecords()):
                for lon, lat in sf.shape(i).points:
                    coords.append(lat)
                    coords.append(lon)
                starts.append(len(coords) // 2)
                code = rec[RDCTG_FIELD].encode("utf-8")
                if len(code) > RDCTG_WIDTH:
                    raise SystemExit(
                        f"{mesh}: rdCtg {rec[RDCTG_FIELD]!r} は {RDCTG_WIDTH} "
                        "バイトに収まらない。N13 の年版が変わって欄が広がった "
                        "可能性がある。RDCTG_WIDTH を確かめること。"
                    )
                codes += code.ljust(RDCTG_WIDTH, b"\0")
        finally:
            # `with` ではなく try/finally にする。依存(pyshp。スクリプトの
            # ヘッダで版を固定していない)が、Reader の context manager に対応した
            # 版であるとは限らないためである。
            sf.close()

    N13.mkdir(parents=True, exist_ok=True)
    arrays = (
        # starts は小さいので、buffer の書式から素直に写す(array("i") が何バイト
        # かに依らない)。coords は最大 120 MB あるので、写さず buffer をそのまま
        # 見る——array("d") は C の double であり、float64 と同じ並びである。
        np.array(starts, dtype=np.int32),
        np.frombuffer(codes, dtype=f"S{RDCTG_WIDTH}"),
        (np.frombuffer(coords, dtype=np.float64).reshape(-1, 2)
         if len(coords) else np.empty((0, 2), dtype=np.float64)),
    )
    # それぞれ同じディレクトリの一時ファイルへ書いてから名前を付け替える——書き
    # 込みの途中で実行が止まると(Ctrl-C、メモリ不足による強制終了)、そうしなけれ
    # ば途中までのファイルが残り、次の実行は解析し直すのではなく np.load で落ちる。
    # 同じディレクトリにしておけば名前の付け替えが 1 つのファイルシステムの中で
    # 済み、それが不可分になる理由である。
    #
    # 3 本の順序にも意味がある。pts を最後に置き、load_mesh はその 1 本の有無だけ
    # を見る。pts が在るなら他の 2 本は既に置き替わっている——県ごとの段を並列に
    # したとき、半分だけ入れ替わった組を掴まないためである。
    for path, arr in zip(mesh_cache_paths(mesh), arrays, strict=True):
        tmp_path = path.with_name(path.name + f".{os.getpid()}.tmp")
        np.save(tmp_path, arr, allow_pickle=False)
        # np.save は拡張子 .npy が無ければ足す。付け替える先は足された物である。
        os.replace(tmp_path.with_name(tmp_path.name + ".npy"), path)


def load_mesh(mesh: str, refresh: bool) -> Mesh:
    """そのメッシュの Mesh を、キャッシュから mmap で開いて返す。無ければ作る。"""
    starts_p, rdctg_p, pts_p = mesh_cache_paths(mesh)
    if refresh or not pts_p.exists():
        pack_mesh(mesh, refresh)
    return Mesh(np.load(pts_p, mmap_mode="r"),
                np.load(starts_p, mmap_mode="r"),
                np.load(rdctg_p, mmap_mode="r"))


def load_kokudo_raw(mesh: str, refresh: bool) -> list[list[tuple[float, float]]]:
    """そのメッシュの国道のレコードだけ。bbox では切らない——キャッシュの考え方は
    pack_mesh の docstring にあり、ここもそれを共有する。"""
    return load_mesh(mesh, refresh).lines(RDCTG_KOKUDO)


# ---------------------------------------------------------------- geometry ---
# haversine と地球半径は geo.py の、DSU は audit.py のものである。写さずに
# import しているので、直せばこちらへ伝わる。
def point_segment_distance_m(p, a, b) -> float:
    """p から線分 a-b までの距離。p を中心とする局所的な正距円筒で測る。アーク
    1 本の尺度(数十 m から数 km)では cm の精度があり、これより重い物は不要である。"""

    def xy(pt):
        x = math.radians(pt[1] - p[1]) * math.cos(math.radians(p[0])) * EARTH_RADIUS_M
        y = math.radians(pt[0] - p[0]) * EARTH_RADIUS_M
        return x, y

    ax, ay = xy(a)
    bx, by = xy(b)
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(ax, ay)
    t = max(0.0, min(1.0, (-ax * dx - ay * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(cx, cy)


# メッシュ 5438(長野県中心部)で較正した。点から頂点までの距離は中央値 6.6 m、
# 90 パーセンタイル 31.6 m で、N13 自身が公称する位置の標準偏差 25 m に対する値で
# ある。点から線分までにすればさらに縮む。100 m は、両側の描き分けの揺れに実際の
# 余裕を与えつつ、audit.py の 50 m と 2 km の切り分けのように短い欠落を隠すことも
# ない値である。
GAP_THRESHOLD_M = 100
ORPHAN_THRESHOLD_M = 100

# アークにつき標本 1 点(旧来の規則は中点を使っていた)では、N13 の近くを通るのが
# 現道との接続だけである道が、完全に孤立していると読めてしまう。逆に、真ん中に
# 本物の隙間がある道が、完全に裏付けられていると読めてもしまう——issue #27 は、
# 旧来の規則で孤立と断じられた候補 804 件のうち 45 件が、実は「半分以上 N13 に
# 覆われている」ことを実測している。50 m はそのどちらも捉えるのに十分細かく、
# しかもこの短さの道を取り過ぎない間隔である。
SAMPLE_INTERVAL_M = 50

# これを下回る旧道のアークは、旧道フラグが古いままである候補になる。これ以上なら
# そのままにする。issue #27 が測った分布ははっきり二つの山に分かれていた——ちょうど
# 0% が 501 本、20% 未満がさらに 104 本、そこから人がどのみち目で見るしかない
# 20〜80% の灰色の帯、そして地理院地図が既に国道として描いている 80〜100% が
# 746 本である。20% はその灰色の帯の下端であって、切りのよい適当な数ではない。
# この線以上のアークはクラスタ化からまるごと外す(national_orphan_report と main
# にある cluster_by_endpoint の呼び出しを参照)。gap の向きが、一致しなかった N13 の
# レコードだけをクラスタ化し、一致した物は決してクラスタ化しないのと同じ形である。
ORPHAN_CANDIDATE_RATIO = 0.2

# 較正は上の ORPHAN_THRESHOLD_M と同じである——「クラスタの標本の点が落ちるまさに
# その場所に、別の分類の物が在る」ことが、たまたま近い無関係な二本の線ではなく
# 本物の一致だと言える距離である。国道(1)と不明(6)は外す。近くに国道が在ることは
# ここに当てはまらない(そのクラスタは既に低被覆率の候補である)し、不明は裏付けに
# なる主張を何もしていない。
CONFIRM_THRESHOLD_M = 100
CONFIRMABLE_RDCTG = {"2", "3", "4", "5"}

CELL = 0.01  # ~1 km at these latitudes — see audit.py's own grid for precedent


def cell_of(pt: tuple[float, float]) -> tuple[float, float]:
    return (round(pt[0], 2), round(pt[1], 2))


def cells_for_segment(a: tuple[float, float], b: tuple[float, float]) -> set:
    """線分 a-b が通る格子のセルを全部返す。中点のセルだけではない。

    N13 のレコードは短いので、中点だけで登録しても差し支えなかった。しかしこちらの
    アークは素の OSM の way である——ノードのまばらな峠区間は数 km に及び、CELL
    1 つを大きく超える。すると、その線分の遠い端の近くを問う点は、登録されていない
    中点のセルの周りを探して空を返す。線分に沿っておよそ CELL ごとに標本を取れば、
    横切るセルを漏れなく捉えられる。それより細かくしても得る物は無い。
    `nearest_segment` が、見つけた候補ごとに本当の距離を測り直すからである。
    """
    steps = max(1, math.ceil(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / CELL))
    return {
        cell_of((a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps))
        for i in range(steps + 1)
    }


def build_segment_grid(lines: list[list[tuple[float, float]]]) -> dict:
    grid: dict = {}
    for line in lines:
        for i in range(len(line) - 1):
            a, b = line[i], line[i + 1]
            for cell in cells_for_segment(a, b):
                grid.setdefault(cell, []).append((a, b))
    return grid


def nearest_segment(pt, grid, radius=1):
    c = cell_of(pt)
    best = None
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            key = (round(c[0] + dx * CELL, 2), round(c[1] + dy * CELL, 2))
            for a, b in grid.get(key, []):
                d = point_segment_distance_m(pt, a, b)
                if best is None or d < best:
                    best = d
    return best


# 距離の走査を numpy で回すとき、1 度に扱う点の数。
#
# メッシュを丸ごと一度に渡してはいけない。最大の 5339(749 万点)では一時配列
# 1 本で 60 MB、数え上げると 500 MB を超える——このファイルが N13 を配列で持つ
# ようにした理由そのものを、走査の側で打ち消してしまう。
#
# 小さすぎてもいけない。この大きさの塊を、問い合わせ点の数だけ繰り返し舐める
# (下の繰り返しの順序を参照)ので、塊とその一時配列が CPU のキャッシュに載って
# いるあいだは、二人目以降の問い合わせがメモリまで降りずに済む。65,536 点なら
# 塊が 1 MB、一時配列が 1 本 512 KB で、両方合わせても L2/L3 に収まる。
SCAN_CHUNK = 1 << 16


def nearest_classified_in_mesh(points: list[tuple[float, float]], mesh_data: Mesh
                                ) -> list[tuple[tuple[float, str] | None,
                                                 tuple[float, str] | None]]:
    """メッシュ 1 つの全分類のレコードに対する、厳密な最近傍線分の探索。セルの
    半径の近傍ではなく、線分を全部見る。

    セルの半径で探すやり方(この関数の以前の版がそうで、このファイルの他の最近傍
    線分の探索は今もその格子と CELL の仕組みを使っている)が安全なのは、呼ぶ側が
    しきい値との比較をしていて、そのしきい値が探索の広がりに比べて十分小さいとき
    だけである。ここの他の格子の参照はどれもそうだが(数 km の広がりに対して 100 m
    のしきい値である)、classify_beneath の「直下」の文面はそうではない。あちらは
    本当に最も近い線までの距離を、それが CONFIRM_THRESHOLD_M をはるかに超えていて
    も報告する。どれだけ大きく取った半径も、メッシュの分類済みの道がどこまで
    まばらになりうるかについての当て推量であり、この PR への CodeRabbit のレビュー
    は、その当て推量を二度(約 1 km と約 4 km で)、まだ本物の線分を見落としうると
    指摘した。線分を全部走査すれば、当て推量そのものが無くなる。

    走査そのものは numpy で回す。Python のループで 1 本ずつ測ると、最大のメッシュ
    の 550 万本に数秒かかり、(クラスタ, メッシュ) の対ごとにそれを払うことになる
    ——福島県 1 県の apply_n13 が 301 秒かかっていたのはここである(issue #103)。

    問い合わせ点は 1 つずつではなく、そのメッシュを見たいものをまとめて受ける。
    繰り返しの順序が「塊が外、点が内」になるのはそのためで、1 つの塊とその一時
    配列が CPU のキャッシュに載っているあいだに、その塊に対する全部の点を片付ける。
    点ごとにメッシュを頭から舐め直すと、同じ数の演算に対してメモリを何倍も往復
    する。茨城県は 9 メッシュに対して 34 クラスタを問うので、この順序だけで
    メッシュを読む回数が 233 回から 9 回になる。

    ただし返す距離そのものは、numpy が出した値ではなく point_segment_distance_m
    が出した値である。numpy が決めるのは「どの線分が最も近いか」だけで、決まった
    後にその 1 本を本物の関数へ渡し直す。だから numpy の側は、括り方を変えて演算
    を減らしてよい——最後の 1 ビットが動いたとしても、それで選ばれ方が変わるのは
    1 ULP 差で並んだ二本のどちらを採るかという場面だけであり、返る値はどちらでも
    本物の関数の出力である。しきい値と比べる値も報告に出る値も、このファイルが
    距離だと述べている定義そのものの出力になる。写した式ではない。

    返すのは points と同じ長さの一覧で、各要素が
    (nearest_any, nearest_confirmable) である——それぞれの意味は classify_beneath
    を参照。どちらも (距離, rdCtg) か None である。
    """
    best: list[list[tuple[float, str] | None]] = [[None, None] for _ in points]
    pts = mesh_data.pts
    n = len(pts)
    if n < 2 or not points:
        return [(b[0], b[1]) for b in best]
    real, confirmable, code = mesh_data.segments

    # 問い合わせ点ごとの、局所的な正距円筒の係数。point_segment_distance_m は
    # 1 点ずつ radians と cos を呼ぶが、点が決まれば定数なので、括り出して 1 回の
    # 掛け算にしておく。
    frames = [(lat0, lon0,
               math.radians(1.0) * math.cos(math.radians(lat0)) * EARTH_RADIUS_M,
               math.radians(1.0) * EARTH_RADIUS_M)
              for lat0, lon0 in points]

    # 作業領域は先に確保して使い回す。塊と問い合わせ点の組ごとに 4 MB の配列を
    # 十数本ずつ作り直すと、確保と解放と、まっさらな頁を触りに行く費用のほうが、
    # 実際の掛け算より高く付く。out= で書き先を渡す形にすれば、この繰り返しの
    # あいだ 1 バイトも新しく確保しない。
    span = min(SCAN_CHUNK, n - 1)
    x, y = np.empty(span + 1), np.empty(span + 1)
    dx, dy, denom, num, t, cx, cy, dist = (np.empty(span) for _ in range(8))

    def closer(prev, j, pt):
        """線分 j を本物の関数で測り直し、これまでの最良と比べる。"""
        a, b = pts[j].tolist(), pts[j + 1].tolist()
        cand = (point_segment_distance_m(pt, (a[0], a[1]), (b[0], b[1])),
                code[j].decode("utf-8"))
        return cand if prev is None or cand[0] < prev[0] else prev

    for lo in range(0, n - 1, SCAN_CHUNK):
        hi = min(lo + SCAN_CHUNK + 1, n)
        w = hi - lo - 1                      # この塊の線分の数
        chunk = np.asarray(pts[lo:hi])
        # 緯度と経度を、それぞれ隙間なく並んだ配列へ写してから使う。pts は
        # (点数, 2) なので chunk[:, 0] は 8 バイトおきの飛び飛びの眺めである。
        # 写しは塊につき 1 度で、その塊に対する全部の問い合わせ点が使い回す。
        lat_c, lon_c = chunk[:, 0].copy(), chunk[:, 1].copy()
        # 線分でない隙間(レコードの境目)と、裏付けにならない分類を、距離へ足す
        # 無限大にしておく。塊ごとに 1 度だけ作れば、点ごとには足し算 1 回で済む。
        window = real[lo:lo + w]
        veil_any = np.where(window, 0.0, np.inf)
        veil_confirmable = np.where(window & confirmable[lo:lo + w], 0.0, np.inf)
        # 長さ 0 の線分がどれかは、問い合わせ点によらない。同じ 2 点が並んでいる
        # かどうかだけで決まるので、塊ごとに 1 度見ておく。
        degenerate = (lat_c[:-1] == lat_c[1:]) & (lon_c[:-1] == lon_c[1:])
        any_degenerate = bool(degenerate.any())
        xw, yw = x[:w + 1], y[:w + 1]
        dxw, dyw, denw, numw = dx[:w], dy[:w], denom[:w], num[:w]
        tw, cxw, cyw, dw = t[:w], cx[:w], cy[:w], dist[:w]
        for k, (lat0, lon0, kx, ky) in enumerate(frames):
            np.subtract(lon_c, lon0, out=xw)
            np.multiply(xw, kx, out=xw)
            np.subtract(lat_c, lat0, out=yw)
            np.multiply(yw, ky, out=yw)
            ax, ay, bx, by = xw[:-1], yw[:-1], xw[1:], yw[1:]
            np.subtract(bx, ax, out=dxw)
            np.subtract(by, ay, out=dyw)
            np.multiply(dxw, dxw, out=denw)
            np.multiply(dyw, dyw, out=tw)
            np.add(denw, tw, out=denw)
            np.multiply(ax, dxw, out=numw)
            np.multiply(ay, dyw, out=tw)
            np.add(numw, tw, out=numw)
            np.negative(numw, out=numw)
            with np.errstate(invalid="ignore", divide="ignore"):
                np.divide(numw, denw, out=tw)
            np.clip(tw, 0.0, 1.0, out=tw)
            # 長さ 0 の線分では 0/0 が出る。t = 0 にすれば始点そのものを指すので、
            # 本物の関数が返す「端点までの距離」と同じ答えになる。
            if any_degenerate:
                np.copyto(tw, 0.0, where=degenerate)
            np.multiply(tw, dxw, out=cxw)
            np.add(ax, cxw, out=cxw)
            np.multiply(tw, dyw, out=cyw)
            np.add(ay, cyw, out=cyw)
            np.hypot(cxw, cyw, out=dw)
            for slot, veil in ((0, veil_any), (1, veil_confirmable)):
                np.add(dw, veil, out=numw)   # numw をここで一時に借りる
                j = int(np.argmin(numw))
                if math.isinf(numw[j]):
                    continue        # この塊に、その条件を満たす線分が 1 本も無い
                best[k][slot] = closer(best[k][slot], lo + j, points[k])
    return [(b[0], b[1]) for b in best]


def classify_beneath(nearest_any: tuple[float, str] | None,
                      nearest_confirmable: tuple[float, str] | None) -> tuple[str, bool]:
    """nearest_classified_in_mesh の結果を、報告の文字列と、指定解除の機械確認
    のフラグに整える。文字列は、分類を問わず N13 が標本の点の最も近くに描いている
    物である。フラグは、全体で最も近い物が何かとは独立に、裏付けになる分類
    (CONFIRMABLE_RDCTG を参照)が CONFIRM_THRESHOLD_M 以内に在るかどうかである。
    考え方はモジュールの docstring の該当の段落にある。main() の 1 地域の報告と
    national_orphan_report が共有するので、「確認済み」の意味が二つに割れることは
    ない。
    """
    confirmed = nearest_confirmable is not None and nearest_confirmable[0] <= CONFIRM_THRESHOLD_M
    if nearest_any is None:
        return "N13 分類なし", confirmed
    dist, rdctg = nearest_any
    label = RDCTG_LABELS.get(rdctg, f"コード{rdctg!r}")
    mark = " [指定解除を機械確認]" if confirmed else ""
    return f"直下 {dist:.0f} m に{label}{mark}", confirmed


def classify_clusters_beneath(clusters: list[dict], refresh: bool,
                               known_meshes: set[str]) -> None:
    """クラスタそれぞれに "beneath"(文字列)と "confirmed"(真偽)を、その場で
    付ける。値は、クラスタの標本の点に最も近い、分類を問わない N13 の線から作る。

    1 メッシュの全分類(国道だけではない)のレコードは、国道だけの部分集合の 30〜50
    倍になる——メッシュあたり 74,000〜137,000 件に対し、国道は 2,000〜3,000 件で
    ある(issue #28)。かつてこれを Python のオブジェクトへ起こしていた頃は、
    クラスタが跨りうるメッシュを全部 1 つにまとめるとメモリを使い果たしたので、
    1 メッシュぶんを読んでは捨てる形にしていた。今は Mesh が mmap で開くので、
    メッシュを開く費用そのものがほとんど無い。それでもメッシュごとに繰り返すのは、
    同じメッシュを何度も開き直さないためである。分類を見る処理を coverage_ratio と
    同じ繰り返しの中に置けないことは変わらない(coverage_ratio のほうは今も
    メッシュごとの国道だけの部分集合を 1 つの格子へ読み込む。そちらは十分小さい
    ままである。load_kokudo_raw を呼ぶ側を参照)。

    道はメッシュの境界ごとに切られているので、境界から CONFIRM_THRESHOLD_M 以内に
    ある標本の点は、本当に最も近い N13 の線が隣のメッシュに在ることがある——この
    関数の以前の版は標本を含むメッシュだけを見ており、縁の近くで確認済みを数え
    落としていた(この PR への CodeRabbit のレビュー)。代わりに、クラスタごとに自分の
    メッシュとその 8 近傍(neighbor_mesh_codes)を見て、その中で最も良い一致を 1 つ
    残す。見るのは known_meshes——呼ぶ側が既に解決済みのメッシュの集合(地域自身の
    `meshes` か、全国の `all_meshes`)——に既に在る近傍だけである。県の bbox は
    大きく重なるので、本物のクラスタが近づきうるメッシュはその集合に既に入って
    いる。だから絞っても失う物は無く、ensure_mesh が一度も検証していないメッシュ
    への要求を避けられる(そこで本当に新しいメッシュが 404 を返すことは、止まって
    手で確かめる理由であって、この関数が当て推量で引き当ててよい物ではない)。
    """
    for c in clusters:
        c["_nearest_any"] = None
        c["_nearest_confirmable"] = None

    mesh_to_clusters: dict[str, list[dict]] = {}
    for c in clusters:
        for mesh in neighbor_mesh_codes(c["sample"]):
            if mesh in known_meshes:
                mesh_to_clusters.setdefault(mesh, []).append(c)

    for mesh, mesh_clusters in mesh_to_clusters.items():
        mesh_data = load_mesh(mesh, refresh)
        # そのメッシュを問うクラスタをまとめて渡す。1 つずつ渡すとメッシュを
        # クラスタの数だけ舐め直すことになる——nearest_classified_in_mesh を参照。
        found = nearest_classified_in_mesh([c["sample"] for c in mesh_clusters],
                                            mesh_data)
        for c, (nearest_any, nearest_confirmable) in zip(mesh_clusters, found,
                                                          strict=True):
            if nearest_any is not None and (c["_nearest_any"] is None
                                             or nearest_any[0] < c["_nearest_any"][0]):
                c["_nearest_any"] = nearest_any
            if nearest_confirmable is not None and (
                c["_nearest_confirmable"] is None
                or nearest_confirmable[0] < c["_nearest_confirmable"][0]
            ):
                c["_nearest_confirmable"] = nearest_confirmable
        # `mesh_data` はここで捨てる。次のメッシュを開く前である——線分ごとの真偽
        # の配列(Mesh.segments)だけは点の数ぶんあるので、二つのメッシュのぶんを
        # 同時に抱えないようにしておく。

    for c in clusters:
        c["beneath"], c["confirmed"] = classify_beneath(
            c.pop("_nearest_any"), c.pop("_nearest_confirmable")
        )


# ----------------------------------------------------------------- coverage --
def resample_line(coords: list[tuple[float, float]],
                   interval_m: float = SAMPLE_INTERVAL_M) -> list[tuple[float, float]]:
    """coords, resampled to one point every interval_m along its length, plus
    both endpoints. A line shorter than interval_m still yields its two
    endpoints, so coverage_ratio never divides by zero."""
    if len(coords) < 2:
        return list(coords)
    points = [coords[0]]
    dist_so_far = 0.0
    next_mark = interval_m
    for a, b in itertools.pairwise(coords):
        seg_len = haversine(a, b)
        if seg_len == 0:
            continue
        while dist_so_far + seg_len >= next_mark:
            t = (next_mark - dist_so_far) / seg_len
            points.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            next_mark += interval_m
        dist_so_far += seg_len
    if points[-1] != coords[-1]:
        points.append(coords[-1])
    return points


def coverage_ratio(coords: list[tuple[float, float]], grid,
                    threshold_m: float) -> tuple[int, int, float | None]:
    """SAMPLE_INTERVAL_M ごとに取り直した点についての (matched, total, min_dist)。

    アーク自身の頂点でもなく、中点 1 点(旧来の規則)でもない。旧道のアークは作り
    からして両端で現道と繋がり直すので、その二つの端点は、道そのものが今も N13 に
    裏付けられているかどうかに関わらず threshold_m 以内に入る。中点だけを見れば、
    一部しか裏付けの残っていない道のどこにでも落ちうる。全長に沿って標本を取ること
    が、この割合を「その道のどれだけか」にする。「その道の適当な 1 点がどうか」では
    なくなる。

    min_dist は、どの標本が N13 に最も近づいたかであり、それが threshold_m を
    超えていても返す——issue #27 の PR への CodeRabbit のレビューが、割合 0 は
    「近くに N13 が無い」を意味しないことを捉えた。50 m ごとのどの標本からも
    threshold_m のすぐ外に在る N13 の線は、被覆率 0% と読めるが、「N13 なし」では
    ない。それを意味するのは、min_dist が None のとき——nearest_segment 自身の
    探索半径の中で、どの標本も何も見つけられなかったとき——だけである。
    """
    points = resample_line(coords)
    matched = 0
    min_dist = None
    for p in points:
        d = nearest_segment(p, grid)
        if d is None:
            continue
        if min_dist is None or d < min_dist:
            min_dist = d
        if d <= threshold_m:
            matched += 1
    return matched, len(points), min_dist


def ratio_of(arc: dict) -> float:
    return arc["matched"] / arc["total"] if arc["total"] else 0.0


def coverage_label(cluster: dict) -> str:
    """「N13 なし」とするのは min_dist が None のときだけである——nearest_segment
    自身の探索半径の中で、どの標本も何も見つけられなかったときである。被覆率 0%
    だけではそれを意味しない。どの標本からも ORPHAN_THRESHOLD_M のすぐ外に在る
    N13 の線は、被覆率 0% と読めるが無いわけではない(coverage_ratio を参照)。"""
    if cluster["min_dist"] is None:
        return "N13 なし"
    label = f"被覆率 {cluster['ratio'] * 100:.0f}%"
    if cluster["ratio"] == 0:
        label += f"(最寄 N13 {cluster['min_dist']:.0f} m)"
    return label


# --------------------------------------------------------------- clustering --
def node_key(pt):
    return (round(pt[0], 6), round(pt[1], 6))


def cluster_by_endpoint(lines: list[list[tuple[float, float]]]) -> list[list[int]]:
    """lines への添字を、端点の DSU によって始点・終点の共有でまとめる。N13 は
    連続した道を、属性が変わるたびに短いレコードへ切る。旧道の路線も、短い OSM の
    way に分かれているのが普通である。だから 1 本の実在する道は、たいてい 1 件では
    なく数十件の連続したレコードやアークになる——gap と orphan の両方の向きで共有
    する(orphan 側は issue #27 で足した。gap 側は元から持っていた)。"""
    dsu = DSU()
    for line in lines:
        dsu.union(node_key(line[0]), node_key(line[-1]))
    groups: dict = {}
    for i, line in enumerate(lines):
        root = dsu.find(node_key(line[0]))
        groups.setdefault(root, []).append(i)
    return list(groups.values())


def cluster_gaps(gap_lines: list[list[tuple[float, float]]]):
    clusters = []
    for idxs in cluster_by_endpoint(gap_lines):
        lines = [gap_lines[i] for i in idxs]
        km = sum(
            haversine(ln[i], ln[i + 1]) for ln in lines for i in range(len(ln) - 1)
        ) / 1000
        mid_line = lines[len(lines) // 2]
        clusters.append({"lines": lines, "km": km, "sample": mid_line[len(mid_line) // 2]})
    return sorted(clusters, key=lambda c: -c["km"])


def cluster_former_arcs(arcs: list[dict]):
    """端点を共有する旧道のアークを 1 つの仕分けの単位にまとめ、まとめた全体に
    ついて長さで重み付けした被覆率を持たせる。

    アークの dict には id・feature・coords・matched・total が必要である(coverage_ratio
    を参照)。先にまとめてから評価する——アークごとに評価してからその評価をまとめる
    のではない——ことが、標本の数が揃わないクラスタ(短いアークは 2 点しか出さない
    こともある)でも、道全体について 1 つの正直な割合になる理由である。
    """
    lines = [a["coords"] for a in arcs]
    clusters = []
    for idxs in cluster_by_endpoint(lines):
        members = [arcs[i] for i in idxs]
        km = sum(haversine(m["coords"][j], m["coords"][j + 1])
                  for m in members for j in range(len(m["coords"]) - 1)) / 1000
        matched = sum(m["matched"] for m in members)
        total = sum(m["total"] for m in members)
        dists = [m["min_dist"] for m in members if m["min_dist"] is not None]
        mid = members[len(members) // 2]
        clusters.append({
            "members": members,
            "km": km,
            "ratio": matched / total if total else 0.0,
            "min_dist": min(dists) if dists else None,
            "sample": mid["coords"][len(mid["coords"]) // 2],
            "ids": sorted({m["id"] for m in members}),
            "refs": sorted({r for m in members for r in m["feature"]["properties"]["refs_list"]}),
        })
    return sorted(clusters, key=lambda c: -c["km"])


# ------------------------------------------------------------------- report --
def nearby_osm_ways(cache, out_ids, point, radius_m):
    hits = []
    for wid, w in cache["ways"].items():
        if wid in out_ids:
            continue
        t = w.get("tags", {})
        if not claims(t):
            continue
        # 頂点だけでなく way の線分までの距離を測る——ノードの間隔が広い way は、
        # そうしないと `point` のすぐ脇を通っているのに、どの頂点も radius_m の
        # 中に落ちず、ただ除外されているだけなのに「OSM に無い」と報告されうる。
        geometry = [(p["lat"], p["lon"]) for p in w["geometry"]]
        if len(geometry) < 2:
            hit = geometry and haversine(point, geometry[0]) <= radius_m
        else:
            hit = any(point_segment_distance_m(point, a, b) <= radius_m
                      for a, b in itertools.pairwise(geometry))
        if hit:
            hits.append((wid, t))
    return hits


def region_former_clusters(meta: dict, gj: dict, refresh: bool) -> tuple[list[dict], int]:
    """この地域自身の旧道のアークを、N13 と突き合わせてクラスタ化し、分類する
    ——メッシュ全体で見るのであって、bbox では切らない(地域の旧道のアークは自分の
    県境の近くに在りうる。ここで bbox で切ると、issue #27 が全国で直した偽の
    「N13 なし」が再現する理由は、main() の n13_grid_raw についてのコメントを参照)。

    main() の 1 地域の報告と、apply_n13.py の書き込みの経路が共有する。人が読む
    報告と、生成物が実際に書く `revoked` 属性とで、どのアークを確認済みと数えるか
    が離れていかないようにするためである——issue #9 を参照。返すのは
    (clusters, former_arc_count) である。
    """
    meshes = mesh_codes_for_bbox(meta["bbox"])
    kokudo_raw: list[list[tuple[float, float]]] = []
    for mesh in meshes:
        kokudo_raw.extend(load_kokudo_raw(mesh, refresh))
    grid = build_segment_grid(kokudo_raw)

    former_arcs = [f for f in gj["features"] if f["properties"].get("former")]
    arcs = []
    for f in former_arcs:
        coords = [(lat, lon) for lon, lat in f["geometry"]["coordinates"]]
        matched, total, min_dist = coverage_ratio(coords, grid, ORPHAN_THRESHOLD_M)
        arcs.append({"id": f["properties"]["id"], "feature": f, "coords": coords,
                      "matched": matched, "total": total, "min_dist": min_dist})
    candidates = [a for a in arcs if ratio_of(a) < ORPHAN_CANDIDATE_RATIO]
    clusters = cluster_former_arcs(candidates)
    classify_clusters_beneath(clusters, refresh, set(meshes))
    return clusters, len(former_arcs)


def national_orphan_report(refresh: bool) -> None:
    """former 孤立候補を全国横断・重複排除・被覆率・クラスタ単位で出す——issue #27。

    1 地域だけの実行では重複排除ができない。同じ way は、余白を付けた bbox が
    たまたまそれを含む県の数だけ現れる(issue #27 は、#9 が挙げた延べ 3,546 件が、
    相異なる way id 1,644 本に畳まれ、うち 1,301 本が 2 県以上に重複していることを
    実測した)。「同じアークが二度並んでいる」のか「別々の二つのアーク」なのかを
    言えるのは、全地域の出力を同時に手元に持つ実行だけである。
    """
    per_way: dict[int, dict] = {}
    raw_count = 0
    all_meshes: set[str] = set()
    for region in PREFECTURES:
        meta = json.loads((DATA / f"{region}.meta.json").read_text(encoding="utf-8"))
        gj = json.loads((DATA / f"{region}.geojson").read_text(encoding="utf-8"))
        all_meshes |= set(mesh_codes_for_bbox(meta["bbox"]))
        for f in gj["features"]:
            if not f["properties"].get("former"):
                continue
            raw_count += 1
            per_way.setdefault(f["properties"]["id"], f)
    print(f"former arcs: {raw_count} raw across {len(PREFECTURES)} region(s), "
          f"{len(per_way)} unique way id(s) after dedup by way id")

    print(f"loading {len(all_meshes)} N13 mesh(es) nationwide (mesh-wide, no bbox cut — "
          "see load_kokudo_raw)...")
    # 全メッシュを同時に積み上げるのは、国道だけの部分集合に限る——全国でも
    # 1 つの格子に収まる大きさに留まる(issue #27 が既に実地で確かめている)。下の
    # classify_clusters_beneath が使う全分類の読み込みは、意図してここに抱えない。
    # 全メッシュの全分類を全国ぶん束ねるとメモリを使い果たす理由は、あの関数の
    # docstring を参照。
    kokudo_raw: list[list[tuple[float, float]]] = []
    for mesh in sorted(all_meshes):
        kokudo_raw.extend(load_kokudo_raw(mesh, refresh))
    print(f"N13 国道 records nationwide: {len(kokudo_raw)}")
    grid = build_segment_grid(kokudo_raw)

    arcs = []
    for wid, f in per_way.items():
        coords = [(lat, lon) for lon, lat in f["geometry"]["coordinates"]]
        matched, total, min_dist = coverage_ratio(coords, grid, ORPHAN_THRESHOLD_M)
        arcs.append({"id": wid, "feature": f, "coords": coords, "matched": matched,
                      "total": total, "min_dist": min_dist})

    def bucket(ratio: float) -> str:
        pct = ratio * 100
        if pct == 0:
            return "0%"
        if pct < 20:
            return "0-20%"
        if pct < 80:
            return "20-80%"
        return "80-100%"

    counts = {"0%": 0, "0-20%": 0, "20-80%": 0, "80-100%": 0}
    for a in arcs:
        counts[bucket(ratio_of(a))] += 1
    print("\narc-level coverage distribution:")
    for k in ("0%", "0-20%", "20-80%", "80-100%"):
        print(f"  {k}: {counts[k]}")

    # クラスタ化するのは候補のアークだけである(ratio_of < ORPHAN_CANDIDATE_RATIO)
    # ——自分自身が N13 に十分裏付けられているアークがクラスタに加わることはない。
    # cluster_gaps が、一致しないと分類済みの N13 のレコードしか見ず、一致した物を
    # 決して見ないのと同じである。
    candidates = [a for a in arcs if ratio_of(a) < ORPHAN_CANDIDATE_RATIO]
    clusters = cluster_former_arcs(candidates)
    print(f"\nclassifying what N13 draws beneath {len(clusters)} cluster(s), "
          "one mesh's 全分類 records at a time (see classify_clusters_beneath)...")
    classify_clusters_beneath(clusters, refresh, all_meshes)
    print(f"{len(clusters)} cluster(s) from {len(candidates)} candidate arc(s) "
          f"(< {ORPHAN_CANDIDATE_RATIO * 100:.0f}% coverage) - candidates for a "
          "stale former flag (地理院地図 may already show this as 指定解除 outright)")
    print("=" * 80)
    confirmed_clusters = 0
    confirmed_arcs = 0
    for c in clusters:
        lat, lon = c["sample"]
        label = coverage_label(c)
        if c["confirmed"]:
            confirmed_clusters += 1
            confirmed_arcs += len(c["members"])
        id_list = ", ".join(f"way/{i}" for i in c["ids"][:5])
        if len(c["ids"]) > 5:
            id_list += f", 他{len(c['ids']) - 5}件"
        print(f"  国道{'・'.join(map(str, c['refs']))}  {c['km']:.2f} km  "
              f"{len(c['members']):>3} arc(s)  {label}  sample {lat:.5f},{lon:.5f}  "
              f"({c['beneath']})")
        print(f"    {id_list}")

    print(f"\n{confirmed_clusters}/{len(clusters)} cluster(s) mechanically confirmed as "
          f"指定解除 ({confirmed_arcs} arc(s)) — 非国道の N13 分類が "
          f"{CONFIRM_THRESHOLD_M} m 以内の直下にある")


def main() -> None:
    # Windows の端末は標準出力の既定が cp932 で、このスクリプトが出す字(ダッシュ
    # や一部の記号)を持たない。build_all.py も同じ壁に当たる。
    sys.stdout.reconfigure(errors="replace")
    args = [a for a in sys.argv[1:] if a != "--refresh"]
    refresh = "--refresh" in sys.argv[1:]
    region = args[0] if args else "nagano"

    if region == "all":
        national_orphan_report(refresh)
        return

    meta = json.loads((DATA / f"{region}.meta.json").read_text(encoding="utf-8"))
    gj = json.loads((DATA / f"{region}.geojson").read_text(encoding="utf-8"))
    bbox = meta["bbox"]
    feats = gj["features"]
    out_ids = {f["properties"]["id"] for f in feats}

    meshes = mesh_codes_for_bbox(bbox)
    print(f"{region}: bbox {bbox} -> {len(meshes)} mesh(es): {', '.join(meshes)}")

    west, south, east, north = bbox
    kokudo: list[list[tuple[float, float]]] = []       # bbox-filtered: gap direction
    kokudo_raw: list[list[tuple[float, float]]] = []   # mesh-wide: orphan direction
    # 全分類(国道だけでなくすべての道路分類)は、ここではメッシュをまたいで積み
    # 上げない——全メッシュの全分類を同時に抱えることこそメモリを使い果たした原因
    # である理由は、classify_clusters_beneath の docstring を参照。あちらは後から、
    # packed キャッシュから 1 メッシュずつ mmap で開き直す。
    for mesh in meshes:
        raw = load_kokudo_raw(mesh, refresh)
        filtered = [line for line in raw if line_touches_bbox(line, west, south, east, north)]
        print(f"  {mesh}: {len(filtered)} N13 国道 record(s) inside bbox ({len(raw)} in mesh)")
        kokudo.extend(filtered)
        kokudo_raw.extend(raw)
    print(f"total N13 国道 records in {region}: {len(kokudo)} bbox-filtered, "
          f"{len(kokudo_raw)} mesh-wide")

    our_lines = [
        [(lat, lon) for lon, lat in f["geometry"]["coordinates"]] for f in feats
    ]
    our_grid = build_segment_grid(our_lines)

    # ---- gap。近くにこちらの物が無い N13 の国道 --------------------------
    gap_lines = []
    matched = 0
    for line in kokudo:
        mid = line[len(line) // 2]
        d = nearest_segment(mid, our_grid)
        if d is None or d > GAP_THRESHOLD_M:
            gap_lines.append(line)
        else:
            matched += 1
    print(f"\nmatched within {GAP_THRESHOLD_M} m: {matched}/{len(kokudo)}")

    clusters = cluster_gaps(gap_lines)
    total_gap_km = sum(c["km"] for c in clusters)
    print(f"gap clusters: {len(clusters)}, {total_gap_km:.1f} km total")

    cache = load_cache(region)
    corroborated = set(meta["corroborated_refs"])

    print("\n" + "=" * 80)
    print("N13 国道 with nothing of ours within "
          f"{GAP_THRESHOLD_M} m - candidates for TRIAGE.md's "
          "\"OSM 自体に無い\" case")
    print("=" * 80)
    for c in clusters[:20]:
        lat, lon = c["sample"]
        print(f"\n  {c['km']:.2f} km  {len(c['lines']):>3} record(s)  "
              f"sample {lat:.5f},{lon:.5f}")
        if not cache:
            continue
        hits = nearby_osm_ways(cache, out_ids, c["sample"], max(GAP_THRESHOLD_M, 150))
        if hits:
            print(f"    OSM has {len(hits)} way(s) here that we excluded:")
            for wid, t in hits[:3]:
                print(f"      way/{wid} ref={t.get('ref')!r} name={t.get('name')!r} "
                      f"highway={t.get('highway')!r}")
                for why in why_excluded(wid, t, cache, corroborated):
                    print(f"        - {why}")
        else:
            print("    no excluded OSM way here - absent from OSM itself")

    # ---- orphan。近くに N13 の裏付けが無いこちらの旧道のアーク -------------
    # 同じ way id を地域をまたいで重複排除したいときは、地域に "all" を渡して
    # 走らせる——national_orphan_report を参照。
    clusters, former_count = region_former_clusters(meta, gj, refresh)
    candidate_count = sum(len(c["members"]) for c in clusters)

    print("\n" + "=" * 80)
    print(f"our former arcs ({former_count} total) - {len(clusters)} cluster(s) "
          f"from {candidate_count} candidate arc(s) (< {ORPHAN_CANDIDATE_RATIO * 100:.0f}% "
          "N13 coverage) - candidates for a stale former flag (地理院地図 may already "
          "show this as 指定解除 outright)")
    print("=" * 80)
    confirmed_clusters = 0
    confirmed_arcs = 0
    for c in clusters:
        lat, lon = c["sample"]
        label = coverage_label(c)
        if c["confirmed"]:
            confirmed_clusters += 1
            confirmed_arcs += len(c["members"])
        print(f"  国道{'・'.join(map(str, c['refs']))}  {c['km']:.2f} km  "
              f"{len(c['members']):>3} arc(s)  {label}  sample {lat:.5f},{lon:.5f}  "
              f"({c['beneath']})")
    if not clusters:
        print("  none")

    print(f"\n{len(clusters)} cluster(s) flagged, from {candidate_count}/{former_count} arc(s)")
    print(f"{confirmed_clusters}/{len(clusters)} cluster(s) mechanically confirmed as "
          f"指定解除 ({confirmed_arcs} arc(s)) — 非国道の N13 分類が "
          f"{CONFIRM_THRESHOLD_M} m 以内の直下にある")


if __name__ == "__main__":
    main()
