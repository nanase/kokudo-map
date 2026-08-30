# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""怪しい路線を機械的に探す——参照データも判断も使わない。

国道は起点から終点までひと続きである。こちらのデータが一部を欠けば、その続きは
途切れる。途切れはスクリプトが断定できる事実である。

  components   その路線が幾つの繋がらない塊に分かれるか
  loose ends   路線がそこで単に終わっているアークの端点
  gaps         端点から、同じ路線の最も近い塊までの距離

隙間の長さが原因を仕分ける。生の数より、どの段に入るかが効く。

  50 m 未満    両側がノードを共有していない。道の欠落であることはまず無い——
               OSM の記入の取りこぼしか、正しく分かれている上下線である。
  50 m〜2 km   短い接続の欠落、バイパスの分岐、または工事中区間の境界(まだ繋がって
               いないのが正しい)。
  2 km 超      区間の欠落か、本物の断絶である。点線国道、未開通、海上国道など。

続いて、隙間ごとにキャッシュの生の OSM の物と突き合わせる。その番号を主張する
way が隙間の中にあり、こちらの出力に無ければ、判定ルールがそれを落としている
——ルールの不具合で、一度直せば全国に効く。そんな way が無ければ、道は OSM に
無いのであって、ルールをどう変えても現れない。その場合を見つけられるのは参照
データ(国土数値情報 N13)だけである。

使い方:  uv run pipeline/audit.py [地域] [--route N ...] [--all]
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict

from _paths import CACHE, REGIONS as DATA
from build_routes import resolve_competing_claims
from geo import haversine

NODE_GAP_M = 50
LINK_GAP_M = 2000

# bbox の縁の許容差(度)。本物の端点ではなく、県境で地域を切ったせいで生じた
# 端点を、路線が本当に途切れている場所と区別するのに使う。build_routes.py も
# 同じ定数を同じ理由で持つ。
EDGE_TOL = 0.02

NAME_NUM = re.compile(r"国道\s*(\d+)\s*号")
NATIONAL_GRADE = {"trunk", "motorway", "construction"}


class DSU:
    def __init__(self):
        self.p: dict = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def key(pt):
    """[経度, 緯度] の対からノードの同一性を作る。"""
    return (round(pt[1], 7), round(pt[0], 7))


def bucket(m):
    if m < NODE_GAP_M:
        return "node"
    if m <= LINK_GAP_M:
        return "link"
    return "section"


def analyse_route(ref, feats, bbox):
    arcs = [f for f in feats if ref in f["properties"]["refs_list"]]
    if not arcs:
        return None

    dsu = DSU()
    for f in arcs:
        ks = [key(c) for c in f["geometry"]["coordinates"]]
        for k in ks[1:]:
            dsu.union(ks[0], k)

    comps: dict = defaultdict(lambda: {"km": 0.0, "nodes": set()})
    endpoint_arcs: dict = defaultdict(list)
    for f in arcs:
        cs = f["geometry"]["coordinates"]
        ks = [key(c) for c in cs]
        c = comps[dsu.find(ks[0])]
        c["km"] += f["properties"]["km"]
        c["nodes"].update(ks)
        endpoint_arcs[ks[0]].append(f["properties"])
        endpoint_arcs[ks[-1]].append(f["properties"])

    loose = [k for k, v in endpoint_arcs.items() if len(v) == 1]

    west, south, east, north = bbox

    def on_edge(lat, lon):
        return (lat - south < EDGE_TOL or north - lat < EDGE_TOL
                or lon - west < EDGE_TOL or east - lon < EDGE_TOL)

    loose_inner = [k for k in loose if not on_edge(k[0], k[1])]

    gaps = []
    for k in loose_inner:
        home = dsu.find(k)
        best = None
        for root, c in comps.items():
            if root == home:
                continue
            for n in c["nodes"]:
                d = haversine(k, n)
                if best is None or d < best[0]:
                    best = (d, n)
        if best:
            kinds = {p["kind"] for p in endpoint_arcs[k]}
            gaps.append({
                "from": k, "to": best[1], "m": best[0],
                "bucket": bucket(best[0]),
                "kinds": kinds,
                "name": endpoint_arcs[k][0].get("name"),
            })
    # 1 つの隙間は両端が 2 件として現れる。短く見えるほうを先に置く。
    gaps.sort(key=lambda g: g["m"])
    seen = set()
    uniq = []
    for g in gaps:
        pair = tuple(sorted([g["from"], g["to"]]))
        if pair in seen:
            continue
        seen.add(pair)
        uniq.append(g)

    return {
        "ref": ref,
        "km": sum(f["properties"]["km"] for f in arcs),
        "arcs": len(arcs),
        "components": len(comps),
        "component_km": sorted((c["km"] for c in comps.values()), reverse=True),
        "loose_inner": len(loose_inner),
        "gaps": uniq,
        "kinds": Counter(f["properties"]["kind"] for f in arcs),
        "srcs": Counter(f["properties"]["src"] for f in arcs),
        "former": sum(1 for f in arcs if f["properties"].get("former")),
    }


def load_cache(region):
    p = CACHE / f"{region}.raw.json"
    if not p.exists():
        return None
    raw = json.loads(p.read_text(encoding="utf-8"))
    if "competing_relations" not in raw:
        raise SystemExit(
            f"{region}: cache predates per-number competing claims; "
            "re-run pipeline/fetch_osm.py")
    ways = {}
    for src in ("core", "candidates"):
        for e in raw[src]:
            if e["type"] == "way" and e.get("geometry"):
                ways.setdefault(e["id"], e)
    return {"ways": ways, "competing": resolve_competing_claims(raw["competing_relations"])}


def claims(tags):
    """その way が自分について主張する路線番号。経路は問わない。"""
    out = {int(x) for x in (tags.get("ref") or "").split(";") if x.strip().isdigit()}
    blob = " ".join(tags.get(k, "") for k in ("name", "name:ja", "official_name"))
    out |= {int(m) for m in NAME_NUM.findall(blob)}
    return out


def why_excluded(wid, tags, cache, corroborated):
    """この way が除外されていそうな理由を、大まかな近似で推測する。

    build_routes.py の判定ルールを厳密には再現しない——
    names_a_closed_residential_road のような細かい規則は見ていない。
    当てはまる理由をすべて返し、どれも無ければ「unclear — investigate」を返す。
    """
    reasons = []
    c = claims(tags)
    if not (c & corroborated):
        reasons.append(f"claims {sorted(c)}, none corroborated by a relation here")
    competing_hit = c & cache["competing"].get(wid, set())
    if competing_hit:
        reasons.append(
            f"a competing route relation claims the same number(s) {sorted(competing_hit)}"
        )
    hw = tags.get("highway")
    if hw not in NATIONAL_GRADE:
        reasons.append(f"highway={hw} is below national grade")
    if not tags.get("ref") and not NAME_NUM.search(
            " ".join(tags.get(k, "") for k in ("name", "name:ja"))):
        reasons.append("no ref and no 国道N号 in name/name:ja")
    return reasons or ["unclear — investigate"]


def missing_ways_in_gap(cache, out_ids, ref, gap, corroborated):
    """隙間の中でこの路線を主張していて、こちらの出力に無い OSM の way。"""
    lo, hi = gap["from"], gap["to"]
    mid = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2)
    radius = max(gap["m"], 150)
    hits = []
    for wid, w in cache["ways"].items():
        if wid in out_ids:
            continue
        t = w.get("tags", {})
        if ref not in claims(t):
            continue
        for p in w["geometry"]:
            if haversine(mid, (p["lat"], p["lon"])) <= radius:
                hits.append((wid, t))
                break
    return hits


def main():
    args = list(sys.argv[1:])
    show_all = "--all" in args
    args = [a for a in args if a != "--all"]
    focus = []
    if "--route" in args:
        i = args.index("--route")
        focus = [int(x) for x in args[i + 1:]]
        args = args[:i]
    region = args[0] if args else "nagano"

    meta = json.loads((DATA / f"{region}.meta.json").read_text(encoding="utf-8"))
    gj = json.loads((DATA / f"{region}.geojson").read_text(encoding="utf-8"))
    feats = gj["features"]
    out_ids = {f["properties"]["id"] for f in feats}
    corroborated = set(meta["corroborated_refs"])
    cache = load_cache(region)

    refs = focus or [r["ref"] for r in meta["routes"]]
    reports = [r for r in (analyse_route(ref, feats, bbox=meta["bbox"]) for ref in refs) if r]

    def counts(r):
        b = Counter(g["bucket"] for g in r["gaps"])
        return b["node"], b["link"], b["section"]

    print("=" * 80)
    print("routes with a broken chain — gaps bucketed by what they can mean")
    print("=" * 80)
    print(f"{'route':>6} {'km':>8} {'parts':>6} {'<50m':>5} {'50m-2km':>8} "
          f"{'>2km':>5} {'旧道':>5}  largest part")
    flagged = 0
    for r in sorted(reports, key=lambda r: (-sum(counts(r)[:2]), -r["components"])):
        node, link, section = counts(r)
        if not show_all and not focus and r["components"] == 1:
            continue
        flagged += 1
        share = (r["component_km"][0] / r["km"] * 100) if r["km"] else 0
        print(f"{r['ref']:>6} {r['km']:>8.1f} {r['components']:>6} {node:>5} {link:>8} "
              f"{section:>5} {r['former']:>5}  {share:>5.0f}%")

    single = [r for r in reports if r["components"] == 1]
    print(f"\n{len(single)} of {len(reports)} routes form a single connected chain")
    tot = Counter()
    for r in reports:
        for g in r["gaps"]:
            tot[g["bucket"]] += 1
    print(f"gaps across all routes: {dict(tot)}")

    detail = focus or [r["ref"] for r in
                       sorted(reports, key=lambda r: -sum(counts(r)[:2]))[:3]]
    for ref in detail:
        r = next((x for x in reports if x["ref"] == ref), None)
        if not r:
            continue
        print()
        print("=" * 80)
        print(f"国道{ref}号  {r['km']:.1f} km / {r['arcs']} arcs / {r['components']} components"
              + (f" / {r['former']} 旧道" if r["former"] else ""))
        print("=" * 80)
        print(f"  kinds: {dict(r['kinds'])}   admitted by: {dict(r['srcs'])}")
        print(f"  component lengths (km): "
              f"{', '.join(f'{k:.1f}' for k in r['component_km'][:10])}")
        if not r["gaps"]:
            print("  no gaps")
            continue
        for g in r["gaps"][:14]:
            kinds = "/".join(sorted(g["kinds"]))
            note = ""
            if "construction" in g["kinds"]:
                note = "  (construction boundary — expected)"
            elif g["bucket"] == "node":
                note = "  (nodes not shared)"
            print(f"\n  [{g['bucket']:>7}] {g['m']:>8.0f} m  "
                  f"{g['from'][0]:.5f},{g['from'][1]:.5f} -> "
                  f"{g['to'][0]:.5f},{g['to'][1]:.5f}")
            print(f"            end arc: {kinds} {g['name']!r}{note}")
            if not cache:
                continue
            hits = missing_ways_in_gap(cache, out_ids, ref, g, corroborated)
            if hits:
                print(f"            OSM has {len(hits)} way(s) claiming 国道{ref}号 here "
                      f"that we excluded:")
                for wid, t in hits[:4]:
                    print(f"              way/{wid} ref={t.get('ref')!r} "
                          f"name={t.get('name')!r} highway={t.get('highway')!r}")
                    for why in why_excluded(wid, t, cache, corroborated):
                        print(f"                - {why}")
            else:
                print(f"            no excluded OSM way claims 国道{ref}号 here — "
                      f"the road is absent from OSM itself")


if __name__ == "__main__":
    main()
