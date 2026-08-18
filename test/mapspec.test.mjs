/* The filter expressions, and the wiring between the layers and the code that
 * switches them.
 *
 * check_expressions.mjs already asks MapLibre whether these are *legal*, and
 * evaluates them over real arcs when a region has been built. What it cannot
 * ask is whether they mean the right thing when nothing is selected, or
 * whether the table app.js drives the layers from still names layers that
 * exist. Those are questions about the shape of the code, so they live here
 * and run everywhere.
 */
import { describe, expect, test } from 'bun:test';

import {
  buildFilter,
  CLICKABLE_LAYERS,
  EXCLUDE_FROM_ROADS_LAYER,
  FILTERED_LAYERS,
  hasRef,
  kindTest,
  NOTHING,
  pickedFilter,
  routeLayers,
  routeSources,
  SPECIAL_KINDS,
  withKind,
} from '../web/mapspec.mjs';

/* ------------------------------------------------------------- filtering --- */
describe('buildFilter', () => {
  test('選択も強調も無ければ、絞り込まない', () => {
    // `true` は「全部通す」であって、空の ['all'] ではない。ここを配列にすると
    // 何も描かれない側に倒れる。
    expect(buildFilter([], 'off')).toBe(true);
  });

  test('選択があれば any で並べる', () => {
    expect(buildFilter([18], 'off')).toEqual(['all', ['any', hasRef(18)]]);
  });

  test('重用のみは n>=2 で、選択とは独立に効く', () => {
    // 重用かどうかは道路の性質であって選択の結果ではない。18 と 117 が重なる
    // 区間は、両方を選んでいなくても重用区間である。
    expect(buildFilter([], 'all')).toEqual(['all', ['>=', ['get', 'n'], 2]]);
    expect(buildFilter([18], 'all')).toEqual([
      'all',
      ['any', hasRef(18)],
      ['>=', ['get', 'n'], 2],
    ]);
  });
});

describe('hasRef', () => {
  test('区切り文字で囲むので、部分一致で誤爆しない', () => {
    // これを `['in', '4', ['get','refs']]` と書くと 14 号も 400 号も引っ掛かる。
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
    // `if (!id)` と書くと 0 が null と同じ扱いになる。
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

/* ------------------------------------------------------------ the wiring --- */
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
    // 実在する走行可能な車道である。破線にすると走れない道と紛れる。
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
    // 破線と高速道路は roads から外してある。外したなら、代わりに自分の
    // レイヤーで描かれていなければ、その種別はどこにも出ない。
    const shown = new Set(
      FILTERED_LAYERS.filter((l) => l.kinds && !l.negate).flatMap(
        (l) => l.kinds,
      ),
    );
    for (const kind of EXCLUDE_FROM_ROADS_LAYER)
      expect(shown.has(kind)).toBe(true);
  });
});

describe('ソース', () => {
  const sources = routeSources('data/national-routes.pmtiles');

  test('アーカイブに maxzoom を書き足さない', () => {
    // アーカイブ自身が持つ範囲を TileJSON が伝える。ここで重ねて述べると、
    // 実際には無い zoom を要求して、それより下が黙って消える。
    expect(sources.routes.maxzoom).toBeUndefined();
    expect(sources.routes.url).toBe('pmtiles://data/national-routes.pmtiles');
  });

  test('起終点は GeoJSON で、最初は空である', () => {
    expect(sources.termini.type).toBe('geojson');
    expect(sources.termini.data.features).toEqual([]);
  });
});
