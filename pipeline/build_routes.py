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
      (b) its name is 国道N号 — unless it is also graded and gated like an
          ordinary closed residential street with no relation backing it up
          (see names_a_closed_residential_road);
      (c) it is mapped at national grade (trunk / motorway / construction of
          one) and no *competing* route relation claims the same number
          for it.
    (c) exists because route relations lag badly behind the ways: 長野南バイパス
    (国道19号, open for decades) is 22 trunk ways that no relation contains.
    A bare numeric `ref` alone proves nothing — 都道府県道 use the same format.

  which routes?                    The union of:
      - the numbers of every relation containing it (inherited through parents);
      - 国道N号 parsed from its name;
      - the semicolon-separated tokens of its own `ref`, but only for numbers
        some national relation in the region independently vouches for, and
        that no competing relation claims under the same number for this way.
        競合 relations are mostly 都道府県道, but an operator-branded route
        numbering scheme (首都高速道路 etc.) makes the identical kind of claim
        — see resolve_competing_claims and CASES.md 20.

Usage:  uv run pipeline/build_routes.py [region]
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict

from _paths import CACHE, REGIONS as OUT
from geo import haversine, line_length
from regions import for_region

# Route numbers a general national route can legally have: 1-58 and 101-507,
# less the six numbers whose routes were abolished or absorbed.
ABOLISHED = {109, 110, 111, 214, 215, 216}
VALID = (set(range(1, 59)) | set(range(101, 508))) - ABOLISHED

NAME_NUM = re.compile(r"国道\s*(\d+)\s*号")

FOOT_HIGHWAYS = {"path", "footway", "steps", "track", "cycleway", "bridleway"}
NATIONAL_GRADE = {"trunk", "motorway"}

# The same grades, for a road still being built. `primary` used to be here, and
# it was the one back door through the rule that keeps primary out: RULES.md
# excludes it because a bare numeric `ref` on a primary proves nothing — 3,305
# relation-less primary ways in 長野県 carry one and not one is named 国道.
# `construction=primary` let exactly that class back in. 北海道道39号奥尻島線 became
# 国道39号 292 km from where 国道39号 runs, and 京都府の山手幹線 and 岩屋バイパス
# became 国道2号. Nationwide it admitted 5 legitimate arcs (栗東水口道路, 1.6 km of
# 国道1号) against those; the road will come back when it opens and is retagged.
NATIONAL_GRADE_UNDER_CONSTRUCTION = {"trunk", "motorway"}

# bbox edge tolerance (deg) for suppressing endpoints that are artefacts of
# clipping the region rather than real termini
EDGE_TOL = 0.02

# How far apart two routes' endpoints may sit and still be the same junction.
# One crossing is several OSM nodes — one per approach — so the endpoints of the
# routes that meet there scatter over the intersection rather than coinciding.
# decree.py reads this too, to tell a legal terminus from an OSM break.
TERMINI_CLUSTER_M = 150


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

# Where a way may say it is a sea section. Mappers put it in the name about half
# the time and in `description` the other half, and the two halves are different
# routes, not the same ones said twice — see SEA_SECTION below.
SEA_FIELDS = (*NAME_FIELDS, "description", "note")

# Every way tag the rules in this file consult, and therefore the only ones a
# nationwide extract has to carry. extract_pbf.py imports this rather than
# restating it: a rule that starts reading a new tag must widen the set here, or
# the tag will silently be absent from the cache it builds from.
#
# `oneway` is the exception: no rule here reads it, and none should — which
# carriageway a way is has nothing to do with whether it is a national route or
# which one. compare_annual_report.py reads it, to tell a divided road's two
# carriageways (two OSM ways, one length in the ledger) from a frontage road
# that merely runs alongside. It is listed here because this set is what the
# extract carries, not because this file consults it.
TAGS_USED = frozenset({
    *SEA_FIELDS, "ref", "highway", "construction", "route", "access", "motor_vehicle",
    "proposed", "planned",
    "historic:highway", "oneway",
})

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


# way/152895667 (長野・静岡県境, a 19 m bridge) never says 旧道 in its name — it
# has no `name` at all, only `old_name=国道152号`, `highway=residential` and
# `route=hiking`/`tourism=yes`: OSM's real-world state is "this is a hiking
# trail now", recorded the way OSM records that, not with the 旧道/廃道 words
# this function used to require. It still sits on the *current* 国道152号
# relation (regel a doesn't distinguish a stale membership from a live one),
# so without this it drew as an ordinary, non-`former` national route.
# `historic:highway` is the OSM convention for exactly this claim — "this used
# to be a road of this grade, not any more" — independent of what the name
# field says. Measured nationwide against every way a national relation
# vouches for: one way carries it without already saying 旧道 in its name.
# See CASES.md 21.
def is_former(tags: dict[str, str]) -> bool:
    blob = " ".join(tags.get(k, "") for k in NAME_FIELDS)
    if FORMER_ALIGNMENT.search(blob):
        return True
    return "historic:highway" in tags


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


def resolve_competing_claims(competing_relations: list[dict]) -> dict[int, set[int]]:
    """Which non-national numbers each member way is claimed under.

    A way can sit on a 県道 relation for reasons that have nothing to do with
    its own designation — 広島南道路 (国道2号) is still, incidentally, a member
    of 広島県道243号広島港線. Recording *which number* the relation claims,
    per way, lets the guard below compare that number against what the way
    claims for itself instead of treating any competing membership at all
    as disqualifying.

    都道府県道 relations are most of `competing_relations`, but not all of it:
    an operator-branded route numbering scheme makes the same kind of claim.
    way/560259106 (首都高速都心環状線, `ref=1`) sits on a relation with
    `network=首都高速道路`, `ref=1` — the same shape as a 県道 collision, just a
    different authority naming its own numbers. See CASES.md 20.
    """
    claims: dict[int, set[int]] = defaultdict(set)
    for rel in competing_relations:
        nums = tokens(rel["tags"].get("ref")) or name_numbers(rel["tags"])
        if not nums:
            continue
        for wid in rel["members"]:
            claims[wid] |= nums
    return claims


# A sea section of a national route: the designation continues across water with
# no road under it. Most carry no `route=ferry` — nationwide, 20 arcs and 1,390
# km of open water were classified as carriageway and drawn as solid line,
# against 2 arcs and 63 km that were tagged as a ferry. A 295 km straight line
# you appear to be able to drive down is the exact confusion the dashed 海上国道
# layer exists to prevent, so the words 海上区間 are read as the evidence they
# plainly are.
#
# They are not always in the name. Of the 34 ways in Japan that say 海上区間, 20
# say it in `name` and 14 only in `description` or `note` — and the 14 are other
# routes, not the same ones said twice: 16, 28, 30, 42, 57, 259, 317, 324 were
# drawn as solid road across 東京湾, 明石海峡, 備讃瀬戸, 伊勢湾 and 有明海 while the
# name-only rule was in force. The two fields are one piece of evidence.
SEA_SECTION = re.compile(r"海上区間")

# A designated section with no road built yet — a straight line an OSM mapper
# drew to keep the route relation continuous, not something you can drive.
# Nationwide: 86 arcs, 173.3 km (76 `proposed`, 10 `planned`), the longest
# being 16.4 km of 国道360号 (白山白川郷ホワイトロードの代替路) and 16.1 km of
# 国道274号 (`description=国道274号不通区間`). Left as `road` it drew as a solid
# line — CASES.md 8 and 12's "draw a straight line across nothing and it reads
# as driveable" mistake, this time on land instead of water.
#
# This check must come after the sea-section checks above, not before: 32 of
# the 34 ways that say 海上区間 nationwide (CASES.md 12) carry
# `highway=planned`, and checking `hw` first would reclassify them back to
# solid road, undoing that fix.
UNOPENED_HIGHWAYS = {"planned", "proposed"}

# The same idea, tagged the other way round: a way with no `highway` key at
# all, only `proposed=trunk` or `planned=*` — "if this gets built, it will be
# a trunk road", not "this is a road". way/743758644 (岐阜県, layer=-5) is a
# relation member of 国道257号 with no road under it: no tunnel, nothing in
# aerial imagery, just a straight line through a mountain pass. `hw` is `None`
# here, so it falls through UNOPENED_HIGHWAYS above and reads as ordinary
# `road`. Measured nationwide against every way a national relation vouches
# for: exactly this one way. See CASES.md 22.
UNOPENED_TAGS = {"proposed", "planned"}

# 高速道路として指定された国道: grade-separated, no at-grade access, mapped
# `highway=motorway`. These carry an expressway route number of their own
# (第二神明道路 is `ref=E93;2`, 東海環状自動車道 is `ref=C3;475`) on top of the
# national-route number, and drive differently from an ordinary at-grade 国道
# — which is what put them behind the `ref=E93;2`-shaped bug in the first
# place (see extract_pbf.py's REF_NUMERIC history). They are real, driveable
# carriageway, so they stay a solid line rather than joining the dashed kinds
# above; they get their own legend/toggle because the class itself is a
# different kind of road, not because anything about it is incomplete.
#
# `highway=motorway` alone is the signal, not the presence of an E-prefixed
# `ref`: measured nationwide, 6,321 candidate ways carry both, 6,619 are
# motorway-graded under a different numbering prefix (C3, A1, …), and only 199
# carry an expressway ref without being motorway-graded — all 199 of them
# `construction=motorway`, already claimed by the `construction` bucket above.
# Matching on the `ref` shape would miss the C/A-prefixed roads and gain
# nothing over matching the grade OSM already tags for exactly this class.


def classify(tags: dict[str, str]) -> str:
    """Which legend the piece of road belongs in."""
    if tags.get("route") == "ferry":
        return "ferry"
    if SEA_SECTION.search(" ".join(tags.get(k, "") for k in SEA_FIELDS)):
        return "ferry"
    hw = tags.get("highway")
    if hw == "construction" or "construction" in tags:
        return "construction"
    if hw in UNOPENED_HIGHWAYS:
        return "unopened"
    if hw is None and UNOPENED_TAGS & tags.keys():
        return "unopened"
    if hw == "steps":
        return "steps"
    if hw in FOOT_HIGHWAYS:
        return "foot"
    if hw == "motorway":
        return "expressway"
    return "road"


# 都市高速道路 number their own routes, and the number lands in `ref` looking
# exactly like a national one. 首都高速4号新宿線 carries `ref=4`; 国道4号 is the
# road to Aomori. Nationwide this put 303 arcs and 208 km of urban expressway on
# to eleven national routes, and the corroboration guard cannot see it, because
# 国道4号 really does run through the same prefecture.
#
# Only rule (c) consults this. A way a relation vouches for is unaffected, and
# so is one whose own name says 国道N号 — some urban expressway sections really
# are designated, and they say so.
URBAN_EXPRESSWAY = re.compile(r"高速\s*\d+\s*号")


def names_an_expressway_route(tags: dict[str, str]) -> bool:
    blob = " ".join(tags.get(k, "") for k in NAME_FIELDS)
    return bool(URBAN_EXPRESSWAY.search(blob)) and not NAME_NUM.search(blob)


def is_national_grade(tags: dict[str, str]) -> bool:
    hw = tags.get("highway")
    if hw in NATIONAL_GRADE:
        return True
    if hw == "construction":
        return tags.get("construction") in NATIONAL_GRADE_UNDER_CONSTRUCTION
    return False


# A route relation is only supposed to hold road ways, but mapping mistakes
# put other things on it too: レッドバロン川口南 (a retailer's building outline)
# sat on 国道122号's relation as a plain member, with no `highway` tag at all,
# and got drawn as a designated arc. Measured nationwide, 124 relation members
# carry no `highway` tag; of those, only a handful are closed rings (building
# footprints, or a tunnel/bridge's outline recorded as a separate feature) —
# the rest are `国道352号`-named ways with a real road shape that just happens
# to be missing the tag, and stay in. `route=ferry` is excluded from this
# check on purpose: a sea-section way legitimately carries no `highway`.
def is_building_like(tags: dict[str, str], geometry: list[dict]) -> bool:
    if "highway" in tags or tags.get("route") == "ferry":
        return False
    return len(geometry) >= 2 and geometry[0] == geometry[-1]


# A way whose only claim is its name (国道6号) but whose grade and access tags
# describe an ordinary, closed-to-traffic residential street, not a road
# anyone would call a national route. way/497559205 (highway=residential,
# access=no, motor_vehicle=no) sits deep inland in 福島県, nowhere near 国道6号's
# actual Pacific-coast alignment, and 地理院地図 draws it as a city street.
#
# This can't be `highway` grade alone: nationwide, rule (b) admits 10,810 ways
# on name alone, 33 of them `residential`, and every other one of those 33 is
# either a legitimately-designated 旧道/側道 or a real `ref`-bearing 国道
# carrying ordinary traffic. Narrowed to residential *and* closed to motor
# vehicles, exactly one way nationwide matches — this one.
def names_a_closed_residential_road(tags: dict[str, str]) -> bool:
    return (
        tags.get("highway") == "residential"
        and tags.get("access") == "no"
        and tags.get("motor_vehicle") == "no"
    )


# -------------------------------------------------------------------- main ---
def main() -> None:
    region = sys.argv[1] if len(sys.argv) > 1 else "nagano"
    raw_path = CACHE / f"{region}.raw.json"
    if not raw_path.exists():
        raise SystemExit(f"no cache for {region!r}; run pipeline/fetch_osm.py {region} first")

    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    if "core" not in raw:
        raise SystemExit("cache is in the old single-query format; re-run pipeline/fetch_osm.py")
    if "competing_relations" not in raw:
        raise SystemExit(
            "cache predates per-number competing claims; re-run pipeline/fetch_osm.py")

    base_ts = raw["timestamp_osm_base"]
    bbox = raw["bbox"]
    print(f"OSM data base: {base_ts}   fetched: {raw['fetched_at']}")

    rels = {e["id"]: e for e in raw["core"] if e["type"] == "relation"}
    ways: dict[int, dict] = {}
    for src in ("core", "candidates"):
        for e in raw[src]:
            if e["type"] == "way" and e.get("geometry") and not is_building_like(
                    e.get("tags", {}), e["geometry"]):
                ways.setdefault(e["id"], e)
    competing_claims = resolve_competing_claims(raw["competing_relations"])
    competing_ids = set(competing_claims)
    print(f"loaded {len(rels)} relations, {len(ways)} distinct ways, "
          f"{len(competing_ids)} competing-claimed ways")

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
        # A number this way's `ref` claims is not believed when some
        # competing relation claims that same number for it — the
        # 372号-in-長野 collision rule (b) exists to stop, and 首都高速都心環状線
        # (`ref=1` under an operator-branded relation, CASES.md 20) is the same
        # shape. It stays believed when the way merely sits on an unrelated
        # relation for some other number: 広島南道路 (国道2号) is incidentally
        # still a member of 広島県道243号広島港線, and 巴橋 (国道375号;433号;434号)
        # of 広島県道39号 — neither collision is with the number the way itself
        # claims.
        from_tag = (raw_tag & corroborated) - competing_claims.get(wid, set())
        for n in (raw_tag | raw_name) - corroborated:
            rejected[n] += 1

        # --- is it a national route? -------------------------------------
        if from_rel or from_name:
            if from_rel:
                source = "relation"
            elif names_a_closed_residential_road(tags):
                # Named 国道N号 but graded and gated like an ordinary closed
                # residential street, with no relation to back it up: see
                # names_a_closed_residential_road.
                dropped.append(wid)
                continue
            else:
                source = "name"
        elif (from_tag and not names_an_expressway_route(tags)
              and (wid in vouched or is_national_grade(tags))):
            # Relation-less but mapped as a national road and unclaimed by any
            # competing route under this number: this is the bypass case.
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
        print(f"    国道{'・'.join(map(str, refs)):<12} {name!s:<24} x{c}")

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

    # How many arc ends of each route meet at each point. A point touched once
    # is where that route's chain stops; touched twice or more, the chain runs
    # through it.
    #
    # One pass over the arcs, not one pass per route. The route loop used to sit
    # outside and re-read all 13,000 arcs to skip the 12,000 that are not its
    # own — the arc already names the routes it belongs to, so it can be handed
    # to all of them as it goes by. The rounding, the order the ends are counted
    # in, and the order the routes come out in are all unchanged, so this builds
    # the same list.
    ends_of: dict[int, Counter] = defaultdict(Counter)
    for a in arcs:
        ends = [
            (round(p[0], 7), round(p[1], 7))
            for p in (a["coords"][0], a["coords"][-1])
        ]
        for r in a["refs"]:
            for p in ends:
                ends_of[r][p] += 1

    endpoints = []
    for r in sorted(routes):
        for (lat, lon), d in ends_of[r].items():
            if d == 1 and not on_edge(lat, lon):
                endpoints.append({"ref": r, "lat": lat, "lon": lon})

    print(f"\ncandidate termini inside the region: {len(endpoints)}")

    clusters: list[dict] = []
    for e in endpoints:
        for c in clusters:
            if haversine((e["lat"], e["lon"]), (c["lat"], c["lon"])) < TERMINI_CLUSTER_M:
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
                # Only apply_n13.py ever sets this to 1 — see issue #9. It is
                # independent of `former`: a former arc keeps former=1 either
                # way, since 指定解除 (revoked) can lag OSM's own tagging by
                # years (RULES.md 旧道). 0 means "not confirmed", not
                # "confirmed still current".
                "revoked": 0,
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
        # `routes` may fall outside this set — see pipeline/verify.py.
        #
        # This set is what makes the guard a guard, and it only works because it
        # is regional. Judged over the whole country it would approach all 459
        # numbers and filter nothing, putting 長野県道372号 back on the map as
        # 国道372号. verify.py asserts it stays well short of that.
        "corroborated_refs": sorted(corroborated),
        # Numbers a way claimed for itself that no relation here vouches for,
        # with how many ways claimed each. Almost all of these are 都道府県道
        # sharing the bare-number `ref` format. Recorded so the guard's effect
        # is a measured number rather than an assurance.
        "rejected_refs": {str(k): v for k, v in sorted(rejected.items())},
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
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

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
