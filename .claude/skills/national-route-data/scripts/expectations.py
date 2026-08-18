"""Per-region facts the build must reproduce.

Kept apart from the checks themselves so that adding a region is a data edit,
not a code edit. Only assert what is independently known to be true — a wrong
expectation is worse than none, because it trains you to ignore failures.

  present   route numbers that certainly run through the region
  absent    routes that certainly do not, with where they actually are. These
            catch numbers leaking in from 都道府県道 or from bad tags.
  kinds     routes that must have arcs of a given kind, e.g. a 点線国道
  named     (way name, route number) pairs that must be present and designated

`present` lists are deliberately short. They are the routes whose 政令 itinerary
names the prefecture outright, not everything the build happens to find. The
boxes are rectangles and spill into neighbours, so what a region contains is
always a superset of what its prefecture does — asserting the superset would
mean asserting the shape of the rectangle, which is not a fact about roads.

`absent` works the other way and has to respect the same spill. 国道12号 is
Hokkaido-only and 国道390号 is Okinawa-only, and no rectangle drawn around any
other prefecture reaches either, so the pair is the standard guard everywhere
else. Both numbers are ones a 都道府県道 somewhere really does carry — 12 was
among the tokens rejected in 長野県 — so they test the corroboration guard and
not just the absence of a road.
"""
from __future__ import annotations

# The two that catch a leak anywhere on Honshu, Shikoku or Kyushu.
FAR = [(12, "北海道"), (390, "沖縄"), (58, "鹿児島〜沖縄")]

EXPECTATIONS: dict[str, dict] = {
    # ---- 北海道・東北 -----------------------------------------------------
    "hokkaido": {
        "present": [5, 12, 36, 37, 38, 39, 40, 44, 230, 231, 232, 236, 237,
                    238, 239, 240, 241, 242, 243, 244],
        "absent": [(1, "東京〜大阪"), (390, "沖縄"), (58, "鹿児島〜沖縄")],
        # 274 号は `description=国道274号不通区間` の 16.1 km を未開通で持つ。
        "kinds": {274: ["unopened"]}, "named": [],
    },
    "aomori": {
        "present": [4, 7, 45, 101, 102, 103, 104, 279, 338, 339, 340],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "iwate": {
        "present": [4, 45, 46, 106, 107, 281, 282, 283, 284, 340, 343, 396,
                    397, 455],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "miyagi": {
        "present": [4, 6, 45, 47, 48, 108, 113, 346, 347, 398, 457],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "akita": {
        "present": [7, 13, 46, 101, 103, 105, 107, 108, 285, 341, 342, 398],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "yamagata": {
        "present": [7, 13, 47, 48, 112, 113, 121, 287, 344, 345, 347, 348, 458],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "fukushima": {
        "present": [4, 6, 13, 49, 113, 114, 115, 118, 121, 252, 288, 289, 294,
                    349, 352, 399, 400, 401, 459],
        "absent": FAR, "kinds": {}, "named": [],
    },
    # ---- 関東 -------------------------------------------------------------
    "ibaraki": {
        "present": [6, 50, 51, 118, 123, 124, 125, 245, 293, 294, 349, 354,
                    355, 408, 461],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "tochigi": {
        "present": [4, 50, 119, 120, 121, 122, 123, 293, 294, 352, 400, 408, 461],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "gunma": {
        "present": [17, 18, 50, 120, 122, 145, 291, 292, 293, 353, 354, 405,
                    406, 462],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "saitama": {
        "present": [4, 16, 17, 122, 125, 140, 254, 298, 299, 407, 463],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "chiba": {
        "present": [6, 14, 16, 51, 126, 127, 128, 296, 297, 356, 357, 409,
                    410, 464, 465],
        "absent": FAR,
        # 16 号は富津から横須賀まで東京湾を渡る。海上区間と述べているのは
        # `description` だけで、名称は 国道16号 のままである。
        "kinds": {16: ["ferry"]},
        "named": [],
    },
    "tokyo": {
        "present": [1, 4, 6, 14, 15, 16, 17, 20, 122, 246, 254, 298, 357,
                    409, 411, 466],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "kanagawa": {
        "present": [1, 15, 16, 129, 133, 134, 138, 246, 271, 357, 409, 412,
                    413, 466, 467],
        "absent": FAR,
        # 357号は 7.0 km の未開通区間を持つ。
        "kinds": {357: ["unopened"]}, "named": [],
    },
    # ---- 中部 -------------------------------------------------------------
    # 佐渡島 と 粟島 が入る高さにしてある。南東の角で栃木県と福島県に及び、
    # そこから 121・352・400 号が入る。
    "niigata": {
        "present": [7, 8, 17, 18, 49, 113, 116, 117, 252, 253, 289, 290, 291,
                    292, 350, 351, 352, 402, 403, 459],
        "absent": [(2, "大阪〜北九州"), (42, "浜松〜和歌山"), (368, "三重"), *FAR],
        "kinds": {
            # 清水峠が点線国道
            291: ["foot"],
            # 350号は佐渡を経由する海上国道
            350: ["ferry"],
            # 353号は 7.2 km の未開通区間を持つ
            353: ["unopened"],
        },
        "named": [],
    },
    "toyama": {
        "present": [8, 41, 156, 160, 359, 360, 415, 471, 472],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "ishikawa": {
        "present": [8, 157, 159, 160, 249, 304, 305, 359, 360, 415, 416, 471],
        "absent": FAR,
        # 360号は白山白川郷ホワイトロードが代替路の 16.4 km を未開通で持つ。
        "kinds": {360: ["unopened"]}, "named": [],
    },
    "fukui": {
        "present": [8, 27, 158, 161, 162, 305, 364, 365, 416, 417, 476],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "yamanashi": {
        "present": [20, 52, 137, 138, 139, 140, 141, 300, 358, 411, 413],
        # 368 は way/263470309 の official_name のタイポで一度ここに出た番号。
        "absent": [(368, "三重"), *FAR],
        "kinds": {}, "named": [],
    },
    "nagano": {
        "present": [18, 19, 20, 117, 141, 142, 143, 144, 148, 151, 152, 153,
                    158, 254, 256, 292, 299, 361, 403, 405, 406, 418, 474],
        "absent": [
            (372, "京都〜兵庫"),   # 長野県道372号が混入した実例
            (368, "三重"),         # official_name のタイポを拾った実例
            (4, "東京〜青森"),
            (2, "大阪〜北九州"),
            *FAR,
        ],
        "kinds": {
            # 地蔵峠が点線国道、青崩峠が工事中
            152: ["foot", "construction"],
        },
        "named": [("長野南バイパス", 19)],
    },
    "gifu": {
        "present": [19, 21, 22, 41, 156, 157, 158, 248, 256, 257, 258, 303,
                    360, 361, 363, 365, 417, 418, 419],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "shizuoka": {
        "present": [1, 52, 135, 136, 138, 139, 149, 150, 151, 152, 246, 257,
                    301, 362, 414, 473, 474],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "aichi": {
        "present": [1, 19, 22, 23, 41, 151, 153, 155, 247, 248, 257, 259, 301,
                    302, 362, 363, 419, 420, 473, 474, 475],
        "absent": FAR,
        # 伊良湖から鳥羽まで、42 号と 259 号が重用のまま伊勢湾を渡る。
        "kinds": {42: ["ferry"], 259: ["ferry"]},
        "named": [],
    },
    # ---- 近畿 -------------------------------------------------------------
    "mie": {
        "present": [1, 23, 25, 42, 163, 165, 166, 167, 258, 259, 260, 306,
                    368, 369, 421, 422, 477],
        "absent": FAR,
        # 1号は北勢バイパスに 8.2 km x2 の未開通区間を持つ。
        "kinds": {1: ["unopened"]}, "named": [],
    },
    "shiga": {
        "present": [1, 8, 21, 161, 303, 306, 307, 365, 367, 421, 422, 477],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "kyoto": {
        "present": [1, 9, 24, 27, 162, 173, 175, 176, 177, 178, 307, 312, 367,
                    372, 423, 426, 427, 477, 478],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "osaka": {
        # 425 号は御坊から尾鷲で、大阪府は通らない。
        "present": [1, 2, 25, 26, 43, 163, 165, 166, 168, 170, 171, 173, 176,
                    307, 308, 309, 310, 371, 423, 424, 479],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "hyogo": {
        # 478 号は京都縦貫自動車道で、京都府に閉じている。
        "present": [2, 9, 28, 29, 43, 175, 176, 178, 179, 250, 312, 372, 373,
                    427, 428, 429, 436, 477, 483],
        "absent": FAR,
        # 28 号は明石から岩屋まで明石海峡を渡る。
        "kinds": {28: ["ferry"]},
        # 第二神明道路・神戸淡路鳴門自動車道はどちらも国道リレーションのメンバーで
        # なく、`ref` が `E93;2` のように高速道路番号と同居していたため候補判定
        # から丸ごと落ちていた（CASES.md 15）。
        "named": [("第二神明道路", 2), ("神戸淡路鳴門自動車道", 28)],
    },
    "nara": {
        "present": [24, 25, 163, 165, 166, 168, 169, 308, 309, 310, 369, 370],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "wakayama": {
        "present": [24, 26, 42, 168, 169, 311, 370, 371, 424, 425, 480],
        "absent": FAR, "kinds": {}, "named": [],
    },
    # ---- 中国 -------------------------------------------------------------
    "tottori": {
        "present": [9, 29, 53, 178, 179, 180, 181, 182, 183, 313, 373, 482],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "shimane": {
        "present": [9, 54, 180, 184, 185, 186, 187, 191, 261, 314, 375, 432,
                    485, 488],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "okayama": {
        "present": [2, 30, 53, 179, 180, 181, 182, 313, 373, 374, 429, 430,
                    484, 486],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "hiroshima": {
        "present": [2, 31, 54, 183, 184, 185, 186, 187, 261, 314, 375, 432,
                    433, 434, 486, 487],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "yamaguchi": {
        "present": [2, 9, 188, 189, 190, 191, 262, 315, 316, 376, 434, 435,
                    437, 490, 491],
        "absent": FAR, "kinds": {}, "named": [],
    },
    # ---- 四国 -------------------------------------------------------------
    "tokushima": {
        "present": [11, 28, 32, 55, 192, 193, 195, 318, 319, 377, 438, 439,
                    492, 493],
        "absent": FAR,
        "kinds": {},
        # 兵庫県と同じ理由で候補判定から落ちていた（CASES.md 15）。
        "named": [("神戸淡路鳴門自動車道", 28)],
    },
    "kagawa": {
        "present": [11, 30, 32, 192, 193, 319, 377, 436, 438],
        "absent": [(1, "東京〜大阪"), *FAR],
        # 30 号は高松から宇野まで備讃瀬戸を渡る。
        "kinds": {30: ["ferry"]},
        "named": [],
    },
    "ehime": {
        "present": [11, 33, 56, 194, 196, 197, 317, 320, 378, 379, 380, 437,
                    440, 441, 494],
        "absent": FAR,
        # 317 号は今治から芸予諸島を経て尾道へ渡る。海上区間が 6 本ある。
        "kinds": {317: ["ferry"]},
        "named": [],
    },
    "kochi": {
        "present": [32, 33, 55, 56, 194, 195, 197, 320, 321, 380, 381, 439,
                    441, 493, 494],
        "absent": FAR, "kinds": {}, "named": [],
    },
    # ---- 九州・沖縄 -------------------------------------------------------
    "fukuoka": {
        "present": [2, 3, 10, 199, 200, 201, 202, 208, 209, 210, 211, 322,
                    385, 386, 442, 495, 496, 497, 500, 501],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "saga": {
        "present": [34, 35, 202, 203, 204, 207, 208, 263, 264, 323, 385, 444,
                    498, 500],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "nagasaki": {
        "present": [34, 35, 202, 204, 205, 206, 207, 251, 324, 382, 383, 384, 499],
        "absent": FAR, "kinds": {}, "named": [],
    },
    "kumamoto": {
        # 502 号は臼杵から豊後大野で、大分県に閉じている。
        "present": [3, 57, 208, 209, 218, 219, 265, 266, 267, 268, 325, 387,
                    388, 389, 443, 445, 501],
        "absent": FAR,
        # 57 号と 324 号は三角から島原まで有明海を渡る。26 km と 22 km の直線で、
        # 名称に海上区間と書いていないので実線のまま海の上に出ていた。
        "kinds": {57: ["ferry"], 324: ["ferry"]},
        "named": [],
    },
    "oita": {
        # 389 号は大牟田から長島で、大分県は通らない。
        "present": [10, 57, 210, 211, 212, 213, 217, 326, 387, 388, 442,
                    496, 502],
        "absent": FAR, "kinds": {}, "named": [],
    },
    # 58 号の海上区間は鹿児島市から種子島へ渡り、宮崎県の矩形を海の上で横切る。
    # way/561255584 の 1 本だけである。食み出しであって漏れではない。
    "miyazaki": {
        "present": [10, 218, 219, 220, 221, 222, 223, 265, 268, 269, 327, 388,
                    446, 448, 503],
        "absent": [(12, "北海道"), (390, "沖縄"), (1, "東京〜大阪")],
        "kinds": {}, "named": [],
    },
    # 58号の起点は鹿児島市である。種子島と奄美を経て沖縄へ渡るので、ここでは
    # 「遠くにある番号」として使えない。
    "kagoshima": {
        "present": [3, 10, 58, 220, 223, 224, 225, 226, 267, 268, 269, 270,
                    328, 389, 447, 448, 504],
        "absent": [(12, "北海道"), (390, "沖縄"), (1, "東京〜大阪")],
        "kinds": {
            # 58 号は鹿児島市から種子島・奄美を経て沖縄へ渡る海上国道
            58: ["ferry"],
            # 224 号は錦江湾を渡って桜島へ
            224: ["ferry"],
        },
        "named": [],
    },
    "okinawa": {
        "present": [58, 329, 330, 331, 332, 390, 449, 505, 506, 507],
        "absent": [(12, "北海道"), (1, "東京〜大阪"), (4, "東京〜青森")],
        "kinds": {
            # 390 号は那覇から宮古・石垣までが海上国道
            390: ["ferry"],
        },
        "named": [],
    },
}


# Where a route may be, as south, west, north, east. Checked against the merged
# nationwide data by verify_national.py, which is the only place the question
# "did a number leak into the wrong end of the country?" can be asked at all:
# every per-region check sees one rectangle and cannot tell.
#
# These are the itineraries, padded generously. A box here says "nowhere else",
# not "exactly here" — it is a leak detector, not a description of the road.
ROUTE_EXTENTS: dict[int, tuple[tuple[float, float, float, float], str]] = {
    2: ((33.2, 130.5, 35.1, 135.9), "大阪〜北九州"),
    4: ((35.3, 139.4, 41.1, 141.7), "東京〜青森"),
    12: ((42.7, 141.0, 44.1, 142.7), "札幌〜旭川"),
    58: ((25.7, 127.3, 32.1, 131.3), "鹿児島〜那覇"),
    # CASES.md 1: 長野県道372号 の ref を国道として拾った実例。
    372: ((34.4, 134.3, 35.3, 136.0), "京都〜姫路"),
    # CASES.md 2: official_name のタイポで山梨に出た実例。
    368: ((34.1, 135.7, 35.2, 136.9), "松阪〜伊賀"),
    390: ((23.9, 123.8, 26.6, 128.1), "石垣〜那覇"),
}


def for_region(region: str) -> dict:
    if region not in EXPECTATIONS:
        raise SystemExit(
            f"no expectations for region {region!r}. Add an entry to "
            f"expectations.py; known: {', '.join(EXPECTATIONS)}"
        )
    return EXPECTATIONS[region]
