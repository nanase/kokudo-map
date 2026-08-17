"""The regions the map can be built for.

Bounding boxes are south, west, north, east, padded slightly so routes are not
clipped mid-corridor. A rectangle cannot follow a prefecture outline, so
neighbouring prefectures spill in; that is a known limitation, not a defect.

Kept apart from both the fetch and the build so the label and the box are
defined once. The label is a property of the region, not of the fetched data.
"""
from __future__ import annotations

REGIONS: dict[str, dict] = {
    "nagano": {"label": "長野県", "bbox": (35.15, 137.30, 37.05, 138.80)},
    # Tall enough to include 佐渡島 and 粟島. Spills into 栃木県 and 福島県 at the
    # south-east corner, which is where 121・352 号 and 400 号 come from.
    "niigata": {"label": "新潟県", "bbox": (36.65, 137.55, 38.65, 140.00)},
    "kagawa": {"label": "香川県", "bbox": (34.00, 133.45, 34.60, 134.45)},
}


def for_region(region: str) -> dict:
    if region not in REGIONS:
        raise SystemExit(
            f"unknown region {region!r}. Add an entry to regions.py; "
            f"known: {', '.join(REGIONS)}"
        )
    return REGIONS[region]
