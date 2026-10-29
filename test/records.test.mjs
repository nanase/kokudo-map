/* 国道の記録です。ここが捕まえるのは、もっともらしい答えを出す間違いです。
 *
 * 延長は上下線を 2 本ぶん数えています。そのまま比べると国道174号は 0.3 km に
 * なり、公式の 0.187 km とずれます。台帳と同じ数え方に直すには、行の
 * `link_km` と `twin_km` を引きます。引き忘れても「最も短い国道」は 174 号の
 * ままなので、答えを見ただけでは気付けません。
 *
 * 経過地の数え方も同じ形の罠を持ちます。地名は全角の空白で区切ってありますが、
 * 括弧の中にも空白が入ります。空白だけで切ると国道 1 号は 55 か所になり、1 位の
 * まま 1 か所多く数えます。
 */
import { describe, expect, test } from 'bun:test';

import { RECORD_TABS, recordsOf, viaPlaces } from '../web/records.mjs';

const row = (refs, km, extra = {}) => ({
  refs,
  n: refs.length,
  km,
  arcs: 1,
  kinds: { road: km },
  bbox: [135, 34, 135.1, 34.1],
  ...extra,
});

const decreeRow = (ref, start, end, via = '', coords = {}) => ({
  ref,
  via,
  start: { name: start, ...(coords.start ?? {}) },
  end: { name: end, ...(coords.end ?? {}) },
});

/* 174 号は 0.31 km の線のうち 0.08 km が上下線の片側です。175 号は 0.25 km
 * ですが上下線を持たず、線の長さだけで比べると 174 号より短く見えます。 */
const META = {
  combinations: [
    row([174], 0.31, { twin_km: 0.08 }),
    row([175], 0.25),
    row([1], 100, {
      kinds: { road: 60, ferry: 40 },
      bbox: [139, 35, 140, 36],
    }),
    row([2], 50, { kinds: { expressway: 48, road: 2 }, link_km: 2 }),
    row([3], 50, { kinds: { expressway: 47, road: 3 }, link_km: 2 }),
    row([1, 3], 10, { kinds: { road: 10 }, bbox: [130, 30, 131, 31] }),
  ],
  crossings: [
    [1, 2],
    [2, 175],
  ],
  shared_termini: [],
  decree: {
    routes: [
      decreeRow(
        1,
        '東京都中央区',
        '大阪市',
        '横浜市　平塚市（浅間町　袖ケ浜）　小田原市',
      ),
      decreeRow(2, '大阪市', '北九州市', '神戸市'),
      decreeRow(3, '北九州市', '鹿児島市'),
      decreeRow(174, '神戸港', '神戸市中央区'),
      decreeRow(175, '横浜市', '横浜市'),
    ],
  },
};

const by = (records, key) => records.find((r) => r.key === key);

describe('viaPlaces', () => {
  test('括弧の中の空白では切らない', () => {
    expect(viaPlaces('横浜市　平塚市（浅間町　袖ケ浜）　小田原市')).toEqual([
      '横浜市',
      '平塚市（浅間町　袖ケ浜）',
      '小田原市',
    ]);
  });

  test('空の欄は 0 か所', () => {
    expect(viaPlaces('')).toEqual([]);
    expect(viaPlaces(undefined)).toEqual([]);
  });
});

describe('recordsOf', () => {
  const records = recordsOf(META);

  test('最も短い国道は、上下線の片側を引いた延長で比べる', () => {
    const r = by(records, 'shortest');
    expect(r.refs).toEqual([174]);
    expect(r.value).toBeCloseTo(0.23, 5);
    expect(r.approx).toBe(true);
    expect(r.reference).toBe(true);
  });

  test('全線が自動車専用道路は、ランプのほかに一般道を持たない路線だけ', () => {
    // 2 号の一般道 2 km はすべてランプ、3 号は 1 km がランプでない一般道です。
    expect(by(records, 'motorway').refs).toEqual([2]);
  });

  test('区分の記録はその区分の延長で比べ、場所はその区分を持つ行だけ', () => {
    const r = by(records, 'ferry');
    expect(r.refs).toEqual([1]);
    expect(r.value).toBe(40);
    // 1 号は九州で 3 号と重なる行も持ちますが、航路はそこにありません。
    expect(r.bbox).toEqual([139, 35, 140, 36]);
  });

  test('同点はまとめて返す', () => {
    // 2 号は 1 号と 175 号の 2 本と交わります。1 号・175 号は 1 本ずつです。
    expect(by(records, 'crossings').refs).toEqual([2]);
    const tied = recordsOf({
      ...META,
      crossings: [
        [1, 2],
        [3, 174],
      ],
    });
    expect(by(tied, 'crossings').refs).toEqual([1, 2, 3, 174]);
  });

  test('どの国道とも交わらず重ならない路線は、交差・重用・起終点の共有を持たない', () => {
    // 1 号と 3 号は重用、2 号と 175 号は交差を持ちます。
    expect(by(records, 'alone').refs).toEqual([174]);
  });

  test('経過地は括弧の外の空白で数える', () => {
    const r = by(records, 'via');
    expect(r.refs).toEqual([1]);
    expect(r.value).toBe(3);
  });

  test('起点と終点が同じ国道は、政令の地名で決める', () => {
    const r = by(records, 'loop');
    expect(r.refs).toEqual([175]);
    expect(r.desc).toBe('175号は横浜市。');
  });

  test('端点は行の広がりの端で、一つの路線が二つの端を持てる', () => {
    const r = by(records, 'ends');
    const at = Object.fromEntries(r.ends.map((e) => [e.dir, e.ref]));
    // 1 号は九州の行で南と西の端を、本州の行で北と東の端を持ちます。
    expect(at).toEqual({ 北: 1, 南: 1, 東: 1, 西: 1 });
    expect(r.desc).toBe('1号は北と南と東と西の端を一つで持つ。');
  });

  test('最も大きい番号', () => {
    expect(by(records, 'largest').refs).toEqual([175]);
  });

  test('延長を使う記録にだけ「参考」が立つ', () => {
    const reference = records.filter((r) => r.reference).map((r) => r.key);
    expect(reference.sort()).toEqual(
      ['concurrency', 'ferry', 'motorway', 'shortest'].sort(),
    );
  });

  test('どの記録もタブのどれかに入る', () => {
    for (const r of records) {
      expect(r.tab).toBeGreaterThanOrEqual(0);
      expect(r.tab).toBeLessThan(RECORD_TABS.length);
    }
  });

  test('上下線を数え直した延長を持たない古い meta では、それを要る記録を出さない', () => {
    const old = recordsOf({
      ...META,
      combinations: META.combinations.map(({ twin_km, link_km, ...c }) => c),
    });
    const keys = old.map((r) => r.key);
    expect(keys).not.toContain('shortest');
    expect(keys).not.toContain('motorway');
    expect(keys).not.toContain('concurrency');
    expect(keys).toContain('ferry');
  });

  test('空の meta では何も出さない', () => {
    expect(recordsOf({})).toEqual([]);
    expect(recordsOf(null)).toEqual([]);
  });
});
