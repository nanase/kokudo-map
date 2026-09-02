# /// script
# requires-python = ">=3.12"
# dependencies = ["osmium>=4.0"]
# ///
""".osm.pbf から都道府県ごとの bbox を測り、regions.py の表を出力する。

47 個の bbox を手で打つことは、国土のどこかに覆われない帯を残す機会が 47 回ある
ということで、しかも後段の誰もそれを言わない。ここで出す bbox は、道と同じ
ファイルにある `admin_level=4` の境界リレーションから作るので、bbox と道が食い
違いようがない。

名前は測らない。同一性を決めるのは ISO 3166-2:JP の符号で、符号ごとの slug と
日本語ラベルは決まっている。それは regions.py が持っているので、ここは読むだけで
あり、ファイルの中身と突き合わせる。

使い方:  uv run pipeline/prefecture_boxes.py [--pbf path] [--pad 0.05]
"""
from __future__ import annotations

import sys

import osmium

from _paths import PBF
from regions import PREF_CODE, REGIONS

# ISO 3166-2:JP -> (slug, 日本語ラベル)。符号と slug の対応は regions.py が
# 持ち、ラベルも同じ表にある。ここで打ち直せば、片方が暗黙のうちに古くなる。
# ファイルが与えるのは形だけである。
JP = {
    f"JP-{code}": (slug, REGIONS[slug]["label"])
    for code, slug in PREF_CODE.items()
}


def main() -> None:
    args = sys.argv[1:]
    path = str(PBF / "japan-latest.osm.pbf")
    pad = 0.05
    if "--pbf" in args:
        i = args.index("--pbf")
        if i + 1 >= len(args) or args[i + 1].startswith("--"):
            raise SystemExit("--pbf needs a value")
        path = args[i + 1]
    if "--pad" in args:
        i = args.index("--pad")
        if i + 1 >= len(args) or args[i + 1].startswith("--"):
            raise SystemExit("--pad needs a value")
        pad = float(args[i + 1])

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
