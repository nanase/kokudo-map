# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""web/data/ を、サイトが読みに行く R2 バケットへ公開する。

配信データを git に入れないのは意図してのことである。理由は二つあり、どちらも
.gitignore に書いてある。道路データは ODbL でコードは MIT であること。そして
タイルは既に gzip 済みの 156 MB で、差分も圧縮も効かず、作り直すたびに丸ごと
履歴へ積まれることである。

GitHub Pages も経由しない。Pages の裏側(Fastly)は、バイト 0 から始まらない
Range 要求に対して、要求したファイルとは無関係なバイト列を返す不具合を持つ。
試したどのファイルでも、迂回しようと試したどの経路でも(Cloudflare のキャッシュ
規則、圧縮規則、配信のやり直し)同じだった。PMTiles の読み取りはほぼ全てそういう
要求なので、地図は一度も描けなかった。R2 は同じ Cloudflare ゾーンの内側にあり、
この不具合を持たない。だからデータはそちら——data.nanase.cc——に置き、
.github/workflows/pages.yml が web/dataurl.mjs の基点をそこへ向け直す。書き換える
のはその 1 行だけなので、配信データのファイルが増えてもここは変わらない。

使い方:
    uv run pipeline/publish_data.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys

from _paths import DATA
from regions import REGIONS

BUCKET = "kokudo-map-data"

# 閲覧側が取る物ちょうど。index.html や app.js はリポジトリと一緒に運ばれる。
# 生成されるのはこれだけである。
#
# 国道と都道府県道でアーカイブが分かれているのは #100 の判断である。分けてあると、
# 県道を直したときに上げ直すのは 100 MB の側だけで済む——国道の 55.9 MB は動かない。
# 県ごとの meta が 47 個あるのも同じ理由で、画面が最初に読む JSON を増やさずに、
# 県を選んだときにその県のぶんだけを取らせるためである。
FILES = [
    "national-routes.pmtiles",
    "national.meta.json",
    "regions.json",
    "prefectural-routes.pmtiles",
    # 全国の県と番号だけの索引。選択パネルが番号で絞り込むために 1 度だけ読む。
    # 県別 meta 47 本(3.29 MB)を読ませずに済ませるためのもので、pack_web_pref が
    # 作る。glob は *.meta.json なので、これは名指しで挙げる。
    "pref/index.json",
]


def pref_metas() -> list[str]:
    """web/data/pref/ に在る県ごとの meta。R2 でも同じ `pref/` の下に置く。"""
    return sorted(f"pref/{p.name}" for p in (DATA / "pref").glob("*.meta.json"))


def wrangler(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """wrangler を bun x 経由で走らせ、出力をロケールによらず UTF-8 で読む。"""
    # `bunx` 自体は mise がシムを作らないことがあります。`bun x` は bun 本体の
    # サブコマンドなので、mise.toml が述べる bun さえ入っていれば必ず通ります。
    # encoding を省くと日本語 Windows では cp932 に落ち、wrangler が出す UTF-8 の
    # 飾り罫を読み取りスレッドが読めず、成功時も含め毎回そこで落ちます。実行自体は
    # そのまま進むので実害は薄いのですが、wrangler が本当に失敗したときだけ、
    # 下の sys.exit が見せるはずの理由が読めなくなります。
    r = subprocess.run(
        ["bun", "x", "wrangler", *args], text=True, capture_output=True,
        encoding="utf-8", errors="replace",
    )
    if check and r.returncode != 0:
        sys.exit(f"wrangler が失敗した(終了コード {r.returncode}):\n{r.stdout}{r.stderr}")
    return r


def preflight() -> None:
    """wrangler の理由ではなく、本当の理由で落ちる。"""
    if shutil.which("bun") is None:
        sys.exit("bun が見つからない。mise install で入るはずである。")

    missing = [f for f in FILES if not (DATA / f).is_file()]
    if missing:
        sys.exit(
            f"web/data/ に {', '.join(missing)} が無い。先に `mise run pack` を実行する。"
        )
    # 県が 1 つでも欠けた状態で上げない。欠けた県の路線はアーカイブにも入らない
    # のに、R2 には前回の meta が残る。半分だけの配信物は、揃った物と見分けが
    # 付かない。ここは配る直前の最後の関門なので、ここで数える。
    have = {name[len("pref/"):-len(".meta.json")] for name in pref_metas()}
    if have != set(REGIONS):
        short = sorted(set(REGIONS) - have)
        extra = sorted(have - set(REGIONS))
        sys.exit(
            "web/data/pref/ の県が 47 県と一致しない。"
            f"足りない: {', '.join(short) or 'なし'} / "
            f"余分: {', '.join(extra) or 'なし'}。"
            "先に `mise run build-pref` と `mise run pack` を実行する。"
        )

    if wrangler("whoami", check=False).returncode != 0:
        sys.exit(
            "wrangler が Cloudflare にログインしていない。`bun x wrangler login` を実行する。"
        )


def main() -> None:
    """配信データを wrangler で BUCKET へ上げる。"""
    # Windows の端末は標準出力の既定が cp932 である——build_all.main() を参照。
    sys.stdout.reconfigure(errors="replace")
    preflight()

    for name in FILES + pref_metas():
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
