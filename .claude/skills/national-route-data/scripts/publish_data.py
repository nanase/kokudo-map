# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Publish web/data/ to the R2 bucket the site fetches from.

The served data is deliberately not in git. Two reasons, both in .gitignore:
the road data is ODbL while the code is MIT, and the tiles are ~55 MB of
already-gzipped bytes that neither delta nor compress, so every rebuild would
be stacked whole onto the history.

It also does not travel through GitHub Pages. Pages' backend (Fastly) has a
bug: a Range request that does not start at byte 0 comes back as bytes
unrelated to the file actually asked for, on every file we tried, on every
path we tried to route around it (Cloudflare cache rules, compression rules,
a fresh deploy). PMTiles is read almost entirely by such requests, so the map
never drew. R2 sits behind the same Cloudflare zone and does not have the
bug, so the data lives there instead — at data.nanase.cc — and
.github/workflows/pages.yml rewrites the two relative paths in the shipped
JS to point at it.

Usage:
    uv run scripts/publish_data.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys

from _paths import DATA

BUCKET = "kokudo-map-data"

# Exactly what the viewer fetches. index.html, app.js and the rest travel with
# the repository; only these are built.
FILES = ["national-routes.pmtiles", "national.meta.json", "regions.json"]


def wrangler(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bunx", "wrangler", *args], text=True, capture_output=True, check=check
    )


def preflight() -> None:
    """Fail with the actual reason rather than with wrangler's."""
    if shutil.which("bunx") is None:
        sys.exit("bun が見つからない。mise install で入るはずである。")

    missing = [f for f in FILES if not (DATA / f).is_file()]
    if missing:
        sys.exit(
            f"web/data/ に {', '.join(missing)} が無い。先に `mise run pack` を実行する。"
        )

    if wrangler("whoami", check=False).returncode != 0:
        sys.exit(
            "wrangler が Cloudflare にログインしていない。`bunx wrangler login` を実行する。"
        )


def main() -> None:
    preflight()

    for name in FILES:
        path = DATA / name
        size = path.stat().st_size
        print(f"  {name}  {size / 1e6:.1f} MB  を上げる")
        wrangler(
            "r2", "object", "put", f"{BUCKET}/{name}",
            "--file", str(path),
            "--remote",
        )

    print("上げ終わった。data.nanase.cc は数秒で新しい内容を返すようになる。")


if __name__ == "__main__":
    main()
