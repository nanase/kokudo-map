/* Reading the panel's numbers out of what the build counted.
 *
 * The viewer never holds the arcs — nationwide they are ~130,000 features that
 * arrive as vector tiles — so it cannot count features to fill the panel in.
 * Everything it displays is a sum over `national.meta.json`, and these are the
 * two sums.
 *
 * Kept apart from the panel that shows them so they can be checked directly.
 * What they get right is the whole point of the map, and it is exactly the
 * thing that is easy to get wrong by accident: see test/aggregate.test.mjs.
 */

/**
 * The build ships one table: every distinct *combination* of designations, with
 * its length, arc count and extent. Everything the panel shows is a sum over a
 * subset of its rows.
 *
 * A per-route table would not do. Concurrency means an arc belongs to several
 * routes at once, so adding two route rows counts the shared arcs twice —
 * which is exactly the number the map exists to stop hiding.
 */
export function routesOf(combos) {
  const by = new Map();
  for (const c of combos) {
    for (const ref of c.refs) {
      let e = by.get(ref);
      if (!e) {
        e = { ref, km: 0, arcs: 0, max_n: 1 };
        by.set(ref, e);
      }
      e.km += c.km;
      e.arcs += c.arcs;
      e.max_n = Math.max(e.max_n, c.n);
    }
  }
  const out = [...by.values()].sort((a, b) => a.ref - b.ref);
  for (const e of out) e.km = Math.round(e.km * 10) / 10;
  return out;
}

/** Totals over the combinations a selection touches. An empty selection means
 *  everything, which is what the map is already showing.
 *
 *  Takes the table rather than reading it off the module's state: a sum with
 *  no hidden input can be checked by handing it rows and comparing. */
export function statsFor(combos, selected) {
  let arcs = 0;
  let km = 0;
  let conc = 0;
  for (const c of combos) {
    if (selected.size && !c.refs.some((r) => selected.has(r))) continue;
    arcs += c.arcs;
    km += c.km;
    if (c.n >= 2) conc += c.arcs;
  }
  return { arcs, km, conc };
}
