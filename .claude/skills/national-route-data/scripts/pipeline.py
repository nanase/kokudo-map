# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Run the whole build for one region, stopping at the first failure.

The stage order is fixed, so it lives here rather than in the skill document.

Usage:  uv run pipeline.py [region] [--skip-fetch]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from _paths import ROOT

HERE = Path(__file__).resolve().parent


def run(label: str, cmd: list[str]) -> None:
    print(f"\n{'=' * 70}\n{label}\n{'=' * 70}", flush=True)
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        raise SystemExit(f"\n{label} failed with exit code {r.returncode}")


def main() -> None:
    args = sys.argv[1:]
    skip_fetch = "--skip-fetch" in args
    args = [a for a in args if not a.startswith("--")]
    region = args[0] if args else "nagano"

    stages = []
    if not skip_fetch:
        stages.append(("取得 — OSM から取得してキャッシュする",
                       ["uv", "run", str(HERE / "fetch_osm.py"), region]))
    stages += [
        ("判定 — web/data/ を生成する",
         ["uv", "run", str(HERE / "build_routes.py"), region]),
        ("検証 — 生成物の整合性を確認する",
         ["uv", "run", str(HERE / "verify.py"), region]),
        ("式検証 — 地図スタイルと絞り込み式を確認する",
         ["node", str(HERE / "check_expressions.mjs"), region]),
    ]

    for label, cmd in stages:
        run(label, cmd)

    print(f"\n{'=' * 70}")
    print("すべて通った。ブラウザでの実描画は render_check.mjs で確認する。")
    print("ローカルサーバを起動してから次を実行する。")
    print(f"  node {Path(HERE / 'render_check.mjs').relative_to(ROOT)} shot")


if __name__ == "__main__":
    main()
