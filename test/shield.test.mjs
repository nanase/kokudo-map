/* The 国道番号標識 the map draws wherever it names a route.
 *
 * SHIELD_PATH is traced from a real sign's proportions, not computed, so
 * there is no formula to re-derive here. What's worth checking instead is
 * that the string stays a well-formed closed path whose points sit inside
 * its own viewBox — a corrupted edit (a dropped digit, a wrong sign) would
 * otherwise only show up as a visibly broken shape in the browser.
 */
import { describe, expect, test } from 'bun:test';

import {
  SHIELD_PATH,
  SHIELD_STROKE_WIDTH,
  SHIELD_VIEWBOX,
  shield,
  shieldRow,
} from '../web/shield.mjs';

/** Every number in a path, in order. */
const nums = (d) =>
  [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

/**
 * The absolute point each `M`/`c` segment ends at, resolving the relative
 * `c` deltas by walking the path from its `M` start.
 */
function anchors(d) {
  const points = [];
  let [x, y] = [0, 0];
  for (const seg of d.matchAll(/([Mc])([^Mc]*)/g)) {
    const [, cmd, body] = seg;
    const n = nums(body);
    if (cmd === 'M') {
      [x, y] = n;
      points.push([x, y]);
      continue;
    }
    for (let i = 0; i < n.length; i += 6) {
      x += n[i + 4];
      y += n[i + 5];
      points.push([x, y]);
    }
  }
  return points;
}

describe('SHIELD_PATH', () => {
  test('閉じた path である', () => {
    expect(SHIELD_PATH.startsWith('M')).toBe(true);
    expect(SHIELD_PATH.endsWith('Z')).toBe(true);
  });

  test('M と c 以外のコマンドを含まない', () => {
    expect(SHIELD_PATH.replace(/[Mc0-9.,\s-]/g, '')).toBe('Z');
  });

  test('端点は viewBox の内側、縁の太さぶんの余白を残す', () => {
    const [, , vw, vh] = nums(SHIELD_VIEWBOX);
    const margin = SHIELD_STROKE_WIDTH / 2;
    for (const [x, y] of anchors(SHIELD_PATH)) {
      expect(x).toBeGreaterThanOrEqual(margin);
      expect(x).toBeLessThanOrEqual(vw - margin);
      expect(y).toBeGreaterThanOrEqual(margin);
      expect(y).toBeLessThanOrEqual(vh - margin);
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
    // 3 桁は標識より広くなるので、textLength で押し込みます。放っておくと
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
