"""OSM データがどれだけ古いかを、一箇所でだけ数える。

古さは検証を落とす境界ではなく、気付かせるための警告の境界でしかない
(issue #179)。公開されている Overpass のミラーは日常的に遅れ、pbf の取得元も
それに従うので、日数そのものは珍しくも異常でもない。検証で落とすと、ミラーの
都合で生成が止まる。
"""
from __future__ import annotations

from datetime import datetime, timezone

# これを超えて古ければ警告する。検証を落とす閾値ではない。1 か月古くても道路の
# 変化を見落とす実害は測っておらず、7 日はミラーの遅れに対して厳しすぎた。
STALE_AFTER_DAYS = 30


def age_days(timestamp: str) -> float:
    """ISO8601(Z 終端)の時刻から、今までの経過日数。"""
    base = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - base).total_seconds() / 86400
