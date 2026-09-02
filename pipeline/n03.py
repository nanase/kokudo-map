# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
"""国土数値情報(N03, 行政区域)の在り処と、取ってくる手立て。

読む側は二つある。decree.py は市区町村の輪郭を、政令の起終点に座標を当てる
ために読む。prefectures.py は都道府県の輪郭を、way の所属を決めるために読む。
同じ配布物を同じ場所へ落とすので、どこから取るかを二箇所に書けば片方が暗黙の
うちに古くなる。ここが一箇所である。

`cached` は N03 だけの物ではない。decree.py は e-Gov の法令 XML も同じ関数で
取る。取ってきた物をディスクに残して次から読む振る舞いは、相手が誰でも変わら
ないためである。
"""
from __future__ import annotations

import io
import time
import zipfile
from pathlib import Path

import requests

from _paths import N03

UA = {"User-Agent": "NationalRouteMap/0.2 (build pipeline)"}

# 国土数値情報(N03, 行政区域)。この順に試す。shapefile はどちらの年版でも同じ
# 五つの列(都道府県名、支庁名、郡・政令市名、市区町村名、政令市の区名)を持つ
# が、古いほうの年版は DBF が UTF-8 へ移る前の物である。
N03_BASE = "https://nlftp.mlit.go.jp/ksj/gml/data/N03"
VINTAGES = (
    ("2026", f"{N03_BASE}/N03-2026/N03-20260101_{{code}}_GML.zip", "utf-8"),
    ("2000", f"{N03_BASE}/N03-2000/N03-001001_{{code}}_GML.zip", "cp932"),
)
PREF_CODES = tuple(f"{i:02d}" for i in range(1, 48))


def cached(url: str, path: Path, max_age_s: float | None = None) -> bytes:
    """一度 GET し、以後はディスクから読む。`max_age_s` を過ぎた物は
    取り直す。"""
    fresh = path.exists() and (
        max_age_s is None or time.time() - path.stat().st_mtime < max_age_s
    )
    if fresh:
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = requests.get(url, headers=UA, timeout=120)
        r.raise_for_status()
    except requests.RequestException as e:
        # 省庁のサーバが落ちているせいで全国の生成を止めるより、古い写しの
        # ほうがましである。致命的なのは、写しが 1 つも無いときだけである。
        if not path.exists():
            raise
        print(f"WARN  {url} を取れませんでした({e})。古いキャッシュを使います。")
        return path.read_bytes()
    path.write_bytes(r.content)
    return r.content


def zip_path(vintage: str, code: str) -> Path:
    return N03 / vintage / f"{code}.zip"


def archive(vintage: str, url: str, code: str) -> tuple[zipfile.ZipFile, str]:
    """その年版・その都道府県の zip と、中の shapefile の基底名。"""
    raw = cached(url.format(code=code), zip_path(vintage, code))
    z = zipfile.ZipFile(io.BytesIO(raw))
    base = next(n[:-4] for n in z.namelist() if n.endswith(".shp"))
    return z, base
