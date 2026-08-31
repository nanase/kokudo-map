# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""1 地域ぶんの生成を通しで走らせ、最初の失敗で止まる。

段の順番は決まっているので、スキルの文書ではなくここが持つ。

これは 1 地域の経路で、その地域を Overpass から取得する。全国なら
extract_pbf.py を一度走らせてから build_all.py を使う。47 都道府県は約 140 件の
Overpass クエリと 1 GB の応答になり、公開ミラーの用途から外れる。

パックを最後に置くのは、web/data が全国ぶんだからである。1 地域を作り直して
パックを省くと、地図が自分のデータより 1 地域ぶん遅れる。

使い方:  uv run pipeline.py [地域] [--skip-fetch] [--skip-n13] [--no-pack]
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
    skip_n13 = "--skip-n13" in args
    no_pack = "--no-pack" in args
    args = [a for a in args if not a.startswith("--")]
    region = args[0] if args else "nagano"

    stages = []
    if not skip_fetch:
        stages.append(("取得 — OSM から取得してキャッシュする",
                       ["uv", "run", str(HERE / "fetch_osm.py"), region]))
    stages.append(
        ("判定 — build/regions/ を生成する",
         ["uv", "run", str(HERE / "build_routes.py"), region]),
    )
    # 地域の索引は、その 1 県ではなく揃っている物すべての話なので、判定そのものは
    # 書かない(build_routes.write_index を参照)。下のパックが読むので、ここで
    # 書き直しておく。
    stages.append(
        ("索引 — build/regions/regions.json を書く",
         ["uv", "run", str(HERE / "build_routes.py"), "--index-only"]),
    )
    if not skip_n13:
        # N13(国土数値情報)への都度ネットワーク取得が必要 — オフライン反復時は
        # --skip-n13 で飛ばす。ミラーは無く、単一の政府サイトのみを見る。
        stages.append(
            ("指定解除確認 — N13 と照合し revoked を書き込む",
             ["uv", "run", str(HERE / "apply_n13.py"), region]),
        )
    stages += [
        ("検証 — 生成物の整合性を確認する",
         ["uv", "run", str(HERE / "verify.py"), region]),
        ("式検証 — 地図スタイルと絞り込み式を確認する",
         ["node", str(HERE / "check_expressions.mjs"), region]),
    ]
    if not no_pack:
        stages += [
            ("配信データ — 地域を結合してタイルを切る",
             ["node", "--max-old-space-size=6144", str(HERE / "pack_web.mjs")]),
            ("配信データ — PMTiles にまとめる",
             ["uv", "run", str(HERE / "pack_pmtiles.py")]),
            ("全国検証 — 結合後にしか答えられないことを確認する",
             ["uv", "run", str(HERE / "verify_national.py")]),
        ]

    for label, cmd in stages:
        run(label, cmd)

    print(f"\n{'=' * 70}")
    print("すべて通った。ブラウザでの実描画は render_check.mjs で確認する。")
    print("ローカルサーバを起動してから次を実行する。")
    print(f"  node {Path(HERE / 'render_check.mjs').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
