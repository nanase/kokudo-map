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

# Per-region GeoJSON and meta. Intermediate, not served: nationwide they come to
# ~70 MB across 47 files, and the viewer reads the packed tiles instead.
REGIONS = ROOT / "build" / "regions"

# What the viewer actually fetches.
DATA = ROOT / "web" / "data"
