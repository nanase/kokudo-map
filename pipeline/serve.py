# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""web/ を、バイト範囲の要求に答えられる形で配る。

`python -m http.server` は `Range` を無視し、200 でファイル全体を返す。GeoJSON
なら構わないが、PMTiles には致命的である。大きなアーカイブから必要な数 kB だけを
ブラウザが取ることこそ、あの形式の眼目だからである。これが無いと、閲覧側は最初の
1 タイルでアーカイブを丸ごと引き、解析に失敗する。

配信先として使えるだけの静的ホストはどれも範囲要求に答える。答えていなかったのは
開発用サーバだけだった。

使い方:  uv run pipeline/serve.py [ポート]
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
        # 開発用サーバは編集のたびに読まれる。キャッシュはその編集を隠すだけ。
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
            # このファイルはこのメソッドより長く生きる——下で返す _Slice を通して
            # 後から読まれるので、ここで with を使うと早く閉じすぎる。
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
            # 末尾からの範囲、つまり最後の N バイト。PMTiles は使わないが、
            # 中途半端な Range の実装は、無いよりたちが悪い。
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
    """要求された範囲に限ったファイル。copyfile() に渡す。"""

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
    print(f"http://localhost:{port}/  (web/ を配信、バイト範囲に対応)")
    ThreadingHTTPServer(("", port), handler).serve_forever()


if __name__ == "__main__":
    main()
