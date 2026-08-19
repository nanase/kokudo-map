/* The panel's numbers.
 *
 * This is the arithmetic the map exists for. A conventional map answers "how
 * long is 国道18号" by adding up the road it drew, having already dropped the
 * numbers it rounded away; and a table of per-route totals answers "how much
 * road is selected" by adding routes together, which counts every concurrent
 * arc once per designation on it. Both are wrong in the same direction, and
 * both look plausible.
 *
 * So the rows are per *combination* of designations, and these two sums read
 * them two different ways: `routesOf` fans a combination out to each of its
 * routes, `statsFor` adds each combination at most once. Getting those two the
 * wrong way round is the bug this file is here to catch.
 */
import { describe, expect, test } from 'bun:test';

import { routesOf, statsFor } from '../web/aggregate.mjs';

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

  test('路線の延長を足すと、重用のぶんだけ実延長を超える', () => {
    // これが路線別の表で全体を語れない理由です。実延長は 614 km しかありません。
    const sumOfRoutes = routes.reduce((a, r) => a + r.km, 0);
    const actual = COMBOS.reduce((a, c) => a + c.km, 0);
    expect(actual).toBe(614);
    expect(sumOfRoutes).toBe(644);
    expect(sumOfRoutes).toBeGreaterThan(actual);
  });

  test('組み合わせが無ければ路線も無い', () => {
    expect(routesOf([])).toEqual([]);
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
