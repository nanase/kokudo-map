# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Publish web/data/ as the assets of one GitHub Release.

The served data is deliberately not in git. Two reasons, both in .gitignore:
the road data is ODbL while the code is MIT, and the tiles are ~55 MB of
already-gzipped bytes that neither delta nor compress, so every rebuild would
be stacked whole onto the history.

But GitHub Pages can only serve what the repository has or what a workflow
produced. A Release asset is the way out: it hangs off the repository without
entering its history, and .github/workflows/pages.yml downloads it at deploy
time. So the data is built here, uploaded here, and never committed.

One rolling tag rather than one release per build. The build is reproducible
from the pbf and the region definitions, so a shelf of old tiles would be
storage without a question to answer; `national.meta.json` already states which
day of OpenStreetMap is inside.

Usage:
    uv run scripts/publish_data.py            # upload, then redeploy the site
    uv run scripts/publish_data.py --no-deploy
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys

from _paths import DATA

TAG = "data-latest"
WORKFLOW = "pages.yml"

# Exactly what the viewer fetches. index.html, app.js and the rest travel with
# the repository; only these are built.
FILES = ["national-routes.pmtiles", "national.meta.json", "regions.json"]
SUMS = "SHA256SUMS"

NOTES = """\
国道マップの配信データである。`.github/workflows/pages.yml` がここから取って GitHub Pages に配る。

| ファイル | 中身 |
| --- | --- |
| `national-routes.pmtiles` | 全国のベクタタイル。Range 要求で読む |
| `national.meta.json` | 画面が出す集計。指定の組み合わせ単位 |
| `regions.json` | 地域の一覧 |
| `SHA256SUMS` | 上の 3 つのチェックサム |

道路データは © OpenStreetMap contributors であり、ODbL 1.0 で提供する。これは OSM を加工した派生データベースであり、同じ条件で使える。リポジトリのコード（MIT）とは条件が異なる。

タグは固定で、中身は作り直すたびに差し替わる。どの日の OpenStreetMap かは `national.meta.json` の `osm_timestamp` が述べる。
"""


def gh(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["gh", *args], text=True, capture_output=True, check=check
    )


def preflight() -> None:
    """Fail with the actual reason rather than with gh's."""
    if shutil.which("gh") is None:
        sys.exit(
            "gh が見つからない。GitHub CLI を入れて `gh auth login` を済ませる。\n"
            "  https://cli.github.com/"
        )
    if gh("auth", "status", check=False).returncode != 0:
        sys.exit("gh が認証されていない。`gh auth login` を実行する。")
    if gh("repo", "view", "--json", "name", check=False).returncode != 0:
        sys.exit(
            "GitHub のリポジトリが見つからない。remote を設定する。\n"
            "  gh repo create <名前> --private --source=. --remote=origin"
        )

    missing = [f for f in FILES if not (DATA / f).is_file()]
    if missing:
        sys.exit(
            f"web/data/ に {', '.join(missing)} が無い。先に `mise run pack` を実行する。"
        )


def write_sums() -> None:
    """coreutils format, so the workflow can check it with plain `sha256sum -c`."""
    lines = []
    for name in FILES:
        h = hashlib.sha256()
        with open(DATA / name, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        size = (DATA / name).stat().st_size
        print(f"  {name}  {size / 1e6:.1f} MB  {h.hexdigest()[:12]}…")
        lines.append(f"{h.hexdigest()}  {name}\n")
    (DATA / SUMS).write_text("".join(lines), encoding="utf-8", newline="\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--no-deploy",
        action="store_true",
        help="Release に上げるだけで、Pages を作り直さない",
    )
    args = ap.parse_args()

    preflight()

    print("チェックサムを作る")
    write_sums()

    if gh("release", "view", TAG, check=False).returncode != 0:
        print(f"Release {TAG} が無いので作る")
        gh(
            "release",
            "create",
            TAG,
            "--title",
            "配信データ（最新）",
            "--notes",
            NOTES,
        )

    print(f"Release {TAG} に上げる")
    gh(
        "release",
        "upload",
        TAG,
        *[str(DATA / f) for f in (*FILES, SUMS)],
        "--clobber",
    )

    if args.no_deploy:
        print("上げ終わった。Pages は作り直していない。")
        return

    print(f"{WORKFLOW} を起動する")
    gh("workflow", "run", WORKFLOW)
    print("上げ終わった。進行は `gh run watch` で見られる。")


if __name__ == "__main__":
    main()
