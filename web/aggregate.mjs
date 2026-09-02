/* 画面が出す数を、ビルドが数えた表から読む。閲覧側はアークを手元に持たない
 * (全国約 13 万件がベクタタイルで届く)ので、画面に出る数はすべて
 * `national.meta.json` の部分和であり、それがここにある。操作面と分けてあるのは
 * 直接検査するためである。ここが出す数はこの地図の存在理由そのもので、
 * 間違えやすい。test/aggregate.test.mjs を参照。
 */

/* 組み合わせ表の km は小数第 1 位まで。足し合わせた浮動小数の尾を、同じ桁で
 * 落とす。 */
const round1 = (km) => Math.round(km * 10) / 10;

/* 選択が問うている行かどうか。選択が空なら全部である。下の合計と一覧はどれも
 * 同じ絞り方をするので、規則はここに一度だけ書く。写しを持つと延長と内訳が
 * 食い違う。 */
const touched = (c, selected) =>
  !selected.size || c.refs.some((r) => selected.has(r));

/* 路線の既定の並べ方。国道は番号そのものが路線のキーなので、数として比べる。 */
const byNumber = (a, b) => a - b;

/**
 * ビルドが配るのは 1 枚の表である。指定の組み合わせごとに 1 行で、延長・アーク
 * 数・広がりを持つ。画面が出すものはその行の部分和である。路線別の表では
 * 足りない。重用区間のアークは複数の路線に属するので、路線の行を足すと
 * 共有部分を二重に数える。数え方は路線の格に依らないので、都道府県道の県別 meta
 * も同じ表である。違うのは路線のキー(国道は番号 `18`、都道府県道は `nagano-18`)
 * だけで、並べ方として受け取る(pipeline/rollup.mjs)。
 */
export function routesOf(combos, compare = byNumber) {
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
  const out = [...by.values()].sort((a, b) => compare(a.ref, b.ref));
  for (const e of out) {
    e.km = round1(e.km);
    e.conc_km = round1(e.conc_km);
  }
  return out;
}

/**
 * その都道府県道 1 本の格(主要地方道か一般都道府県道か)。どの番号が
 * 主要地方道かを持つのは判定(pipeline/build_prefectural.py の `rank_of`)
 * なので、番号から決め直さず、組み合わせ表の `rank` を読む。読めるのはその路線
 * 1 本だけの行に限る。重用の行の `rank` は「重なっている路線のうち一つでも
 * 主要地方道なら major」だからである。1 本だけの行を持たない路線(延長のすべてが
 * 重用)は 13,234 のうち 78 あり、null を返す。
 */
export const prefRankOf = (combos, key) =>
  combos.find((c) => c.n === 1 && c.refs[0] === key)?.rank ?? null;

/** 選択が触れる組み合わせの合計。選択が空なら全部である。表は引数で受け取り、
 * 隠れた入力を持たない。 */
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
 * 選択が問うている重用区間。重用は道の性質なので `n >= 2` はアークに聞き、
 * 選択は並べる区間を絞るだけである。返すのは行だが、同じ規則で表を読むので
 * markup(panel.mjs の rankingHTML)ではなく和の側に置く。
 */
export const concurrencies = (combos, selected) =>
  combos.filter((c) => c.n >= 2 && touched(c, selected));

/**
 * 選択が触れる組み合わせの、区分(`kind`)ごとの距離。km の大きい順。statsFor()
 * と同じく組み合わせ 1 行を高々 1 回だけ足す。路線ごとに足すと重用アークが
 * 指定の数だけ重複する。表が `kinds` を持たない meta では空を返す。web/data は
 * 追跡していないので、古い meta が配信されたまま新しいコードが出ることがある。
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
 * 選択が触れる組み合わせのうち、旧道が占める距離。旧道は区分ではなく、
 * kindsFor() の値に足すと二度数える(#26)ので別の軸として数える。`former_km`
 * を持たない meta では 0 を返す。
 */
export function formerKmFor(combos, selected) {
  let km = 0;
  for (const c of combos) {
    if (!touched(c, selected)) continue;
    km += c.former_km ?? 0;
  }
  return round1(km);
}
