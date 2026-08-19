/* The 国道番号標識 the map draws wherever it names a route.
 *
 * The outline is a construction rather than a path string, because the tangent
 * points a corner radius implies are not numbers anyone should check by hand.
 * That is exactly why they are worth checking here: the geometry has
 * properties that hold for any convex polygon, and a mistake in the
 * trigonometry breaks them without breaking anything that would throw.
 */
import { describe, expect, test } from 'bun:test';

import {
  roundedPolygon,
  SHIELD_PATH,
  shield,
  shieldRow,
} from '../web/shield.mjs';

/** Every number in a path, in order. */
const nums = (d) =>
  [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

describe('roundedPolygon', () => {
  // 一辺 100 の正方形です。直角なので、どの角も半径ぶんちょうど手前で折れます。
  const SQUARE = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];

  test('閉じた path を返す', () => {
    const d = roundedPolygon(SQUARE, 10);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });

  test('頂点の数だけ円弧が要る', () => {
    for (const n of [3, 4, 5]) {
      const pts = Array.from({ length: n }, (_, i) => {
        const a = (2 * Math.PI * i) / n;
        return [50 + 40 * Math.cos(a), 50 + 40 * Math.sin(a)];
      });
      expect(roundedPolygon(pts, 5).match(/A/g)).toHaveLength(n);
    }
  });

  test('直角では半径ぶんちょうど手前で折れる', () => {
    // tan(90°/2) = 1 なので後退量は半径そのものになります。手計算できる唯一の角です。
    const d = roundedPolygon(SQUARE, 10);
    expect(d).toContain('10 0');
    expect(d).toContain('90 0');
    expect(d).toContain('100 10');
  });

  test('鋭い角ほど深く手前で折れる', () => {
    // 同じ半径でも、角が尖っているほど円弧は辺の奥から始まります。
    const sharp = [
      [0, 0],
      [100, 0],
      [50, 8],
    ];
    const blunt = [
      [0, 0],
      [100, 0],
      [50, 90],
    ];
    const backoff = (pts) => nums(roundedPolygon(pts, 5))[0];
    expect(backoff(sharp)).toBeGreaterThan(backoff(blunt));
  });

  test('座標は小数第 2 位までに丸める', () => {
    for (const v of nums(roundedPolygon(SQUARE, 7))) {
      expect(Math.round(v * 100) / 100).toBe(v);
    }
  });

  test('数値はすべて有限である', () => {
    for (const v of nums(roundedPolygon(SQUARE, 10))) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  test('円弧の掃引方向は常に 1 である', () => {
    // 画面座標（y は下向き）で頂点を時計回りに並べることが前提になっています。
    // ここが 0 になると角が外側に膨らみます。
    for (const m of roundedPolygon(SQUARE, 10).matchAll(
      /A(\S+) (\S+) 0 0 (\d)/g,
    )) {
      expect(m[3]).toBe('1');
    }
  });
});

describe('SHIELD_PATH', () => {
  test('逆三角形なので円弧は 3 つである', () => {
    expect(SHIELD_PATH.match(/A/g)).toHaveLength(3);
  });

  test('48x42 の viewBox に収まる', () => {
    // 標識は 0 0 48 42 の中に描かれます。はみ出せば縁が切られます。
    const v = nums(SHIELD_PATH);
    for (const n of v) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(48);
    }
  });
});

describe('shield', () => {
  test('番号が中に入り、読み上げも番号を言う', () => {
    const html = shield(18);
    expect(html).toContain('>18</text>');
    expect(html).toContain('aria-label="国道18号"');
  });

  test('桁が増えるほど文字幅を詰める', () => {
    // 3 桁は三角形より広くなるので、textLength で押し込みます。放っておくと
    // 白い数字が背後の面へはみ出して読めなくなります。
    const width = (ref) => Number(shield(ref).match(/textLength="(\d+)"/)[1]);
    expect(width(1)).toBeLessThan(width(18));
    expect(width(18)).toBeLessThan(width(459));
  });

  test('幅は桁数だけで決まる', () => {
    const width = (ref) => shield(ref).match(/textLength="(\d+)"/)[1];
    expect(width(7)).toBe(width(9));
    expect(width(18)).toBe(width(99));
    expect(width(100)).toBe(width(459));
  });

  test('小さい版は class で区別する', () => {
    expect(shield(18, true)).toContain('class="shield sm"');
    expect(shield(18, false)).toContain('class="shield"');
  });

  test('どの標識も同じ輪郭を使う', () => {
    expect(shield(1)).toContain(SHIELD_PATH);
    expect(shield(459)).toContain(SHIELD_PATH);
  });
});

describe('shieldRow', () => {
  test('渡した順に並べる', () => {
    const row = shieldRow([7, 8, 17], true);
    expect(row.indexOf('>7</text>')).toBeLessThan(row.indexOf('>8</text>'));
    expect(row.indexOf('>8</text>')).toBeLessThan(row.indexOf('>17</text>'));
  });

  test('空なら空文字である', () => {
    expect(shieldRow([], true)).toBe('');
  });

  test('六重用でも 6 枚出る', () => {
    const row = shieldRow([7, 8, 17, 49, 403, 459], true);
    expect(row.match(/<svg/g)).toHaveLength(6);
  });
});
