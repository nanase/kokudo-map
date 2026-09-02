/* 画面が出す数を、ビルドが数えた表から読む。
 *
 * 閲覧側はアークを手元に持たない——全国で約 13 万件がベクタタイルとして届く
 * ——ので、特徴量を数えて操作面を埋めることはできない。画面に出る数はすべて
 * `national.meta.json` の部分和であり、その部分和がここにある。
 *
 * 出す側の操作面と分けてあるのは、直接検査できるようにするためである。ここが
 * 正しく出す数はこの地図の存在理由そのもので、しかも不用意に間違えやすい。
 * test/aggregate.test.mjs を参照。
 */

/* 組み合わせ表の km は小数第 1 位まで。足し合わせた浮動小数の尾を、同じ
 * 桁で落とす。 */
const round1 = (km) => Math.round(km * 10) / 10;

/* 選択が問うている行かどうか。選択が空なら全部——それが地図の見せている
 * ものである。下の合計と一覧はどれも同じ絞り方をするので、規則はここに
 * 一度だけ書く。写しを持つと、延長と内訳が別の道の話を始める。 */
const touched = (c, selected) =>
  !selected.size || c.refs.some((r) => selected.has(r));

/* 路線の既定の並べ方。国道は番号そのものが路線の鍵なので、数として比べる。 */
const byNumber = (a, b) => a - b;

/**
 * ビルドが配るのは 1 枚の表である。指定の組み合わせごとに 1 行で、延長・
 * アーク数・広がりを持つ。画面が出すものは、どれもその行の部分和である。
 *
 * 路線別の表では足りない。重用区間のアークは複数の路線に同時に属するので、
 * 路線の行を足すと共有部分を二重に数える——それは地図が隠すのをやめさせたい
 * 数そのものである。
 *
 * 数え方は路線の格に依らないので、都道府県道の県別 meta も同じ表である。違うのは
 * 路線の鍵だけで——国道は番号 `18`、都道府県道は県を貼り付けた `nagano-18`——
 * それは並べ方として受け取る(pipeline/rollup.mjs が同じ形で書いている)。
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
 * その都道府県道 1 本の格。主要地方道か一般都道府県道かである。
 *
 * どの番号が主要地方道かを持っているのは判定(pipeline/build_prefectural.py の
 * `rank_of`)なので、番号から決め直さない。読むのは組み合わせ表の `rank` だが、
 * 読めるのはその路線 1 本だけの行に限る——重用の行の `rank` は「重なっている路線のうち
 * 一つでも主要地方道なら major」なので、一般都道府県道が主要地方道と重用して
 * いる行にも major と書いてある。
 *
 * 1 本だけの行を持たない路線——延長のすべてが重用である路線——は 13,234 のうち
 * 78 ある。その 78 では null を返す。欄が無ければその欄ごと出さないのは、詳細
 * パネルの他の欄と同じ扱いである。
 */
export const prefRankOf = (combos, key) =>
  combos.find((c) => c.n === 1 && c.refs[0] === key)?.rank ?? null;

/** 選択が触れる組み合わせの合計。選択が空なら全部で、それが地図の見せている
 *  ものである。
 *
 *  表はモジュールの状態から読まず、引数で受け取る。隠れた入力を持たない和は、
 *  行を渡して突き合わせるだけで検査できる。 */
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
 * 選択が問うている重用区間。
 *
 * 重用は道の性質なので、`n >= 2` はアークに聞くのであって選択に聞くのでは
 * ない。選択は並べる区間を絞るだけである。選択が空なら全部を並べる——上の
 * 三つの和と同じ読み方で、同じ `touched` を使っているためである。
 *
 * 返すのは数ではなく行だが、同じ規則で組み合わせ表を読むことに変わりはない。
 * だから、並べ方を組み立てる markup(panel.mjs の rankingHTML)の側ではなく、
 * 和の側に置く。
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
