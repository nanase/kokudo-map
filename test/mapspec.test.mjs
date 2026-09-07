/* 絞り込み式と、層とそれを切り替えるコードの対応づけ。MapLibre の仕様への適合は
 * check_expressions.mjs が既に確かめ、地域が生成済みなら実データでも
 * 評価します。そちらが確かめられないのは、何も選んでいないときに式が正しい
 * 意味になるか、app.js が層を動かすのに使う表が実在する層を指しているか、です。
 * どちらもコードの形についての問いなので、ここに置いてどこでも走らせます。
 *
 * 式を評価する検査も一つだけ置いています(「重用の絞り込みが層まで届く」)。
 * 作り物のアークを相手にするので生成物が要らず、データを持たない clone でも
 * 走ります。実データでの突き合わせは check_expressions.mjs の役目です。
 */
import { describe, expect, test } from 'bun:test';
import spec from '@maplibre/maplibre-gl-style-spec';

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
  KINDS_BY_TOGGLE,
  kindTest,
  layerFilter,
  NOTHING,
  PREF_CASING,
  PREF_CASING_LAYER,
  PREF_CASING_PHOTO_MAJOR,
  PREF_CLICKABLE_LAYERS,
  PREF_DEFAULT_FILTERS,
  PREF_FILTERED_LAYERS,
  PREF_GENERAL,
  PREF_GENERAL_INK,
  PREF_KIND_DRIVEABLE,
  PREF_MAJOR,
  PREF_MAJOR_INK,
  PREF_PICKED_LAYER,
  PREF_POPUP_MINZOOM,
  PREF_SOURCE,
  pickedFilter,
  prefCasingColor,
  prefClickableHitLayers,
  prefLabelLayer,
  prefLayerFilter,
  prefLayers,
  prefLineLayers,
  resolvedPrefFilter,
  routeLayers,
  routeSources,
  SPECIAL_KINDS,
  shownSystems,
  terminiFilter,
  withKind,
} from '../web/mapspec.mjs';

/** interpolate 式の各段が、元の式の同じ段より一定量だけ大きいことを
 * 確かめる。 */
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
 * 残るのは選んだ道路だけになります。 */
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

  /* 系統トグル(表示のポップオーバーの「国道」「都道府県道」)は選択とは別の
   * 物です。選択に関わりなく、消してあれば消えたままです。 */
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
    // `true` は「全部通す」であって、空の ['all'] ではありません。ここを
    // 配列にすると何も描かれない側に倒れます。
    expect(buildFilter([], 'off')).toBe(true);
  });

  test('選択があれば any で並べる', () => {
    expect(buildFilter([18], 'off')).toEqual(['all', ['any', hasRef(18)]]);
  });

  test('重用のみは n>=2 で、選択とは独立に効く', () => {
    // 重用かどうかは道路の性質であって選択の結果ではありません。18 と 117 が
    // 重なる区間は、両方を選んでいなくても重用区間です。
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
    // これを `['in', '4', ['get','refs']]` と書くと 14 号も 400 号も
    // 引っ掛かります。
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

describe('resolvedPrefFilter', () => {
  /* 区切り文字で囲む防ぎは国道と同じ式が持つ。`nagano-6` が `nagano-63` に
   * 当たってはならない。 */
  test('選択のキーは県を伴い、区切り文字で囲まれる', () => {
    expect(hasRef('nagano-6')).toEqual(['in', ',nagano-6,', ['get', 'refs']]);
  });

  test('prefBase が true(絞り込み無し)なら、既定の区分の式だけになる', () => {
    const defaultFilter = kindTest(['road']);
    expect(resolvedPrefFilter(defaultFilter, true)).toBe(defaultFilter);
  });

  test('既定の式が true(区分を選ばない層)なら、prefBase だけになる', () => {
    const prefBase = buildFilter(['nagano-63'], 'off');
    expect(resolvedPrefFilter(true, prefBase)).toBe(prefBase);
  });

  test('両方あれば all で重ねる', () => {
    const defaultFilter = kindTest(['road', 'expressway']);
    const prefBase = buildFilter(['nagano-63'], 'all', false);
    expect(resolvedPrefFilter(defaultFilter, prefBase)).toEqual([
      'all',
      defaultFilter,
      prefBase,
    ]);
  });

  /* 自動車専用道路トグルが切のとき、既定の区分からさらに外す。国道の roads が
   * EXCLUDE_FROM_ROADS_LAYER を負で外すのと同じ考えである。 */
  test('excludeKinds は既定の区分からさらに外す', () => {
    const defaultFilter = kindTest(['road', 'expressway']);
    expect(resolvedPrefFilter(defaultFilter, true, ['expressway'])).toEqual([
      'all',
      defaultFilter,
      ['!', kindTest(['expressway'])],
    ]);
  });
});

/* 「重用区間のみ」は共有の buildFilter が持ちますが、画面に効くのは層ごとに
 * 組み直した後の式です(app.js の applyFilters)。国道は共有の式へ区分を足し
 * (withKind)、都道府県道は層が持つ区分の式へ共有の式を重ねます
 * (resolvedPrefFilter)。順序が逆なので、片方だけを見ても足りません。
 *
 * ここは式の形ではなく、式を評価した結果を見ます。上の describe が確かめるのは
 * 組み上がった配列の形で、その形が MapLibre の目にどのアークとして映るかまでは
 * 述べていません。#187 で「重用区間のみ」が都道府県道に効かないという報告を
 * 調べ、実装は正しいと分かりましたが、そのとき壊れていても検査は通ることも
 * 分かりました。ここはその穴を塞ぎます。
 *
 * 層ごとの期待は書きません。どの区分を通すかは層自身が持っており、ここへ
 * 書き写せば写しを検査することになります。代わりに同じ層へ「強調なし」と
 * 「重用区間のみ」の二通りを通し、後者が前者の n>=2 の部分と過不足なく
 * 一致することを見ます。層の区分を知らなくても言える不変です。
 */
describe('重用の絞り込みが層まで届く', () => {
  /* 式を評価して確かめるための、作り物のアーク。区分は書き並べず、層が使う
   * 区分の定義そのものから作ります。区分が増えたときに、この並びだけが古く
   * なることを避けるためです。
   *
   * 系統ごとに 1 組ずつ持ちます。選択の鍵の形が違い(国道は番号、都道府県道は
   * `nagano-63` の県つきの文字列)、実データでもアーカイブが分かれているため
   * です。`refs` は `n` と辻褄が合う長さにし、先頭は必ず選択に使う 1 本に
   * します。そうしないと、選択を重ねた場面で単独指定のアークが 1 本も残らず、
   * 比べる土台が消えます。 */
  const KINDS = [
    ...new Set([...EXCLUDE_FROM_ROADS_LAYER, ...PREF_KIND_DRIVEABLE]),
  ];
  const GEOMETRY = {
    type: 'LineString',
    coordinates: [
      [138, 36],
      [138.1, 36.1],
    ],
  };
  const arcsAnchoredOn = (anchor, others) =>
    KINDS.flatMap((kind) =>
      [1, 2, 3, 4].flatMap((n) =>
        ['major', 'general'].map((rank) => ({
          kind,
          rank,
          n,
          former: 0,
          refs: `,${[anchor, ...others].slice(0, n).join(',')},`,
        })),
      ),
    );
  const ARCS = arcsAnchoredOn(18, [117, 406, 292]);
  const PREF_ARCS = arcsAnchoredOn('nagano-63', [
    'nagano-80',
    'nagano-14',
    'nagano-2',
  ]);

  const compile = (filter) => {
    // 選択も重用も旧道も無いとき、共有の式は真値そのものになります
    // (buildFilter)。式ではないので createExpression には渡せません。
    if (filter === true) return () => true;
    const r = spec.expression.createExpression(filter, { type: 'boolean' });
    expect(r.result).toBe('success');
    return (properties) =>
      r.value.evaluate(
        { zoom: 10 },
        { type: 'Feature', properties, geometry: GEOMETRY },
      ) === true;
  };

  /** 式を通ったアーク。集合として比べるために添字で持ちます。 */
  const passing = (filter, arcs) => {
    const fn = compile(filter);
    return new Set(arcs.map((a, i) => (fn(a) ? i : -1)).filter((i) => i >= 0));
  };

  const holds = (filterFor, arcs) => {
    const off = passing(filterFor('off'), arcs);
    // 層が単独指定も重用も通していなければ、下の一致は空集合どうしの一致に
    // なり、何も述べません。先に土台を確かめます。
    expect([...off].some((i) => arcs[i].n === 1)).toBe(true);
    expect([...off].some((i) => arcs[i].n >= 2)).toBe(true);
    expect(passing(filterFor('all'), arcs)).toEqual(
      new Set([...off].filter((i) => arcs[i].n >= 2)),
    );
  };

  test('国道の各層で、重用のみが強調なしの n>=2 の部分と一致する', () => {
    for (const { kinds, negate } of FILTERED_LAYERS) {
      holds((conc) => {
        const base = buildFilter([], conc);
        return kinds ? withKind(base, kinds, negate) : base;
      }, ARCS);
    }
  });

  test('都道府県道の各層でも一致する', () => {
    for (const { id } of PREF_FILTERED_LAYERS) {
      holds(
        (conc) =>
          resolvedPrefFilter(
            PREF_DEFAULT_FILTERS.get(id),
            buildFilter([], conc),
          ),
        PREF_ARCS,
      );
    }
  });

  /* 自動車専用道路のトグルが切のとき、都道府県道は層ごと消さずに区分だけを
   * 外します(app.js の applyFilters)。式の重なりが一段深くなる経路なので、
   * ここも通します。 */
  test('自動車専用道路を外した都道府県道の層でも一致する', () => {
    for (const { id, excludeKinds } of PREF_FILTERED_LAYERS) {
      if (!excludeKinds) continue;
      holds(
        (conc) =>
          resolvedPrefFilter(
            PREF_DEFAULT_FILTERS.get(id),
            buildFilter([], conc),
            excludeKinds,
          ),
        PREF_ARCS,
      );
    }
  });

  test('路線を選んでいても、重用の絞り込みは同じように効く', () => {
    // 重用は道路の性質であって選択の結果ではありません(buildFilter)。選択を
    // 重ねても、残るのは選んだ路線の重用区間だけです。
    holds(
      (conc) =>
        withKind(buildFilter([18], conc), EXCLUDE_FROM_ROADS_LAYER, true),
      ARCS,
    );
    holds(
      (conc) =>
        resolvedPrefFilter(
          PREF_DEFAULT_FILTERS.get('pref-roads'),
          buildFilter(['nagano-63'], conc),
        ),
      PREF_ARCS,
    );
  });
});

describe('PREF_FILTERED_LAYERS', () => {
  const ids = new Set(prefLineLayers().map((l) => l.id));
  ids.add(prefLabelLayer().id);

  test('絞り込む対象は実在する都道府県道の層である', () => {
    for (const { id } of PREF_FILTERED_LAYERS) expect(ids.has(id)).toBe(true);
  });

  test('縁取りと実線は同じ自動車専用道路のトグルに従う', () => {
    const casing = PREF_FILTERED_LAYERS.find((l) => l.id === PREF_CASING_LAYER);
    const roads = PREF_FILTERED_LAYERS.find((l) => l.id === 'pref-roads');
    expect(casing.excludeToggle).toBe('expressway');
    expect(casing.excludeToggle).toBe(roads.excludeToggle);
    expect(casing.excludeKinds).toEqual(roads.excludeKinds);
  });

  /* road と expressway を両方描く 1 層なので、自動車専用道路を切っても層ごと
   * 消してはならない。消すと road まで巻き添えで消え、県道が 1 本も出なくなる
   * (issue #171 の実装で一度この形の不具合を作った)。 */
  test('自動車専用道路トグルは pref-roads・pref-casing を層ごと消さない', () => {
    const casing = PREF_FILTERED_LAYERS.find((l) => l.id === PREF_CASING_LAYER);
    const roads = PREF_FILTERED_LAYERS.find((l) => l.id === 'pref-roads');
    expect(casing.toggle).toBeUndefined();
    expect(roads.toggle).toBeUndefined();
  });

  test('走行不能区間(pref-special)は国道の special・ferry とは別のトグルを持ち、層ごと消える', () => {
    const special = PREF_FILTERED_LAYERS.find((l) => l.id === 'pref-special');
    expect(special.toggle).toBe('prefSpecial');
    expect(special.excludeToggle).toBeUndefined();
  });

  test('路線番号(pref-labels)は国道と同じ labels トグルに従う', () => {
    const labels = PREF_FILTERED_LAYERS.find((l) => l.id === 'pref-labels');
    expect(labels.toggle).toBe('labels');
  });
});

/* 「表示」の面のトグル。どれが在るかは層の表が答えるので、書き写さずに作ります。 */
const ALL_ON = Object.fromEntries(
  [...FILTERED_LAYERS, ...PREF_FILTERED_LAYERS]
    .flatMap((l) => [l.toggle, l.excludeToggle, l.keepToggle])
    .filter(Boolean)
    .map((name) => [name, true]),
);
const toggles = (off) => ({ ...ALL_ON, ...off });

describe('KINDS_BY_TOGGLE', () => {
  test('区分のトグルは、線の層が描く区分から導かれる', () => {
    expect([...KINDS_BY_TOGGLE.keys()].sort()).toEqual([
      'expressway',
      'ferry',
      'special',
    ]);
    expect(KINDS_BY_TOGGLE.get('expressway')).toEqual(['expressway']);
    expect(KINDS_BY_TOGGLE.get('ferry')).toEqual(['ferry']);
    // 「点線国道・工事中・未開通」は三つの層(construction・unopened・foot)を
    // 一つのトグルで切ります。航路は別のトグルなので入りません。
    expect(KINDS_BY_TOGGLE.get('special')).toEqual([
      'construction',
      'unopened',
      'foot',
      'steps',
    ]);
  });

  test('区分を外す側の層(roads・casing)は、トグルの区分を答えない', () => {
    // 負の層は「その区分を描く層」ではないので、混ぜると `road` まで隠れます。
    for (const kinds of KINDS_BY_TOGGLE.values())
      expect(kinds).not.toContain('road');
  });
});

/* 区分のトグルを切ると、線と一緒に番号のラベルも消えます(#187)。ラベルの層は
 * 区分をまたいで 1 つしかないので、層ごと消すのではなく式で区分を外します。 */
describe('layerFilter', () => {
  const labels = FILTERED_LAYERS.find((l) => l.id === 'route-labels');
  const roads = FILTERED_LAYERS.find((l) => l.id === 'roads');
  const ferry = FILTERED_LAYERS.find((l) => l.id === 'ferry');

  test('区分を持つ層は、共有の式に区分を足す', () => {
    const base = buildFilter([18], 'off');
    expect(layerFilter(roads, base, ALL_ON)).toEqual(
      withKind(base, EXCLUDE_FROM_ROADS_LAYER, true),
    );
  });

  test('トグルが切なら、区分を持つ層は層ごと消える', () => {
    expect(layerFilter(ferry, true, toggles({ ferry: false }))).toBe(NOTHING);
  });

  test('区分のトグルが全部入なら、ラベルは共有の式のままである', () => {
    const base = buildFilter([18], 'all', false);
    expect(layerFilter(labels, base, ALL_ON)).toBe(base);
  });

  test('海上国道を切ると、番号のラベルからも航路が外れる', () => {
    expect(layerFilter(labels, true, toggles({ ferry: false }))).toEqual([
      '!',
      kindTest(['ferry']),
    ]);
  });

  test('点線国道・工事中・未開通を切ると、その三つの区分が外れる', () => {
    expect(layerFilter(labels, true, toggles({ special: false }))).toEqual([
      '!',
      kindTest(['construction', 'unopened', 'foot', 'steps']),
    ]);
  });

  test('複数のトグルを切ると、消えた区分がまとめて外れる', () => {
    const filter = layerFilter(
      labels,
      true,
      toggles({ ferry: false, expressway: false }),
    );
    expect(filter).toEqual(['!', kindTest(['expressway', 'ferry'])]);
  });

  test('選択や旧道の絞り込みと重なっても、両方が効く', () => {
    const base = buildFilter([18], 'off', false);
    expect(layerFilter(labels, base, toggles({ ferry: false }))).toEqual([
      'all',
      base,
      ['!', kindTest(['ferry'])],
    ]);
  });

  /* 「路線番号」のトグルは番号を全部消すものなので、区分のトグルとは別物です。
   * ラベルの層を層ごと消せるのはこちらだけです。 */
  test('路線番号を切ると、区分に関わりなく層ごと消える', () => {
    expect(layerFilter(labels, true, toggles({ labels: false }))).toBe(NOTHING);
  });
});

describe('prefLayerFilter', () => {
  const labels = PREF_FILTERED_LAYERS.find((l) => l.id === 'pref-labels');
  const roads = PREF_FILTERED_LAYERS.find((l) => l.id === 'pref-roads');
  const special = PREF_FILTERED_LAYERS.find((l) => l.id === 'pref-special');
  const driveable = kindTest(PREF_KIND_DRIVEABLE);

  test('区分のトグルが全部入なら、ラベルは共有の式のままである', () => {
    const prefBase = buildFilter(['nagano-63'], 'off');
    expect(prefLayerFilter(labels, prefBase, ALL_ON)).toBe(prefBase);
  });

  /* 走れない区分は一覧ではなく「走れる区分ではないもの」なので、外す側ではなく
   * 残す側を書きます(pref-special の層の式と同じ分け方)。 */
  test('走行不能区間を切ると、番号のラベルが走れる区分だけに絞られる', () => {
    expect(
      prefLayerFilter(labels, true, toggles({ prefSpecial: false })),
    ).toEqual(driveable);
  });

  test('自動車専用道路を切ると、番号のラベルから自動車専用道路が外れる', () => {
    expect(
      prefLayerFilter(labels, true, toggles({ expressway: false })),
    ).toEqual(['!', kindTest(['expressway'])]);
  });

  test('二つとも切ると、番号のラベルは一般の県道だけに残る', () => {
    expect(
      prefLayerFilter(
        labels,
        true,
        toggles({ prefSpecial: false, expressway: false }),
      ),
    ).toEqual(['all', driveable, ['!', kindTest(['expressway'])]]);
  });

  test('走行不能区間を切っても、線の層(pref-roads)は巻き添えにならない', () => {
    expect(
      prefLayerFilter(roads, true, toggles({ prefSpecial: false })),
    ).toEqual(driveable);
  });

  test('走行不能区間を切ると、pref-special は層ごと消える', () => {
    expect(
      prefLayerFilter(special, true, toggles({ prefSpecial: false })),
    ).toBe(NOTHING);
  });

  test('路線番号を切ると、区分に関わりなく層ごと消える', () => {
    expect(prefLayerFilter(labels, true, toggles({ labels: false }))).toBe(
      NOTHING,
    );
  });

  test('選択や旧道の絞り込みと重なっても、両方が効く', () => {
    const prefBase = buildFilter(['nagano-63'], 'all', false);
    expect(
      prefLayerFilter(labels, prefBase, toggles({ prefSpecial: false })),
    ).toEqual(['all', driveable, prefBase]);
  });
});

/* 残る番号は、残る線と一致していなければなりません。線が消えた区分の番号が
 * 地図に浮いたままになるのが #187 の不具合です。 */
describe('線が消えた区分の番号は残らない', () => {
  const labels = FILTERED_LAYERS.find((l) => l.id === 'route-labels');
  /** その区分の線を描く層が、いま一つでも残っているか。 */
  const drawn = (kind, state) =>
    FILTERED_LAYERS.some(
      (l) =>
        l.kinds &&
        !l.negate &&
        l.kinds.includes(kind) &&
        (!l.toggle || state[l.toggle]),
    );

  for (const off of ['special', 'ferry', 'expressway']) {
    test(`${off} を切ったとき、残る番号の区分と残る線の区分が一致する`, () => {
      const state = toggles({ [off]: false });
      // `['!', ['in', ['get', 'kind'], ['literal', [...]]]]` の区分の一覧。
      const filter = layerFilter(labels, true, state);
      const hidden = filter === true ? [] : filter[1][2][1];
      for (const kind of EXCLUDE_FROM_ROADS_LAYER)
        expect(hidden.includes(kind)).toBe(!drawn(kind, state));
      // `road` は区分のトグルを持たないので、いつでも番号が出ます。
      expect(hidden).not.toContain('road');
    });
  }
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
/* 見た目の太さは重用の深さを表すので広げられない。押しやすさは、見た目とは別の
 * 透明な層(clickableHitLayers)だけを太らせて確保する。 */
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
      // 太らせる量はズームによらず一定である。狙いやすさは画面上の距離で
      // 決まり、縮尺では決まらない。
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
    // 実線の層と破線の層は互いの否定です。片方だけを直すと、どちらにも入らない
    // アークが暗黙のうちに消えるか、同じ線が二度描かれます。
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

  test('札の字はどちらの格も線より濃い', () => {
    // 線は幅と縁取りが輪郭を作るので、明るい塗りでも形が出ます。字にあるのは
    // 白い縁だけで画線も細いので、線と同じ明るさではどちらの格のラベルも
    // 読めません(mapspec.mjs の PREF_MAJOR_INK)。
    expect(inkByRank[3]).not.toBe(colorByRank[3]);
    expect(inkByRank[3]).toBe(PREF_MAJOR_INK);
    expect(inkByRank[4]).not.toBe(colorByRank[4]);
    expect(inkByRank[4]).toBe(PREF_GENERAL_INK);
  });

  test('縁取りは灰で、旧道以外は薄めない', () => {
    // 白い縁取りは淡色地図の上で何もしていませんでした。純白の地に白を引いた
    // 輝度比は 1.01 です。薄めるのも同じ向きの損なので、下げるのは旧道のぶん
    // だけにします(mapspec.mjs の pref-casing)。
    const casing = drawn.find((l) => l.id === PREF_CASING_LAYER);
    expect(casing.paint['line-color']).toBe(PREF_CASING);
    expect(casing.paint['line-opacity']).toEqual(formerOpacity());
  });

  test('縁取りの足し量はズームで変わり、線より太くならない', () => {
    // 一つの数で持つと、浅いところで縁のほうが厚くなります。z9 の線は 0.94px
    // しかなく、以前の +1.8 はその倍近くありました。
    const casing = drawn.find((l) => l.id === PREF_CASING_LAYER);
    const roads = drawn.find((l) => l.id === 'pref-roads');
    const adds = stopAdds(
      casing.paint['line-width'],
      roads.paint['line-width'],
    );
    expect(new Set(adds).size).toBe(adds.length);
    for (let i = 1; i < adds.length; i += 1) {
      expect(adds[i]).toBeGreaterThan(adds[i - 1]);
    }
  });

  test('写真の下地図でだけ、主要地方道の縁取りが濃くなる', () => {
    // 写真で緑が弱くなるのは暗い森ではなく、雪や造成地のような明るい面です。
    // 一般都道府県道の黄はどの面に対しても明るいので、そちらは替えません。
    expect(prefCasingColor('pale')).toBe(PREF_CASING);
    expect(prefCasingColor('std')).toBe(PREF_CASING);
    expect(prefCasingColor('photo')).toEqual([
      'match',
      ['get', 'rank'],
      'major',
      PREF_CASING_PHOTO_MAJOR,
      PREF_CASING,
    ]);
    // 層は起動時の下地図をそのまま持つ。切り替えたときと同じ関数が答えます。
    const photo = prefLineLayers('photo').find(
      (l) => l.id === PREF_CASING_LAYER,
    );
    expect(photo.paint['line-color']).toEqual(prefCasingColor('photo'));
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
    // ラベルが z8 からなのは、z0-7 のタイルが `label` を持たないためです
    // (#100)。
    for (const l of lines) expect(l.minzoom).toBeUndefined();
    expect(labels.minzoom).toBe(8);
  });
});
