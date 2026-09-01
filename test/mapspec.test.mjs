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
  clickableHitLayers,
  colorByRank,
  EXCLUDE_FROM_ROADS_LAYER,
  FILTERED_LAYERS,
  formerOpacity,
  hasRef,
  hitLayerId,
  inkByRank,
  kindTest,
  NOTHING,
  PREF_CLICKABLE_LAYERS,
  PREF_GENERAL,
  PREF_GENERAL_INK,
  PREF_KIND_DRIVEABLE,
  PREF_MAJOR,
  PREF_PICKED_LAYER,
  PREF_POPUP_MINZOOM,
  PREF_SOURCE,
  pickedFilter,
  prefClickableHitLayers,
  prefLabelLayer,
  prefLayers,
  prefLineLayers,
  routeLayers,
  routeSources,
  SPECIAL_KINDS,
  shownSystems,
  terminiFilter,
  withKind,
  withPrefSelection,
} from '../web/mapspec.mjs';

/** interpolate 式の各段が、元の式の同じ段より一定量だけ大きいことを確かめる。 */
function stopAdds(widenedExpr, baseExpr) {
  const widenedStops = widenedExpr.slice(3);
  const baseStops = baseExpr.slice(3);
  const adds = [];
  for (let i = 1; i < widenedStops.length; i += 2) {
    expect(widenedStops[i]).toEqual(['+', baseStops[i], widenedStops[i][2]]);
    adds.push(widenedStops[i][2]);
  }
  return adds;
}

/* -------------------------------------------------------------- 絞り込み --- */

/* 選択は系統をまたいで一つです。どちらかの系統で 1 本でも選んだら、地図に
 * 残るのは選んだ道路だけになります——国道を選べば都道府県道は消え、都道府県道を
 * 選べば国道が消えます。どちらかが上位ということはありません。 */
describe('shownSystems', () => {
  const shown = (o) =>
    shownSystems({
      national: true,
      pref: true,
      selected: 0,
      prefSelected: 0,
      ...o,
    });

  test('選択が空なら両方とも出す', () => {
    // 空は「何も出ていない」ではなく「全部出ている」を意味します。
    expect(shown({})).toEqual({ national: true, pref: true });
  });

  test('国道を選ぶと都道府県道は消える', () => {
    expect(shown({ selected: 1 })).toEqual({ national: true, pref: false });
  });

  test('都道府県道を選ぶと国道は消える', () => {
    expect(shown({ prefSelected: 1 })).toEqual({ national: false, pref: true });
  });

  test('両方から選んでいれば両方とも出す', () => {
    expect(shown({ selected: 2, prefSelected: 1 })).toEqual({
      national: true,
      pref: true,
    });
  });

  /* 系統トグル(表示の面の「国道」「都道府県道」)は選択とは別の物です。
     選択に関わりなく、消してあれば消えたままです。 */
  test('系統トグルは選択より後に効く', () => {
    expect(shown({ national: false })).toEqual({ national: false, pref: true });
    expect(shown({ pref: false, selected: 1 })).toEqual({
      national: true,
      pref: false,
    });
    // 選んだ系統そのものを消してあれば、選んでいても出ない。
    expect(shown({ national: false, selected: 1 })).toEqual({
      national: false,
      pref: false,
    });
  });
});
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

describe('withPrefSelection', () => {
  test('選択が空なら、渡された式をそのまま返す', () => {
    const base = kindTest(['road']);
    expect(withPrefSelection(base, [])).toBe(base);
    expect(withPrefSelection(true, [])).toBe(true);
  });

  /* 鍵は県を伴う文字列です。番号は県の中でしか一意でないので、`63` では
     47 本のどれか決まりません(prefroute.mjs)。 */
  test('選択は県を伴う鍵で any に並べる', () => {
    expect(withPrefSelection(true, ['nagano-63'])).toEqual([
      'any',
      hasRef('nagano-63'),
    ]);
  });

  test('層が持っている式には all で重ねる', () => {
    const base = kindTest(['road']);
    expect(withPrefSelection(base, ['nagano-63', 'tokyo-18'])).toEqual([
      'all',
      base,
      ['any', hasRef('nagano-63'), hasRef('tokyo-18')],
    ]);
  });

  /* 区切り文字で囲む防ぎは国道と同じ式が持ちます。`nagano-6` が
     `nagano-63` に当たってはなりません。 */
  test('鍵は区切り文字で囲まれる', () => {
    expect(hasRef('nagano-6')).toEqual(['in', ',nagano-6,', ['get', 'refs']]);
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

describe('terminiFilter', () => {
  test('選んでいなければ、共有地点だけに絞る', () => {
    // 単独区間の端点は片方の路線しか無く、地図の上で意味を持ちません(#117)。
    expect(terminiFilter([])).toEqual(['==', ['get', 'shared'], 1]);
  });

  test('選んでいれば、その路線が絡む共有地点だけにさらに絞る', () => {
    expect(terminiFilter([18])).toEqual([
      'all',
      ['==', ['get', 'shared'], 1],
      ['any', hasRef(18)],
    ]);
  });

  test('選択が複数でも any で束ねる', () => {
    expect(terminiFilter([18, 117])).toEqual([
      'all',
      ['==', ['get', 'shared'], 1],
      ['any', hasRef(18), hasRef(117)],
    ]);
  });
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

/* ------------------------------------------------------------ 当たり判定 --- */
/* 見た目の太さは重用の深さを読ませる符牒なので広げられない。押しやすさは、
 * 見た目とは別の透明な層(clickableHitLayers)だけを太らせて確保する。 */
describe('当たり判定の透明な層', () => {
  const layers = routeLayers();
  const byId = new Map(layers.map((l) => [l.id, l]));
  const hits = clickableHitLayers();

  test('見た目のレイヤー 1 つにつき 1 つ、当たり判定の層を持つ', () => {
    expect(hits.map((l) => l.id)).toEqual(CLICKABLE_LAYERS.map(hitLayerId));
  });

  test('id は見た目のレイヤーとぶつからない', () => {
    const visibleIds = new Set(layers.map((l) => l.id));
    for (const l of hits) expect(visibleIds.has(l.id)).toBe(false);
  });

  test('描かれない(不透明度 0)が、線としては見た目より太い', () => {
    for (const l of hits) {
      const source = byId.get(l.id.replace(/-hit$/, ''));
      expect(l.paint['line-opacity']).toBe(0);
      expect(l.source).toBe(source.source);
      expect(l['source-layer']).toBe(source['source-layer']);
      const adds = stopAdds(l.paint['line-width'], source.paint['line-width']);
      for (const add of adds) expect(add).toBeGreaterThan(0);
      // 太らせる量はズームによらず一定である——狙いやすさは画面上の距離で
      // 決まり、縮尺では決まらないため。
      expect(new Set(adds).size).toBe(1);
    }
  });
});

describe('都道府県道の当たり判定の透明な層', () => {
  const layers = prefLineLayers();
  const byId = new Map(layers.map((l) => [l.id, l]));
  const hits = prefClickableHitLayers();

  test('見た目のレイヤー 1 つにつき 1 つ、当たり判定の層を持つ', () => {
    expect(hits.map((l) => l.id)).toEqual(
      PREF_CLICKABLE_LAYERS.map(hitLayerId),
    );
  });

  test('id は国道・都道府県道どちらの見た目のレイヤーともぶつからない', () => {
    const visibleIds = new Set([
      ...layers.map((l) => l.id),
      ...routeLayers().map((l) => l.id),
    ]);
    for (const l of hits) expect(visibleIds.has(l.id)).toBe(false);
  });

  test('描かれない(不透明度 0)が、線としては見た目より太い', () => {
    for (const l of hits) {
      const source = byId.get(l.id.replace(/-hit$/, ''));
      expect(l.paint['line-opacity']).toBe(0);
      const adds = stopAdds(l.paint['line-width'], source.paint['line-width']);
      for (const add of adds) expect(add).toBeGreaterThan(0);
      expect(new Set(adds).size).toBe(1);
    }
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
  const sources = routeSources(
    'data/national-routes.pmtiles',
    'data/prefectural-routes.pmtiles',
  );

  test('アーカイブに maxzoom を書き足さない', () => {
    // アーカイブ自身が持つ範囲を TileJSON が伝えます。ここで重ねて述べると、
    // 実際には無い zoom を要求して、それより下が何も出ないまま消えます。
    expect(sources.routes.maxzoom).toBeUndefined();
    expect(sources.routes.url).toBe('pmtiles://data/national-routes.pmtiles');
  });

  test('都道府県道は別のソースで、こちらも zoom を書き足さない', () => {
    // アーカイブは #100 で二つに分かれました。国道の 55.9 MB を県道を直すたびに
    // 上げ直さずに済み、県道側が壊れても国道の地図は出ます。
    expect(sources[PREF_SOURCE].maxzoom).toBeUndefined();
    expect(sources[PREF_SOURCE].url).toBe(
      'pmtiles://data/prefectural-routes.pmtiles',
    );
  });

  test('起終点は GeoJSON で、最初は空である', () => {
    expect(sources.termini.type).toBe('geojson');
    expect(sources.termini.data.features).toEqual([]);
  });
});

/* ---------------------------------------------------------- 都道府県道 --- */
describe('都道府県道のレイヤー', () => {
  const lines = prefLineLayers();
  const labels = prefLabelLayer();
  const all = prefLayers();
  // 影(pref-picked)は「押されているアークの下」を示す層で、路線を描く層では
  // ありません。国道の picked と同じ扱いで、道の体裁を問う検査からは外します。
  const drawn = lines.filter((l) => l.id !== PREF_PICKED_LAYER);

  test('層はすべて都道府県道のソースを読み、source-layer を名乗る', () => {
    for (const l of all) {
      expect(l.source).toBe(PREF_SOURCE);
      expect(l['source-layer']).toBe('routes');
    }
  });

  test('id は国道の層とぶつからない', () => {
    const national = new Set(routeLayers().map((l) => l.id));
    for (const l of all) expect(national.has(l.id)).toBe(false);
  });

  test('prefLayers は線の層と札の層の全部である', () => {
    expect(all.map((l) => l.id)).toEqual([
      ...lines.map((l) => l.id),
      labels.id,
    ]);
  });

  test('走れる区分と走れない区分で、アークを重複も脱落も無く分ける', () => {
    // 実線の層と破線の層は互いの否定です。片方だけを直すと、どちらにも
    // 入らないアークが黙って消えるか、同じ線が二度描かれます。
    const solid = drawn.filter((l) => l.id !== 'pref-special');
    for (const l of solid) {
      expect(l.filter).toEqual(kindTest(PREF_KIND_DRIVEABLE));
    }
    expect(drawn.find((l) => l.id === 'pref-special').filter).toEqual([
      '!',
      kindTest(PREF_KIND_DRIVEABLE),
    ]);
  });

  test('走れない区分だけが破線である', () => {
    for (const l of lines) {
      const dashed = l.paint['line-dasharray'] !== undefined;
      expect(dashed).toBe(l.id === 'pref-special');
    }
  });

  test('線も札も former で不透明度を下げる', () => {
    // 旧道は除外せず薄く描きます。国道と同じ扱いです。
    for (const l of drawn) {
      const base = l.paint['line-opacity'][3];
      expect(l.paint['line-opacity']).toEqual(formerOpacity(base));
    }
    expect(labels.paint['text-opacity']).toEqual(formerOpacity());
  });

  test('色は格を述べ、重用の深さは述べない', () => {
    // 国道が既に四色を重用の深さに使っています。同じ画面で八色を配ると、
    // どの色が何を述べているかが読めなくなります。
    expect(colorByRank).toEqual([
      'match',
      ['get', 'rank'],
      'major',
      PREF_MAJOR,
      PREF_GENERAL,
    ]);
    for (const l of drawn) {
      if (l.id === 'pref-casing') continue;
      expect(l.paint['line-color']).toEqual(colorByRank);
    }
    expect(labels.paint['text-color']).toEqual(inkByRank);
  });

  test('札の字は線より濃い。主要地方道だけは同じ色でよい', () => {
    // #8CBF4A は線としては読めますが、字としては白い地に対して 2.15:1 です。
    // 線は幅を持つので形が出ますが、字は画線が細く、同じ明るさでは読めません。
    expect(inkByRank[3]).toBe(colorByRank[3]);
    expect(inkByRank[4]).not.toBe(colorByRank[4]);
    expect(inkByRank[4]).toBe(PREF_GENERAL_INK);
  });

  test('影の層はいちばん下で、押されるまで何も描かない', () => {
    // 国道の picked と同じ役目です。層を分けてあるのは、国道と重用する県道の
    // アークが二つのアーカイブに同じ way id で入っているためで、一つにすると
    // 県道を押したときに国道の線が光ります。
    expect(lines[0].id).toBe(PREF_PICKED_LAYER);
    expect(lines[0].filter).toEqual(NOTHING);
    expect(lines[0].paint['line-color']).toBe('#000000');
  });

  test('押されて答えるのは実線と破線の層だけである', () => {
    const ids = new Set(all.map((l) => l.id));
    for (const id of PREF_CLICKABLE_LAYERS) expect(ids.has(id)).toBe(true);
    expect(PREF_CLICKABLE_LAYERS).not.toContain(PREF_PICKED_LAYER);
    expect(PREF_CLICKABLE_LAYERS).not.toContain('pref-casing');
    expect(PREF_CLICKABLE_LAYERS).not.toContain('pref-labels');
  });

  test('ポップアップを組めるのは z8 から', () => {
    // z0-7 のタイルは id・name・km・src を落としてあります
    // (pipeline/pack_web_pref.mjs)。国道はこの制限を持ちません。
    expect(PREF_POPUP_MINZOOM).toBe(8);
  });

  test('主要地方道のほうが太い', () => {
    // 太さは格と重用の両方を述べます。ここで見るのは格の側です。
    const mult = (l) => l.paint['line-width'];
    for (const l of lines) {
      expect(JSON.stringify(mult(l))).toContain('"major",1.2,0.85');
    }
  });

  test('札だけが z8 から出る。線にズーム下限は無い', () => {
    // 縮尺で番号を省略しないのがこの地図の存在理由です。線は z0 から出ます。
    // 札が z8 からなのは、z0-7 のタイルが `label` を持たないためです(#100)。
    for (const l of lines) expect(l.minzoom).toBeUndefined();
    expect(labels.minzoom).toBe(8);
  });
});
