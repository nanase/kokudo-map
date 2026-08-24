# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Serve web/ with byte-range support.

`python -m http.server` ignores `Range` and answers 200 with the whole file.
That is fine for GeoJSON and fatal for PMTiles, whose whole point is that the
browser fetches the few kilobytes it needs out of a large archive. Without this
the viewer would pull the entire archive on the first tile and fail to parse it.

Every static host worth deploying to answers ranges; only the development server
did not.

Usage:  uv run scripts/serve.py [port]
"""
from __future__ import annotations

import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

from _paths import ROOT

RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeHandler(SimpleHTTPRequestHandler):
    extensions_map: ClassVar[dict[str, str]] = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".pmtiles": "application/octet-stream",
        ".mjs": "text/javascript",
    }

    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        # The dev server is read once per edit; caching only hides the edit.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        header = self.headers.get("Range")
        if not header:
            return super().send_head()
        m = RANGE.match(header.strip())
        if not m:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            # The file outlives this method — it's read later via the _Slice
            # returned below, so a context manager here would close it too soon.
            f = open(path, "rb")  # noqa: SIM115
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        first, last = m.group(1), m.group(2)
        if first:
            start = int(first)
            end = int(last) if last else size - 1
        else:
            # A suffix range: the last N bytes. PMTiles does not use it, but a
            # half-implemented Range header is worse than none.
            start = max(0, size - int(last or 0))
            end = size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        return _Slice(f, end - start + 1)


class _Slice:
    """A file restricted to the requested range, for copyfile()."""

    def __init__(self, f, length: int) -> None:
        self.f = f
        self.left = length

    def read(self, n: int = -1) -> bytes:
        if self.left <= 0:
            return b""
        if n < 0 or n > self.left:
            n = self.left
        data = self.f.read(n)
        self.left -= len(data)
        return data

    def close(self) -> None:
        self.f.close()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(RangeHandler, directory=str(ROOT / "web"))
    print(f"http://localhost:{port}/  (serving web/, byte ranges enabled)")
    ThreadingHTTPServer(("", port), handler).serve_forever()


if __name__ == "__main__":
    main()
