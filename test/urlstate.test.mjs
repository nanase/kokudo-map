/* URL のクエリ文字列と表示状態の変換。
 *
 * ここでの取りこぼしは、リンクを開いた側に静かに違う地図を見せる。範囲表記
 * の境界(単発・隣接・逆順)と、既定値を書かない省略の両方がその形で壊れうる
 * ので、両方をここで縛る。
 */
import { describe, expect, test } from 'bun:test';

import {
  decodePrefRoutes,
  decodeRoutes,
  decodeURLState,
  encodePrefRoutes,
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

  /* 桁の違う範囲は路線を指していません。展開すると、リンクを開いた側で数億回の
     同期ループが走り、地図が出る前に画面が止まります。 */
  test('広すぎる範囲は読み飛ばす。前後の有効な項目は残る', () => {
    expect(decodeRoutes('18,1-999999999,117')).toEqual([18, 117]);
  });

  test('実在しうる幅の範囲は展開する', () => {
    // 番号は国道が 507 まで、都道府県道が 1199 まである。
    expect(decodeRoutes('1-1199')).toHaveLength(1199);
  });
});

describe('encodePrefRoutes / decodePrefRoutes', () => {
  test('県ごとにまとめ、県の中は範囲表記に畳む', () => {
    expect(
      encodePrefRoutes(['nagano-1', 'nagano-2', 'nagano-3', 'tokyo-18']),
    ).toBe('nagano:1-3;tokyo:18');
  });

  test('県の並びは入力の順に左右されない', () => {
    expect(encodePrefRoutes(['tokyo-18', 'nagano-63'])).toBe(
      'nagano:63;tokyo:18',
    );
  });

  test('空の選択は空文字列', () => {
    expect(encodePrefRoutes([])).toBe('');
  });

  test('encode/decode は互いの逆である', () => {
    const keys = ['nagano-1', 'nagano-2', 'nagano-63', 'tokyo-18'];
    expect(decodePrefRoutes(encodePrefRoutes(keys))).toEqual(keys);
  });

  /* 同じ番号でも県が違えば別の路線である。県道18号は 47 本ある。 */
  test('県をまたいだ同じ番号は別々に残る', () => {
    expect(decodePrefRoutes('nagano:18;tokyo:18')).toEqual([
      'nagano-18',
      'tokyo-18',
    ]);
  });

  test('県を名乗らない項目・県の形をしない項目は読み飛ばす', () => {
    expect(decodePrefRoutes('nagano:63;18;Tokyo:1;na-gano:2;osaka:2')).toEqual([
      'nagano-63',
      'osaka-2',
    ]);
  });

  test('番号側が壊れていれば、その番号だけを読み飛ばす', () => {
    expect(decodePrefRoutes('nagano:1-3,abc,9-8,63')).toEqual([
      'nagano-1',
      'nagano-2',
      'nagano-3',
      'nagano-63',
    ]);
  });

  test('空文字列は空配列', () => {
    expect(decodePrefRoutes('')).toEqual([]);
  });
});

describe('encodeState', () => {
  const base = {
    selected: new Set(),
    prefSelected: new Set(),
    conc: 'off',
    labels: true,
    termini: true,
    expressway: true,
    special: true,
    ferry: true,
    former: true,
    national: true,
    pref: true,
    prefSpecial: true,
  };

  test('すべて既定値なら空文字列', () => {
    expect(encodeState(base)).toBe('');
  });

  test('選択路線だけが違えば routes だけ出る', () => {
    expect(encodeState({ ...base, selected: new Set([18, 117]) })).toBe(
      'routes=18%2C117',
    );
  });

  test('都道府県道の選択は proutes として出る', () => {
    expect(encodeState({ ...base, prefSelected: new Set(['nagano-63']) })).toBe(
      'proutes=nagano%3A63',
    );
  });

  /* 国道のキーの形は変えない。いま共有されているリンクが開けなくなる。 */
  test('国道と都道府県道は別々の鍵に出る', () => {
    const p = new URLSearchParams(
      encodeState({
        ...base,
        selected: new Set([18]),
        prefSelected: new Set(['nagano-63']),
      }),
    );
    expect(p.get('routes')).toBe('18');
    expect(p.get('proutes')).toBe('nagano:63');
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

  test('国道・都道府県道をオフにすると national=0/pref=0 が出る', () => {
    const p = new URLSearchParams(
      encodeState({ ...base, national: false, pref: false }),
    );
    expect(p.get('national')).toBe('0');
    expect(p.get('pref')).toBe('0');
  });

  test('都道府県道の走れない区間をオフにすると prefSpecial=0 が出る', () => {
    const p = new URLSearchParams(encodeState({ ...base, prefSpecial: false }));
    expect(p.get('prefSpecial')).toBe('0');
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

  test('proutes は鍵の Set に戻る', () => {
    expect(decodeURLState('?proutes=nagano:63;tokyo:18')).toEqual({
      prefSelected: new Set(['nagano-63', 'tokyo-18']),
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

  test('都道府県道の走れない区間も 0/それ以外 で真偽になる', () => {
    expect(decodeURLState('?prefSpecial=0')).toEqual({ prefSpecial: false });
  });

  test('国道・都道府県道の表示項目も 0/それ以外 で真偽になる', () => {
    expect(decodeURLState('?national=0&pref=1')).toEqual({
      national: false,
      pref: true,
    });
  });

  test('encodeState の出力を decodeURLState に通すと同じ差分が戻る', () => {
    const diff = {
      selected: new Set([1, 2, 3]),
      prefSelected: new Set(['nagano-63']),
      conc: 'all',
      special: false,
    };
    const full = {
      selected: new Set(),
      prefSelected: new Set(),
      conc: 'off',
      labels: true,
      termini: true,
      expressway: true,
      special: true,
      ferry: true,
      former: true,
      national: true,
      pref: true,
      prefSpecial: true,
      ...diff,
    };
    expect(decodeURLState(encodeState(full))).toEqual(diff);
  });
});
