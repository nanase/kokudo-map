/* 都道府県道の路線を名指す鍵。
 *
 * 路線番号は県の中でしか一意ではありません。県道 18 号は 47 本あります。だから
 * 鍵は(県, 番号)の組で、判定はそれを `nagano-18` の 1 本の文字列にして配ります。
 * 番号だけで路線を指した瞬間に、地図は 47 本のどれの話をしているのか分からなく
 * なります。
 */
import { describe, expect, test } from 'bun:test';

import { comparePrefKeys, prefRefOf, prefRegionOf } from '../web/prefroute.mjs';

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
