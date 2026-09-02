# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""全地域をキャッシュから生成し、続けて全国の生成物をパックして検査する。

地域ごとの判定は意図してそのままである。県はそれぞれ自分の bbox の中で判定する。
裏取りが濾せるのは、信用する路線番号の集合が全国ぶんではなく 1 県ぶんであるあいだ
だけだからである。新しいのは後半——地域を結合し、タイルを切り、地図が全国になって
初めて成り立つ問いを訊くこと——である。

パックの前に全地域を生成して検査し、失敗はまとめて報告する。最初の失敗で止めれば、
47 県のことを 1 回の実行につき 1 県ずつ知ることになる。それでもパックは全県が
通ったときにしか走らない。半分だけ生成した集合をアーカイブに詰めた物は、完全な物と
見分けが付かない。

県は互いに独立なので、同時に何県か走らせる。県ごとの段は自分の bbox の中だけを見て、
書く先も build/regions/<県>.* に分かれている。並列度の決め方と、その前に何を直列で
済ませておく必要があるかは REGION_JOBS を参照。

使い方:  uv run pipeline/build_all.py [地域 ...]   (既定: 全地域)
         uv run pipeline/build_all.py --skip-verify  (生成とパックだけ)
         uv run pipeline/build_all.py --no-pack      (地域ごとの処理だけ)
         uv run pipeline/build_all.py --jobs N       (県を同時に N 本まで)
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from _paths import PREFECTURAL, ROOT, SURVEY
from regions import REGIONS, named_regions

HERE = Path(__file__).resolve().parent

# 県を同時に何本まで走らせるか。
#
# 8 コア 16 スレッドの機械で、47 県を通しで測った(issue #103)。時間は秒、
# メモリは全プロセスぶんの合計である。RSS は mmap で共有している頁を本数ぶん
# 重複して数えるので、USS(そのプロセスだけが持つ頁)も併記する。
#
#     本数    時間     RSS 計    USS 計
#        1   412.8s    381 MB    199 MB
#        2   223.1s    620 MB
#        4   132.7s    967 MB    592 MB
#        6   113.7s  1,467 MB    901 MB
#        8   117.3s  1,837 MB  1,113 MB
#       12   127.1s  2,680 MB  1,660 MB
#       16   129.6s  3,082 MB  1,938 MB
#
# 6 で底を打ち、8 以降は縮まないままメモリだけ増える。だから 6 である。
#
# **空きメモリを埋める本数を選んではいけない。**この機械では他のプロセスが同時に
# 動いており、空いて見えるメモリを埋めれば、それらが押し出される。ここは「収まる
# 最大」ではなく「速さがもう伸びない所」である。増やしたいときは --jobs で渡せる
# が、山も一緒に測ること。
#
# N13 のメッシュは、この並列に入る前に pack_n13.py が直列で用意しておく。1 次
# メッシュは県境をまたぐので、用意しないまま並列に入ると、隣り合う県が同じ符号を
# 同時に KSJ へ要求する。用意さえ済んでいれば、読むのは mmap である——上の表で
# 1 本増やすごとに USS が 130〜150 MB しか増えないのは、N13 の中身を全員が同じ
# 物理ページで見ているからで、本数に比例するのは Python と地域の GeoJSON だけで
# ある。
REGION_JOBS = 6

# 返ってくる物を UTF-8 として読むので、子プロセスも UTF-8 で書かねばならない。
# pipe はコンソールではないため、そうしないと Python は端末のロケール——日本語
# Windows では cp932——へ落ちる。「尾駮バイパス」には cp932 に無い漢字が入って
# いる。青森県は自分の進捗の行を出そうとして落ち、それが生成の失敗として報告
# された。
CHILD_ENV = {**os.environ, "PYTHONIOENCODING": "utf-8"}


def run(cmd: list[str]) -> tuple[int, str]:
    r = subprocess.run(
        cmd, cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", env=CHILD_ENV,
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def stage(label: str, cmd: list[str]) -> None:
    """全国を相手にする段。こちらは最初の失敗で止まる。"""
    print(f"\n{'=' * 70}\n{label}\n{'=' * 70}", flush=True)
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        raise SystemExit(f"\n{label} failed with exit code {r.returncode}")


def verdict(out: str) -> str:
    lines = [ln for ln in out.splitlines() if "passed," in ln]
    return lines[-1] if lines else "no verdict"


def failures(out: str) -> list[str]:
    return [ln.strip() for ln in out.splitlines() if ln.startswith("FAIL")]


def outcome(label: str, code: int, out: str) -> list[str]:
    """子プロセスの判定。FAIL 行が捉えない終了コードも畳み込む。

    verify.py は FAIL 行を出せば自分で終了コード 1 を返すので、`code != 0` は
    `failures()` が既に見つけた以上のことを示さない。新しい情報になるのは、
    FAIL 行が 1 つも無いまま 0 でない終了コードが返ったとき——traceback や
    異常終了——だけである。それは FAIL 行ごとにではなく、一度だけ報告する。
    """
    bad = failures(out)
    if code != 0 and not bad:
        bad.append(f"{label} が終了コード {code} で異常終了しました(FAIL 行なし)")
    return bad


def prefectural(judge: bool) -> None:
    """都道府県道を判定し、別のアーカイブへ切る。

    国道と分けて持つ理由は #100 にある——国道の 55.9 MB を県道を直すたびに上げ
    直さずに済むこと、タイル化のメモリが 2 回に分かれること、県道側が壊れても
    国道の地図は出ること。

    判定が読むのは build/survey で、あれを作るのは pbf を一度読む別の段
    (`mise run survey-pref`)である。そこまでを build_all が抱えると、国道だけを
    作り直したい手元で 2.5 GB の読み直しを強いることになる。無いときは飛ばし、
    何をすれば入るかを名指す。

    飛ばす判断は、詰める物が半分だけある状態を作らないためでもある。47 県のうち
    幾つかが欠けたアーカイブは、揃った物と見分けが付かない。
    """
    need = SURVEY if judge else PREFECTURAL
    suffix = ".json" if judge else ".meta.json"
    missing = [r for r in REGIONS if not (need / f"{r}{suffix}").is_file()]
    if missing:
        label = need.relative_to(ROOT).as_posix()
        first = ", ".join(missing[:5]) + (" ほか" if len(missing) > 5 else "")
        print(f"\n{'=' * 70}")
        print("都道府県道 — 飛ばす")
        print(f"{'=' * 70}")
        print(f"{label} に {len(missing)} 県が無い({first})。")
        print("入れるには `mise run survey-pref` と `mise run build-pref` を"
              "先に実行する。", flush=True)
        return
    if judge:
        stage("都道府県道 — build/survey から判定する",
              ["uv", "run", str(HERE / "build_prefectural.py")])
    # 国道の 151,004 本に対して 290,529 本ある。低ズームでは属性を減らすものの、
    # アークが 1.9 倍あるぶんは埋まらない。実測では 1,024 MB で通り、896 MB で落ちる。
    stage("配信データ — 都道府県道のタイルを切る",
          ["node", "--max-old-space-size=1280", str(HERE / "pack_web_pref.mjs")])


def positive_jobs(value: str | None) -> int:
    """`--jobs` に渡された物を本数として読む。読めなければ止まる。

    黙って既定へ戻さない。`--jobs --no-pack` は値の抜けであると同時に、次の
    フラグを食べてしまう指定でもある。`--jobs 0` を 1 に丸めるのも同じで、
    渡した本数と走る本数が違うまま気付けない。
    """
    if value is None or not value.lstrip("+").isdigit() or int(value) < 1:
        raise SystemExit(
            f"--jobs には 1 以上の整数を渡す(受け取ったのは {value!r})。\n"
            "  uv run pipeline/build_all.py --jobs N   (県を同時に N 本まで)"
        )
    return int(value)


def build_region(region: str, skip_verify: bool) -> tuple[str, list[str]]:
    """1 県ぶんの段を通し、(表示する 1 行, 失敗の一覧) を返す。

    表示は返すだけで、ここでは書かない。並列に走る何本もが同時に print すると、
    どの行がどの県のものか分からなくなる。呼ぶ側が、終わった順に 1 県ぶんずつ
    まとめて書く。
    """
    code, out = run(["uv", "run", str(HERE / "build_routes.py"), region])
    if code != 0:
        return f"判定に失敗\n{out}", ["build_routes.py failed"]

    # revoked は検証ではなくデータそのものなので、--skip-verify でも飛ばさない。
    # この後のパックは --skip-verify の有無に関係なく走るので、ここを飛ばすと
    # revoked が反映されないデータがそのまま配信物になる(この PR への CodeRabbit
    # のレビュー)。N13 側の障害(ネットワーク・KSJ 側の不具合)はこの県だけの失敗
    # として扱い、他県の続行は止めない——build_routes.py の失敗とは別扱い。
    code, out = run(["uv", "run", str(HERE / "apply_n13.py"), region])
    bad = outcome("apply_n13.py", code, out)

    if skip_verify:
        return "判定のみ", bad

    code, out = run(["uv", "run", str(HERE / "verify.py"), region])
    bad += outcome("verify.py", code, out)
    line = verdict(out)

    code, out = run(["node", str(HERE / "check_expressions.mjs"), region])
    bad += outcome("check_expressions.mjs", code, out)
    return f"{line} | 式 {verdict(out)}", bad


def main() -> None:
    # この端末が符号化できない道の名前で、生成が止まってはならない。
    sys.stdout.reconfigure(errors="replace")
    args = sys.argv[1:]
    skip_verify = "--skip-verify" in args
    no_pack = "--no-pack" in args
    # --pack-only は、生成済みの地域から配信データだけを作り直す。地域ごとの
    # 判定は回さない。段の順番を知っているのはこの関数だけにしたいので、
    # `mise run pack` もここを呼ぶ。
    pack_only = "--pack-only" in args
    jobs, names = REGION_JOBS, []
    rest = iter(args)
    for a in rest:
        if a == "--jobs":
            jobs = positive_jobs(next(rest, None))
        elif a.startswith("--jobs="):
            jobs = positive_jobs(a.split("=", 1)[1])
        elif not a.startswith("--"):
            names.append(a)
    wanted = [] if pack_only else named_regions(names)

    started = time.time()
    broken: dict[str, list[str]] = {}

    if wanted:
        # 並列に入る前に、N13 のメッシュを直列で用意しておく。理由は REGION_JOBS
        # の上のコメントにある。
        stage("N13 — メッシュを用意する",
              ["uv", "run", str(HERE / "pack_n13.py"), *wanted])
        print(f"\n{'=' * 70}\n判定 — {len(wanted)} 地域を最大 {jobs} 本ずつ\n"
              f"{'=' * 70}", flush=True)

    done = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(build_region, r, skip_verify): r for r in wanted}
        # 終わった順に書く。速い県が遅い県の後ろで待たされないので、進みが見える。
        # 何番目かは「幾つ終わったか」であって、名指しの順番ではない。
        for fut in as_completed(futures):
            region = futures[fut]
            line, bad = fut.result()
            done += 1
            label = REGIONS[region]["label"]
            print(f"[{done:>2}/{len(wanted)}] {region:<11} {label:<5} {line}",
                  flush=True)
            for f in bad:
                print(f"        {f}", flush=True)
            if bad:
                broken[region] = bad

    # 索引は 1 県の話ではなく、揃っている物すべての話である。県ごとの段は自分の
    # 県のファイルだけを書き、ここが最後に 1 度だけ索引を書く。--pack-only でも
    # 書くのは、この後の decree.py と pack_web.mjs が読むのがこの索引だからである。
    stage("索引 — build/regions/regions.json を書く",
          ["uv", "run", str(HERE / "build_routes.py"), "--index-only"])

    if not pack_only:
        print(
            f"\n{len(wanted)} region(s) in {time.time() - started:.0f}s",
            flush=True,
        )

    if broken:
        print(f"\n{'=' * 70}")
        print(f"{len(broken)} region(s) did not pass — nothing was packed")
        print(f"{'=' * 70}")
        for region, bad in broken.items():
            print(f"\n{region} ({REGIONS[region]['label']}) — {len(bad)}")
            for f in bad:
                print(f"  {f}")
        raise SystemExit(1)

    if no_pack:
        return

    # 台帳の起点・終点は地域ごとの端点を読むので、判定の後・結合の前に置く。
    # pack_web.mjs はこれが無いと meta を書けないので、失敗はここで止める。
    stage("台帳 — 政令の別表から起点・終点を取り込む",
          ["uv", "run", str(HERE / "decree.py")])
    # 47 県ぶんの GeoJSON、結合した特徴量、タイルのピラミッド全体がここで同時に
    # 生きている。既定のヒープでは足りず、実測では 640 MB で通り、512 MB で落ちる。
    # 上限は余らせない。V8 は与えたぶんまでゴミを溜めるので、渡した値がそのまま
    # プロセスのピークを押し上げる。
    stage("配信データ — 地域を結合してタイルを切る",
          ["node", "--max-old-space-size=1024", str(HERE / "pack_web.mjs")])
    prefectural(judge=not pack_only)
    # アーカイブは国道と都道府県道で別々である。引数を渡さなければ、切ってある
    # 物をすべて詰める。
    stage("配信データ — PMTiles にまとめる",
          ["uv", "run", str(HERE / "pack_pmtiles.py")])
    if not skip_verify:
        stage("全国検証 — 結合後にしか答えられないことを確認する",
              ["uv", "run", str(HERE / "verify_national.py")])

    print(f"\n{'=' * 70}")
    print(f"すべて通った。{time.time() - started:.0f}s")
    print("ブラウザでの実描画は次で確認する。")
    print("  mise run serve   (別の端末で)")
    print("  mise run render-check")


if __name__ == "__main__":
    main()
