/* 都道府県道の路線を名指す鍵。
 *
 * 路線番号は県の中でしか一意ではありません。県道 18 号は 47 本あります。だから
 * 鍵は(県, 番号)の組で、判定はそれを `nagano-18` の 1 本の文字列にして配ります。
 * 番号だけで路線を指した瞬間に、地図は 47 本のどれの話をしているのか分からなく
 * なります。
 */
import { describe, expect, test } from 'bun:test';

import {
  comparePrefKeys,
  matchPrefRoutes,
  prefRefOf,
  prefRegionOf,
} from '../web/prefroute.mjs';

describe('鍵の読み書き', () => {
  test('県と番号に分ける', () => {
    expect(prefRegionOf('nagano-18')).toBe('nagano');
    expect(prefRefOf('nagano-18')).toBe(18);
  });

  test('判定が配る形をそのまま読める', () => {
    // build_prefectural.py の refs_key が書く形です。
    for (const [key, region, ref] of [
      ['hokkaido-106', 'hokkaido', 106],
      ['tokyo-7', 'tokyo', 7],
      ['osaka-1', 'osaka', 1],
      ['kagoshima-1000', 'kagoshima', 1000],
    ]) {
      expect(prefRegionOf(key)).toBe(region);
      expect(prefRefOf(key)).toBe(ref);
    }
  });

  test('番号は末尾の `-` から後ろだけである', () => {
    // 県の名前に `-` を含む物はありませんが、切る場所は最後の `-` と決めて
    // あります。前から切ると、いつか名前の中の `-` で割れます。
    expect(prefRefOf('a-b-42')).toBe(42);
    expect(prefRegionOf('a-b-42')).toBe('a-b');
  });
});

describe('comparePrefKeys', () => {
  test('番号の順に並べる。文字列の順ではない', () => {
    const keys = ['nagano-100', 'nagano-9', 'nagano-63'];
    expect([...keys].sort(comparePrefKeys)).toEqual([
      'nagano-9',
      'nagano-63',
      'nagano-100',
    ]);
    // 文字列として並べると '100' < '63' になります。
    expect([...keys].sort()).not.toEqual([...keys].sort(comparePrefKeys));
  });

  test('番号が同じなら県で分ける', () => {
    expect(comparePrefKeys('aichi-18', 'nagano-18')).toBeLessThan(0);
    expect(comparePrefKeys('nagano-18', 'aichi-18')).toBeGreaterThan(0);
    expect(comparePrefKeys('nagano-18', 'nagano-18')).toBe(0);
  });
});

/* 打たれた番号で全国から探します。当て方は国道の一覧と同じ前方一致です——
 * 同じ欄が両方の系統に当たるので、当て方も二つに分かれてはなりません。 */
describe('matchPrefRoutes', () => {
  const index = new Map([
    ['hokkaido', [1, 18, 180]],
    ['aomori', [18, 20]],
    ['nagano', [18, 63, 181]],
  ]);

  test('前方一致で当てる', () => {
    const { matches } = matchPrefRoutes(index, '18', 100);
    expect(matches.map((m) => m.key)).toEqual([
      'hokkaido-18',
      'aomori-18',
      'nagano-18',
      'hokkaido-180',
      'nagano-181',
    ]);
  });

  /* 番号が先、同じ番号の中は県の順です。県道 18 号は 47 本あるので、番号で
     並べれば同じ番号のものが固まり、県で目を走らせられます。 */
  test('番号の昇順に並べ、同じ番号は index の県順を保つ', () => {
    const { matches } = matchPrefRoutes(index, '1', 100);
    expect(matches.map((m) => m.ref)).toEqual([1, 18, 18, 18, 180, 181]);
    expect(matches.slice(1, 4).map((m) => m.region)).toEqual([
      'hokkaido',
      'aomori',
      'nagano',
    ]);
  });

  /* 「1」の一致は本物の索引では数千件になり、それが打っている途中の 1 文字
     ごとに起きます。切った後の総数も返すので、呼ぶ側は「上位 N 件」と
     述べられます。 */
  test('上限で切り、切る前の総数も返す', () => {
    const { matches, total } = matchPrefRoutes(index, '1', 2);
    expect(matches).toHaveLength(2);
    expect(total).toBe(6);
  });

  test('一致が無ければ空を返す', () => {
    const { matches, total } = matchPrefRoutes(index, '999', 100);
    expect(matches).toEqual([]);
    expect(total).toBe(0);
  });

  test('鍵は県と番号の組である', () => {
    // 番号は県の中でしか一意でないので、鍵は必ず県を伴います。
    const { matches } = matchPrefRoutes(index, '63', 100);
    expect(matches).toEqual([{ region: 'nagano', ref: 63, key: 'nagano-63' }]);
  });
});
