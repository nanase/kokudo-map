/* URL のクエリ文字列と表示状態の変換。
 *
 * ここでの取りこぼしは、リンクを開いた側に静かに違う地図を見せる。範囲表記
 * の境界(単発・隣接・逆順)と、既定値を書かない省略の両方がその形で壊れうる
 * ので、両方をここで縛る。
 */
import { describe, expect, test } from 'bun:test';

import {
  decodeRoutes,
  decodeURLState,
  encodeRoutes,
  encodeState,
} from '../web/urlstate.mjs';

describe('encodeRoutes / decodeRoutes', () => {
  test('連続した番号は範囲にまとめる', () => {
    expect(encodeRoutes([1, 2, 3, 5, 7, 8, 9])).toBe('1-3,5,7-9');
  });

  test('単発の番号には - が付かない', () => {
    expect(encodeRoutes([246])).toBe('246');
  });

  test('順不同でも昇順の範囲になる', () => {
    expect(encodeRoutes([9, 1, 2])).toBe('1-2,9');
  });

  test('空集合は空文字列', () => {
    expect(encodeRoutes([])).toBe('');
  });

  test('encode/decode は互いの逆である', () => {
    const refs = [1, 2, 3, 5, 7, 8, 9, 246, 507];
    expect(decodeRoutes(encodeRoutes(refs))).toEqual(refs);
  });

  test('壊れた項目は読み飛ばす', () => {
    expect(decodeRoutes('1-3,abc,,9-8,18')).toEqual([1, 2, 3, 18]);
  });

  test('空文字列は空配列', () => {
    expect(decodeRoutes('')).toEqual([]);
  });
});

describe('encodeState', () => {
  const base = {
    selected: new Set(),
    conc: 'off',
    labels: true,
    termini: true,
    expressway: true,
    special: true,
    ferry: true,
    former: true,
  };

  test('すべて既定値なら空文字列', () => {
    expect(encodeState(base)).toBe('');
  });

  test('選択路線だけが違えば routes だけ出る', () => {
    expect(encodeState({ ...base, selected: new Set([18, 117]) })).toBe(
      'routes=18%2C117',
    );
  });

  test('重用区間のみ表示は conc=all として出る', () => {
    expect(encodeState({ ...base, conc: 'all' })).toBe('conc=all');
  });

  test('オフにした表示項目だけが 0 で出る', () => {
    const s = encodeState({ ...base, labels: false, ferry: false });
    const p = new URLSearchParams(s);
    expect(p.get('labels')).toBe('0');
    expect(p.get('ferry')).toBe('0');
    expect(p.has('termini')).toBe(false);
  });

  test('旧道をオフにすると former=0 が出る', () => {
    const p = new URLSearchParams(encodeState({ ...base, former: false }));
    expect(p.get('former')).toBe('0');
  });
});

describe('decodeURLState', () => {
  test('空文字列は空オブジェクト — 何にも触れない', () => {
    expect(decodeURLState('')).toEqual({});
  });

  test('routes は Set に戻る', () => {
    expect(decodeURLState('?routes=18,117')).toEqual({
      selected: new Set([18, 117]),
    });
  });

  test('conc=all だけが認識される。それ以外の値は無視する', () => {
    expect(decodeURLState('?conc=all')).toEqual({ conc: 'all' });
    expect(decodeURLState('?conc=off')).toEqual({});
    expect(decodeURLState('?conc=nonsense')).toEqual({});
  });

  test('表示項目は 0/それ以外 で真偽になる', () => {
    expect(decodeURLState('?labels=0&ferry=1')).toEqual({
      labels: false,
      ferry: true,
    });
  });

  test('旧道の表示項目も 0/それ以外 で真偽になる', () => {
    expect(decodeURLState('?former=0')).toEqual({ former: false });
  });

  test('encodeState の出力を decodeURLState に通すと同じ差分が戻る', () => {
    const diff = { selected: new Set([1, 2, 3]), conc: 'all', special: false };
    const full = {
      selected: new Set(),
      conc: 'off',
      labels: true,
      termini: true,
      expressway: true,
      special: true,
      ferry: true,
      former: true,
      ...diff,
    };
    expect(decodeURLState(encodeState(full))).toEqual(diff);
  });
});
