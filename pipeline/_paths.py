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

# Per-region GeoJSON and meta. Intermediate, not served: nationwide they come to
# ~70 MB across 47 files, and the viewer reads the packed tiles instead.
REGIONS = ROOT / "build" / "regions"

# What the viewer actually fetches.
DATA = ROOT / "web" / "data"
