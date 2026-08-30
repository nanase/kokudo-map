/* 絞り込み式と、層とそれを切り替えるコードの対応づけ。
 *
 * これが MapLibre の仕様に適合するかは check_expressions.mjs が既に訊いており、
 * 地域が生成済みなら実データのアークで評価もします。そちらが訊けないのは、
 * 何も選んでいないときに式が正しい意味になるか、app.js が層を動かすのに使う表が
 * 実在する層を指しているか、です。どちらもコードの形についての問いなので、
 * ここに置いてどこでも走らせます。
 */
import { describe, expect, test } from 'bun:test';

import {
  buildFilter,
  CLICKABLE_LAYERS,
  EXCLUDE_FROM_ROADS_LAYER,
  FILTERED_LAYERS,
  formerOpacity,
  hasRef,
  kindTest,
  NOTHING,
  pickedFilter,
  routeLayers,
  routeSources,
  SPECIAL_KINDS,
  withKind,
} from '../web/mapspec.mjs';

/* -------------------------------------------------------------- 絞り込み --- */
describe('buildFilter', () => {
  test('選択も強調も無ければ、絞り込まない', () => {
    // `true` は「全部通す」であって、空の ['all'] ではありません。ここを配列にすると
    // 何も描かれない側に倒れます。
    expect(buildFilter([], 'off')).toBe(true);
  });

  test('選択があれば any で並べる', () => {
    expect(buildFilter([18], 'off')).toEqual(['all', ['any', hasRef(18)]]);
  });

  test('重用のみは n>=2 で、選択とは独立に効く', () => {
    // 重用かどうかは道路の性質であって選択の結果ではありません。18 と 117 が重なる
    // 区間は、両方を選んでいなくても重用区間です。
    expect(buildFilter([], 'all')).toEqual(['all', ['>=', ['get', 'n'], 2]]);
    expect(buildFilter([18], 'all')).toEqual([
      'all',
      ['any', hasRef(18)],
      ['>=', ['get', 'n'], 2],
    ]);
  });

  test('既定では旧道も含む', () => {
    expect(buildFilter([], 'off')).toBe(true);
    expect(buildFilter([], 'off', true)).toBe(true);
  });

  test('旧道を隠すときは former を除く条件を足す', () => {
    expect(buildFilter([], 'off', false)).toEqual([
      'all',
      ['!=', ['get', 'former'], 1],
    ]);
    expect(buildFilter([18], 'all', false)).toEqual([
      'all',
      ['any', hasRef(18)],
      ['>=', ['get', 'n'], 2],
      ['!=', ['get', 'former'], 1],
    ]);
  });
});

describe('hasRef', () => {
  test('区切り文字で囲むので、部分一致で誤爆しない', () => {
    // これを `['in', '4', ['get','refs']]` と書くと 14 号も 400 号も引っ掛かります。
    expect(hasRef(4)).toEqual(['in', ',4,', ['get', 'refs']]);
  });

  test('包含判定を手元で回しても、4 が 14 や 400 を拾わない', () => {
    const refs = ',14,400,';
    expect(refs.includes(',4,')).toBe(false);
    expect(',4,18,'.includes(',4,')).toBe(true);
  });
});

describe('withKind', () => {
  test('絞り込みが無いときは種別だけの式になる', () => {
    expect(withKind(true, ['ferry'], false)).toEqual(kindTest(['ferry']));
  });

  test('否定は種別を外す', () => {
    expect(withKind(true, ['ferry'], true)).toEqual(['!', kindTest(['ferry'])]);
  });

  test('絞り込みがあれば all で束ねる', () => {
    const base = buildFilter([18], 'off');
    expect(withKind(base, ['road'], false)).toEqual([
      'all',
      base,
      kindTest(['road']),
    ]);
  });
});

describe('pickedFilter', () => {
  test('何も選ばれていなければ何も描かない', () => {
    expect(pickedFilter(true, null)).toBe(NOTHING);
    expect(pickedFilter(true, undefined)).toBe(NOTHING);
  });

  test('way id は 0 でも有効な id である', () => {
    // `if (!id)` と書くと 0 が null と同じ扱いになります。
    expect(pickedFilter(true, 0)).toEqual(['==', ['get', 'id'], 0]);
  });

  test('選択から外れたアークは影も残さない', () => {
    const base = buildFilter([18], 'off');
    expect(pickedFilter(base, 42)).toEqual([
      'all',
      base,
      ['==', ['get', 'id'], 42],
    ]);
  });
});

test('NOTHING は実在しない n を要求する', () => {
  expect(NOTHING).toEqual(['==', ['get', 'n'], -1]);
});

/* ---------------------------------------------------------------- 対応づけ --- */
describe('レイヤーと絞り込みの対応', () => {
  const layers = routeLayers();
  const ids = new Set(layers.map((l) => l.id));

  test('絞り込む対象は実在するレイヤーである', () => {
    for (const { id } of FILTERED_LAYERS) expect(ids.has(id)).toBe(true);
  });

  test('押せるレイヤーも実在する', () => {
    for (const id of CLICKABLE_LAYERS) expect(ids.has(id)).toBe(true);
  });

  test('押せるのは道路のレイヤーだけで、影や文字は含まない', () => {
    for (const id of CLICKABLE_LAYERS) {
      expect(layers.find((l) => l.id === id).type).toBe('line');
    }
    expect(CLICKABLE_LAYERS).not.toContain('picked');
    expect(CLICKABLE_LAYERS).not.toContain('casing');
    expect(CLICKABLE_LAYERS).not.toContain('route-labels');
  });

  test('タイルを読むレイヤーは source-layer を必ず名乗る', () => {
    for (const l of layers) {
      if (l.source === 'routes') expect(l['source-layer']).toBe('routes');
    }
  });

  test('各レイヤーの id は一意である', () => {
    expect(ids.size).toBe(layers.length);
  });
});

describe('種別の切り分け', () => {
  test('車道レイヤーから外す種別は、特殊な種別と高速道路の和である', () => {
    for (const k of SPECIAL_KINDS)
      expect(EXCLUDE_FROM_ROADS_LAYER).toContain(k);
    expect(EXCLUDE_FROM_ROADS_LAYER).toContain('expressway');
  });

  test('高速道路は破線の仲間ではない', () => {
    // 実在する走行可能な車道です。破線にすると走れない道と紛れます。
    expect(SPECIAL_KINDS).not.toContain('expressway');
  });

  test('roads と casing は同じ種別を外す', () => {
    const roads = FILTERED_LAYERS.find((l) => l.id === 'roads');
    const casing = FILTERED_LAYERS.find((l) => l.id === 'casing');
    expect(roads.kinds).toEqual(casing.kinds);
    expect(roads.negate).toBe(true);
    expect(casing.negate).toBe(true);
  });

  test('高速道路の線と縁取りは同じ切り替えに従う', () => {
    const line = FILTERED_LAYERS.find((l) => l.id === 'expressway');
    const casing = FILTERED_LAYERS.find((l) => l.id === 'expressway-casing');
    expect(line.toggle).toBe(casing.toggle);
    expect(line.kinds).toEqual(casing.kinds);
  });

  test('切り替えられる種別が、車道レイヤーから外れたままにならない', () => {
    // 破線と高速道路は roads から外してあります。外したなら、代わりに自分の
    // レイヤーで描かれていなければ、その種別はどこにも出ません。
    const shown = new Set(
      FILTERED_LAYERS.filter((l) => l.kinds && !l.negate).flatMap(
        (l) => l.kinds,
      ),
    );
    for (const kind of EXCLUDE_FROM_ROADS_LAYER)
      expect(shown.has(kind)).toBe(true);
  });
});

describe('旧道の不透明度', () => {
  const layers = routeLayers();
  const byId = (id) => layers.find((l) => l.id === id);
  // 影(picked)は「押されているアークの下」を示す層で、former の性質そのものを
  // 表すものではないので対象に含めません。
  const lineLayers = layers.filter(
    (l) => l.type === 'line' && l.id !== 'picked',
  );

  test('道路を描くすべての線レイヤーが former で不透明度を下げる', () => {
    for (const l of lineLayers) {
      // 各レイヤーの元の不透明度を式そのものから読み、その値を通した
      // formerOpacity() と一致するかを見る。実際の値(0.85 か既定の 1)を
      // ここで思い出す必要が無い。
      const base = l.paint['line-opacity'][3];
      expect(l.paint['line-opacity']).toEqual(formerOpacity(base));
    }
  });

  test('路線番号ラベルも former で不透明度を下げる', () => {
    expect(byId('route-labels').paint['text-opacity']).toEqual(formerOpacity());
  });
});

describe('ソース', () => {
  const sources = routeSources('data/national-routes.pmtiles');

  test('アーカイブに maxzoom を書き足さない', () => {
    // アーカイブ自身が持つ範囲を TileJSON が伝えます。ここで重ねて述べると、
    // 実際には無い zoom を要求して、それより下が何も出ないまま消えます。
    expect(sources.routes.maxzoom).toBeUndefined();
    expect(sources.routes.url).toBe('pmtiles://data/national-routes.pmtiles');
  });

  test('起終点は GeoJSON で、最初は空である', () => {
    expect(sources.termini.type).toBe('geojson');
    expect(sources.termini.data.features).toEqual([]);
  });
});
