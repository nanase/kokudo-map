"""Per-region facts the build must reproduce.

Kept apart from the checks themselves so that adding a region is a data edit,
not a code edit. Only assert what is independently known to be true — a wrong
expectation is worse than none, because it trains you to ignore failures.

  present   route numbers that certainly run through the region
  absent    routes that certainly do not, with where they actually are. These
            catch numbers leaking in from 都道府県道 or from bad tags.
  kinds     routes that must have arcs of a given kind, e.g. a 点線国道
  named     (way name, route number) pairs that must be present and designated
"""
from __future__ import annotations

EXPECTATIONS: dict[str, dict] = {
    "nagano": {
        "present": [18, 19, 20, 117, 141, 142, 143, 144, 148, 151, 152, 153, 158,
                    254, 256, 292, 299, 361, 403, 405, 406, 418, 474],
        "absent": [
            (372, "京都〜兵庫"),   # 長野県道372号が混入した実例
            (368, "三重"),         # official_name のタイポを拾った実例
            (4, "東京〜青森"),
            (2, "大阪〜北九州"),
            (58, "沖縄"),
        ],
        "kinds": {
            # 地蔵峠が点線国道、青崩峠が工事中
            152: ["foot", "construction"],
        },
        "named": [("長野南バイパス", 19)],
    },
    "niigata": {
        "present": [7, 8, 17, 18, 49, 113, 116, 117, 252, 253, 289, 290, 291,
                    292, 350, 351, 352, 402, 403, 459],
        "absent": [
            (2, "大阪〜北九州"),
            (42, "浜松〜和歌山"),
            (58, "沖縄"),
            (368, "三重"),
        ],
        "kinds": {
            # 清水峠が点線国道
            291: ["foot"],
            # 350号は佐渡を経由する海上国道
            350: ["ferry"],
        },
        "named": [],
    },
    "kagawa": {
        "present": [11, 30, 32, 33, 192, 193, 319, 377, 436, 438],
        "absent": [(1, "東京〜大阪"), (58, "沖縄")],
        "kinds": {},
        "named": [],
    },
}


def for_region(region: str) -> dict:
    if region not in EXPECTATIONS:
        raise SystemExit(
            f"no expectations for region {region!r}. Add an entry to "
            f"expectations.py; known: {', '.join(EXPECTATIONS)}"
        )
    return EXPECTATIONS[region]
