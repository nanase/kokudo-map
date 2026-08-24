# /// script
# requires-python = ">=3.12"
# dependencies = ["requests", "pyshp"]
# ///
"""Write N13's mechanical 指定解除 confirmation into build/regions/<region>.geojson
as the `revoked` property — issue #9's decision on the former 孤立候補 triage.

compare_n13.py's own CLI stays read-only; it only ever prints a report. This
script is the one place that turns compare_n13.region_former_clusters()'s
`confirmed` verdict into build data, via the exact same clustering function
the report uses (see that function's docstring) — so what a human reads in
`mise run compare-n13` and what a build actually writes never drift apart.

`revoked` is independent of `former` (RULES.md 旧道), not a replacement for
it: a former arc keeps former=1 regardless of what N13 says, because the
legal designation can lag OSM's own tagging by years. Only former arcs in the
low-coverage candidate set compare_n13.py already triages are checked against
N13 at all; every other arc — former or not — keeps the revoked=0 default
build_routes.py already writes. revoked=0 therefore means "not confirmed",
not "confirmed still current".

Usage:  uv run pipeline/apply_n13.py <region> [--refresh]
"""
from __future__ import annotations

import json
import sys

from _paths import REGIONS as DATA
from compare_n13 import region_former_clusters


def main() -> None:
    # Windows terminals default stdout to cp932 — see compare_n13.main().
    sys.stdout.reconfigure(errors="replace")
    args = [a for a in sys.argv[1:] if a != "--refresh"]
    refresh = "--refresh" in sys.argv[1:]
    region = args[0] if args else "nagano"

    gj_path = DATA / f"{region}.geojson"
    meta_path = DATA / f"{region}.meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    gj = json.loads(gj_path.read_text(encoding="utf-8"))

    # Reset first: this script is meant to run right after build_routes.py,
    # which already writes revoked=0 fresh on every arc, but it is also run
    # standalone during triage (mise run apply-n13). Without this reset, a
    # second standalone run over a geojson that already has revoked=1 from a
    # prior run would only ever add confirmations, never retract one for an
    # arc that dropped out of the candidate set (CodeRabbit review on this
    # PR) — this loop is what makes every run start from the same baseline
    # regardless of what called it.
    for f in gj["features"]:
        f["properties"]["revoked"] = 0

    # No former arcs at all (e.g. a region with none) means nothing to check
    # against N13 — skip the mesh fetch entirely rather than downloading data
    # this region has no use for. Still write back the reset above, so a
    # region that used to have former arcs and no longer does loses any
    # stale revoked=1 too.
    if not any(f["properties"].get("former") for f in gj["features"]):
        print(f"{region}: no former arcs, nothing to confirm against N13")
        gj_path.write_text(
            json.dumps(gj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        meta["revoked_arcs"] = 0
        meta_path.write_text(
            json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        return

    clusters, former_count = region_former_clusters(meta, gj, refresh)
    confirmed = {m["id"] for c in clusters if c["confirmed"] for m in c["members"]}

    touched = 0
    for f in gj["features"]:
        if f["properties"]["id"] in confirmed:
            f["properties"]["revoked"] = 1
            touched += 1
    gj_path.write_text(
        json.dumps(gj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    meta["revoked_arcs"] = touched
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    print(f"{region}: {touched}/{former_count} former arc(s) confirmed 指定解除 by N13 "
          f"(revoked=1 written to {gj_path.name})")


if __name__ == "__main__":
    main()
