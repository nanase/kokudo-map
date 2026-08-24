# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Build every region from cache, then pack and check the nationwide product.

The per-region half is deliberately unchanged: each prefecture is judged inside
its own box, because the corroboration guard only filters while the set of route
numbers it trusts is a prefecture's worth rather than the country's. What is new
is the second half — merging the regions, cutting tiles, and asking the
questions that only exist once the map is nationwide.

Every region is built and checked before anything is packed, and the failures
are reported together. Stopping at the first one would mean learning about 47
prefectures one run at a time. Packing still only happens if all of them passed:
a half-built set packed into an archive looks exactly like a complete one.

Usage:  uv run pipeline/build_all.py [region ...]   (default: every region)
        uv run pipeline/build_all.py --skip-verify  (build and pack only)
        uv run pipeline/build_all.py --no-pack      (per-region only)
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from _paths import ROOT
from regions import REGIONS, named_regions

HERE = Path(__file__).resolve().parent

# What comes back is read as UTF-8, so the child has to write UTF-8. A pipe is
# not a console, so Python otherwise falls back to the system locale — cp932 on
# a Japanese Windows — and 尾駮バイパス has a kanji cp932 does not contain. 青森県
# died printing its own progress line, and it was reported as a build failure.
CHILD_ENV = {**os.environ, "PYTHONIOENCODING": "utf-8"}


def run(cmd: list[str]) -> tuple[int, str]:
    r = subprocess.run(
        cmd, cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", env=CHILD_ENV,
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def stage(label: str, cmd: list[str]) -> None:
    """A whole-country stage. These do stop at the first failure."""
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
    """A subprocess's verdict, folding in exit codes that FAIL lines miss.

    verify.py itself exits 1 whenever it prints FAIL lines, so `code != 0`
    is not evidence of anything beyond what `failures()` already found.
    Only a nonzero exit with no FAIL line at all — a traceback, a crash —
    is new information, and it is reported once, not per FAIL line.
    """
    bad = failures(out)
    if code != 0 and not bad:
        bad.append(f"{label} が終了コード {code} で異常終了しました（FAIL 行なし）")
    return bad


def main() -> None:
    # A road name this terminal cannot encode must not be what stops the build.
    sys.stdout.reconfigure(errors="replace")
    args = sys.argv[1:]
    skip_verify = "--skip-verify" in args
    no_pack = "--no-pack" in args
    # --pack-only は、生成済みの地域から配信データだけを作り直します。
    # 地域ごとの判定は回しません。段の順番を知っているのはこの関数だけに
    # したいので、`mise run pack` もここを呼びます。
    pack_only = "--pack-only" in args
    wanted = (
        []
        if pack_only
        else named_regions([a for a in args if not a.startswith("--")])
    )

    started = time.time()
    broken: dict[str, list[str]] = {}

    for i, region in enumerate(wanted, 1):
        label = REGIONS[region]["label"]
        head = f"[{i:>2}/{len(wanted)}] {region:<11} {label:<5}"

        code, out = run(["uv", "run", str(HERE / "build_routes.py"), region])
        if code != 0:
            print(f"{head} 判定に失敗\n{out}", flush=True)
            broken[region] = ["build_routes.py failed"]
            continue

        # revoked は検証ではなくデータそのものなので、--skip-verify でも飛ばさ
        # ない。この後のパックは --skip-verify の有無に関係なく走るので、ここを
        # 飛ばすと revoked が反映されないデータがそのまま配信物になる
        # (CodeRabbit review on this PR)。N13 側の障害(ネットワーク・KSJ 側の
        # 不具合)はこの県だけの失敗として扱い、他県の続行は止めない —
        # build_routes.py の失敗とは別扱い。
        code, out = run(["uv", "run", str(HERE / "apply_n13.py"), region])
        bad = outcome("apply_n13.py", code, out)

        if skip_verify:
            print(f"{head} 判定のみ", flush=True)
            for f in bad:
                print(f"        {f}", flush=True)
            if bad:
                broken[region] = bad
            continue

        code, out = run(["uv", "run", str(HERE / "verify.py"), region])
        bad += outcome("verify.py", code, out)
        line = f"{head} {verdict(out)}"

        code, out = run(["node", str(HERE / "check_expressions.mjs"), region])
        bad += outcome("check_expressions.mjs", code, out)
        line += f" | 式 {verdict(out)}"

        print(line, flush=True)
        for f in bad:
            print(f"        {f}", flush=True)
        if bad:
            broken[region] = bad

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

    # 47 prefectures of GeoJSON, the merged features and the whole tile pyramid
    # are live at once here; the default heap is not enough.
    stage("配信データ — 地域を結合してタイルを切る",
          ["node", "--max-old-space-size=6144", str(HERE / "pack_web.mjs")])
    stage("配信データ — PMTiles にまとめる",
          ["uv", "run", str(HERE / "pack_pmtiles.py")])
    if not skip_verify:
        stage("全国検証 — 結合後にしか答えられないことを確認する",
              ["uv", "run", str(HERE / "verify_national.py")])

    print(f"\n{'=' * 70}")
    print(f"すべて通った。{time.time() - started:.0f}s")
    print("ブラウザでの実描画は次で確認する。")
    print("  mise run serve   （別の端末で）")
    print("  mise run render-check")


if __name__ == "__main__":
    main()
