# /// script
# requires-python = ">=3.12"
# dependencies = ["pmtiles>=3.4"]
# ///
"""pack_web.mjs が切ったタイルを、1 つの PMTiles アーカイブにまとめる。

ばらばらの .pbf が 10 万個あっても、リポジトリに置ける物でも配れる物でもない。
PMTiles は 1 ファイルで、素の静的ホストが範囲要求に答えられる。閲覧側が求めるの
はそれである。

これと pack_web.mjs が分かれているのはライブラリの都合だけである。geojson-vt と
vt-pbf は JavaScript、PMTiles を書く側は Python である。受け渡しがディレクトリ
ではなく blob と索引なのは、Windows では 10 万個の小さなファイルを作るほうが、
タイルを切るより時間がかかるからである。

使い方:  uv run pipeline/pack_pmtiles.py
"""
from __future__ import annotations

import gzip
import json

from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

from _paths import DATA, ROOT

TILEDIR = ROOT / "build" / "tiles"
OUT = DATA / "national-routes.pmtiles"

# どの属性がタイルに載り、閲覧側がそれぞれをどう使うか。PMTiles のアーカイブは
# 自分の層を自分で述べることになっているので、ここで述べる。
FIELDS = {
    "id": "Number",     # OSM way id — identity, and the link out to osm.org
    "refs": "String",   # ",18,117," — every filter tests membership in this
    "label": "String",  # 18・117 — what the symbol layer draws
    "n": "Number",      # how many designations, i.e. concurrency depth
    "kind": "String",   # road / expressway / construction / unopened / foot / steps / ferry
    "src": "String",    # relation / name / tag
    "former": "Number", # 1 for 旧道, still designated until 指定解除
    "name": "String",
    "updated": "String",
    "km": "Number",
}


def main() -> None:
    idx = json.loads((TILEDIR / "tiles.json").read_text(encoding="utf-8"))
    blob = (TILEDIR / "tiles.bin").read_bytes()
    rows = idx["tiles"]
    west, south, east, north = idx["bbox"]
    print(f"{len(rows):,} tiles, z{idx['minzoom']}-{idx['maxzoom']}, "
          f"{len(blob) / 1e6:.1f} MB uncompressed")

    # PMTiles はヒルベルト曲線の上でタイルを指す。id が増える一方になっている
    # 整列済みのアーカイブであることが、範囲要求が目録を辿らずにタイルを見つけ
    # られる理由である。
    rows.sort(key=lambda r: zxy_to_tileid(r[0], r[1], r[2]))

    e7 = lambda v: int(v * 1e7)  # noqa: E731
    DATA.mkdir(parents=True, exist_ok=True)
    written = 0
    with open(OUT, "wb") as f:
        w = Writer(f)
        for z, x, y, off, length in rows:
            w.write_tile(zxy_to_tileid(z, x, y), gzip.compress(blob[off:off + length], 6))
            written += 1
        w.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_lon_e7": e7(west), "min_lat_e7": e7(south),
                "max_lon_e7": e7(east), "max_lat_e7": e7(north),
                "min_zoom": idx["minzoom"], "max_zoom": idx["maxzoom"],
                "center_zoom": 5,
                "center_lon_e7": e7((west + east) / 2),
                "center_lat_e7": e7((south + north) / 2),
            },
            {
                "name": "国道マップ",
                "description": "日本の一般国道。重用区間は全指定を保持する。",
                "attribution": "© OpenStreetMap contributors (ODbL 1.0)",
                "format": "pbf",
                "vector_layers": [
                    {
                        "id": idx["layer"],
                        "description": "国道の区間（OSM の way 単位）",
                        "minzoom": idx["minzoom"],
                        "maxzoom": idx["maxzoom"],
                        "fields": FIELDS,
                    }
                ],
            },
        )
    size = OUT.stat().st_size
    print(f"wrote {OUT.relative_to(ROOT)} — {written:,} tiles, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
