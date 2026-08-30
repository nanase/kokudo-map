/* 起点・終点を GeoJSON にする。 */
import { describe, expect, test } from 'bun:test';

import { hasRef } from '../web/mapspec.mjs';
import { terminiFeatures } from '../web/termini.mjs';

const META = {
  shared_termini: [{ refs: [7, 8, 17], lon: 139.06, lat: 37.91 }],
  termini: [
    { ref: 18, lon: 138.2, lat: 36.6 },
    { ref: 4, lon: 139.7, lat: 35.6 },
  ],
};

describe('terminiFeatures', () => {
  const fc = terminiFeatures(META);
  const props = (i) => fc.features[i].properties;

  test('共有地点と単独の端点をひとつの層にまとめる', () => {
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(3);
  });

  test('共有地点が先に来る', () => {
    // あとから描かれるものが上に載ります。共有地点のほうが伝える量が多いです。
    expect(props(0).shared).toBe(1);
    expect(props(1).shared).toBe(0);
  });

  test('refs はアークと同じ区切りで書く', () => {
    // 路線を絞る式がひとつで済むのは、この形が揃っているためです。
    expect(props(0).refs).toBe(',7,8,17,');
    expect(props(1).refs).toBe(',18,');
  });

  test('番号の照合が部分一致で誤爆しない', () => {
    // 4 号の端点を、14 号や 400 号の端点として拾ってはいけません。
    const needle = hasRef(4)[1];
    expect(props(2).refs.includes(needle)).toBe(true);
    expect(props(0).refs.includes(needle)).toBe(false);
  });

  test('ラベルは中黒で繋ぐ', () => {
    expect(props(0).label).toBe('7・8・17');
    expect(props(1).label).toBe('18');
  });

  test('count は集まる路線の数である', () => {
    expect(props(0).count).toBe(3);
    expect(props(1).count).toBe(1);
  });

  test('座標は経度・緯度の順である', () => {
    expect(fc.features[0].geometry.coordinates).toEqual([139.06, 37.91]);
  });

  test('端点が無くても空の層を返す', () => {
    expect(
      terminiFeatures({ shared_termini: [], termini: [] }).features,
    ).toEqual([]);
  });
});
