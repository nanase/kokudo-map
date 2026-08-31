# /// script
# requires-python = ">=3.12"
# dependencies = ["requests", "pyshp", "numpy"]
# ///
"""N13 のメッシュを、県ごとの段が読む packed の形へまとめて直す。

置き場と読み方は compare_n13.Mesh と pack_mesh にある。ここが足すのは「どの
メッシュを、いつ、どの順で用意するか」だけである。

**県ごとの段を並列にする前に、ここを直列で通す。**並列に入ってから取りに行くと、
同じ 1 次メッシュを何本ものプロセスが同時に KSJ へ要求しうる——1 次メッシュは
県境をまたぐので、隣り合う県が同じ符号を欲しがるのは例外ではなく普通である。
build_all.py がそのためにこれを先に呼ぶ。単独でも呼べる(`mise run pack-n13`)。

古い `<メッシュ>.classified.raw.json` は、packed が書けたメッシュから順に消す。
読む物はもう無く、全国で 6.7 GB ある。同じ内容を packed は 2.7 GB で持つ。消すの
は「その 1 ファイル」であって、`build/n13/` を木ごと消すことは決してしない。

使い方:  uv run pipeline/pack_n13.py [地域 ...]      (既定: 全地域)
         uv run pipeline/pack_n13.py --keep-legacy   (古い JSON を残す)
         uv run pipeline/pack_n13.py --refresh       (取り直して解析し直す)
"""
from __future__ import annotations

import sys
import time

from _paths import N13
from compare_n13 import mesh_cache_paths, mesh_codes_for_bbox, pack_mesh
from regions import REGIONS, named_regions


def meshes_for(regions: list[str]) -> list[str]:
    """その地域が触りうる 1 次メッシュ。regions.py の bbox から出す。

    build/regions/*.meta.json の `bbox` ではなく regions.py を読む。同じ値だが
    (meta はここから写されている)、meta があるのは build_routes.py が走った後
    だけである。取得の段は判定より前に置きたいので、判定の生成物に依存させない。
    """
    seen: set[str] = set()
    for region in regions:
        south, west, north, east = REGIONS[region]["bbox"]
        seen.update(mesh_codes_for_bbox([west, south, east, north]))
    return sorted(seen)


def main() -> None:
    sys.stdout.reconfigure(errors="replace")
    args = sys.argv[1:]
    keep_legacy = "--keep-legacy" in args
    refresh = "--refresh" in args
    regions = named_regions([a for a in args if not a.startswith("--")])

    meshes = meshes_for(regions)
    todo = [m for m in meshes if refresh or not mesh_cache_paths(m)[2].exists()]
    print(f"{len(regions)} 地域 → 1 次メッシュ {len(meshes)} 個。"
          f"うち用意するのは {len(todo)} 個。", flush=True)

    started = time.time()
    for i, mesh in enumerate(todo, 1):
        t = time.time()
        pack_mesh(mesh, refresh)
        pts = mesh_cache_paths(mesh)[2]
        print(f"  [{i:>3}/{len(todo)}] {mesh}  {time.time() - t:6.1f}s  "
              f"{pts.stat().st_size / 1048576:7.1f} MB", flush=True)
    if todo:
        print(f"{len(todo)} 個を {time.time() - started:.0f}s で用意した。", flush=True)

    if keep_legacy:
        return
    freed = 0
    dropped = 0
    for mesh in meshes:
        legacy = N13 / f"{mesh}.classified.raw.json"
        # packed が確かに在るメッシュだけ消す。取得に失敗して packed を書けな
        # かったメッシュの古い写しを、道連れにしないためである。
        if legacy.is_file() and mesh_cache_paths(mesh)[2].exists():
            freed += legacy.stat().st_size
            legacy.unlink()
            dropped += 1
    if dropped:
        print(f"古い JSON キャッシュ {dropped} 個を消した({freed / 1048576:.0f} MB)。")


if __name__ == "__main__":
    main()
