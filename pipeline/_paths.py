"""Locate the project. pipeline/ sits directly under the project root, so the
depth is fixed."""
from __future__ import annotations

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

# Per-region GeoJSON and meta. Intermediate, not served: nationwide they come to
# ~70 MB across 47 files, and the viewer reads the packed tiles instead.
REGIONS = ROOT / "build" / "regions"

# What the viewer actually fetches.
DATA = ROOT / "web" / "data"
