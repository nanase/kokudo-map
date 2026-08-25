# /// script
# requires-python = ">=3.12"
# dependencies = ["requests", "pyshp"]
# ///
"""Read the 起点 and 終点 the decree itself states, and put a coordinate on them.

What the map calls 端点 today is a graph fact: a node where a route's own arcs
stop. Nationwide there are 5,706 of them, about 12 per route, and most are
places where OSM runs out or a prefecture box cuts the road — not where the
route legally begins or ends. Nothing in that set says which end is the 起点.

The ledger does say. 一般国道の路線を指定する政令 (昭和40年政令第58号) carries a
別表 of 459 rows: 路線名, 起点, 終点, 重要な経過地. e-Gov 法令検索 serves it as
XML. This script reads that table and writes it as data, as a column of its own
next to the endpoints rather than a replacement for them.

The table names places, not coordinates — 「東京都中央区」, 「大阪市」. A point
has to be found, and the rule here is the narrow one:

    the coordinate of a decree terminus is one of that route's own endpoints,
    the one that lies inside the municipality the decree names.

So a coordinate is never invented. It is always a node the route really stops
at, and it is always inside the named municipality. When no endpoint is in
there, the row keeps its place name and says it has no coordinate. Half-right
coordinates wearing the name 台帳上の起点 would be worse than none.

Two sources are needed to run that rule:

  行政区域 (国土数値情報 N03)   the municipality's polygon. Two vintages are
      read, current first. The decree's place names are the ones in force when
      the row was last amended — the newest amendment is 平成16年 — and 平成の
      大合併 has since erased about a fifth of them from the map. 清水市 and
      中村市 are not missing data; they are municipalities that stopped
      existing. The 2000-10-01 vintage, the last one before that wave, still
      draws them, and a town's ground does not move when its name changes.

  端点                          build/regions/*.meta.json. A route's endpoints
      are unioned across the regions that report them: prefecture boxes
      overlap, so the same node is reported by both neighbours.

Ties are broken twice. Endpoints where another national route also ends win
first — a legal terminus is usually a junction of national routes, and 日本橋
is the endpoint of six of them. What is left is settled by taking the endpoint
farthest from the centre of the route's own endpoints, because 起点 and 終点 are
the far ends of a route and not somewhere along it.

A route that begins and ends in the same municipality is a ring — 国道16号 and
国道302号 are the clear cases — and for those the far-end rule has nothing to
say. Those rows keep their names and no coordinate.

Usage:  uv run pipeline/decree.py [--refresh]

`--refresh` re-fetches the decree even if the cache is fresh.
"""
from __future__ import annotations

import collections
import io
import json
import math
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import requests
import shapefile

from _paths import DECREE, N03, REGIONS
from build_routes import TERMINI_CLUSTER_M, VALID

# 一般国道の路線を指定する政令(昭和40年政令第58号). e-Gov 法令検索 API v1 hands
# back the whole law as XML, 別表 included, at a stable id.
LAW_ID = "340CO0000000058"
LAW_URL = f"https://laws.e-gov.go.jp/api/1/lawdata/{LAW_ID}"

# The decree is amended a few times a year, so asking e-Gov on every build would
# be a request per build for an answer that changes quarterly. The cache is
# re-fetched once it is this old, which lands near the amendment rate without
# anyone having to remember to pass --refresh.
DECREE_MAX_AGE_S = 90 * 24 * 3600

# 国土数値情報 N03(行政区域), tried in this order. The shapefile carries the same
# five columns in both vintages — 都道府県名, 支庁名, 郡・政令市名, 市区町村名,
# 政令市の区名 — but the older one predates the switch to UTF-8 in the DBF.
N03_BASE = "https://nlftp.mlit.go.jp/ksj/gml/data/N03"
VINTAGES = (
    ("2026", f"{N03_BASE}/N03-2026/N03-20260101_{{code}}_GML.zip", "utf-8"),
    ("2000", f"{N03_BASE}/N03-2000/N03-001001_{{code}}_GML.zip", "cp932"),
)
PREF_CODES = tuple(f"{i:02d}" for i in range(1, 48))

UA = {"User-Agent": "NationalRouteMap/0.2 (build pipeline)"}

# N03 field positions. The names are N03_001..N03_007 per the KSJ encoding
# convention, so only the ones this script reads get a name here.
F_PREF, F_GUN, F_MUNI, F_WARD = 0, 2, 3, 4

# A record with no municipality of its own. 所属未定地 is ground whose
# municipality is undecided; it has a prefecture and nothing else.
NO_MUNICIPALITY = {"", "所属未定地"}


# ------------------------------------------------------------------ fetch ---
def cached(url: str, path: Path, max_age_s: float | None = None) -> bytes:
    """GET once, then read from disk. `max_age_s` re-fetches a stale file."""
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
        # A stale copy beats stopping a nationwide build because a ministry's
        # server is down. Only the absence of any copy is fatal.
        if not path.exists():
            raise
        print(f"WARN  {url} を取れませんでした（{e}）。古いキャッシュを使います。")
        return path.read_bytes()
    path.write_bytes(r.content)
    return r.content


# ----------------------------------------------------------------- decree ---
KANJI_DIGITS = {"〇": 0, "一": 1, "二": 2, "三": 3, "四": 4,
                "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
KANJI_UNITS = {"十": 10, "百": 100}


def route_number(name: str) -> int:
    """`五百七号` -> 507. The 別表 writes route numbers as kanji numerals."""
    total = 0
    digit = 0
    for ch in name.removesuffix("号"):
        if ch in KANJI_DIGITS:
            digit = KANJI_DIGITS[ch]
        elif ch in KANJI_UNITS:
            total += (digit or 1) * KANJI_UNITS[ch]
            digit = 0
        else:
            raise ValueError(f"路線名を数に直せません: {name}")
    return total + digit


def decree_table(refresh: bool) -> tuple[dict, list[dict]]:
    """The 別表, one row per route, plus what the law calls itself."""
    path = DECREE / f"{LAW_ID}.xml"
    raw = cached(LAW_URL, path, 0 if refresh else DECREE_MAX_AGE_S)
    root = ET.fromstring(raw)
    if (root.findtext("Result/Code") or "") != "0":
        raise SystemExit(f"e-Gov が拒みました: {root.findtext('Result/Message')}")
    law = root.find(".//Law")
    table = root.find(".//AppdxTable//Table")
    if table is None:
        raise SystemExit("別表が見つかりません。e-Gov の XML の形が変わっています。")

    rows = []
    for tr in table.findall("TableRow"):
        cells = ["".join(td.itertext()).strip() for td in tr.findall("TableColumn")]
        if len(cells) != 4 or cells[0] == "路線名":
            continue
        rows.append({
            "ref": route_number(cells[0]),
            "start": cells[1],
            "end": cells[2],
            "via": cells[3],
        })
    about = {
        "law_id": LAW_ID,
        "law_num": law.findtext("LawNum") or "",
        "law_title": law.findtext("LawBody/LawTitle") or "",
        "fetched_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
                              .strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    return about, rows


# -------------------------------------------------------------- gazetteer ---
class Gazetteer:
    """One N03 vintage: which municipality a place name means, and its outline.

    Only the DBF is read to build the index — 1,900 rows of text nationwide —
    and a municipality's polygons are read from the SHP only once something
    asks for them.
    """

    def __init__(self, vintage: str, url: str, encoding: str) -> None:
        self.vintage = vintage
        self.url = url
        self.encoding = encoding
        # (code, pref, gun, muni, ward) -> the SHP record numbers it spans;
        # an island municipality is many records.
        self.units: list[tuple] = []
        self.by_name: dict[str, set[int]] = collections.defaultdict(set)
        self._rings: dict[int, list] = {}

    def zip_path(self, code: str) -> Path:
        return N03 / self.vintage / f"{code}.zip"

    def _archive(self, code: str) -> tuple[zipfile.ZipFile, str]:
        raw = cached(self.url.format(code=code), self.zip_path(code))
        z = zipfile.ZipFile(io.BytesIO(raw))
        base = next(n[:-4] for n in z.namelist() if n.endswith(".shp"))
        return z, base

    def load(self) -> None:
        for code in PREF_CODES:
            z, base = self._archive(code)
            sf = shapefile.Reader(dbf=io.BytesIO(z.read(base + ".dbf")),
                                  encoding=self.encoding)
            spans: dict[tuple, list[int]] = {}
            for i, rec in enumerate(sf.iterRecords()):
                muni = (rec[F_MUNI] or "").strip()
                if muni in NO_MUNICIPALITY:
                    continue
                key = (rec[F_PREF].strip(), (rec[F_GUN] or "").strip(),
                       muni, (rec[F_WARD] or "").strip())
                spans.setdefault(key, []).append(i)
            for key, recs in spans.items():
                idx = len(self.units)
                self.units.append((code, *key, recs))
                self._name(idx, *key)

    def _name(self, idx: int, pref: str, gun: str, muni: str, ward: str) -> None:
        """Every way the 別表 might spell this municipality.

        The table is inconsistent by design: it writes 大阪市 bare, 東京都中央区
        with its prefecture, and 熊本県鹿本郡植木町 with its 郡. All of those
        forms have to point at the same outline.
        """
        for name in {pref + gun + muni + ward, pref + muni + ward,
                     (gun + muni + ward) if gun else "", muni + ward}:
            if name:
                self.by_name[name].add(idx)
        if ward:
            # 政令市 as a whole, for rows that name the city without a ward —
            # and for 大阪市東区, a ward abolished in 1989 whose city still
            # exists.
            for name in {pref + muni, muni}:
                self.by_name[name].add(idx)

    def lookup(self, place: str) -> tuple[str, set[int]] | None:
        """The longest administrative name this place name starts with.

        The 別表 often writes a terminus finer than a municipality —
        「川崎市川崎区宮前町」, 「岩国市麻里布町一丁目」 — and the 丁目 is below
        anything N03 draws. The longest prefix that is a municipality is as
        far down as this can honestly go.
        """
        for cut in range(len(place), 1, -1):
            head = place[:cut]
            if head in self.by_name:
                return head, self.by_name[head]
        return None

    def rings(self, idxs: set[int]) -> list[list[tuple[float, float]]]:
        missing = [i for i in idxs if i not in self._rings]
        by_code: dict[str, list[int]] = collections.defaultdict(list)
        for i in missing:
            by_code[self.units[i][0]].append(i)
        for code, want in sorted(by_code.items()):
            z, base = self._archive(code)
            sf = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")),
                                  dbf=io.BytesIO(z.read(base + ".dbf")),
                                  encoding=self.encoding)
            for i in want:
                out = []
                for rec_no in self.units[i][5]:
                    shape = sf.shape(rec_no)
                    bounds = [*shape.parts, len(shape.points)]
                    for p in range(len(bounds) - 1):
                        out.append(shape.points[bounds[p]:bounds[p + 1]])
                self._rings[i] = out
            del sf
        return [ring for i in idxs for ring in self._rings[i]]


def contains(rings: list, lat: float, lon: float) -> bool:
    """Even-odd ray casting over every ring at once.

    Counting all the rings together is what makes holes and islands both come
    out right. A point on one island crosses that island's outline once and is
    in; a point in an enclave crosses the enclosing outline and the enclave's
    own ring, twice, and is out. Testing each ring on its own would put the
    enclave inside the municipality that surrounds it.
    """
    inside = False
    for ring in rings:
        x0, y0 = ring[-1]
        for x1, y1 in ring:
            if (y1 > lat) != (y0 > lat) and lon < x1 + (lat - y1) * (x0 - x1) / (y0 - y1):
                inside = not inside
            x0, y0 = x1, y1
    return inside


# ------------------------------------------------------------------ termini ---
def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371008.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def endpoints_by_route() -> dict[int, list[tuple[float, float]]]:
    """Every region's termini, unioned. Boxes overlap, so a node on a shared
    border is reported by both neighbours as the identical pair of numbers."""
    index = json.loads((REGIONS / "regions.json").read_text(encoding="utf-8"))
    seen: dict[int, set[tuple[float, float]]] = collections.defaultdict(set)
    for entry in index:
        meta = json.loads(
            (REGIONS / f"{entry['region']}.meta.json").read_text(encoding="utf-8"))
        for t in meta["termini"]:
            seen[t["ref"]].add((t["lat"], t["lon"]))
    return {ref: sorted(pts) for ref, pts in seen.items()}


def centre_of(points: list[tuple[float, float]]) -> tuple[float, float]:
    """The middle of the box the route's endpoints span. A plain mean would
    lean toward whichever stretch OSM has broken into the most pieces."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return ((min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2)


# ------------------------------------------------------------------- match ---
def choose(candidates: list, meeting: dict, centre: tuple) -> tuple[dict, str]:
    """Which of a municipality's endpoints is the one the decree means."""
    if len(candidates) == 1:
        return candidates[0], "sole"
    # A legal terminus is usually where national routes meet, and the more of
    # them meet there the more clearly it is that place: 日本橋 is the end of
    # six routes, and the OSM breaks a few streets away are the end of none.
    best = max(meeting.get(p, 0) for p in candidates)
    pool = [p for p in candidates if meeting.get(p, 0) == best] if best else candidates
    if best and len(pool) == 1:
        return pool[0], "junction"
    # 起点 and 終点 are the far ends of a route, so of what is left, take the
    # endpoint farthest from the middle of the route.
    return max(pool, key=lambda p: haversine(p, centre)), "farthest"


def meeting_counts(routes: dict[int, list]) -> dict[int, dict]:
    """Per route, how many *other* national routes end at each of its endpoints.

    Same cluster distance the map already uses for shared termini: one crossing
    is several nodes, so the ends that meet there do not coincide exactly.
    """
    lat_cell = TERMINI_CLUSTER_M / 111_320  # degrees of latitude
    # A degree of longitude is shorter the further north it is, so the same
    # number of degrees makes a narrower cell in 宗谷 than in 八重山 — 105 m
    # against 150 m. Two endpoints 150 m apart would then land two cells apart
    # and the neighbour scan below, which only looks one cell out, would miss
    # them. Sizing the longitude cell at the northernmost endpoint in the data
    # keeps every cell at least TERMINI_CLUSTER_M wide.
    top = max(abs(p[0]) for pts in routes.values() for p in pts)
    lon_cell = lat_cell / math.cos(math.radians(top))
    grid: dict[tuple, list] = collections.defaultdict(list)
    for ref, pts in routes.items():
        for p in pts:
            grid[(int(p[0] // lat_cell), int(p[1] // lon_cell))].append((ref, p))
    out: dict[int, dict] = {}
    for ref, pts in routes.items():
        counts = {}
        for p in pts:
            gy, gx = int(p[0] // lat_cell), int(p[1] // lon_cell)
            near = set()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    for other, q in grid[(gy + dy, gx + dx)]:
                        if other != ref and haversine(p, q) < TERMINI_CLUSTER_M:
                            near.add(other)
            counts[p] = len(near)
        out[ref] = counts
    return out


def main() -> None:
    sys.stdout.reconfigure(errors="replace")
    refresh = "--refresh" in sys.argv[1:]

    about, rows = decree_table(refresh)
    print(f"{about['law_title']}({about['law_num']}) 別表 — {len(rows)} 路線")
    refs = [r["ref"] for r in rows]
    if len(set(refs)) != len(refs):
        raise SystemExit("別表に同じ路線番号が二度あります。")
    if set(refs) != VALID:
        raise SystemExit(f"別表の路線番号が一般国道の番号と合いません: "
                         f"{sorted(set(refs) ^ VALID)}")

    routes = endpoints_by_route()
    meeting = meeting_counts(routes)
    centres = {ref: centre_of(pts) for ref, pts in routes.items()}
    print(f"端点: {sum(len(v) for v in routes.values()):,} 点 / {len(routes)} 路線")

    places = sorted({r[side] for r in rows for side in ("start", "end")})
    gazetteers: list[Gazetteer] = []
    found: dict[str, tuple[Gazetteer, str, set[int]]] = {}
    for vintage, url, encoding in VINTAGES:
        left = [p for p in places if p not in found]
        if not left:
            break
        g = Gazetteer(vintage, url, encoding)
        print(f"N03 {vintage} 年版を読みます（{len(left)} 件の地名が未解決）", flush=True)
        g.load()
        gazetteers.append(g)
        for place in left:
            hit = g.lookup(place)
            if hit:
                found[place] = (g, *hit)
        print(f"  {len([p for p in left if p in found])} 件が当たりました")
    print(f"地名 {len(places)} 件のうち {len(found)} 件が市区町村に当たりました")

    out = []
    how_count: collections.Counter = collections.Counter()
    for row in rows:
        ref = row["ref"]
        rec = {"ref": ref, "via": row["via"]}
        same = row["start"] == row["end"]
        for side in ("start", "end"):
            place = row[side]
            cell: dict = {"name": place}
            hit = found.get(place)
            if hit is None:
                # 港・空港のような市区町村でない地名と、合併で消えて 2000 年版
                # にも無い地名は、どちらもここへ来る。どちらも当たらなかった
                # ことに変わりはないので、一つの理由にまとめる。
                cell["how"] = "no-boundary"
            elif same:
                # 環状の路線。起点も終点も同じ市区町村なので、遠い側を採る規則が
                # 二つの端点を区別できない。
                cell["how"] = "ring"
            else:
                g, _, idxs = hit
                rings = g.rings(idxs)
                inside = [p for p in routes.get(ref, ())
                          if contains(rings, p[0], p[1])]
                if not inside:
                    cell["how"] = "no-endpoint"
                else:
                    point, how = choose(inside, meeting.get(ref, {}),
                                        centres[ref])
                    cell |= {"lat": point[0], "lon": point[1], "how": how}
            how_count[cell["how"]] += 1
            rec[side] = cell
        out.append(rec)

    DECREE.mkdir(parents=True, exist_ok=True)
    path = DECREE / "decree.json"
    path.write_text(
        json.dumps({**about, "routes": out}, ensure_ascii=False,
                   separators=(",", ":")),
        encoding="utf-8")

    got = sum(how_count[k] for k in ("sole", "junction", "farthest"))
    both = sum(1 for r in out if "lat" in r["start"] and "lat" in r["end"])
    print(f"\n座標が当たった起終点: {got} / {len(rows) * 2}")
    print(f"  両端とも当たった路線: {both} / {len(rows)}")
    for k in ("sole", "junction", "farthest"):
        print(f"  {k:<12} {how_count[k]:>4}")
    print("当たらなかった起終点:")
    for k in ("no-boundary", "no-endpoint", "ring"):
        print(f"  {k:<12} {how_count[k]:>4}")
    print(f"\nwrote {path.name} ({path.stat().st_size / 1e3:.1f} kB)")


if __name__ == "__main__":
    main()
