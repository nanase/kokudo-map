/* 「外部サイトで開く」が組む URL。丸めと正規化の境目をここで検査する。
 * web/extlinks.mjs は地図にも DOM にも触れない純関数だけを持つ。 */
import { describe, expect, test } from 'bun:test';

import {
  googleMapsURL,
  googleMapsZoom,
  gsiMapURL,
  gsiZoom,
  normalizeLng,
  round6,
} from '../web/extlinks.mjs';

describe('round6', () => {
  test('小数第 6 位までに丸める', () => {
    expect(round6(35.12345678)).toBe(35.123457);
    expect(round6(139.7)).toBe(139.7);
  });
});

describe('normalizeLng', () => {
  test('範囲内はそのまま', () => {
    expect(normalizeLng(139.767052)).toBeCloseTo(139.767052, 9);
    expect(normalizeLng(-179.5)).toBeCloseTo(-179.5, 9);
  });

  test('180 を超えたら畳む', () => {
    expect(normalizeLng(185)).toBeCloseTo(-175, 9);
    expect(normalizeLng(180)).toBeCloseTo(-180, 9);
  });

  test('-180 を下回っても畳む', () => {
    expect(normalizeLng(-185)).toBeCloseTo(175, 9);
    expect(normalizeLng(-180)).toBeCloseTo(-180, 9);
  });
});

describe('googleMapsZoom', () => {
  test('小数第 2 位までに丸める', () => {
    expect(googleMapsZoom(12.567)).toBe(12.57);
    expect(googleMapsZoom(8.123)).toBe(8.12);
  });

  test('3 未満・21 超は丸める', () => {
    expect(googleMapsZoom(1)).toBe(3);
    expect(googleMapsZoom(2.99)).toBe(3);
    expect(googleMapsZoom(21.01)).toBe(21);
    expect(googleMapsZoom(25)).toBe(21);
  });
});

describe('gsiZoom', () => {
  test('四捨五入で整数の段にする', () => {
    expect(gsiZoom(12.4)).toBe(12);
    expect(gsiZoom(12.5)).toBe(13);
    expect(gsiZoom(12.6)).toBe(13);
  });

  test('5 未満・18 超は丸める', () => {
    expect(gsiZoom(4)).toBe(5);
    expect(gsiZoom(0)).toBe(5);
    expect(gsiZoom(18.6)).toBe(18);
    expect(gsiZoom(25)).toBe(18);
  });
});

describe('googleMapsURL', () => {
  test('中心と縮尺を @lat,lng,zoomz へ組む', () => {
    expect(googleMapsURL({ lat: 36.651289, lng: 138.180962, zoom: 12.3 })).toBe(
      'https://www.google.com/maps/@36.651289,138.180962,12.3z',
    );
  });

  test('丸めと正規化を通してから組む', () => {
    expect(
      googleMapsURL({ lat: 35.12345678, lng: 185.123456789, zoom: 25 }),
    ).toBe('https://www.google.com/maps/@35.123457,-174.876543,21z');
  });

  // 丸めで 180 ちょうどに繰り上がる値は、丸めた後にもう一度正規化しないと
  // normalizeLng() の「180 未満」の約束を破って 180 のまま出てしまう。
  test('丸めた結果が 180 になる値も正規化される', () => {
    expect(googleMapsURL({ lat: 0, lng: 179.9999999, zoom: 10 })).toBe(
      'https://www.google.com/maps/@0,-180,10z',
    );
  });
});

describe('gsiMapURL', () => {
  test('#zoom/lat/lng/ へ組む', () => {
    expect(gsiMapURL({ lat: 36.651289, lng: 138.180962, zoom: 12 })).toBe(
      'https://maps.gsi.go.jp/#12/36.651289/138.180962/',
    );
  });

  test('丸めと正規化を通してから組む', () => {
    expect(gsiMapURL({ lat: -89.999999999, lng: -185, zoom: 1 })).toBe(
      'https://maps.gsi.go.jp/#5/-90/175/',
    );
  });
});
