# /// script
# requires-python = ">=3.12"
# dependencies = ["pmtiles>=3.4"]
# ///
"""pack_web.mjs と pack_web_pref.mjs が切ったタイルを、PMTiles にまとめる。

ばらばらの .pbf が 10 万個あっても、リポジトリに置ける物でも配れる物でもない。
PMTiles は 1 ファイルで、素の静的ホストが範囲要求に答えられる。閲覧側が求めるの
はそれである。

これとタイルを切る側が分かれているのはライブラリの都合だけである。geojson-vt と
vt-pbf は JavaScript、PMTiles を書く側は Python である。受け渡しがディレクトリ
ではなく blob と索引なのは、Windows では 10 万個の小さなファイルを作るほうが、
タイルを切るより時間がかかるからである。

アーカイブは国道と都道府県道で分かれている。理由は #100 にある——国道の 55.9 MB を
県道を直すたびに上げ直さずに済むこと、タイル化のメモリが 2 回に分かれること、
県道側が壊れても国道の地図は出ること。

使い方:  uv run pipeline/pack_pmtiles.py [national|prefectural ...]
         (既定: 生成物が在るアーカイブすべて)
"""
from __future__ import annotations

import gzip
import json
import sys

from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

from _paths import DATA, ROOT

# 国道のタイルが持つ属性。閲覧側がそれぞれをどう使うかも述べる。PMTiles の
# アーカイブは自分の層を自分で述べることになっているので、ここで述べる。
NATIONAL_FIELDS = {
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

# 都道府県道のタイルが持つ属性。国道との違いは四つある。
#
#   pref     所属県。番号は県の中でしか一意でないので、路線の同一性は (県, 番号)
#            である。`refs` にも県が入っているが、県だけで絞るときはこちらを見る
#   rank     主要地方道か一般都道府県道か。境目を決めているのは判定である
#   updated  持たない。都道府県道の判定は way の最終更新を運ばない
#   z0-7     `id`・`label`・`name`・`km`・`src` は載らない。pack_web_pref.mjs の
#            LOW_ZOOM_FIELDS を参照
PREFECTURAL_FIELDS = {
    "id": "Number",     # OSM way id — identity, and the link out to osm.org
    "pref": "String",   # nagano — 所属県。regions.py の地域名
    "refs": "String",   # ",nagano-18,nagano-30," — every filter tests membership
    "label": "String",  # 18・30 — what the symbol layer draws
    "n": "Number",      # how many designations, i.e. concurrency depth
    "kind": "String",   # road / expressway / construction / unopened / foot / steps / ferry
    "rank": "String",   # major (主要地方道) / general (一般都道府県道)
    "src": "String",    # relation / tag
    "former": "Number", # 1 for 旧道, still designated until 指定解除
    "name": "String",
    "km": "Number",
}

ARCHIVES = {
    "national": {
        "tiledir": ROOT / "build" / "tiles",
        "out": DATA / "national-routes.pmtiles",
        "name": "国道マップ",
        "description": "日本の一般国道。重用区間は全指定を保持する。",
        "layer_description": "国道の区間（OSM の way 単位）",
        "fields": NATIONAL_FIELDS,
    },
    "prefectural": {
        "tiledir": ROOT / "build" / "tiles-prefectural",
        "out": DATA / "prefectural-routes.pmtiles",
        "name": "国道マップ — 都道府県道",
        "description": "日本の都道府県道。重用区間は全指定を保持する。",
        "layer_description": "都道府県道の区間（OSM の way 単位）",
        "fields": PREFECTURAL_FIELDS,
    },
}


def pack(key: str) -> None:
    spec = ARCHIVES[key]
    tiledir = spec["tiledir"]
    out = spec["out"]
    idx = json.loads((tiledir / "tiles.json").read_text(encoding="utf-8"))
    blob = (tiledir / "tiles.bin").read_bytes()
    rows = idx["tiles"]
    west, south, east, north = idx["bbox"]
    print(f"{key}: {len(rows):,} tiles, z{idx['minzoom']}-{idx['maxzoom']}, "
          f"{len(blob) / 1e6:.1f} MB uncompressed")

    # PMTiles はヒルベルト曲線の上でタイルを指す。id が増える一方になっている
    # 整列済みのアーカイブであることが、範囲要求が目録を辿らずにタイルを見つけ
    # られる理由である。
    rows.sort(key=lambda r: zxy_to_tileid(r[0], r[1], r[2]))

    e7 = lambda v: int(v * 1e7)  # noqa: E731
    DATA.mkdir(parents=True, exist_ok=True)
    written = 0
    with open(out, "wb") as f:
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
                "name": spec["name"],
                "description": spec["description"],
                "attribution": "© OpenStreetMap contributors (ODbL 1.0)",
                "format": "pbf",
                "vector_layers": [
                    {
                        "id": idx["layer"],
                        "description": spec["layer_description"],
                        "minzoom": idx["minzoom"],
                        "maxzoom": idx["maxzoom"],
                        "fields": spec["fields"],
                    }
                ],
            },
        )
    size = out.stat().st_size
    print(f"wrote {out.relative_to(ROOT)} — {written:,} tiles, {size / 1e6:.1f} MB")


def main() -> None:
    wanted = [a for a in sys.argv[1:] if not a.startswith("--")]
    for key in wanted:
        if key not in ARCHIVES:
            raise SystemExit(
                f"知らないアーカイブ: {key}。選べるのは {', '.join(ARCHIVES)} である。")
    # 名指しが無ければ、切ってある物を詰める。都道府県道は survey-pref と
    # build-pref を先に要求するので、まだ無い手元がある。
    if not wanted:
        wanted = [k for k, s in ARCHIVES.items()
                  if (s["tiledir"] / "tiles.json").is_file()]
        if not wanted:
            raise SystemExit("切ってあるタイルが無い。先に `mise run pack` を実行する。")
    for key in wanted:
        pack(key)


if __name__ == "__main__":
    main()
