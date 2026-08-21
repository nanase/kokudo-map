"""Locate the project regardless of where these scripts are installed.

The scripts belong to the skill, so their depth below the project root is not
fixed. They walk up until they find the project instead of counting parents.
"""
from __future__ import annotations

from pathlib import Path


def project_root(start: Path | None = None) -> Path:
    start = (start or Path(__file__)).resolve()
    for p in (start, *start.parents):
        if (p / "mise.toml").is_file() and (p / "web").is_dir():
            return p
    raise SystemExit(
        "project root not found: expected a directory containing mise.toml and web/ "
        f"above {start}"
    )


ROOT = project_root()
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
