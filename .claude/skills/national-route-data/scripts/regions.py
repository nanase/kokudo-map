"""The regions the map can be built for: the 47 prefectures.

Bounding boxes are south, west, north, east. A rectangle cannot follow a
prefecture outline, so neighbouring prefectures spill in; that is a known
limitation, not a defect.

The boxes are measured, not typed. `prefecture_boxes.py` reads the
`admin_level=4` boundary relations out of the same .osm.pbf the roads come from
and pads each extent by 0.05° — enough that a terminus on a prefecture border
clears the 0.02° edge tolerance in build_routes.py and is reported as the real
terminus it is. Forty-seven boxes typed by hand would be forty-seven chances to
leave a strip of the country uncovered with nothing to say so; extract_pbf.py
additionally reports any national-route way that falls outside every box.

Why a prefecture at all, now that acquisition is nationwide: the corroboration
guard in build_routes.py only filters while the set of route numbers it trusts
is small. Over the whole country that set approaches all 459 numbers and stops
filtering, and 長野県道372号 is 国道372号 again. The box is what keeps it sharp.

Three boxes are not the measured ones. Each says why.
"""
from __future__ import annotations

REGIONS: dict[str, dict] = {
    # ---- 北海道・東北 -----------------------------------------------------
    "hokkaido": {"label": "北海道", "bbox": (41.10, 139.02, 45.76, 145.97)},
    "aomori": {"label": "青森県", "bbox": (40.17, 139.18, 41.66, 141.95)},
    "iwate": {"label": "岩手県", "bbox": (38.70, 140.60, 40.61, 142.38)},
    "miyagi": {"label": "宮城県", "bbox": (37.72, 140.22, 39.05, 142.10)},
    "akita": {"label": "秋田県", "bbox": (38.82, 139.29, 40.56, 141.05)},
    "yamagata": {"label": "山形県", "bbox": (37.68, 139.09, 39.64, 140.70)},
    "fukushima": {"label": "福島県", "bbox": (36.69, 139.11, 38.04, 141.49)},
    # ---- 関東 -------------------------------------------------------------
    "ibaraki": {"label": "茨城県", "bbox": (35.69, 139.64, 37.00, 141.08)},
    "tochigi": {"label": "栃木県", "bbox": (36.15, 139.28, 37.21, 140.34)},
    "gunma": {"label": "群馬県", "bbox": (35.94, 138.35, 37.11, 139.72)},
    "saitama": {"label": "埼玉県", "bbox": (35.70, 138.66, 36.33, 139.95)},
    "chiba": {"label": "千葉県", "bbox": (34.57, 139.47, 36.15, 141.17)},
    # 本土だけである。都域は小笠原・南鳥島・沖ノ鳥島に及び、測ると 15.8x18.5 度
    # になる。その矩形は愛知から和歌山までを飲み込むので、東京都の保証集合が
    # 八県ぶんに膨らみ、裏取りが効かなくなる。外した島々に国道は無く、
    # extract_pbf.py の取りこぼし検査がそれを毎回確かめる。
    "tokyo": {"label": "東京都", "bbox": (35.45, 138.87, 35.98, 140.00)},
    "kanagawa": {"label": "神奈川県", "bbox": (34.91, 138.87, 35.72, 139.91)},
    # ---- 中部 -------------------------------------------------------------
    # 測った箱ではなく、Overpass 時代からの箱をそのまま使う。佐渡島と粟島が
    # 入る高さで、南東の角が栃木県と福島県に及ぶ。そこから 121・352・400 号が
    # 入っている。既存の期待値はこの箱の中身に対して確かめてある。
    "niigata": {"label": "新潟県", "bbox": (36.65, 137.55, 38.65, 140.00)},
    "toyama": {"label": "富山県", "bbox": (36.22, 136.72, 37.30, 137.81)},
    "ishikawa": {"label": "石川県", "bbox": (36.02, 136.03, 38.18, 137.92)},
    "fukui": {"label": "福井県", "bbox": (35.29, 135.40, 36.50, 136.88)},
    "yamanashi": {"label": "山梨県", "bbox": (35.12, 138.13, 36.02, 139.18)},
    # 同じく Overpass 時代からの箱。測った箱とは 0.03 度しか違わない。
    "nagano": {"label": "長野県", "bbox": (35.15, 137.30, 37.05, 138.80)},
    "gifu": {"label": "岐阜県", "bbox": (35.08, 136.23, 36.52, 137.70)},
    "shizuoka": {"label": "静岡県", "bbox": (34.32, 137.42, 35.70, 139.47)},
    "aichi": {"label": "愛知県", "bbox": (34.23, 136.62, 35.47, 137.89)},
    # ---- 近畿 -------------------------------------------------------------
    "mie": {"label": "三重県", "bbox": (33.56, 135.80, 35.31, 137.38)},
    "shiga": {"label": "滋賀県", "bbox": (34.74, 135.71, 35.75, 136.51)},
    "kyoto": {"label": "京都府", "bbox": (34.66, 134.80, 36.20, 136.11)},
    "osaka": {"label": "大阪府", "bbox": (34.22, 134.98, 35.10, 135.80)},
    "hyogo": {"label": "兵庫県", "bbox": (33.96, 134.20, 35.92, 135.52)},
    "nara": {"label": "奈良県", "bbox": (33.81, 135.49, 34.83, 136.28)},
    "wakayama": {"label": "和歌山県", "bbox": (33.18, 134.83, 34.44, 136.37)},
    # ---- 中国 -------------------------------------------------------------
    "tottori": {"label": "鳥取県", "bbox": (35.01, 133.09, 35.85, 134.57)},
    "shimane": {"label": "島根県", "bbox": (34.25, 131.41, 36.61, 133.69)},
    "okayama": {"label": "岡山県", "bbox": (34.20, 133.22, 35.40, 134.46)},
    "hiroshima": {"label": "広島県", "bbox": (33.96, 131.99, 35.16, 133.55)},
    "yamaguchi": {"label": "山口県", "bbox": (33.50, 130.35, 35.13, 132.56)},
    # ---- 四国 -------------------------------------------------------------
    "tokushima": {"label": "徳島県", "bbox": (33.28, 133.61, 34.42, 135.04)},
    "kagawa": {"label": "香川県", "bbox": (33.96, 133.31, 34.68, 134.65)},
    "ehime": {"label": "愛媛県", "bbox": (32.74, 131.83, 34.37, 133.74)},
    "kochi": {"label": "高知県", "bbox": (32.33, 132.16, 33.93, 134.59)},
    # ---- 九州・沖縄 -------------------------------------------------------
    "fukuoka": {"label": "福岡県", "bbox": (32.89, 129.76, 34.70, 131.30)},
    "saga": {"label": "佐賀県", "bbox": (32.87, 129.59, 33.75, 130.59)},
    "nagasaki": {"label": "長崎県", "bbox": (31.73, 127.82, 34.94, 130.53)},
    "kumamoto": {"label": "熊本県", "bbox": (31.96, 129.27, 33.25, 131.38)},
    "oita": {"label": "大分県", "bbox": (32.33, 130.77, 33.90, 132.33)},
    "miyazaki": {"label": "宮崎県", "bbox": (31.20, 130.65, 32.89, 132.26)},
    "kagoshima": {"label": "鹿児島県", "bbox": (26.79, 128.16, 32.38, 131.37)},
    "okinawa": {"label": "沖縄県", "bbox": (23.80, 122.66, 28.14, 131.60)},
}


def for_region(region: str) -> dict:
    if region not in REGIONS:
        raise SystemExit(
            f"unknown region {region!r}. Add an entry to regions.py; "
            f"known: {', '.join(REGIONS)}"
        )
    return REGIONS[region]
