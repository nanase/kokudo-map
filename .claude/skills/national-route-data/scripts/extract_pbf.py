# /// script
# requires-python = ">=3.12"
# dependencies = ["osmium>=4.0"]
# ///
"""Cut every region's raw OSM objects out of one nationwide .osm.pbf.

This replaces the Overpass fetch for nationwide builds. It answers exactly the
same three questions per region, and writes exactly the same cache file, so
build_routes.py, verify.py and audit.py do not know the difference:

  1. core        — national route relations touching the box, their child
                   relations, and the member ways inside the box;
  2. candidates  — national-grade ways with a numeric `ref`, and any way named
                   国道N号, inside the box;
  3. prefectural — the ways prefectural route relations claim, as a negative
                   signal.

Why not keep using Overpass: 47 prefectures is ~140 queries and about a
gigabyte of response off public mirrors, for hours. One 2.5 GB file downloaded
once is both faster and within what the mirrors are for.

What is deliberately *not* changed: the region stays the unit of work. The
corroboration guard in build_routes.py only filters because the set of route
numbers a region's relations vouch for is small. Judged over the whole country
that set approaches all 459 numbers and the guard stops filtering — 長野県道372号
would come back as 国道372号. Acquisition goes nationwide; adjudication stays
boxed. See RULES.md 裏取り and CASES.md 1・2.

Usage:  uv run scripts/extract_pbf.py [region ...]   (default: every region)
        uv run scripts/extract_pbf.py --pbf path/to/japan-latest.osm.pbf
"""
from __future__ import annotations

import json
import re
import sys
from array import array
from datetime import datetime, timezone

import osmium

from _paths import CACHE, PBF
from regions import REGIONS, named_regions

# The build reads these way tags and no others. Keeping the rest would triple
# the memory this pass needs for nothing. build_routes.TAGS_USED is the
# authority; it is imported rather than restated so the two cannot drift.
#
# `tokens` is imported for the same reason: whether a `ref` carries a national
# route number is answered once, by build_routes.py, and read here rather than
# re-answered with a second pattern. A second pattern is how 第二神明道路
# (`ref=E93;2`, no 国道2号 relation) and 神戸淡路鳴門自動車道 (`ref=E28;28`, no
# relation at all) went missing nationwide: a full-string `^[0-9]+(;[0-9]+)*$`
# match rejected the whole `ref` the moment one semicolon-token carried an
# E-road prefix, so the road never became a candidate and build_routes.py never
# saw it to corroborate. `tokens()` already tests token by token — it has to,
# to accept `ref=4;6;14;17` — so it accepts `E93;2` for the same reason it
# accepts `2;28;250`.
from build_routes import TAGS_USED, tokens

SOURCE_URL = "https://download.geofabrik.de/asia/japan-latest.osm.pbf"

# Same shapes the Overpass queries use, so the two paths admit the same ways.
CANDIDATE_GRADES = {"trunk", "motorway", "construction"}
NAME_KOKUDO = re.compile(r"^国道[0-9]+号")

# The same pattern for relation names, but tolerant of full-width digits — one
# relation really is named 国道３２５号（阿蘇大橋）の応急的な迂回路.
REL_KOKUDO = re.compile(r"^国道\s*\d+\s*号")

NATIONAL = "JP:national"
PREFECTURAL = "JP:prefectural"

# libosmium spells member types 'n'/'w'/'r'; the cache is in Overpass's spelling
# because build_routes.py reads it. Translating here keeps that file untouched.
MEMBER_TYPE = {"n": "node", "w": "way", "r": "relation"}


# ------------------------------------------------------------------ storage ---
class Ways:
    """Way geometry for the whole country, without a Python object per node.

    Roughly 8 million coordinates survive the filters. As tuples in lists that
    is well over a gigabyte; as two flat float arrays it is 128 MB.
    """

    def __init__(self) -> None:
        self.lat = array("d")
        self.lon = array("d")
        self.start: dict[int, int] = {}
        self.count: dict[int, int] = {}
        self.tags: dict[int, dict[str, str]] = {}
        self.ts: dict[int, str] = {}
        # bounding box per way, for the region test
        self.box: dict[int, tuple[float, float, float, float]] = {}

    def add(self, wid: int, tags: dict[str, str], ts: str, pts: list[tuple[float, float]]) -> None:
        self.start[wid] = len(self.lat)
        self.count[wid] = len(pts)
        self.tags[wid] = tags
        self.ts[wid] = ts
        lats = [p[0] for p in pts]
        lons = [p[1] for p in pts]
        self.lat.extend(lats)
        self.lon.extend(lons)
        self.box[wid] = (min(lats), min(lons), max(lats), max(lons))

    def geometry(self, wid: int) -> list[dict[str, float]]:
        i, n = self.start[wid], self.count[wid]
        return [{"lat": self.lat[j], "lon": self.lon[j]} for j in range(i, i + n)]

    def in_box(self, wid: int, box: tuple[float, float, float, float]) -> bool:
        """True when any node of the way lies inside the box.

        Overpass's own bbox filter is the same test, so the cheap rectangle
        rejection below only skips ways it would also have skipped.
        """
        south, west, north, east = box
        ws, ww, wn, we = self.box[wid]
        if wn < south or ws > north or we < west or ww > east:
            return False
        i, n = self.start[wid], self.count[wid]
        for j in range(i, i + n):
            if south <= self.lat[j] <= north and west <= self.lon[j] <= east:
                return True
        return False


def kept_tags(tags) -> dict[str, str]:
    return {k: v for k, v in tags if k in TAGS_USED}


# -------------------------------------------------------------------- passes ---
def read_header(path: str) -> str:
    """The moment the extract was cut, as an OSM base timestamp.

    verify.py insists the data is under a week old and the page prints it as
    データ基準. A pbf has to state the same thing an Overpass mirror does.
    """
    header = osmium.io.Reader(path, osmium.osm.osm_entity_bits.NOTHING).header()
    ts = header.get("osmosis_replication_timestamp") or header.get("timestamp")
    if not ts:
        raise SystemExit(
            f"{path} carries no osmosis_replication_timestamp; its base time is "
            "unknown and verify.py could not check freshness"
        )
    return ts


def pass_relations(path: str) -> tuple[dict[int, dict], set[int]]:
    """Every road route relation, plus the ids of relations they hold.

    Two passes: a child relation need not be tagged as a route itself, so which
    ones matter is only known once the parents have been read.
    """
    rels: dict[int, dict] = {}
    wanted: set[int] = set()

    def take(r) -> None:
        rels[r.id] = {
            "type": "relation",
            "id": r.id,
            "tags": dict(r.tags),
            "members": [
                {"type": MEMBER_TYPE[m.type], "ref": m.ref, "role": m.role}
                for m in r.members
                if m.type in MEMBER_TYPE
            ],
        }

    print("  pass 1/3: road route relations", flush=True)
    for r in osmium.FileProcessor(path, osmium.osm.osm_entity_bits.RELATION):
        if r.tags.get("type") == "route" and r.tags.get("route") == "road":
            take(r)
    for rel in rels.values():
        for m in rel["members"]:
            if m["type"] == "relation":
                wanted.add(m["ref"])

    missing = wanted - set(rels)
    if missing:
        print(f"  pass 2/3: {len(missing)} child relations that are not road routes",
              flush=True)
        for r in osmium.FileProcessor(path, osmium.osm.osm_entity_bits.RELATION):
            if r.id in missing:
                take(r)
    else:
        print("  pass 2/3: skipped, every child relation is itself a road route",
              flush=True)
    return rels, wanted


def pass_ways(path: str, member_ways: set[int], member_nodes: set[int], idx: str):
    """Way geometry for members and candidates, and the member nodes' positions."""
    ways = Ways()
    nodes: dict[int, tuple[float, float]] = {}
    print("  pass 3/3: node locations and way geometry", flush=True)

    # Japan is ~270 million nodes. The location cache still has to see every one
    # of them, but that happens in C++; letting them cross into Python to be
    # rejected one at a time costs more than the rest of the pass put together.
    # The filter keeps the cache and skips the hand-off. Member nodes are read
    # back out of the cache afterwards.
    proc = (
        osmium.FileProcessor(
            path, osmium.osm.osm_entity_bits.NODE | osmium.osm.osm_entity_bits.WAY
        )
        .with_locations(idx)
        .with_filter(osmium.filter.EntityFilter(osmium.osm.osm_entity_bits.WAY))
    )
    seen = 0
    for o in proc:
        seen += 1
        if seen % 2_000_000 == 0:
            print(f"    {seen:,} ways scanned, {len(ways.start):,} kept", flush=True)

        tags = o.tags
        keep = o.id in member_ways
        if not keep:
            hw = tags.get("highway")
            if hw is None:
                continue
            ref = tags.get("ref")
            keep = (hw in CANDIDATE_GRADES and bool(tokens(ref))) or bool(
                NAME_KOKUDO.match(tags.get("name") or "")
            )
        if not keep:
            continue
        try:
            pts = [(n.location.lat, n.location.lon) for n in o.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            continue
        if len(pts) < 2:
            continue
        ways.add(o.id, kept_tags(tags), o.timestamp.strftime("%Y-%m-%dT%H:%M:%SZ"), pts)

    # Relations may hold nodes as members — a junction a route passes through.
    # They are few, and a relation whose only presence in a box is such a node
    # still counts as being there, the same way Overpass counted it.
    store = proc.node_location_storage
    for nid in member_nodes:
        try:
            loc = store.get(nid)
        except (osmium.InvalidLocationError, KeyError, IndexError):
            continue
        if loc.valid():
            nodes[nid] = (loc.lat, loc.lon)
    return ways, nodes


# ---------------------------------------------------------------- per region ---
def write_region(region: str, box, rels, national, prefectural, ways, nodes, base_ts, fetched):
    """Reproduce the three Overpass queries over the in-memory country."""
    # Query 1: national relations touching the box, then their children.
    parents = [
        rid for rid in national
        if any(m["type"] == "way" and m["ref"] in ways.start and ways.in_box(m["ref"], box)
               for m in rels[rid]["members"])
        or any(m["type"] == "node" and m["ref"] in nodes and inside(nodes[m["ref"]], box)
               for m in rels[rid]["members"])
    ]
    kids = {m["ref"] for rid in parents for m in rels[rid]["members"]
            if m["type"] == "relation" and m["ref"] in rels}
    rel_ids = sorted(set(parents) | kids)

    core_way_ids = sorted({
        m["ref"] for rid in rel_ids for m in rels[rid]["members"]
        if m["type"] == "way" and m["ref"] in ways.start and ways.in_box(m["ref"], box)
    })

    # Query 2: candidates, whether or not a relation holds them. The Overpass
    # query has no such exclusion, but a way returned by both `out` statements
    # is deduplicated by build_routes.py anyway, and skipping it here halves the
    # cache. Ways held only by a *prefectural* relation are still candidates.
    core_set = set(core_way_ids)
    cand_ids = sorted(
        wid for wid in ways.start
        if wid not in core_set and is_candidate(ways.tags[wid]) and ways.in_box(wid, box)
    )

    # Query 3: the negative signal.
    pref_ids = sorted({
        m["ref"] for rid in prefectural for m in rels[rid]["members"]
        if m["type"] == "way" and m["ref"] in ways.start and ways.in_box(m["ref"], box)
    })

    def way_doc(wid: int) -> dict:
        return {
            "type": "way",
            "id": wid,
            "timestamp": ways.ts[wid],
            "tags": ways.tags[wid],
            "geometry": ways.geometry(wid),
        }

    doc = {
        "region": region,
        "label": REGIONS[region]["label"],
        "bbox": list(box),
        "endpoint": SOURCE_URL,
        "timestamp_osm_base": base_ts,
        "fetched_at": fetched,
        "core": [rels[rid] for rid in rel_ids] + [way_doc(w) for w in core_way_ids],
        "candidates": [way_doc(w) for w in cand_ids],
        "prefectural_way_ids": pref_ids,
    }
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"{region}.raw.json"
    out.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    print(f"  {region:12} {REGIONS[region]['label']:6} rel {len(rel_ids):5}  "
          f"core ways {len(core_way_ids):6}  cand {len(cand_ids):6}  "
          f"pref {len(pref_ids):6}  {out.stat().st_size / 1e6:6.1f} MB", flush=True)


def is_national_relation(tags: dict[str, str]) -> bool:
    """Is this route relation a 国道 relation?

    `network=JP:national` is the usual evidence. It is not the only evidence:
    measured over the whole country, 582 route=road relations named 国道N号 carry
    that network and 43 carry no `network` tag at all. Most of the 43 are 旧道,
    バイパス or 支線 of routes some other relation already vouches for, but two
    route numbers have nothing else — and for 国道478号 (京都縦貫自動車道) the
    untagged relation is the only one that exists, so the whole route was
    missing from 京都府.

    A relation named 国道N号 is therefore admitted on its name, which is the
    evidence RULES.md 問1 規則 b already accepts from a way. The name is read
    from `name` and `name:ja` only, never `official_name` — that is the field
    that put a Mie route number into Yamanashi (CASES.md 2).
    """
    net = tags.get("network") or ""
    if net.startswith(NATIONAL):
        return True
    if net.startswith(PREFECTURAL):
        return False
    return any(
        REL_KOKUDO.match((tags.get(k) or "").strip()) for k in ("name", "name:ja")
    )


def inside(pt, box) -> bool:
    south, west, north, east = box
    return south <= pt[0] <= north and west <= pt[1] <= east


def is_candidate(tags: dict[str, str]) -> bool:
    if "highway" not in tags:
        return False
    if tags["highway"] in CANDIDATE_GRADES and tokens(tags.get("ref")):
        return True
    return bool(NAME_KOKUDO.match(tags.get("name") or ""))


# -------------------------------------------------------------------- main ---
def main() -> None:
    args = sys.argv[1:]
    path = str(PBF / "japan-latest.osm.pbf")
    node_index = "flex_mem"

    def take(flag: str, current: str) -> str:
        nonlocal args
        if flag not in args:
            return current
        i = args.index(flag)
        value = args[i + 1]
        args = args[:i] + args[i + 2:]
        return value

    path = take("--pbf", path)
    node_index = take("--index", node_index)
    wanted = named_regions(args)

    base_ts = read_header(path)
    age = (datetime.now(timezone.utc)
           - datetime.fromisoformat(base_ts.replace("Z", "+00:00"))).total_seconds()
    print(f"pbf: {path}")
    print(f"data base: {base_ts}  age={age / 86400:.1f} days")
    if age > 7 * 86400:
        print("  WARNING: over 7 days old; verify.py will fail on freshness.")

    rels, _ = pass_relations(path)
    national = [rid for rid, r in rels.items() if is_national_relation(r["tags"])]
    prefectural = [rid for rid, r in rels.items()
                   if (r["tags"].get("network") or "").startswith(PREFECTURAL)]
    by_name = sum(1 for rid in national
                  if not (rels[rid]["tags"].get("network") or "").startswith(NATIONAL))
    print(f"  road route relations: {len(rels):,}  "
          f"national {len(national):,}  prefectural {len(prefectural):,}")
    print(f"  national admitted on their name alone (no network tag): {by_name}")

    member_ways = {m["ref"] for r in rels.values() for m in r["members"] if m["type"] == "way"}
    member_nodes = {m["ref"] for r in rels.values() for m in r["members"] if m["type"] == "node"}
    print(f"  ways held by a road route relation: {len(member_ways):,}")

    # Japan is ~150 million node positions. In memory that is 2-3 GB and the
    # pass is I/O bound on the pbf alone; on disk it is a 2.4 GB index file and
    # several times slower. Machines that cannot spare the memory pass
    # --index sparse_file_array,build/pbf/nodes.idx.
    PBF.mkdir(parents=True, exist_ok=True)
    ways, nodes = pass_ways(path, member_ways, member_nodes, node_index)
    print(f"  ways kept: {len(ways.start):,}  coordinates: {len(ways.lat):,}")

    fetched = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"\nwriting {len(wanted)} region cache file(s)")
    for region in wanted:
        write_region(region, REGIONS[region]["bbox"], rels, national, prefectural,
                     ways, nodes, base_ts, fetched)

    # Completeness: a way no region's box covers is a way the map cannot show.
    # This is the failure a set of hand-drawn rectangles would otherwise hide.
    #
    # Only national members count. Prefectural ones are expected to fall out:
    # the 東京都 box is the mainland alone, and the 都道 of 三宅島 and 小笠原 are
    # outside every box by design. A *national* orphan means a box is wrong.
    boxes = [REGIONS[r]["bbox"] for r in REGIONS]
    national_ways = {
        m["ref"] for rid in national for m in rels[rid]["members"] if m["type"] == "way"
    }
    covered = set(ways.start)

    def orphans(ids: set[int]) -> list[int]:
        return [w for w in ids & covered if not any(ways.in_box(w, b) for b in boxes)]

    orphan = orphans(national_ways)
    other = orphans(member_ways - national_ways)
    print(f"\nnational-route ways outside every region box: {len(orphan)}")
    print(f"  (prefectural ways outside, expected: {len(other)})")
    if orphan:
        print("  " + ", ".join(f"way/{w}" for w in orphan[:20]))
        print("  A national route is outside every box. Fix regions.py before building.")

    (CACHE / "pbf_source.json").write_text(json.dumps({
        "path": path, "url": SOURCE_URL,
        "timestamp_osm_base": base_ts, "extracted_at": fetched,
        "ways_kept": len(ways.start), "orphan_ways": len(orphan),
    }, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
