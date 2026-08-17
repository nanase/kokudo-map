# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Turn cached OSM objects into the map's data files.

The whole point of this stage is to answer, for every piece of road, the
question conventional maps refuse to answer: *which* national routes are
designated over it — all of them, not just the lowest number.

Deciding that has two halves, and they need different evidence:

  is it a national route at all?   Any of:
      (a) a national route relation contains it;
      (b) its name is 国道N号;
      (c) it is mapped at national grade (trunk / motorway / construction of
          one) and no *prefectural* route relation claims it.
    (c) exists because route relations lag badly behind the ways: 長野南バイパス
    (国道19号, open for decades) is 22 trunk ways that no relation contains.
    A bare numeric `ref` alone proves nothing — 都道府県道 use the same format.

  which routes?                    The union of:
      - the numbers of every relation containing it (inherited through parents);
      - 国道N号 parsed from its name;
      - the semicolon-separated tokens of its own `ref`, but only for numbers
        some national relation in the region independently vouches for.

Usage:  uv run build/build_routes.py [region]
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, defaultdict

from _paths import CACHE, DATA as OUT
from regions import for_region

# Route numbers a general national route can legally have: 1-58 and 101-507,
# less the six numbers whose routes were abolished or absorbed.
ABOLISHED = {109, 110, 111, 214, 215, 216}
VALID = (set(range(1, 59)) | set(range(101, 508))) - ABOLISHED

NAME_NUM = re.compile(r"国道\s*(\d+)\s*号")

FOOT_HIGHWAYS = {"path", "footway", "steps", "track", "cycleway", "bridleway"}
NATIONAL_GRADE = {"trunk", "motorway"}
NATIONAL_GRADE_UNDER_CONSTRUCTION = {"trunk", "motorway", "primary"}

# bbox edge tolerance (deg) for suppressing endpoints that are artefacts of
# clipping the region rather than real termini
EDGE_TOL = 0.02


# ---------------------------------------------------------------- geometry ---
def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Metres between two (lat, lon) pairs."""
    r = 6371008.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def line_length(coords: list[tuple[float, float]]) -> float:
    return sum(haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


# ------------------------------------------------------------ designations ---
def tokens(ref: str | None) -> set[int]:
    """Numeric national-route numbers in a `ref` value, token by token.

    `ref=4;6;14;17` is four designations, not one string. Matching the whole
    value (the mistake that makes concurrent sections vanish) would drop
    every one of them.
    """
    out: set[int] = set()
    for tok in (ref or "").split(";"):
        tok = tok.strip()
        if tok.isdigit() and int(tok) in VALID:
            out.add(int(tok))
    return out


# `official_name` is not trustworthy for this: way/263470309 (精進ブルーライン,
# `ref=358`, in the 国道358号 relation) carries `official_name=一般国道368号` — a
# typo in OSM that put a Mie-prefecture route number into Yamanashi. Only the
# primary name fields are read, and even those are corroborated below.
NAME_FIELDS = ("name", "name:ja")

# Sections bypassed by a newer alignment. These are deliberately *kept*: a
# 旧道 stays legally designated until 指定解除, which lags the bypass opening by
# years, and 地理院地図 shows it as 国道 for exactly that reason. OSM mappers
# tend to record practical reality instead — dropping `ref`, downgrading
# `highway`, removing the way from the route relation — so this is a systematic
# divergence, not a tagging accident. They are flagged rather than filtered so
# the map can show them distinctly.
FORMER_ALIGNMENT = re.compile(r"旧道|廃道|旧国道")


def name_numbers(tags: dict[str, str], fields: tuple[str, ...] = NAME_FIELDS) -> set[int]:
    blob = " ".join(tags.get(k, "") for k in fields)
    return {int(m) for m in NAME_NUM.findall(blob) if int(m) in VALID}


def is_former(tags: dict[str, str]) -> bool:
    blob = " ".join(tags.get(k, "") for k in NAME_FIELDS)
    return bool(FORMER_ALIGNMENT.search(blob))


def resolve_relation_routes(rels: dict[int, dict]) -> dict[int, set[int]]:
    """Route numbers each relation stands for, inheriting through parents.

    Bypass relations (`name=長野バイパス`) routinely have no `ref`; the number
    has to come from whichever relation holds them as a member.
    """
    own: dict[int, set[int]] = {}
    for rid, rel in rels.items():
        tags = rel.get("tags", {})
        own[rid] = tokens(tags.get("ref")) or name_numbers(tags)

    children: dict[int, list[int]] = defaultdict(list)
    for rid, rel in rels.items():
        for m in rel.get("members", []):
            if m["type"] == "relation" and m["ref"] in rels:
                children[rid].append(m["ref"])

    # Push parent numbers down to children that resolved to nothing.
    # Depth is 2-3 in practice; iterate to a fixed point and cap it.
    for _ in range(5):
        changed = False
        for rid, kids in children.items():
            if not own[rid]:
                continue
            for kid in kids:
                if not own[kid]:
                    own[kid] = set(own[rid])
                    changed = True
        if not changed:
            break
    return own


def classify(tags: dict[str, str]) -> str:
    """Which legend the piece of road belongs in."""
    if tags.get("route") == "ferry":
        return "ferry"
    hw = tags.get("highway")
    if hw == "construction" or "construction" in tags:
        return "construction"
    if hw == "steps":
        return "steps"
    if hw in FOOT_HIGHWAYS:
        return "foot"
    return "road"


def is_national_grade(tags: dict[str, str]) -> bool:
    hw = tags.get("highway")
    if hw in NATIONAL_GRADE:
        return True
    if hw == "construction":
        return tags.get("construction") in NATIONAL_GRADE_UNDER_CONSTRUCTION
    return False


# -------------------------------------------------------------------- main ---
def main() -> None:
    region = sys.argv[1] if len(sys.argv) > 1 else "nagano"
    raw_path = CACHE / f"{region}.raw.json"
    if not raw_path.exists():
        raise SystemExit(f"no cache for {region!r}; run build/fetch_osm.py {region} first")

    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    if "core" not in raw:
        raise SystemExit("cache is in the old single-query format; re-run build/fetch_osm.py")

    base_ts = raw["timestamp_osm_base"]
    bbox = raw["bbox"]
    print(f"OSM data base: {base_ts}   fetched: {raw['fetched_at']}")

    rels = {e["id"]: e for e in raw["core"] if e["type"] == "relation"}
    ways: dict[int, dict] = {}
    for src in ("core", "candidates"):
        for e in raw[src]:
            if e["type"] == "way" and e.get("geometry"):
                ways.setdefault(e["id"], e)
    pref_ids = set(raw["prefectural_way_ids"])
    print(f"loaded {len(rels)} relations, {len(ways)} distinct ways, "
          f"{len(pref_ids)} prefectural-claimed ways")

    rel_routes = resolve_relation_routes(rels)
    unresolved = [r for r, v in rel_routes.items() if not v]
    print(f"relations resolved to a route number: {len(rels) - len(unresolved)}/{len(rels)}")

    # Which ways any national relation contains, and with which numbers.
    by_relation: dict[int, set[int]] = defaultdict(set)
    vouched: set[int] = set()
    for rid, rel in rels.items():
        nums = rel_routes[rid]
        for m in rel.get("members", []):
            if m["type"] != "way":
                continue
            vouched.add(m["ref"])
            if nums:
                by_relation[m["ref"]] |= nums

    # A number read off a way's `ref` is only believed when some relation in
    # the region independently claims that national route exists here.
    # Without this, way/31660216 (長野県道372号三才大豆島中御所線, `ref=372`)
    # would put 国道372号 — a Kyoto/Hyogo route — into Nagano.
    corroborated: set[int] = set()
    for nums in rel_routes.values():
        corroborated |= nums

    arcs = []
    kinds = Counter()
    n_hist = Counter()
    sources = Counter()
    rejected: Counter = Counter()
    dropped: list[int] = []
    rel_added = 0
    tag_added = 0
    name_added = 0
    formers = 0

    for wid, w in ways.items():
        tags = w.get("tags", {})
        from_rel = by_relation.get(wid, set())
        # Both of the way's own claims are subject to corroboration; only the
        # relations themselves establish which routes exist in this region.
        raw_name = name_numbers(tags)
        raw_tag = tokens(tags.get("ref"))
        from_name = raw_name & corroborated
        from_tag = raw_tag & corroborated
        for n in (raw_tag | raw_name) - corroborated:
            rejected[n] += 1

        # --- is it a national route? -------------------------------------
        if from_rel or from_name:
            source = "relation" if from_rel else "name"
        elif from_tag and wid not in pref_ids and (wid in vouched or is_national_grade(tags)):
            # Relation-less but mapped as a national road and unclaimed by any
            # prefectural route: this is the bypass case.
            source = "tag"
        else:
            dropped.append(wid)
            continue

        refs = from_rel | from_name | from_tag
        if not refs:
            dropped.append(wid)
            continue

        if from_rel - (from_tag | from_name):
            rel_added += 1
        if from_tag - (from_rel | from_name):
            tag_added += 1
        if from_name - (from_rel | from_tag):
            name_added += 1

        coords = [(p["lat"], p["lon"]) for p in w["geometry"]]
        if len(coords) < 2:
            dropped.append(wid)
            continue

        kind = classify(tags)
        kinds[kind] += 1
        n_hist[len(refs)] += 1
        sources[source] += 1
        former = is_former(tags)
        if former:
            formers += 1

        arcs.append({
            "id": wid,
            "former": former,
            "refs": sorted(refs),
            # delimiter-wrapped so a filter can test membership without
            # matching 4 inside 14 / 24 / 400
            "refs_key": "," + ",".join(str(r) for r in sorted(refs)) + ",",
            "n": len(refs),
            "kind": kind,
            "src": source,
            "name": tags.get("name"),
            "updated": (w.get("timestamp") or "")[:10],
            "length_m": line_length(coords),
            "coords": coords,
        })

    print(f"\narcs built: {len(arcs)}   dropped: {len(dropped)}")
    print(f"  admitted by: {dict(sources)}")
    print(f"  kinds: {dict(kinds)}")
    print(f"  concurrency histogram (n -> arcs): {dict(sorted(n_hist.items()))}")
    print(f"  designations contributed only by relations: {rel_added}")
    print(f"  designations contributed only by the ref tag: {tag_added}")
    print(f"  designations contributed only by the name:    {name_added}")
    print(f"  arcs flagged as former alignment (旧道):        {formers}")
    if rejected:
        print(f"  ref tokens rejected as uncorroborated (likely 都道府県道): "
              f"{dict(sorted(rejected.items()))}")

    # What did rule (c) actually add? These are the previously-missing roads.
    tag_only = [a for a in arcs if a["src"] == "tag"]
    by_name = Counter((tuple(a["refs"]), a["name"]) for a in tag_only)
    print(f"\n  relation-less roads recovered by rule (c): {len(tag_only)} arcs, "
          f"{sum(a['length_m'] for a in tag_only) / 1000:.1f} km")
    for (refs, name), c in by_name.most_common(14):
        print(f"    国道{'・'.join(map(str, refs)):<12} {str(name):<24} x{c}")

    # ---- per-route master ------------------------------------------------
    routes: dict[int, dict] = {}
    for a in arcs:
        for r in a["refs"]:
            e = routes.setdefault(
                r, {"ref": r, "length_m": 0.0, "arcs": 0, "max_n": 1, "kinds": Counter()}
            )
            e["length_m"] += a["length_m"]
            e["arcs"] += 1
            e["max_n"] = max(e["max_n"], a["n"])
            e["kinds"][a["kind"]] += 1

    print(f"\nroutes present in region: {len(routes)}")
    print("  " + ", ".join(str(r) for r in sorted(routes)))

    # ---- termini: degree-1 nodes within each route's own subgraph --------
    south, west, north, east = bbox

    def on_edge(lat: float, lon: float) -> bool:
        return (
            lat - south < EDGE_TOL
            or north - lat < EDGE_TOL
            or lon - west < EDGE_TOL
            or east - lon < EDGE_TOL
        )

    endpoints = []
    for r in sorted(routes):
        deg: Counter = Counter()
        for a in arcs:
            if r not in a["refs"]:
                continue
            for p in (a["coords"][0], a["coords"][-1]):
                deg[(round(p[0], 7), round(p[1], 7))] += 1
        for (lat, lon), d in deg.items():
            if d == 1 and not on_edge(lat, lon):
                endpoints.append({"ref": r, "lat": lat, "lon": lon})

    print(f"\ncandidate termini inside the region: {len(endpoints)}")

    clusters: list[dict] = []
    for e in endpoints:
        for c in clusters:
            if haversine((e["lat"], e["lon"]), (c["lat"], c["lon"])) < 150:
                c["refs"].add(e["ref"])
                break
        else:
            clusters.append({"lat": e["lat"], "lon": e["lon"], "refs": {e["ref"]}})
    shared = [c for c in clusters if len(c["refs"]) > 1]
    print(f"  clusters: {len(clusters)}, shared by 2+ routes: {len(shared)}")

    # ---- concurrency ranking (the "things maps hide" feature) ------------
    combos: dict[tuple[int, ...], dict] = {}
    for a in arcs:
        if a["n"] < 2:
            continue
        key = tuple(a["refs"])
        e = combos.setdefault(
            key, {"refs": list(key), "n": a["n"], "length_m": 0.0, "arcs": 0, "names": Counter()}
        )
        e["length_m"] += a["length_m"]
        e["arcs"] += 1
        if a["name"]:
            e["names"][a["name"]] += 1
    ranking = sorted(combos.values(), key=lambda e: (-e["n"], -e["length_m"]))
    for e in ranking:
        e["names"] = [n for n, _ in e["names"].most_common(3)]

    print("\ntop concurrency combinations:")
    for e in ranking[:8]:
        nm = " / ".join(e["names"][:2]) or "—"
        print(f"  {e['n']}x {e['refs']}  {e['length_m'] / 1000:6.1f} km  {nm}")

    # ---- write ----------------------------------------------------------
    OUT.mkdir(parents=True, exist_ok=True)

    features = [
        {
            "type": "Feature",
            "properties": {
                "id": a["id"],
                "refs": a["refs_key"],
                "refs_list": a["refs"],
                "n": a["n"],
                "kind": a["kind"],
                "src": a["src"],
                "former": 1 if a["former"] else 0,
                "name": a["name"],
                "updated": a["updated"],
                "km": round(a["length_m"] / 1000, 3),
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [[round(lon, 6), round(lat, 6)] for lat, lon in a["coords"]],
            },
        }
        for a in arcs
    ]
    gj_path = OUT / f"{region}.geojson"
    gj_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    edits = sorted(a["updated"] for a in arcs if a["updated"])
    total_km = sum(a["length_m"] for a in arcs) / 1000
    meta = {
        "region": region,
        "label": for_region(region)["label"],
        "bbox": [west, south, east, north],
        "osm_timestamp": base_ts,
        "fetched_at": raw["fetched_at"],
        "endpoint": raw["endpoint"],
        # Every route number the region's relations vouch for. Nothing in
        # `routes` may fall outside this set — see build/verify.py.
        "corroborated_refs": sorted(corroborated),
        "oldest_edit": edits[0] if edits else None,
        "newest_edit": edits[-1] if edits else None,
        "total_km": round(total_km, 1),
        "arc_count": len(arcs),
        "sources": dict(sources),
        "former_arcs": formers,
        "routes": [
            {
                "ref": r,
                "km": round(v["length_m"] / 1000, 1),
                "arcs": v["arcs"],
                "max_n": v["max_n"],
                "kinds": dict(v["kinds"]),
            }
            for r, v in sorted(routes.items())
        ],
        "concurrency_ranking": [
            {
                "refs": e["refs"],
                "n": e["n"],
                "km": round(e["length_m"] / 1000, 2),
                "arcs": e["arcs"],
                "names": e["names"],
            }
            for e in ranking
        ],
        "termini": [
            {"lat": round(e["lat"], 6), "lon": round(e["lon"], 6), "ref": e["ref"]}
            for e in endpoints
        ],
        "shared_termini": [
            {"lat": round(c["lat"], 6), "lon": round(c["lon"], 6), "refs": sorted(c["refs"])}
            for c in sorted(shared, key=lambda c: -len(c["refs"]))
        ],
        "n_histogram": {str(k): v for k, v in sorted(n_hist.items())},
    }
    meta_path = OUT / f"{region}.meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # Index of everything built so far, so the viewer can offer a region picker
    # without being told which regions exist.
    index = []
    for p in sorted(OUT.glob("*.meta.json")):
        m = json.loads(p.read_text(encoding="utf-8"))
        index.append({
            "region": m["region"],
            "label": m.get("label", m["region"]),
            "bbox": m["bbox"],
            "arc_count": m["arc_count"],
            "total_km": m["total_km"],
            "routes": len(m["routes"]),
        })
    (OUT / "regions.json").write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"\ntotal arc length: {total_km:,.0f} km")
    print(f"way last-edit range: {meta['oldest_edit']} .. {meta['newest_edit']}")
    print(f"wrote {gj_path.name} ({gj_path.stat().st_size / 1e6:.2f} MB)")
    print(f"wrote {meta_path.name} ({meta_path.stat().st_size / 1e3:.1f} kB)")
    print(f"wrote regions.json ({len(index)} region(s): "
          f"{', '.join(e['label'] for e in index)})")


if __name__ == "__main__":
    main()
