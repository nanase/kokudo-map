# /// script
# requires-python = ">=3.12"
# dependencies = ["requests", "pyshp", "numpy"]
# ///
"""N13 による指定解除の機械確認を、`revoked` 属性として
build/regions/<region>.geojson へ書く。former 孤立候補の仕分けについての
issue #9 の判断である。

compare_n13.py 自身のコマンドは読み取り専用のままで、報告を出すだけである。
compare_n13.region_former_clusters() の `confirmed` を生成データに変える場所は
このスクリプトだけで、報告と同じクラスタ化の関数を通す(その関数の docstring)。
`mise run compare-n13` で人が読む物と、ビルドが書く物が離れないようにするため
である。

`revoked` は `former` とは独立で(RULES.md 旧道)、置き換えではない。旧道の
アークは N13 が何と言おうと former=1 のままである。法令上の指定は OSM のタグ
付けより何年も遅れうるからである。N13 と突き合わせるのは、compare_n13.py が
仕分けた低被覆率の候補に入る旧道のアークだけである。それ以外のアークは、旧道で
あってもなくても build_routes.py が書いた既定の revoked=0 のままである。つまり
revoked=0 は「未確認」であって「現役だと確認済み」ではない。

使い方:  uv run pipeline/apply_n13.py <地域> [--refresh]
"""
from __future__ import annotations

import json
import sys

from _paths import REGIONS as DATA, write_atomic
from compare_n13 import region_former_clusters


def main() -> None:
    # Windows の端末は標準出力の既定が cp932 である(compare_n13.main())。
    sys.stdout.reconfigure(errors="replace")
    args = [a for a in sys.argv[1:] if a != "--refresh"]
    refresh = "--refresh" in sys.argv[1:]
    region = args[0] if args else "nagano"

    gj_path = DATA / f"{region}.geojson"
    meta_path = DATA / f"{region}.meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    gj = json.loads(gj_path.read_text(encoding="utf-8"))

    # 先に戻す。このスクリプトは build_routes.py の直後に走る想定で、あちらは
    # 既に全アークへ revoked=0 を書き直している。しかし仕分けの最中には単独でも
    # 走る(mise run apply-n13)。この戻しが無いと、前回の実行で revoked=1 が
    # 入っている geojson に対する二度目の単独実行は確認を足すばかりで、候補から
    # 外れたアークの確認を取り消せない(CodeRabbit のレビュー)。この戻しで、
    # 誰が呼んでも毎回同じ地点から始まる。
    for f in gj["features"]:
        f["properties"]["revoked"] = 0

    # 旧道のアークが 1 本も無い地域では N13 と突き合わせる物が無い。使い道の
    # 無いデータを落とすより、メッシュの取得ごと飛ばす。それでも上の戻しは書き
    # 戻す。かつて旧道を持っていて今は持たない地域から、古い revoked=1 が消える
    # ようにするためである。
    if not any(f["properties"].get("former") for f in gj["features"]):
        print(f"{region}: no former arcs, nothing to confirm against N13")
        write_atomic(
            gj_path, json.dumps(gj, ensure_ascii=False, separators=(",", ":"))
        )
        meta["revoked_arcs"] = 0
        write_atomic(
            meta_path, json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
        )
        return

    clusters, former_count = region_former_clusters(meta, gj, refresh)
    confirmed = {m["id"] for c in clusters if c["confirmed"] for m in c["members"]}

    touched = 0
    for f in gj["features"]:
        if f["properties"]["id"] in confirmed:
            f["properties"]["revoked"] = 1
            touched += 1
    write_atomic(gj_path, json.dumps(gj, ensure_ascii=False, separators=(",", ":")))

    meta["revoked_arcs"] = touched
    write_atomic(
        meta_path, json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
    )

    print(f"{region}: {touched}/{former_count} former arc(s) confirmed 指定解除 by N13 "
          f"(revoked=1 written to {gj_path.name})")


if __name__ == "__main__":
    main()
