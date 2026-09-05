# /// script
# requires-python = ">=3.12"
# dependencies = ["pyshp", "requests", "shapely>=2.0"]
# ///
"""1 地域ぶんの生の OSM の物を Overpass から取り、キャッシュする。

問い合わせを三つに分けるのは、答える問いが三つ別々だからであり、一つにまとめた
問い合わせは遅いうえに分け直せないからでもある(二つの `out` が返した way は二度
届き、id だけの写しと形を持つ写しを見分けられない)。

  1. 国道のルートリレーション(とその子リレーション)と、それが含む way すべて。
     信用できる中核である
  2. 国道の格を持ち、数字だけの `ref` か 国道N号 の名前を持つ way。どのリレー
     ションが含んでいるかは問わない。ルートリレーションの整備は way 自身の整備
     より大きく遅れるので、開通から何年も経つバイパスがそこに無いことは珍しく
     ない
  3. 競合するルートリレーションと、そのタグとメンバー。負の証拠である。都道府県
     道は国道と同じ、数字だけの `ref` の書式を使う。事業者が自分の路線番号を
     名乗る体系(首都高速道路など)も、`JP:` で始まらない `network` の下で同じ形の
     主張をする(CASES.md 20)。平らな way id の集合ではなくリレーションのまま持つ
     ので、way 自身の主張を、競合するリレーションがその way について述べる番号と
     突き合わせられる。ただ所属しているというだけで失格にせずに済む

書き出す way には所属都道府県 `pref` が付く。extract_pbf.py の経路と同じ物を
同じように書くので、キャッシュを読む側は二つの経路を見分けずに済む。決め方は
prefectures.py にある。

新しさは効いてくるうえに自動では保たれない。公開されている Overpass のミラーは
大きく遅れることがある。だからすべての配布元を測って最も新しい物を選び、その
`timestamp_osm_base` を記録する。地図がいつ時点かを述べられるようにするためで
ある。

使い方:  uv run pipeline/fetch_osm.py [地域]
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone

import requests

from _paths import CACHE
from freshness import STALE_AFTER_DAYS, age_days
from prefectures import Prefectures, assign_docs, report
from regions import for_region

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# 一般国道が描かれうる道路の格。`primary` は意図して外す。この地域では、リレー
# ションに属さない `primary` の way 3,305 本が数字だけの ref を持ち、そのうち
# 国道 と名乗る物は 1 本も無い。認めれば、得る物が無いまま主要地方道を数千本
# 引き込むことになる。
NATIONAL_GRADES = "trunk|motorway|construction"

UA = {"User-Agent": "NationalRouteMap/0.2 (build pipeline)"}


def probe(ep: str, tries: int = 3) -> tuple[str | None, str | None]:
    """配布元の (timestamp_osm_base, エラー) を返す。

    公開ミラーは、ごく軽い問い合わせでも負荷が高ければ 429 や 504 を返す。
    1 回の失敗は、使えるかどうかについて何も述べていない。
    """
    last = "unknown"
    for i in range(tries):
        try:
            r = requests.post(ep, data={"data": "[out:json][timeout:60];node(1);out ids;"},
                              headers=UA, timeout=90)
            r.raise_for_status()
            return r.json().get("osm3s", {}).get("timestamp_osm_base"), None
        except Exception as e:
            last = str(e)[:90]
            if i < tries - 1:
                time.sleep(15)
    return None, last


def pick_endpoint() -> tuple[str, str]:
    print("probing Overpass mirrors for data freshness")
    best: tuple[str, str, float] | None = None
    for ep in ENDPOINTS:
        ts, err = probe(ep)
        host = ep.split("/")[2]
        if not ts:
            print(f"  {host:28} unreachable: {err}")
            continue
        age = age_days(ts)
        print(f"  {host:28} base={ts}  age={age:.1f} days")
        if best is None or age < best[2]:
            best = (ep, ts, age)

    if best is None:
        raise SystemExit("no Overpass mirror is reachable")

    ep, ts, age = best
    print(f"  -> using {ep.split('/')[2]} (data of {ts})")
    if age > STALE_AFTER_DAYS:
        print(f"  WARNING: freshest available data is {age:.1f} days old; "
              f"recent road openings will be missing.")
    return ep, ts


def run(ep: str, query: str, label: str, tries: int = 4) -> dict:
    last: Exception | None = None
    for i in range(tries):
        try:
            print(f"  [{label}] attempt {i + 1}", flush=True)
            r = requests.post(ep, data={"data": query}, headers=UA, timeout=900)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            print(f"    failed: {str(e)[:120]}", flush=True)
            last = e
            if i < tries - 1:
                time.sleep(20)
    raise SystemExit(f"query {label!r} failed after {tries} attempts: {last}")


def main() -> None:
    region = sys.argv[1] if len(sys.argv) > 1 else "nagano"
    spec = for_region(region)
    bb = ",".join(str(v) for v in spec["bbox"])

    ep, base_ts = pick_endpoint()
    print(f"\nfetching {region} ({bb})")

    # 1. 信用できる中核。国道のルートリレーションと、そのメンバーの way。
    #
    # リレーションが国道の路線である証拠は `network=JP:national` だけではない。
    # 全国で測ると、国道N号 という名前の route=road のリレーションのうち 582 が
    # その network を持ち、43 は `network` を持たない。国道478号については、
    # タグの無いほうが唯一のリレーションである。名前は、RULES.md 問 1 規則 b が
    # way について認めるのと同じ証拠なので、ここでも認める。都道府県道の network
    # がそうでないと述べている場合を除く。
    core = run(ep, f"""
[out:json][timeout:900];
(
  relation["type"="route"]["route"="road"]["network"~"^JP:national"]({bb});
  relation["type"="route"]["route"="road"]["name"~"^国道[0-9]+号"]
          ["network"!~"^JP:prefectural"]({bb});
)->.parents;
relation(r.parents)->.kids;
(.parents; .kids;)->.rels;
.rels out body;
way(r.rels)({bb});
out meta geom;
""", "national relations + members")

    # 2. リレーションが取りこぼしたかもしれない候補。
    cand = run(ep, f"""
[out:json][timeout:900];
(
  way["highway"~"^({NATIONAL_GRADES})$"]["ref"~"^[0-9]+(;[0-9]+)*$"]({bb});
  way["highway"]["name"~"^国道[0-9]+号"]({bb});
);
out meta geom;
""", "candidate ways")

    # 3. 負の証拠。競合するリレーションがどの路線を主張し、どの way を抱えて
    # いるか。以前の id だけのメンバー一覧ではなく `out body`(タグとメンバーの
    # 一覧。way 自身の座標はここでは不要)を取る。平らな way id の集合では、
    # 広島県道243号広島港線が way X を主張していることと、国道2号が別の理由で
    # 同じ way X を抱えていることを見分けられない。すると build_routes.py は
    # 「競合するリレーションがこの way に触れている」ことを失格の理由にするしか
    # なく、本物の都道府県道との番号の衝突と同じように、広島南道路(本物の
    # 国道2号で、たまたま無関係な古い県道リレーションに残っていただけ)まで
    # 捨てる。
    # リレーションごとに主張している番号を保てば、裏取りは在る無しではなく番号を
    # 比べられる。
    #
    # `network~"^JP:prefectural"` は都道府県道を捕まえる。`network` が在って
    # `JP:` で始まらない物は、事業者が自分の路線番号を名乗っている場合を捕まえる
    # (首都高速道路、阪神高速道路 など)。首都高速都心環状線(`ref=1`。名前に
    # `高速N号` が無いので CASES.md 9 の見張りには当たらない)は、その形の
    # リレーションに載っている。CASES.md 20 を参照。
    competing = run(ep, f"""
[out:json][timeout:900];
(
  relation["type"="route"]["route"="road"]["network"~"^JP:prefectural"]({bb});
  relation["type"="route"]["route"="road"]["network"]["network"!~"^JP:"]({bb});
)->.pr;
.pr out body;
""", "competing relations")

    doc = {
        "region": region,
        "label": spec["label"],
        "bbox": spec["bbox"],
        "endpoint": ep,
        "timestamp_osm_base": base_ts,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "core": core["elements"],
        "candidates": cand["elements"],
        "competing_relations": [
            {
                "id": e["id"],
                "tags": e.get("tags", {}),
                "members": [m["ref"] for m in e.get("members", []) if m["type"] == "way"],
            }
            for e in competing["elements"] if e["type"] == "relation"
        ],
    }

    # 所属都道府県。extract_pbf.py の経路と同じ物を書く。二つの経路が同じ形の
    # キャッシュを書くからこそ、build_routes.py も verify.py も違いに気付かずに
    # 済む。ここだけ `pref` が無ければ、その約束が破れる。
    print("\n  reading N03 municipal boundaries", flush=True)
    prefs = Prefectures()
    assigned = assign_docs(prefs, doc["core"] + doc["candidates"])

    rels = sum(1 for e in doc["core"] if e["type"] == "relation")
    ways = sum(1 for e in doc["core"] if e["type"] == "way")
    competing_ways = {w for r in doc["competing_relations"] for w in r["members"]}
    print(f"\n  national relations: {rels}")
    print(f"  member ways:        {ways}")
    print(f"  candidate ways:     {sum(1 for e in doc['candidates'] if e['type'] == 'way')}")
    print(f"  competing relations: {len(doc['competing_relations'])}")
    print(f"  competing ways:     {len(competing_ways)}")
    report(assigned, prefs.vintage)

    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"{region}.raw.json"
    out.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    print(f"\n  data base: {base_ts}")
    print(f"  cached -> {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
