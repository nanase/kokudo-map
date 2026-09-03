/* 画面が出す数。この地図が存在する理由そのものの計算です。ふつうの地図は「国道
 * 18 号は何 km か」に自分が描いた道を足して答えますが、丸めて捨てた番号は既に
 * 落ちています。路線別の合計表は路線を足すので、重用区間のアークをその指定の
 * 数だけ数えます。どちらも同じ向きに間違っており、もっともらしく見えます。
 *
 * だから行は指定の組み合わせごとに持ち、`routesOf` は組み合わせをその
 * 路線それぞれへ開き、`statsFor` は組み合わせを高々 1 回だけ足します。この
 * 二つの取り違えが、このファイルが捕まえる不具合です。旧道はもう一つの軸で、
 * 区分ではないので `formerKmFor` の値を `kindsFor` の合計に足すと二度数えます。
 */
import { describe, expect, test } from 'bun:test';

import {
  concurrencies,
  formerKmFor,
  kindsFor,
  prefRankOf,
  routesOf,
  statsFor,
} from '../web/aggregate.mjs';
import { comparePrefKeys } from '../web/prefroute.mjs';

const row = (refs, km, arcs) => ({ refs, n: refs.length, km, arcs });

/* 栗ノ木バイパスまわりを縮めたもの。7 号と 8 号は単独区間も持ち、
 * 4 km だけ 6 路線で重なる。 */
const COMBOS = [
  row([7], 100, 1000),
  row([8], 200, 2000),
  row([17], 300, 3000),
  row([7, 8], 10, 100),
  row([7, 8, 17, 49, 403, 459], 4, 40),
];

describe('routesOf', () => {
  const routes = routesOf(COMBOS);
  const by = (ref) => routes.find((r) => r.ref === ref);

  test('番号順に並び、出てくる番号を漏らさない', () => {
    expect(routes.map((r) => r.ref)).toEqual([7, 8, 17, 49, 403, 459]);
  });

  test('1 路線の延長は、その番号を含む組み合わせすべての和である', () => {
    // 7 号は単独 100 km、8 号との重用 10 km、6 重用 4 km を通ります。
    expect(by(7).km).toBe(114);
    expect(by(7).arcs).toBe(1140);
    // 459 号は 6 重用の 4 km にしか出てきません。
    expect(by(459).km).toBe(4);
    expect(by(459).arcs).toBe(40);
  });

  test('max_n はその路線が到達する最も深い重用である', () => {
    expect(by(7).max_n).toBe(6);
    expect(by(17).max_n).toBe(6);
    expect(by(459).max_n).toBe(6);
  });

  test('max_n は行の並び順に影響されない', () => {
    // 最も深い重用が表の最後にあるとは限りません。`Math.max` を単なる代入に
    // すると、この並びでだけ 1 に潰れます。
    const deepFirst = [row([7, 8, 17], 1, 10), row([7], 100, 1000)];
    expect(routesOf(deepFirst).find((r) => r.ref === 7).max_n).toBe(3);
  });

  test('単独指定しか持たない路線の max_n は 1 である', () => {
    expect(routesOf([row([2], 50, 500)])[0].max_n).toBe(1);
  });

  test('路線の延長を足すと、重用のぶんだけ重複排除の延長を超える', () => {
    // これが路線別の表で全体を語れない理由です。重複排除の延長は 614 km しか
    // ありません。「実延長」とは呼びません。道路統計年報の同名の値は、未供用も
    // 海上も含まない別物です。docs/results.md の検算の節を参照してください。
    const sumOfRoutes = routes.reduce((a, r) => a + r.km, 0);
    const actual = COMBOS.reduce((a, c) => a + c.km, 0);
    expect(actual).toBe(614);
    expect(sumOfRoutes).toBe(644);
    expect(sumOfRoutes).toBeGreaterThan(actual);
  });

  test('組み合わせが無ければ路線も無い', () => {
    expect(routesOf([])).toEqual([]);
  });

  test('conc_km はその路線が重用で通る距離である', () => {
    // 7 号は 8 号との 10 km と 6 重用の 4 km を重用で通ります。単独の 100 km
    // は入りません。
    expect(by(7).conc_km).toBe(14);
    // 17 号は 6 重用の 4 km だけが重用です。
    expect(by(17).conc_km).toBe(4);
  });

  test('重用を持たない路線の conc_km は 0 である', () => {
    expect(routesOf([row([2], 50, 500)])[0].conc_km).toBe(0);
  });

  test('conc_km は延長を超えない', () => {
    for (const r of routes) expect(r.conc_km).toBeLessThanOrEqual(r.km);
  });
});

describe('statsFor', () => {
  test('選択が空なら全部を数える', () => {
    expect(statsFor(COMBOS, new Set())).toEqual({
      arcs: 6140,
      km: 614,
      conc: 140,
    });
  });

  test('選択した路線を含む組み合わせだけを数える', () => {
    // 459 号は 6 重用の行にしか居ないので、その 1 行だけが残ります。
    expect(statsFor(COMBOS, new Set([459]))).toEqual({
      arcs: 40,
      km: 4,
      conc: 40,
    });
  });

  test('重なる区間を二重に数えない', () => {
    // 7 号と 8 号を両方選んでも、共有する 2 行はそれぞれ 1 回だけ入ります。
    const both = statsFor(COMBOS, new Set([7, 8]));
    const seven = statsFor(COMBOS, new Set([7]));
    const eight = statsFor(COMBOS, new Set([8]));
    expect(both.km).toBe(314);
    expect(seven.km + eight.km).toBe(328); // 素朴に足すとこうなる
    expect(both.km).toBeLessThan(seven.km + eight.km);
  });

  test('conc は 2 重用以上のアークだけを数える', () => {
    const all = statsFor(COMBOS, new Set());
    const singles = COMBOS.filter((c) => c.n === 1).reduce(
      (a, c) => a + c.arcs,
      0,
    );
    expect(all.conc).toBe(all.arcs - singles);
  });

  test('どの組み合わせにも居ない番号を選ぶと空になる', () => {
    expect(statsFor(COMBOS, new Set([999]))).toEqual({
      arcs: 0,
      km: 0,
      conc: 0,
    });
  });
});

describe('二つの読み方が食い違わない', () => {
  test('全選択の合計は、組み合わせ表そのものの合計である', () => {
    const all = statsFor(COMBOS, new Set());
    expect(all.arcs).toBe(COMBOS.reduce((a, c) => a + c.arcs, 0));
  });

  test('1 路線だけ選んだときの延長は routesOf の値以上になる', () => {
    // statsFor はその路線を含む行を丸ごと数えるので、重用相手のぶんも入ります。
    // routesOf はその路線に帰属する量だけを持ちます。等しくなるのは重用が無い
    // ときだけで、逆転は起こりません。
    for (const r of routesOf(COMBOS)) {
      const picked = statsFor(COMBOS, new Set([r.ref]));
      expect(picked.km).toBeGreaterThanOrEqual(r.km);
    }
  });
});

describe('concurrencies', () => {
  /* 重用ランキングが並べる行。panel.mjs から移しました。選択で組み合わせ表を
   * 絞る規則は statsFor・kindsFor と同じ `touched` なので、規則の写しではなく
   * 同じものを見ていることが、この場所に置いてある意味です。 */
  const ROWS = [
    row([7], 100, 1000),
    row([7, 8], 10, 100),
    row([17, 49], 5, 50),
  ];

  test('単独指定は重用ではない', () => {
    expect(concurrencies(ROWS, new Set())).toHaveLength(2);
  });

  test('選択はどれを並べるかだけを絞る', () => {
    // 重用かどうかは道路の性質であって、選択の結果ではありません。
    const picked = concurrencies(ROWS, new Set([7]));
    expect(picked).toHaveLength(1);
    expect(picked[0].refs).toEqual([7, 8]);
  });

  test('選ばれた番号が重用の片側にあれば残る', () => {
    expect(concurrencies(ROWS, new Set([49]))[0].refs).toEqual([17, 49]);
  });

  test('該当が無ければ空になる', () => {
    expect(concurrencies(ROWS, new Set([999]))).toEqual([]);
  });

  test('絞り方は statsFor と同じである', () => {
    // 同じ選択に対して、重用行を数え上げた結果が両者で一致します。写しを持って
    // いたころは、ここが暗黙のうちにずれる余地がありました。
    for (const sel of [
      new Set(),
      new Set([7]),
      new Set([49]),
      new Set([999]),
    ]) {
      const arcs = concurrencies(COMBOS, sel).reduce((a, c) => a + c.arcs, 0);
      expect(arcs).toBe(statsFor(COMBOS, sel).conc);
    }
  });
});

/* 区分別の内訳は issue #58 が組み合わせ表に足す欄を読みます。web/data は
 * 追跡していないので、欄を持たない古い meta が配信されたまま新しいコードが
 * 出ることがあります。そのときに空を返すことが、ここで一番大事な
 * 振る舞いです。 */
describe('kindsFor', () => {
  const KINDED = [
    { refs: [7], n: 1, km: 100, arcs: 1000, kinds: { road: 90, ferry: 10 } },
    { refs: [8], n: 1, km: 200, arcs: 2000, kinds: { road: 200 } },
    {
      refs: [7, 8],
      n: 2,
      km: 10,
      arcs: 100,
      kinds: { road: 6, expressway: 4 },
    },
  ];

  test('選択が触れる組み合わせの区分を足す', () => {
    expect(kindsFor(KINDED, new Set([7]))).toEqual([
      { kind: 'road', km: 96 },
      { kind: 'ferry', km: 10 },
      { kind: 'expressway', km: 4 },
    ]);
  });

  test('km の大きい順に並ぶ', () => {
    const kms = kindsFor(KINDED, new Set()).map((k) => k.km);
    expect(kms).toEqual([...kms].sort((a, b) => b - a));
  });

  test('重なる区間を二重に数えない', () => {
    // 7 号と 8 号を両方選んでも、共有する行は 1 回だけ入ります。
    const both = kindsFor(KINDED, new Set([7, 8]));
    expect(both.find((k) => k.kind === 'expressway').km).toBe(4);
    expect(both.reduce((a, k) => a + k.km, 0)).toBe(310);
  });

  test('区分の合計は選択の延長と一致する', () => {
    const total = kindsFor(KINDED, new Set([7])).reduce((a, k) => a + k.km, 0);
    expect(total).toBe(statsFor(KINDED, new Set([7])).km);
  });

  test('kinds を持たない組み合わせ表では空になる', () => {
    expect(kindsFor(COMBOS, new Set())).toEqual([]);
    expect(kindsFor(COMBOS, new Set([7]))).toEqual([]);
  });

  test('欄を持つ行と持たない行が混ざっていても落ちない', () => {
    const mixed = [...KINDED, { refs: [9], n: 1, km: 5, arcs: 50 }];
    expect(kindsFor(mixed, new Set([9]))).toEqual([]);
    expect(kindsFor(mixed, new Set([8, 9]))).toEqual([
      { kind: 'road', km: 206 },
      { kind: 'expressway', km: 4 },
    ]);
  });
});

describe('formerKmFor', () => {
  /* 旧道は区分と直交します。下の 3 km は road と construction の内側に既に
   * 入っていて、その外側にあるのではありません。 */
  const FORMER = [
    {
      refs: [7],
      n: 1,
      km: 100,
      arcs: 1000,
      kinds: { road: 97, construction: 3 },
      former_km: 3,
    },
    { refs: [8], n: 1, km: 200, arcs: 2000, kinds: { road: 200 } },
    {
      refs: [7, 8],
      n: 2,
      km: 10,
      arcs: 100,
      kinds: { road: 10 },
      former_km: 0.5,
    },
  ];

  test('選択が触れる組み合わせの旧道を足す', () => {
    expect(formerKmFor(FORMER, new Set([7]))).toBe(3.5);
    // 8 号の単独区間に旧道はなく、7 号との重用区間の 0.5 km だけが残ります。
    expect(formerKmFor(FORMER, new Set([8]))).toBe(0.5);
  });

  test('選択が空なら全部を数える', () => {
    expect(formerKmFor(FORMER, new Set())).toBe(3.5);
  });

  test('重なる区間を二重に数えない', () => {
    // 7 号と 8 号を両方選んでも、共有する行は 1 回だけ入ります。
    expect(formerKmFor(FORMER, new Set([7, 8]))).toBe(3.5);
  });

  test('旧道を区分の合計に足すと、選択の延長を超える', () => {
    const sel = new Set([7]);
    const kinds = kindsFor(FORMER, sel).reduce((a, k) => a + k.km, 0);
    expect(kinds).toBe(statsFor(FORMER, sel).km);
    expect(kinds + formerKmFor(FORMER, sel)).toBeGreaterThan(
      statsFor(FORMER, sel).km,
    );
  });

  test('former_km を持たない組み合わせ表では 0 になる', () => {
    expect(formerKmFor(COMBOS, new Set())).toBe(0);
    expect(formerKmFor(COMBOS, new Set([7]))).toBe(0);
  });

  test('欄を持つ行と持たない行が混ざっていても落ちない', () => {
    expect(formerKmFor([FORMER[1], FORMER[2]], new Set())).toBe(0.5);
  });

  test('どの組み合わせにも居ない番号を選ぶと 0 になる', () => {
    expect(formerKmFor(FORMER, new Set([999]))).toBe(0);
  });
});

/* ---------------------------------------------------------- 都道府県道 --- */
/* 数え方は路線の格に依りません。違うのは路線のキーだけで(国道は番号 `18`、
 * 都道府県道は `nagano-18`)、並べ方として渡します。 */
describe('routesOf — 都道府県道の鍵', () => {
  const combos = [
    { refs: ['nagano-100'], n: 1, km: 10, arcs: 100, rank: 'general' },
    { refs: ['nagano-9'], n: 1, km: 20, arcs: 200, rank: 'major' },
    { refs: ['nagano-9', 'nagano-100'], n: 2, km: 5, arcs: 50, rank: 'major' },
  ];
  const routes = routesOf(combos, comparePrefKeys);

  test('番号の順に並べる。文字列の順ではない', () => {
    expect(routes.map((r) => r.ref)).toEqual(['nagano-9', 'nagano-100']);
  });

  test('組み合わせを路線それぞれへ開く', () => {
    const r9 = routes.find((r) => r.ref === 'nagano-9');
    expect(r9.km).toBe(25);
    expect(r9.arcs).toBe(250);
    expect(r9.conc_km).toBe(5);
    expect(r9.max_n).toBe(2);
  });
});

describe('prefRankOf', () => {
  /* 組み合わせの `rank` は「重なっている路線のうち一つでも主要地方道なら
   * major」です。だから読めるのは、その路線 1 本だけの行に限ります。 */
  const combos = [
    { refs: ['nagano-9'], n: 1, km: 20, rank: 'major' },
    { refs: ['nagano-100'], n: 1, km: 10, rank: 'general' },
    { refs: ['nagano-9', 'nagano-100'], n: 2, km: 5, rank: 'major' },
    { refs: ['nagano-9', 'nagano-200'], n: 2, km: 2, rank: 'major' },
  ];

  test('1 本だけの行から読む', () => {
    expect(prefRankOf(combos, 'nagano-9')).toBe('major');
    expect(prefRankOf(combos, 'nagano-100')).toBe('general');
  });

  test('重用の行の rank に釣られない', () => {
    // 100 号は 9 号と重なる行では major と書かれていますが、
    // 一般都道府県道です。
    expect(prefRankOf(combos, 'nagano-100')).not.toBe('major');
  });

  test('1 本だけの行を持たない路線では null になる', () => {
    // 延長のすべてが重用である路線です。13,234 のうち 78 あります。
    expect(prefRankOf(combos, 'nagano-200')).toBe(null);
    expect(prefRankOf(combos, 'nagano-999')).toBe(null);
  });
});
