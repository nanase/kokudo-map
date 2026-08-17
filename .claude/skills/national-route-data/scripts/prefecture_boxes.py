# /// script
# requires-python = ">=3.12"
# dependencies = ["osmium>=4.0"]
# ///
"""Measure every prefecture's bounding box from the .osm.pbf and print the
regions.py table.

Forty-seven boxes typed by hand is forty-seven chances to leave a strip of the
country uncovered, and nothing downstream would say so. These come from the
`admin_level=4` boundary relations in the same file the roads come from, so the
boxes and the roads cannot disagree.

Names are not measured. The ISO 3166-2:JP code is the identity, and the slug and
Japanese label for each code are fixed, so they are stated here and matched
against what the file contains.

Usage:  uv run scripts/prefecture_boxes.py [--pbf path] [--pad 0.05]
"""
from __future__ import annotations

import sys

import osmium

from _paths import PBF

# ISO 3166-2:JP -> (slug, 日本語ラベル). Official and fixed; the file supplies
# only the geometry.
JP = {
    "JP-01": ("hokkaido", "北海道"), "JP-02": ("aomori", "青森県"),
    "JP-03": ("iwate", "岩手県"), "JP-04": ("miyagi", "宮城県"),
    "JP-05": ("akita", "秋田県"), "JP-06": ("yamagata", "山形県"),
    "JP-07": ("fukushima", "福島県"), "JP-08": ("ibaraki", "茨城県"),
    "JP-09": ("tochigi", "栃木県"), "JP-10": ("gunma", "群馬県"),
    "JP-11": ("saitama", "埼玉県"), "JP-12": ("chiba", "千葉県"),
    "JP-13": ("tokyo", "東京都"), "JP-14": ("kanagawa", "神奈川県"),
    "JP-15": ("niigata", "新潟県"), "JP-16": ("toyama", "富山県"),
    "JP-17": ("ishikawa", "石川県"), "JP-18": ("fukui", "福井県"),
    "JP-19": ("yamanashi", "山梨県"), "JP-20": ("nagano", "長野県"),
    "JP-21": ("gifu", "岐阜県"), "JP-22": ("shizuoka", "静岡県"),
    "JP-23": ("aichi", "愛知県"), "JP-24": ("mie", "三重県"),
    "JP-25": ("shiga", "滋賀県"), "JP-26": ("kyoto", "京都府"),
    "JP-27": ("osaka", "大阪府"), "JP-28": ("hyogo", "兵庫県"),
    "JP-29": ("nara", "奈良県"), "JP-30": ("wakayama", "和歌山県"),
    "JP-31": ("tottori", "鳥取県"), "JP-32": ("shimane", "島根県"),
    "JP-33": ("okayama", "岡山県"), "JP-34": ("hiroshima", "広島県"),
    "JP-35": ("yamaguchi", "山口県"), "JP-36": ("tokushima", "徳島県"),
    "JP-37": ("kagawa", "香川県"), "JP-38": ("ehime", "愛媛県"),
    "JP-39": ("kochi", "高知県"), "JP-40": ("fukuoka", "福岡県"),
    "JP-41": ("saga", "佐賀県"), "JP-42": ("nagasaki", "長崎県"),
    "JP-43": ("kumamoto", "熊本県"), "JP-44": ("oita", "大分県"),
    "JP-45": ("miyazaki", "宮崎県"), "JP-46": ("kagoshima", "鹿児島県"),
    "JP-47": ("okinawa", "沖縄県"),
}


def main() -> None:
    args = sys.argv[1:]
    path = str(PBF / "japan-latest.osm.pbf")
    pad = 0.05
    if "--pbf" in args:
        path = args[args.index("--pbf") + 1]
    if "--pad" in args:
        pad = float(args[args.index("--pad") + 1])

    print("pass 1/2: admin_level=4 boundary relations", flush=True)
    members: dict[str, set[int]] = {}
    for r in osmium.FileProcessor(path, osmium.osm.osm_entity_bits.RELATION):
        t = r.tags
        if t.get("boundary") != "administrative" or t.get("admin_level") != "4":
            continue
        code = t.get("ISO3166-2")
        if code not in JP:
            continue
        members.setdefault(code, set()).update(m.ref for m in r.members if m.type == "w")

    missing = set(JP) - set(members)
    if missing:
        raise SystemExit(f"no admin_level=4 boundary for {sorted(missing)}")
    wanted = {w for s in members.values() for w in s}
    print(f"  {len(members)} prefectures, {len(wanted):,} boundary ways", flush=True)

    print("pass 2/2: boundary way extents", flush=True)
    box: dict[int, tuple[float, float, float, float]] = {}
    proc = osmium.FileProcessor(
        path, osmium.osm.osm_entity_bits.NODE | osmium.osm.osm_entity_bits.WAY
    ).with_locations(f"sparse_file_array,{PBF / 'nodes.idx'}")
    for o in proc:
        if o.is_node() or o.id not in wanted:
            continue
        lats = [n.location.lat for n in o.nodes if n.location.valid()]
        lons = [n.location.lon for n in o.nodes if n.location.valid()]
        if lats:
            box[o.id] = (min(lats), min(lons), max(lats), max(lons))

    print("\n# south, west, north, east — measured, padded "
          f"{pad}°\nMEASURED = {{")
    for code in sorted(JP):
        slug, label = JP[code]
        bs = [box[w] for w in members[code] if w in box]
        s = min(b[0] for b in bs) - pad
        w = min(b[1] for b in bs) - pad
        n = max(b[2] for b in bs) + pad
        e = max(b[3] for b in bs) + pad
        span = f"{(n - s):.1f}x{(e - w):.1f}"
        print(f'    "{slug}": {{"label": "{label}", '
              f'"bbox": ({s:.2f}, {w:.2f}, {n:.2f}, {e:.2f})}},'
              f'  # {code} span {span}')
    print("}")


if __name__ == "__main__":
    main()
