/* 地図が路線を名指しするところで描く国道番号標識。
 *
 * SHIELD_PATH は実物の標識の比率を写した物で、計算した物ではありません。だから
 * ここで導き直せる式はありません。代わりに確かめる値打ちがあるのは、その文字列
 * が閉じた正しい形のパスであり続けること、点が自分の viewBox の中に収まって
 * いることです。編集で壊れても(桁の脱落、符号の誤り)、そうでなければブラウザで
 * 形が崩れて初めて分かります。
 */
import { describe, expect, test } from 'bun:test';

import {
  HEX_PATH,
  hexShield,
  prefRouteName,
  SHIELD_ICON_PAD,
  SHIELD_ICON_STROKE_WIDTH,
  SHIELD_PATH,
  SHIELD_STROKE_WIDTH,
  SHIELD_VIEWBOX,
  shield,
  shieldRow,
} from '../web/shield.mjs';

/** パスに出てくる数を、順に全部。 */
const nums = (d) =>
  [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

/**
 * `M`・`c` の区間が名指しする点をすべて——端点と、`c` が持つ二つの制御点——
 * 返します。`c` の相対の差分は、`M` の始点からパスを辿って解きます。三次曲線は
 * これらの点の凸包から出ないので、点を検査すれば端点だけでなく曲線そのものを
 * 抑えられます。
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
      points.push([x + n[i], y + n[i + 1]], [x + n[i + 2], y + n[i + 3]]);
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

  test('曲線は viewBox の内側、縁の太さぶんの余白を残す', () => {
    const [, , vw, vh] = nums(SHIELD_VIEWBOX);
    const margin = SHIELD_STROKE_WIDTH / 2;
    for (const [x, y] of anchors(SHIELD_PATH)) {
      expect(x).toBeGreaterThanOrEqual(margin);
      expect(x).toBeLessThanOrEqual(vw - margin);
      expect(y).toBeGreaterThanOrEqual(margin);
      expect(y).toBeLessThanOrEqual(vh - margin);
    }
  });

  test('SHIELD_ICON_PAD は SHIELD_ICON_STROKE_WIDTH の縁を切らさない余白を持つ', () => {
    // favicon 側 (scripts/make_brand.mjs) は SHIELD_VIEWBOX を SHIELD_ICON_PAD
    // ぶん広げてから太い縁を描く。broadened 後の余白が縁の太さの半分を
    // 下回ると、太くした縁がその viewBox の外へ切れて出る。
    const [, , vw, vh] = nums(SHIELD_VIEWBOX);
    const margin = SHIELD_ICON_STROKE_WIDTH / 2 - SHIELD_ICON_PAD;
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

/* ヘキサ(都道府県道番号標識)。おにぎりと同じ枠に描くので、確かめることも
 * 同じです——閉じた形であること、点が viewBox の中に収まっていること。違うのは
 * コマンドが絶対の M・L・Q であることだけです(角を二次ベジエで丸めています)。 */
describe('HEX_PATH', () => {
  /** 絶対の M・L・Q が名指しする点をすべて。二次曲線はこの三点の凸包を出ません。 */
  const hexPoints = (d) => {
    const points = [];
    for (const seg of d.matchAll(/([MLQ])([^MLQZ]*)/g)) {
      const n = nums(seg[2]);
      for (let i = 0; i < n.length; i += 2) points.push([n[i], n[i + 1]]);
    }
    return points;
  };

  test('閉じた path である', () => {
    expect(HEX_PATH.startsWith('M')).toBe(true);
    expect(HEX_PATH.endsWith('Z')).toBe(true);
  });

  test('M・L・Q 以外のコマンドを含まない', () => {
    expect(HEX_PATH.replace(/[MLQ0-9.,\s-]/g, '')).toBe('Z');
  });

  test('点は viewBox の内側、縁の太さぶんの余白を残す', () => {
    const [, , vw, vh] = nums(SHIELD_VIEWBOX);
    const margin = SHIELD_STROKE_WIDTH / 2;
    for (const [x, y] of hexPoints(HEX_PATH)) {
      expect(x).toBeGreaterThanOrEqual(margin);
      expect(x).toBeLessThanOrEqual(vw - margin);
      expect(y).toBeGreaterThanOrEqual(margin);
      expect(y).toBeLessThanOrEqual(vh - margin);
    }
  });

  test('おにぎりより縦長である', () => {
    // 実物の標識の比です。同じ viewBox に描くので、違いは形にしか出ません。
    const xs = hexPoints(HEX_PATH).map(([x]) => x);
    const ys = hexPoints(HEX_PATH).map(([, y]) => y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w).toBeLessThan(h);
  });
});

describe('prefRouteName', () => {
  test('県の名前に「道」を継ぐだけで四つの呼び分けが出る', () => {
    expect(prefRouteName('長野県', 63)).toBe('長野県道63号');
    expect(prefRouteName('東京都', 7)).toBe('東京都道7号');
    expect(prefRouteName('大阪府', 2)).toBe('大阪府道2号');
    expect(prefRouteName('北海道', 106)).toBe('北海道道106号');
  });
});

describe('hexShield', () => {
  test('番号が中に入り、読み上げは県まで言う', () => {
    const html = hexShield('長野県', 63);
    expect(html).toContain('>63</text>');
    expect(html).toContain('aria-label="長野県道63号"');
  });

  test('県名は絵として描かない', () => {
    // 操作面での実寸は高さ 30 px です。その大きさでは県名は形になりません。
    expect(hexShield('長野県', 63)).not.toContain('長野</text>');
  });

  test('桁が増えるほど文字幅を詰める', () => {
    const width = (ref) =>
      Number(hexShield('長野県', ref).match(/textLength="(\d+)"/)[1]);
    expect(width(3)).toBeLessThan(width(63));
    expect(width(63)).toBeLessThan(width(407));
    // 番号は 1199 まで在りうる(判定の MAX_REF)。4 桁でも押し込める。
    expect(width(407)).toBeLessThanOrEqual(width(1104));
  });

  test('おにぎりと同じ枠・同じ縁で、輪郭だけが違う', () => {
    const html = hexShield('長野県', 63);
    expect(html).toContain(`viewBox="${SHIELD_VIEWBOX}"`);
    expect(html).toContain(`stroke-width="${SHIELD_STROKE_WIDTH}"`);
    expect(html).toContain(HEX_PATH);
    expect(html).not.toContain(SHIELD_PATH);
  });

  test('小さい版は class で区別する', () => {
    expect(hexShield('長野県', 63, true)).toContain('class="shield hex sm"');
    expect(hexShield('長野県', 63, false)).toContain('class="shield hex"');
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
