/* Reading the panel's numbers out of what the build counted.
 *
 * The viewer never holds the arcs — nationwide they are ~130,000 features that
 * arrive as vector tiles — so it cannot count features to fill the panel in.
 * Everything it displays is a sum over `national.meta.json`, and these are
 * those sums.
 *
 * Kept apart from the panel that shows them so they can be checked directly.
 * What they get right is the whole point of the map, and it is exactly the
 * thing that is easy to get wrong by accident: see test/aggregate.test.mjs.
 */

/* 組み合わせ表の km は小数第 1 位まで。足し合わせた浮動小数の尾を、同じ
 * 桁で落とす。 */
const round1 = (km) => Math.round(km * 10) / 10;

/* 選択が問うている行かどうか。選択が空なら全部——それが地図の見せている
 * ものである。下の合計と一覧はどれも同じ絞り方をするので、規則はここに
 * 一度だけ書く。写しを持つと、延長と内訳が別の道の話を始める。 */
const touched = (c, selected) =>
  !selected.size || c.refs.some((r) => selected.has(r));

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
        e = { ref, km: 0, arcs: 0, conc_km: 0, max_n: 1 };
        by.set(ref, e);
      }
      e.km += c.km;
      e.arcs += c.arcs;
      // 重用かどうかは道の性質なので、行の n に聞く。選んだ路線の数ではない。
      if (c.n >= 2) e.conc_km += c.km;
      e.max_n = Math.max(e.max_n, c.n);
    }
  }
  const out = [...by.values()].sort((a, b) => a.ref - b.ref);
  for (const e of out) {
    e.km = round1(e.km);
    e.conc_km = round1(e.conc_km);
  }
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
    if (!touched(c, selected)) continue;
    arcs += c.arcs;
    km += c.km;
    if (c.n >= 2) conc += c.arcs;
  }
  return { arcs, km, conc };
}

/**
 * The concurrent sections a selection is asking about.
 *
 * Concurrency is a property of the road, so `n >= 2` is asked of the arc and
 * not of the selection; the selection only narrows which of those sections are
 * listed. An empty selection lists them all — the same reading of an empty
 * selection the three sums above take, because it is the same `touched`.
 *
 * A row, not a number, but it is still a read of the combination table under
 * the same rule, so it belongs beside the sums rather than beside the markup
 * that lays it out (panel.mjs's rankingHTML).
 */
export const concurrencies = (combos, selected) =>
  combos.filter((c) => c.n >= 2 && touched(c, selected));

/**
 * 選択が触れる組み合わせの、区分(`kind`)ごとの距離。km の大きい順。
 *
 * statsFor() と同じ読み方——組み合わせ 1 行を高々 1 回だけ足す——をする。路線ご
 * とに足すと、重用しているアークがその指定の数だけ重複して数えられる。
 *
 * 組み合わせ表が `kinds` を持たない meta では空を返す。web/data は追跡していな
 * いので、古い meta が配信されたまま新しいコードが出ることがある。欄が無けれ
 * ば内訳は空、が正しい振る舞いである。
 */
export function kindsFor(combos, selected) {
  const by = new Map();
  for (const c of combos) {
    if (!touched(c, selected)) continue;
    for (const [kind, km] of Object.entries(c.kinds ?? {})) {
      by.set(kind, (by.get(kind) ?? 0) + km);
    }
  }
  return [...by]
    .map(([kind, km]) => ({ kind, km: round1(km) }))
    .sort((a, b) => b.km - a.km);
}

/**
 * 選択が触れる組み合わせのうち、旧道が占める距離。
 *
 * 旧道は区分ではない。旧道もどれかの区分の道なので、kindsFor() の値に足すと
 * その道を二度数える(#26)。別の軸として別に数える。
 *
 * `former_km` を持たない meta では 0 を返す。kindsFor() が空を返すのと同じ
 * 理由である。
 */
export function formerKmFor(combos, selected) {
  let km = 0;
  for (const c of combos) {
    if (!touched(c, selected)) continue;
    km += c.former_km ?? 0;
  }
  return round1(km);
}
