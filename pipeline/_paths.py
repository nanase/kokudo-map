"""リポジトリの場所を決める。pipeline/ はルートの直下にあるので深さは決まって
いる。

書き込みの作法も 1 つだけ置く。場所を知っている物がそこへどう書くかも知って
いれば、同じ手当てを何箇所にも写さずに済む。"""
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

# 地域ごとの GeoJSON と meta。中間成果であって配信データではない。全国では
# 47 ファイル約 70 MB になり、閲覧側は代わりに詰めたタイルを読む。
REGIONS = ROOT / "build" / "regions"

# 都道府県道の判定の生成物。国道と同じ形の GeoJSON と meta である。木を
# 分けるのは、build_routes.py が REGIONS の `*.meta.json` を数え上げて地域の
# 索引を作るからである。同じ木に置くと、県道の meta が国道の索引に混ざる。
PREFECTURAL = ROOT / "build" / "prefectural"

# 閲覧側が実際に取る物。
DATA = ROOT / "web" / "data"


def write_atomic(path: Path, text: str) -> None:
    """同じディレクトリの一時ファイルへ書いてから名前を付け替える。

    `Path.write_text` は途中まで書けた状態を人に見せる。読む側が別のプロセス
    なら、その途中を掴む。build_routes.py は自分の meta を書いた直後に
    build/regions/ の meta を全部読んで索引を作り直していた。県を並列にすると、
    隣の県が書いている最中の meta をそこで読み、json.loads が「Expecting value:
    line 1 column 1」で落ちた(issue #103 の並列度 6 の実測)。

    同じディレクトリに置くのは、名前の付け替えが 1 つのファイルシステムの中で
    済んで不可分になるからである。プロセス番号を一時名に入れるのは、同じ
    ファイルを同時に書きに来た二人が互いの一時ファイルを潰さないためである。
    """
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    # newline="\n" を渡さないと Windows では書き込み時に \n が \r\n に化ける。
    # cf_cache.py は書いた内容をそのまま読み直して比較するので、プラット
    # フォームによって同じ内容が違う差分として出るのを避ける。
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)
