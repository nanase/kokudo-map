# /// script
# requires-python = ">=3.12"
# dependencies = ["requests", "pyshp"]
# ///
"""政令自身が述べる起点・終点を読み、それに座標を当てる。

地図が今 端点 と呼んでいる物は、グラフ上の事実である。その路線のアークが終わって
いるノードのことで、全国に 5,706 個、1 路線あたり約 12 個ある。その大半は OSM が
尽きた場所か、県の bbox が道を切った場所であって、路線が法令上どこで始まりどこで
終わるかではない。どちらの端が起点かも、その集合は述べていない。

台帳のほうは述べている。一般国道の路線を指定する政令(昭和 40 年政令第 58 号)は、
459 行の別表を持つ。列は 路線名・起点・終点・重要な経過地 である。e-Gov 法令検索
はそれを XML で配る。このスクリプトはその表を読み、データとして書く。端点の
置き換えではなく、その隣に並ぶ独立した欄としてである。

表が名指しするのは地名であって座標ではない——「東京都中央区」「大阪市」といった
具合である。だから点を見つけねばならず、ここでの規則は狭い。

    政令の起終点の座標は、その路線自身の端点のうち、政令が名指しする市区町村の
    中に在る物である。

だから座標が作られることは無い。必ず路線が実際に終わっているノードであり、必ず
その市区町村の中にある。中に端点が無ければ、その行は地名だけを持ち、座標が無いと
述べる。半分だけ正しい座標が「台帳上の起点」の名を着ているより、無いほうがよい。

この規則を回すには二つの出どころが必要である。

  行政区域(国土数値情報 N03)   市区町村の多角形。二つの年版を、現行から順に
      読む。政令の地名は、その行が最後に改正された時点で効力を持っていた物で
      あり——最も新しい改正は平成 16 年である——平成の大合併はその後、およそ
      五分の一を地図から消した。清水市と中村市はデータの欠落ではない。存在
      しなくなった市区町村である。その波の直前、2000-10-01 の年版は今もそれを
      描いており、名前が変わっても土地が動くわけではない。

  端点                          build/regions/*.meta.json。路線の端点は、それを
      報告する地域すべてで和を取る。県の bbox は重なるので、同じノードが隣り
      合う二県から報告される。

同点は二段で解く。まず、別の国道もそこで終わっている端点が勝つ——法令上の起終点
はたいてい国道どうしの交点であり、日本橋は六つの路線の端点である。残ったものは、
その路線自身の端点の中心から最も遠い端点を選んで決める。起点と終点は路線の両端で
あって、途中のどこかではないためである。

同じ市区町村で始まり終わる路線は環状である——国道16号と国道302号が分かりやすい
例である——ので、遠い側を選ぶ規則は何も言えない。その行は地名だけを持ち、座標を
持たない。

使い方:  uv run pipeline/decree.py [--refresh]

`--refresh` は、キャッシュが新しくても政令を取り直す。
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
from geo import haversine

# 一般国道の路線を指定する政令(昭和40年政令第58号). e-Gov 法令検索 API v1 hands
# 安定した id で、別表を含む法令全体を XML として返す。
LAW_ID = "340CO0000000058"
LAW_URL = f"https://laws.e-gov.go.jp/api/1/lawdata/{LAW_ID}"

# 政令の改正は年に数回なので、生成のたびに e-Gov へ訊くのは、四半期に一度しか
# 変わらない答えを毎回求めることになる。キャッシュはこの古さになったら取り直す。
# 誰も --refresh を覚えていなくても、改正の頻度に近いところへ落ち着く。
DECREE_MAX_AGE_S = 90 * 24 * 3600

# 国土数値情報 N03(行政区域)。この順に試す。shapefile はどちらの年版でも同じ
# 五つの列を持つ——都道府県名、支庁名、郡・政令市名、市区町村名、政令市の区名
# ——が、古いほうの年版は DBF が UTF-8 へ移る前の物である。
N03_BASE = "https://nlftp.mlit.go.jp/ksj/gml/data/N03"
VINTAGES = (
    ("2026", f"{N03_BASE}/N03-2026/N03-20260101_{{code}}_GML.zip", "utf-8"),
    ("2000", f"{N03_BASE}/N03-2000/N03-001001_{{code}}_GML.zip", "cp932"),
)
PREF_CODES = tuple(f"{i:02d}" for i in range(1, 48))

UA = {"User-Agent": "NationalRouteMap/0.2 (build pipeline)"}

# N03 の欄の位置。名前は KSJ の符号化の約束に従って N03_001..N03_007 なので、
# ここで名前を付けるのは、このスクリプトが読む物だけである。
F_PREF, F_GUN, F_MUNI, F_WARD = 0, 2, 3, 4

# 自分の市区町村を持たないレコード。所属未定地は市区町村が決まっていない土地で、
# 都道府県だけを持ち、他に何も持たない。
NO_MUNICIPALITY = {"", "所属未定地"}


# ------------------------------------------------------------------ fetch ---
def cached(url: str, path: Path, max_age_s: float | None = None) -> bytes:
    """一度 GET し、以後はディスクから読む。`max_age_s` を過ぎた物は取り直す。"""
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


# ----------------------------------------------------------------- decree ---
KANJI_DIGITS = {"〇": 0, "一": 1, "二": 2, "三": 3, "四": 4,
                "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
KANJI_UNITS = {"十": 10, "百": 100}


def route_number(name: str) -> int:
    """`五百七号` を 507 にする。別表は路線番号を漢数字で書く。"""
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
    """別表を、路線ごとに 1 行で。あわせて法令自身の名前も返す。"""
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
    """N03 の 1 つの年版。地名がどの市区町村を指すかと、その輪郭を持つ。

    索引を組むのに読むのは DBF だけである——全国で 1,900 行の文字列である——
    市区町村の多角形は、誰かが求めたときに初めて SHP から読む。
    """

    def __init__(self, vintage: str, url: str, encoding: str) -> None:
        self.vintage = vintage
        self.url = url
        self.encoding = encoding
        # (code, 都道府県, 郡, 市区町村, 区) -> それが跨ぐ SHP のレコード番号。
        # 島嶼の市区町村は多数のレコードになる。
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
        """別表がこの市区町村を書きうる形すべて。

        表の書き方は元から揃っていない。大阪市は単独で、東京都中央区は都を付けて、
        熊本県鹿本郡植木町は郡まで付けて書く。そのどれもが同じ輪郭を指さねば
        ならない。
        """
        for name in {pref + gun + muni + ward, pref + muni + ward,
                     (gun + muni + ward) if gun else "", muni + ward}:
            if name:
                self.by_name[name].add(idx)
        if ward:
            # 政令市を全体として指す形。区を付けずに市だけを名指しする行の
            # ため、そして 1989 年に廃止された区で、市のほうは今も在る
            # 大阪市東区のためである。
            for name in {pref + muni, muni}:
                self.by_name[name].add(idx)

    def lookup(self, place: str) -> tuple[str, set[int]] | None:
        """その地名が始まりとして持つ、最も長い行政区域の名前。

        別表は起終点を市区町村より細かく書くことが多い——「川崎市川崎区宮前町」
        「岩国市麻里布町一丁目」といった具合で、丁目は N03 が描くどの単位よりも
        細かい。市区町村になる最も長い接頭辞が、正直に降りられる限界である。
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
    """すべての環をまとめて数える、偶奇の判定。

    環を全部まとめて数えることが、穴と島の両方を正しく出す。ある島の上の点は
    その島の輪郭を 1 回横切って中に入り、飛地の中の点は、囲む側の輪郭と飛地
    自身の環を 2 回横切って外になる。環ごとに別々に判定すると、飛地はそれを
    囲む市区町村の中に入ってしまう。
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
def endpoints_by_route() -> dict[int, list[tuple[float, float]]]:
    """全地域の起終点の和。bbox は重なるので、県境上のノードは隣り合う二県から
    まったく同じ数の対として報告される。"""
    index = json.loads((REGIONS / "regions.json").read_text(encoding="utf-8"))
    seen: dict[int, set[tuple[float, float]]] = collections.defaultdict(set)
    for entry in index:
        meta = json.loads(
            (REGIONS / f"{entry['region']}.meta.json").read_text(encoding="utf-8"))
        for t in meta["termini"]:
            seen[t["ref"]].add((t["lat"], t["lon"]))
    return {ref: sorted(pts) for ref, pts in seen.items()}


def centre_of(points: list[tuple[float, float]]) -> tuple[float, float]:
    """路線の端点が張る範囲の中心。単純な平均を使うと、OSM が最も細かく分けた
    区間の側へ寄ってしまう。"""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return ((min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2)


# ------------------------------------------------------------------- match ---
def choose(candidates: list, meeting: dict, centre: tuple) -> tuple[dict, str]:
    """市区町村の中の端点のうち、政令が指しているのはどれか。"""
    if len(candidates) == 1:
        return candidates[0], "sole"
    # 法令上の起終点はたいてい国道どうしが出会う場所で、集まる数が多いほど、
    # そこだとはっきりする。日本橋は六つの路線の端で、数本先の通りにある OSM の
    # 切れ目はどの路線の端でもない。
    best = max(meeting.get(p, 0) for p in candidates)
    pool = [p for p in candidates if meeting.get(p, 0) == best] if best else candidates
    if best and len(pool) == 1:
        return pool[0], "junction"
    # 起点と終点は路線の両端なので、残ったものからは、路線の中心から最も遠い
    # 端点を選ぶ。
    return max(pool, key=lambda p: haversine(p, centre)), "farthest"


def meeting_counts(routes: dict[int, list]) -> dict[int, dict]:
    """路線ごとに、その端点それぞれで幾つの他の国道が終わっているか。

    まとめる距離は、地図が起終点の共有に既に使っているのと同じである。1 つの交差点
    は複数のノードでできているので、そこで出会う端どうしはぴたりとは重ならない。
    """
    lat_cell = TERMINI_CLUSTER_M / 111_320  # degrees of latitude
    # 経度 1 度の長さは北へ行くほど短いので、同じ度数でも宗谷のセルは八重山の
    # セルより狭くなる——105 m に対して 150 m である。すると 150 m 離れた二つの
    # 端点が二つ隣のセルに落ち、隣を 1 つしか見ない下の走査はそれを見落とす。
    # 経度側のセルの大きさを、データの中で最も北にある端点で決めておけば、
    # どのセルも TERMINI_CLUSTER_M 以上の幅を保つ。
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
        print(f"N03 {vintage} 年版を読みます({len(left)} 件の地名が未解決)", flush=True)
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
                # 環状の路線。起点も終点も同じ市区町村なので、遠い側を採用する規則が
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
