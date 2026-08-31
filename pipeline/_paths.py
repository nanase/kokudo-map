"""リポジトリの場所を決める。pipeline/ はルートの直下にあるので、深さは決まって
いる。

書き込みの作法も 1 つだけ置く。場所を知っている物が、そこへどう書くかも知って
いるほうが、同じ手当てを何箇所にも写さずに済む。"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "build" / "cache"
PBF = ROOT / "build" / "pbf"

# 国土数値情報(N13, 道路)のメッシュごとの生データと、道路分類=国道に絞った
# 中間キャッシュ。取り直せる中間データなので build/ 配下(gitignore 対象)に置く。
N13 = ROOT / "build" / "n13"

# 国土数値情報(N03, 行政区域)の都道府県ごと・年版ごとの生データ。政令の起終点に
# 座標を当てるためだけに読む。取り直せるので build/ 配下に置く。
N03 = ROOT / "build" / "n03"

# 一般国道の路線を指定する政令の生 XML と、そこから作った参照表。
DECREE = ROOT / "build" / "decree"

# 都道府県道になりうる way を全国から測った結果。県ごとに 1 ファイルである。
# pbf から作り直せる中間データなので build/ 配下に置く。survey_prefectural.py を
# 参照。
SURVEY = ROOT / "build" / "survey"

# 地域ごとの GeoJSON と meta。中間成果であって配信物ではない。全国では 47 ファイル
# 約 70 MB になり、閲覧側は代わりに詰めたタイルを読む。
REGIONS = ROOT / "build" / "regions"

# 都道府県道の判定の生成物。国道と同じ形の GeoJSON と meta である。木を分けるのは、
# build_routes.py が REGIONS の `*.meta.json` を数え上げて地域の索引を作るからで
# ある。同じ木に置くと、県道の meta が国道の索引に混ざる。
PREFECTURAL = ROOT / "build" / "prefectural"

# 閲覧側が実際に取る物。
DATA = ROOT / "web" / "data"


def write_atomic(path: Path, text: str) -> None:
    """同じディレクトリの一時ファイルへ書いてから名前を付け替える。

    `Path.write_text` は途中まで書けた状態を人に見せる。読む側が別のプロセスなら、
    その途中を掴む。build_routes.py は自分の meta を書いた直後に、build/regions/
    の meta を全部読んで索引を作り直す——県を並列にすると、隣の県が書いている
    最中の meta をそこで読み、json.loads が「Expecting value: line 1 column 1」で
    落ちた(issue #103 の並列度 6 の実測)。

    同じディレクトリに置くのは、名前の付け替えが 1 つのファイルシステムの中で
    済むからで、それが不可分になる理由である。プロセス番号を一時名に入れるのは、
    同じファイルを同時に書きに来た二人が、互いの一時ファイルを潰さないためである。
    """
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
