"""Distance on the globe, answered once.

Four files here measure how far apart two points are, and they were doing it
with four copies of the same eight lines. compare_n13.py had already noticed
and imported audit.py's copy rather than writing a fifth; this is that same
move, made somewhere that does not also drag in a whole audit run.

Nothing in this module reads a file, takes an argument or prints. It is
arithmetic, so it can be imported from anywhere in the pipeline without
ordering anything.
"""
from __future__ import annotations

import math

# IUGG mean radius. Which radius to use is a real choice — the equatorial and
# polar radii differ by 21 km, about 0.3 % — and the answer has to be the same
# one everywhere, or two files measuring the same road disagree in the fourth
# digit. Stated here so nobody has to decide it again.
EARTH_RADIUS_M = 6371008.8


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Metres between two (lat, lon) pairs."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def line_length(coords: list[tuple[float, float]]) -> float:
    """Metres along a polyline of (lat, lon) pairs."""
    return sum(haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
