/* スタイルと絞り込み式の定義。ブラウザに依存しないので、
 * pipeline/check_expressions.mjs が閲覧側の使う物そのものを検査できる。
 * 以前は式を書き写した複製を検査しており、複製が通るのに本物の層は MapLibre に
 * 拒否されていた。
 */

import { dataURL } from './dataurl.mjs';

export const N_COLORS = ['#1B62C4', '#D98324', '#C2352B', '#7B3E9D']; // n = 1,2,3,4+
export const N_LABELS = ['単独指定', '二重用', '三重用', '四重用以上'];
export const FONT = ['NotoSansJP-Regular'];

export const KIND_FOOT = ['foot', 'steps'];
export const KIND_CONSTRUCTION = ['construction'];
export const KIND_UNOPENED = ['unopened'];
export const KIND_FERRY = ['ferry'];
export const KIND_EXPRESSWAY = ['expressway'];

// 走れる車道ではない区分。どれも破線の層を自分で持ち、実線の道路層からは外す。
// 走れる道と取り違えられないようにするためである。
export const SPECIAL_KINDS = [
  ...KIND_CONSTRUCTION,
  ...KIND_UNOPENED,
  ...KIND_FOOT,
  ...KIND_FERRY,
];

// `expressway`(highway=motorway: 第二神明道路、神戸淡路鳴門自動車道など)は
// 走れる車道なので破線の区分には入らないが、平面交差が無く高速道路としての
// 路線番号を別に持つ別種の道なので、`roads` に畳まず自分の層を持つ。工事中や
// 点線国道とは独立に消したい読み手がいる。
export const EXCLUDE_FROM_ROADS_LAYER = [...SPECIAL_KINDS, ...KIND_EXPRESSWAY];

export const COLOR_CONSTRUCTION = '#8A6A2F';
export const COLOR_UNOPENED = '#7B4B94';
export const COLOR_FOOT = '#4B5A6C';
export const COLOR_FERRY = '#0E7490';

export const GSI_TILES =
  'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';

/* 下地図は、上に載る国道に触れないまま別の地理院タイルへ差し替えられる。
 * タイルの切り方も出典も同じで、違うのは絵だけである。三つともラスタ層として
 * 描くので(baseStyle)、切り替えは表示・非表示の反転であって、ソースの
 * 作り直しではない。 */
export const GSI_BASEMAPS = {
  pale: { label: '淡色地図', tiles: GSI_TILES },
  std: {
    label: '標準地図',
    tiles: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
  },
  photo: {
    label: '写真（航空写真）',
    tiles: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  },
};
export const GSI_BASEMAP_ORDER = ['pale', 'std', 'photo'];
export const DEFAULT_BASEMAP = 'pale';

/* 下地図の濃さ。三つの下地図の層が同じ値を使うので、下地図を切り替えても濃さは
 * 残る。暗くするための層は別に持たない。
 *
 * `raster-opacity` だけでは決まらない。これはタイルをページの地と混ぜるので、
 * 明るい配色では白に、暗い配色では黒に近づき、不透明度を上げると人によって
 * 明るくも暗くもなる。`raster-brightness-max` は混ぜる前にタイルの画素を
 * 縮めるので、下げればどの地の上でも暗くなる。不透明度はこのサイトがずっと
 * 配ってきた 0.82 のままにし、`light` は今までの絵を保つ。濃い側の二段だけが
 * 明るさを動かす。 */
export const GSI_SHADE_LEVELS = ['light', 'normal', 'dark'];
export const GSI_SHADE_PAINT = {
  light: { opacity: 0.82, brightnessMax: 1 },
  normal: { opacity: 0.82, brightnessMax: 0.82 },
  dark: { opacity: 0.82, brightnessMax: 0.62 },
};
export const GSI_SHADE_LABELS = { light: '薄い', normal: '通常', dark: '濃い' };
export const DEFAULT_SHADE = 'light';

/* このサイトから配る。ラベルは路線番号を `・` で繋いだ物なので、使う字は数字と
 * 区切りの 11 字、2 ファイル約 5 kB である。scripts/make_glyphs.mjs が Noto
 * Sans JP から作る。以前は国土地理院のデモ用の配布元を指していた。他人の Pages
 * サイトで、消えればラベルも全部消える。 */
const GLYPHS = 'glyphs/{fontstack}/{range}.pbf';

/* アークはベクタタイルとして届く。全国で約 13 万件あり、閲覧側は手元に
 * 持てない。画面に出ている物だけを描き、出す合計はすべて national.meta.json
 * から読む。 */
export const PMTILES_URL = dataURL('national-routes.pmtiles');
export const SOURCE_LAYER = 'routes';

/* 都道府県道は別のアーカイブで届く(#100)。県道を直すたびに国道の 55.9 MB を上げ
 * 直さずに済み、県道側が壊れても国道の地図は出る。層の名前は国道と同じ `routes`
 * で、ソースの id だけが違う。 */
export const PREF_PMTILES_URL = dataURL('prefectural-routes.pmtiles');
export const PREF_SOURCE = 'prefectural';

/** 国道と都道府県道の層が前提とするソース。検査スクリプトもこの同じ関数から
 *  スタイルを組むので、閲覧側が実際には作らないソースの形に対して層を検査する
 *  ことがない。 */
export function routeSources(url, prefURL) {
  return {
    // `maxzoom` は書かない。アーカイブが自分で持ち、protocol が TileJSON で
    // MapLibre に渡す。数を書き写したせいで、アーカイブに無いズームを要求して
    // それより下が描かれなくなったことがある。
    routes: { type: 'vector', url: `pmtiles://${url}` },
    [PREF_SOURCE]: { type: 'vector', url: `pmtiles://${prefURL}` },
    // 起終点は数千点しかなく、どれも操作面に既に出ているので、素の GeoJSON の
    // まま置く。
    termini: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    },
  };
}

/* ------------------------------------------------------------- filtering --- */

/**
 * どちらの系統を地図に出すか。
 *
 * 選択は系統をまたいで一つである。どちらかの系統で 1 本でも選んだら、地図に
 * 残るのは選んだ道路だけになる。国道を選べば都道府県道は消え、都道府県道を
 * 選べば国道が消える。以前は選んだ系統の側だけを絞っていたので、国道を
 * 1 本選んだ地図に都道府県道 13,234 組が網として残り、何を選んだのか
 * 読めなかった。詳細パネルの「この路線だけ表示」だけが系統トグルを裏で
 * 倒してそれを避けており、同じ選択が押した場所によって違う絵になっていた。
 *
 * 選択が空なら両方とも全部出す。空は「全部出ている」を意味する。
 *
 * `national` と `pref` は表示のポップオーバーの系統トグルで、選択に関わりなく
 * 系統ごと消すので、最後に掛け合わせるだけでよい。数える対象は本数だけなので、
 * Set ではなく個数を受け取る。
 */
export function shownSystems({ national, pref, selected, prefSelected }) {
  const picked = selected > 0 || prefSelected > 0;
  return {
    national: national && (!picked || selected > 0),
    pref: pref && (!picked || prefSelected > 0),
  };
}

/** 部分文字列に騙されない所属の検査。`,4,` が `,14,` に当たることはない。 */
export const hasRef = (ref) => ['in', `,${ref},`, ['get', 'refs']];

/**
 * どの道路層も共有する絞り込み式。`selected` は描く路線を、`conc` は重用区間を
 * 絞り、`showFormer`(既定は入)を切ると旧道を落とす。
 *
 * 重用は道の性質であって選択の結果ではない。18 号と 117 号を持つアークは、
 * 両方を選んでいるかどうかに関わらず重用区間である。
 *
 * 旧道も層ではなく道の性質である。`kind` を横切る(road・expressway・foot・
 * construction のどれにも旧道がある)ので FILTERED_LAYERS ではなくここに置く。
 * 共有の式に畳んでおくと pickedFilter もそのまま従い、地図から外れた旧道は影も
 * 失う。
 */
export function buildFilter(selected, conc, showFormer = true) {
  const parts = [];
  if (selected.length) parts.push(['any', ...selected.map(hasRef)]);
  if (conc === 'all') parts.push(['>=', ['get', 'n'], 2]);
  if (!showFormer) parts.push(['!=', ['get', 'former'], 1]);

  return parts.length ? ['all', ...parts] : true;
}

export const kindTest = (kinds) => ['in', ['get', 'kind'], ['literal', kinds]];

/** 共有の絞り込み式に、区分の限定を重ねる。 */
export function withKind(base, kinds, negate) {
  const k = negate ? ['!', kindTest(kinds)] : kindTest(kinds);
  return base === true ? k : ['all', base, k];
}

/**
 * 都道府県道の層が持つ絞り込みに、路線の選択を重ねる。国道の buildFilter に
 * 当たるが、国道が共有の式に区分を足すのに対し、都道府県道は層が区分の式を持つ
 * (prefLineLayers)ので、それを土台にして選択を足す。選択のキーは `nagano-63` の
 * 形で、タイルの `refs` も同じキーを並べるので、検査は hasRef で足りる。空の
 * 選択は「全部出す」で、buildFilter と同じ約束である。
 */
export function withPrefSelection(base, selected) {
  if (!selected.length) return base;
  const any = ['any', ...selected.map(hasRef)];
  return base === true ? any : ['all', base, any];
}

/** 何にも当たらない式。層を消さずに隠すのに使う。 */
export const NOTHING = ['==', ['get', 'n'], -1];

/**
 * 起終点の絞り込み式。単独区間の端点は地図の上で意味を持たないので、2 つ以上の
 * 国道が出会う地点だけを描く。`selected` があれば、その路線が絡む共有地点に
 * さらに絞る。
 */
export function terminiFilter(selected) {
  const shared = ['==', ['get', 'shared'], 1];
  return selected.length
    ? ['all', shared, ['any', ...selected.map(hasRef)]]
    : shared;
}

/**
 * ポップアップが説明しているアークの下に敷く影。OSM の way id はそれだけで
 * アークを一意に指す(ビルドの重複排除もこれをキーにする)が、共有の式も
 * 畳み込む。選択で地図から外れたアークが、影だけを残さないためである。
 */
export function pickedFilter(base, id) {
  if (id == null) return NOTHING;
  const test = ['==', ['get', 'id'], id];
  return base === true ? test : ['all', base, test];
}

/* ----------------------------------------------------------------- paint --- */

export const colorByN = [
  'match',
  ['get', 'n'],
  1,
  N_COLORS[0],
  2,
  N_COLORS[1],
  3,
  N_COLORS[2],
  N_COLORS[3],
];

/* 旧道は破線にせず、同じ線を薄くして描く。`line-dasharray` はデータ駆動の式を
 * 取らないので、破線にするには区分ごとに層を複製することになる。そのうえ破線は
 * 点線国道・工事中・海上国道・未開通で「走れない」の印に使っており、旧道は
 * ほとんどが普通に走れる車道である。色は重用の深さを、太さは深さとズームを運ぶ
 * ので、残るのは不透明度である。 */
export const FORMER_OPACITY = 0.4;

/** 旧道のアークだけ、層の不透明度を `FORMER_OPACITY` 倍に落とす。 */
export const formerOpacity = (base = 1) => [
  'case',
  ['==', ['get', 'former'], 1],
  base * FORMER_OPACITY,
  base,
];

// 重用は色だけでなく太さでも読ませる。色の違いが判じにくいところまで引いても、
// 深さが残るようにするためである。
const N_MULT = ['match', ['get', 'n'], 1, 1, 2, 1.5, 3, 2, 2.4];
const ZOOM_STOPS = [
  [6, 0.9],
  [9, 1.8],
  [12, 3.2],
  [15, 6],
];

/**
 * ズームで補間する線の太さ。`zoom` の式は最上位の `interpolate`・`step` の
 * 直接の入力にしか書けないので、路線ごとの掛け算は補間の出力の側に置く。
 */
function lineWidth({ add = 0, scaleByN = true } = {}) {
  const out = ['interpolate', ['linear'], ['zoom']];
  for (const [z, w] of ZOOM_STOPS) {
    const base = scaleByN ? ['*', w, N_MULT] : w;
    out.push(z, add ? ['+', base, add] : base);
  }
  return out;
}

/* ----------------------------------------------------------------- style --- */

/** 下地図の層の id。`gsi-pale` のような形で、どれを出すかを選ぶのにも使う。 */
export const gsiLayerId = (basemap) => `gsi-${basemap}`;

export function baseStyle(basemap = DEFAULT_BASEMAP, shade = DEFAULT_SHADE) {
  const attribution =
    '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
  const { opacity, brightnessMax } = GSI_SHADE_PAINT[shade];

  const sources = {};
  const layers = [];
  // 三つの下地図は常にスタイルの中にあり、見えるのは一つである。画面に出ている
  // ラスタ層のソースはその場で差し替えられないので、切り替えは
  // `setLayoutProperty('visibility', …)` で行う。
  for (const id of GSI_BASEMAP_ORDER) {
    sources[id] = {
      type: 'raster',
      tiles: [GSI_BASEMAPS[id].tiles],
      tileSize: 256,
      maxzoom: 18,
      attribution,
    };
    layers.push({
      id: gsiLayerId(id),
      type: 'raster',
      source: id,
      layout: { visibility: id === basemap ? 'visible' : 'none' },
      paint: {
        'raster-opacity': opacity,
        'raster-brightness-max': brightnessMax,
      },
    });
  }

  return { version: 8, glyphs: GLYPHS, sources, layers };
}

/**
 * 国道の層を、描く順に並べる。
 * `line-dasharray` はデータ駆動の式を取らないので、破線の区分は 1 層にまとめた
 * `match` ではなく、区分ごとに 1 層を持つ。
 */
export function routeLayers() {
  return [
    {
      // ポップアップが説明している 1 本を影で浮かせる。地図の線に CSS の
      // drop-shadow は効かないので、影も線として持つ。道より太く、ぼかし、
      // 黒く、他のすべての下に描く。押されるまで何も描かず、押されたら app.js
      // が way id に絞る。影は白い縁取り(道より 2.6 px 太い)の外へ
      // 出る必要がある。+9 px、ぼかし 5 px では縁取りの外に残る輪が細く淡すぎて
      // 見えなかった。
      id: 'picked',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      filter: NOTHING,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#000000',
        'line-opacity': 0.6,
        'line-blur': 3,
        'line-width': lineWidth({ add: 11 }),
      },
    },
    {
      // 白い縁取りが、ラスタの下地図の上でも線を読めるようにする。
      id: 'casing',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#FFFFFF',
        'line-opacity': formerOpacity(0.85),
        'line-width': lineWidth({ add: 2.6 }),
      },
    },
    {
      id: 'roads',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        // 重用は単独指定の上に描く。並べ替えのキーが無いとタイルの
        // 順のままになり、四重用が単独指定の下に埋もれる。押したときもそう
        // 扱われ、福岡の四重用が国道 202 号の単独指定と報告された。
        // `line-sort-key` は昇順に並べて最後に一番大きい物を描くので、`n` を
        // 渡せば最も深い重なりが上に来る。
        'line-sort-key': ['get', 'n'],
      },
      paint: {
        'line-color': colorByN,
        'line-opacity': formerOpacity(),
        'line-width': lineWidth(),
      },
    },
    {
      // 高速道路として指定された国道(highway=motorway)。走れる車道なので
      // `roads` と同じ体裁で描くが、点線国道や工事中と同じように単独で
      // 消せるよう層は分ける。
      id: 'expressway-casing',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#FFFFFF',
        'line-opacity': formerOpacity(0.85),
        'line-width': lineWidth({ add: 2.6 }),
      },
    },
    {
      id: 'expressway',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        'line-sort-key': ['get', 'n'],
      },
      paint: {
        'line-color': colorByN,
        'line-opacity': formerOpacity(),
        'line-width': lineWidth(),
      },
    },
    {
      id: 'construction',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': COLOR_CONSTRUCTION,
        'line-opacity': formerOpacity(),
        'line-width': lineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [2, 2],
      },
    },
    {
      // 未開通区間。`highway=planned`・`proposed` で、道が無い場所でルート
      // リレーションを繋ぐ線である。実体が最も薄いので、四つのうち最も細かい
      // 破線にする。
      id: 'unopened',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': COLOR_UNOPENED,
        'line-opacity': formerOpacity(),
        'line-width': lineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [1, 3],
      },
    },
    {
      id: 'foot',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': COLOR_FOOT,
        'line-opacity': formerOpacity(),
        'line-width': lineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [1, 2],
      },
    },
    {
      // 海上国道。下に道が無いまま、指定だけが海を渡る。破線の三区分のうち最も
      // 長い破線にする。ひと続きで何 km も伸びるのはこれだけだからである。
      id: 'ferry',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': COLOR_FERRY,
        'line-opacity': formerOpacity(),
        'line-width': lineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [4, 2.5],
      },
    },
    {
      // この地図の存在理由そのもの。縮尺によらず番号を画面に残し、番号の若い
      // ものだけでなく全指定を並べる。
      id: 'route-labels',
      type: 'symbol',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      minzoom: 8,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'label'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 12, 13, 16],
        'symbol-spacing': 220,
        // ラベルは並べ替えのキーの順に置かれ、ぶつかった物は捨てられる。`n` の
        // 符号を反転すると最も深い重なりから置かれ、ふつうの地図が丸める
        // ラベルが最後に諦められる。
        'symbol-sort-key': ['-', 0, ['get', 'n']],
        'text-rotation-alignment': 'viewport',
        'text-pitch-alignment': 'viewport',
      },
      paint: {
        'text-color': colorByN,
        'text-halo-color': '#FFFFFF',
        'text-halo-width': 2,
        'text-opacity': formerOpacity(),
      },
    },
    {
      id: 'termini-dot',
      type: 'circle',
      source: 'termini',
      // terminiFilter() が shared=1 の地点だけに絞る(単独の起終点は #117 で地図
      // から落とした)ので、shared による場合分けは無い。
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 13, 5],
        'circle-color': '#FFFFFF',
        'circle-stroke-color': '#00449E',
        'circle-stroke-width': 1.8,
      },
    },
    {
      id: 'termini-label',
      type: 'symbol',
      source: 'termini',
      minzoom: 9,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': FONT,
        'text-size': 11,
        'text-offset': [0, -1.1],
        'text-anchor': 'bottom',
      },
      paint: {
        'text-color': '#00449E',
        'text-halo-color': '#FFFFFF',
        'text-halo-width': 2,
      },
    },
  ];
}

/* -------------------------------------------------------- 都道府県道の層 --- */
/**
 * 都道府県道の配色。線の輪郭は縁取り(`PREF_CASING`)が引き受け、塗りの色の役目は
 * 「隣の線と見分けられること」だけである。
 *
 * 塗りの明るさに輪郭まで持たせると下地図の上で行き詰まる。淡色地図は市街地で
 * 49.5%、山間部で 71.4% が純白で、白の縁取りは輝度比 1.01 で
 * 何もしていなかった。白地に対して 3:1 に届く暗さと、写真の上で沈まない明るさの
 * 両方を一色に求めることになる。縁取りを薄い灰にすると輪郭がそちらに移り、格の
 * 二色は色相の間隔で選べる。`PREF_GENERAL` の黄は白地に対して 1.24 しかないが、
 * 縁取りがあるから読める。地図帳の黄色い一般県道と同じ成り立ちである。CIELAB
 * 上の距離は格の二色どうしで 68.2、縁取りとの間で 73.2 と 101.8 ある。
 *
 * 色は格(主要地方道か一般都道府県道か)を表し、重用の深さは持たせない。国道の
 * 四色と合わせて八色になると、どの色が何かが読めなくなる。都道府県道の重用は
 * 太さで表す(`prefLineWidth`)。
 */
export const PREF_MAJOR = '#2BBB5E';
export const PREF_GENERAL = '#F2EB1F';
export const PREF_RANK_LABELS = {
  major: '主要地方道',
  general: '一般都道府県道',
};

/** 都道府県道の区分のうち、走れる車道であるもの。残りは破線の層が引き取る。 */
export const PREF_KIND_DRIVEABLE = ['road', 'expressway'];

export const colorByRank = [
  'match',
  ['get', 'rank'],
  'major',
  PREF_MAJOR,
  PREF_GENERAL,
];

/**
 * 都道府県道の縁取りの色。線に足す輪郭であって、格を表す色ではない。薄い灰と
 * 明るい緑は輝度比が 1.29 しかないが、灰に彩度がほとんど無く緑の彩度が
 * 68 あるので CIELAB 上の距離は 73.2 あり、縁として読める。
 *
 * 写真の下地図のときだけ、主要地方道の縁取りを濃くする。緑が弱くなるのは雪や
 * 造成地のような明るい面で、薄い灰は 2.50 と 1.71 しか出ないが、濃い灰なら 6.
 * 93 と 4.74 出る。暗い森では逆転するが、緑自身が 3.34 あって足りる。
 * 一般都道府県道の黄は写真のどの面に対しても明るいので、薄い灰のままでよい。
 */
export const PREF_CASING = '#85909F';
export const PREF_CASING_PHOTO_MAJOR = '#414A57';

/** 縁取りの層の id。下地図を替えるたびに app.js がこの層の色を差し替える。 */
export const PREF_CASING_LAYER = 'pref-casing';

/** 下地図に合わせた縁取りの色。閲覧側の起動時と切り替え時が同じ関数を読む
 *  ので、最初に描かれる絵と、切り替えたあとの絵が食い違うことはない。 */
export const prefCasingColor = (basemap = DEFAULT_BASEMAP) =>
  basemap === 'photo'
    ? ['match', ['get', 'rank'], 'major', PREF_CASING_PHOTO_MAJOR, PREF_CASING]
    : PREF_CASING;

/**
 * 番号のラベルに使う色。線は幅と縁取りが輪郭を作るので塗りが明るくても形が出る
 * が、字にあるのは白い縁(`text-halo-color`)だけで画線も細く、線と同じ明るさでは
 * 読めない。色相は線のまま保ち、白い地に対して 5.5:1 前後になるところまで暗く
 * した。色相だけ違う字と線が並ぶと、同じ格を指しているように見えなくなる。
 *
 * 凡例が出すのは線の色である(panel.mjs)。凡例は線が何かを示す物で、字の色を示す
 * 物ではない。
 */
export const PREF_MAJOR_INK = '#1B7A3E';
export const PREF_GENERAL_INK = '#6F6A08';

export const inkByRank = [
  'match',
  ['get', 'rank'],
  'major',
  PREF_MAJOR_INK,
  PREF_GENERAL_INK,
];

/* 都道府県道は国道の下に敷く。同じ太さで引くと、上に載る国道が県道の網に
 * 埋もれる(アークは国道 151,004 に対して 290,529)。国道の ZOOM_STOPS のおよそ
 * 0.65 倍を基準にし、格で細み分ける。 */
const PREF_ZOOM_STOPS = [
  [6, 0.55],
  [9, 1.1],
  [12, 2.1],
  [15, 4],
];
const PREF_RANK_MULT = ['match', ['get', 'rank'], 'major', 1.2, 0.85];
// 重用は色ではなく太さだけで表す。国道の N_MULT より刻みが浅いのは、県道の
// 重用が二重までにほぼ収まるためである。290,529 アークの内訳は単独 276,433、
// 二重 13,424、三重 646、四重 26 で、三重以上は 0.23% しかない。
const PREF_N_MULT = ['match', ['get', 'n'], 1, 1, 2, 1.35, 1.6];

/* 縁取りが線に足す量。段ごとに持つのは、一つの数では浅いところで縁のほうが太く
 * なるためである。z9 の線は 0.94px しかなく、以前の +1.8 を足すと線より縁が
 * 厚かった。 */
const PREF_CASING_ADD = [0.7, 1, 1.7, 2.4]; // PREF_ZOOM_STOPS と同じ並び

/** 都道府県道の線の太さ。`lineWidth` と同じ理由で、掛け算は補間の出力側に置く。
 *  `add` は 1 つの数か、`PREF_ZOOM_STOPS` と同じ並びの段ごとの量である。 */
function prefLineWidth({ add = 0, scaleByN = true } = {}) {
  const out = ['interpolate', ['linear'], ['zoom']];
  PREF_ZOOM_STOPS.forEach(([z, w], i) => {
    let base = ['*', w, PREF_RANK_MULT];
    if (scaleByN) base = ['*', base, PREF_N_MULT];
    const at = Array.isArray(add) ? add[i] : add;
    out.push(z, at ? ['+', base, at] : base);
  });
  return out;
}

/**
 * 影を敷く層の id。国道の `picked` と同じ役目だが、一つの層で兼ねられない。
 * キーは OSM の way id で、国道と重用する都道府県道のアークは二つのアーカイブに
 * 同じ id で入っているため、一つの層にすると県道を押したときに国道の線が光る。
 */
export const PREF_PICKED_LAYER = 'pref-picked';

/**
 * 都道府県道のポップアップを組める、最も浅いズーム。z0-7 のタイルは `id`・
 * `name`・`km`・`src` を落としてある(pipeline/pack_web_pref.mjs の
 * `LOW_ZOOM_FIELDS`)。低ズームのタイルの大きさのためで、覆せない。押しても
 * 何も出せないので、押せそうにも見せない(カーソルは app.js が変える)。
 *
 * 国道は z0 から出る。z7 は 1 画素が約 1.2 km で、県道の網はその縮尺では網目に
 * なり、どの線を掴んだか決められない。国道側を z8 に揃えると見え方が変わる。
 */
export const PREF_POPUP_MINZOOM = 8;

/** 押されたら答える都道府県道の層。破線の層も押せる。工事中の区間も
 * ポップアップに出す情報を持つ。縁取りとラベルは押しても路線を指さない。 */
export const PREF_CLICKABLE_LAYERS = ['pref-roads', 'pref-special'];

/**
 * 都道府県道の線の層を、描く順に並べる。国道のどの層よりも下に入れ(app.js の
 * boot)、国道の見え方を変えない。
 *
 * 国道と違って区分ごとに層を分けない。走れない区分は 290,529 アーク中 1,
 * 037 しかなく、「点線国道」「海上国道」のような区分ごとの呼び名も
 * 都道府県道には無い。破線であること自体が「走れない」の印なので、色は
 * 格のままにして 1 層にまとめる。`line-dasharray` はデータ駆動にできないが
 * `line-color` はできるので、分ける必要があるのは破線の形だけである。
 *
 * `basemap` は縁取りの色だけに効く(`prefCasingColor`)。省くと既定の下地図の
 * 値になるので、層があることだけを問う側は引数を渡さない。
 */
export function prefLineLayers(basemap = DEFAULT_BASEMAP) {
  return [
    {
      // 国道の `picked` と同じで、ポップアップが説明している 1 本を浮かせる。
      // 都道府県道の層すべてより下に敷く。太らせる量が国道の +11 ではなく +8
      // なのは、県道の線が国道のおよそ 0.65 倍しかないためである。同じ +11 では
      // 影が輪ではなく帯になった。
      id: PREF_PICKED_LAYER,
      type: 'line',
      source: PREF_SOURCE,
      'source-layer': SOURCE_LAYER,
      filter: NOTHING,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#000000',
        'line-opacity': 0.6,
        'line-blur': 3,
        'line-width': prefLineWidth({ add: 8, scaleByN: false }),
      },
    },
    {
      // 灰の縁取り。国道の `casing` と同じ役目で、破線の区分には敷かない。
      // 国道と違って白ではなく薄めもしない(PREF_CASING)。淡色地図の半分以上は
      // 純白で、白を 0.85 で引いても輝度比は 1.01 にしかならず、輪郭が
      // 無かった。灰は透けさせない。透かすと輪郭を持たせた意味がその分だけ
      // 戻る。
      id: PREF_CASING_LAYER,
      type: 'line',
      source: PREF_SOURCE,
      'source-layer': SOURCE_LAYER,
      filter: kindTest(PREF_KIND_DRIVEABLE),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': prefCasingColor(basemap),
        'line-opacity': formerOpacity(),
        'line-width': prefLineWidth({ add: PREF_CASING_ADD }),
      },
    },
    {
      id: 'pref-roads',
      type: 'line',
      source: PREF_SOURCE,
      'source-layer': SOURCE_LAYER,
      filter: kindTest(PREF_KIND_DRIVEABLE),
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        // 主要地方道を一般都道府県道の上に描く。鍵が無いとタイルの並び順の
        // ままになり、格の違いが交差のたびに入れ替わる。
        'line-sort-key': ['match', ['get', 'rank'], 'major', 2, 1],
      },
      paint: {
        'line-color': colorByRank,
        'line-opacity': formerOpacity(),
        'line-width': prefLineWidth(),
      },
    },
    {
      // 工事中・未開通・徒歩道・階段・航路。走れる車道と取り違えられないよう、
      // 国道側と同じく破線にする。
      id: 'pref-special',
      type: 'line',
      source: PREF_SOURCE,
      'source-layer': SOURCE_LAYER,
      filter: ['!', kindTest(PREF_KIND_DRIVEABLE)],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': colorByRank,
        'line-opacity': formerOpacity(),
        'line-width': prefLineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [2, 2],
      },
    },
  ];
}

/**
 * 都道府県道の番号のラベル。国道の `route-labels` のすぐ下に入れる(app.js の
 * boot)。線より上でなければ国道の線に潜って読めなくなり、MapLibre は上の層から
 * 順にラベルを置いて置けなかった物を捨てるので、国道のラベルが上にあるかぎり
 * 県道のラベルに押しのけられない。
 *
 * 出す字は番号だけである。県名を載せると日本語 1 書体ぶんのグリフが必要になる。
 * いまは数字と `・` の 11 字、約 5 kB で済んでいる。国道か都道府県道かは色で
 * 表し、その色が何かは凡例が示す。
 *
 * `minzoom` は国道と同じ 8 である。線は z0 から出る。z8 はラベルが出る縮尺で
 * あって、路線が現れる縮尺ではない。
 */
export function prefLabelLayer() {
  return {
    id: 'pref-labels',
    type: 'symbol',
    source: PREF_SOURCE,
    'source-layer': SOURCE_LAYER,
    minzoom: 8,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'label'],
      'text-font': FONT,
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 13.5],
      'symbol-spacing': 260,
      // 国道のラベルと同じ考えである。深い重用の番号ほど先に置き、諦めるのは
      // 最後にする。同点は主要地方道を先にする。
      'symbol-sort-key': [
        '-',
        0,
        ['+', ['get', 'n'], ['match', ['get', 'rank'], 'major', 0.5, 0]],
      ],
      'text-rotation-alignment': 'viewport',
      'text-pitch-alignment': 'viewport',
    },
    paint: {
      'text-color': inkByRank,
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 2,
      'text-opacity': formerOpacity(),
    },
  };
}

/** 都道府県道の層すべて。層が在ることだけを問う側(検査、表示の切り替え)が
 * 使う。 */
export const prefLayers = () => [...prefLineLayers(), prefLabelLayer()];

/** 共有の絞り込み式を、どの層にどう当てるか。 */
export const FILTERED_LAYERS = [
  { id: 'casing', kinds: EXCLUDE_FROM_ROADS_LAYER, negate: true },
  { id: 'roads', kinds: EXCLUDE_FROM_ROADS_LAYER, negate: true },
  {
    id: 'expressway-casing',
    kinds: KIND_EXPRESSWAY,
    negate: false,
    toggle: 'expressway',
  },
  {
    id: 'expressway',
    kinds: KIND_EXPRESSWAY,
    negate: false,
    toggle: 'expressway',
  },
  {
    id: 'construction',
    kinds: KIND_CONSTRUCTION,
    negate: false,
    toggle: 'special',
  },
  { id: 'unopened', kinds: KIND_UNOPENED, negate: false, toggle: 'special' },
  { id: 'foot', kinds: KIND_FOOT, negate: false, toggle: 'special' },
  { id: 'ferry', kinds: KIND_FERRY, negate: false, toggle: 'ferry' },
  { id: 'route-labels', kinds: null, negate: false, toggle: 'labels' },
];

export const CLICKABLE_LAYERS = [
  'roads',
  'expressway',
  'construction',
  'unopened',
  'foot',
  'ferry',
];

/** 押せるレイヤーの当たり判定だけを太らせた透明な層の id。 */
export const hitLayerId = (id) => `${id}-hit`;

/** interpolate 式の各段に一定量を足す。zoom による補間そのものは変えない。 */
function widened(expr, add) {
  const [op, interp, input, ...stops] = expr;
  const out = [op, interp, input];
  for (let i = 0; i < stops.length; i += 2) {
    out.push(stops[i], ['+', stops[i + 1], add]);
  }
  return out;
}

/* 細い線ほどクリックで外しやすいが、太さは重用の深さを表すので広げられない。
 * そこで見た目と別に透明な層を重ね、そちらだけを太らせて当たり判定に使う(app.js
 * の wirePopups)。透明な層は不透明度 0 で描かれるだけで、ソースの追加読み込みは
 * 無い。`queryRenderedFeatures` に矩形を渡す手は層を増やさないが、
 * `mouseenter`/`mouseleave` は点でしか判定しないので、カーソルの形と押せる
 * 範囲がずれる。透明な層なら同じ id を hover にも click にも使えて、二つが
 * 揃う。
 *
 * 太らせる量は固定のピクセル数である。狙いやすさは画面上の距離で決まり、地図の
 * 縮尺では決まらない。値は市街地の込み合った場所で、隣の道路を誤って
 * 拾わないことを確かめて決めた。 */
const HIT_ADD = 10;
const PREF_HIT_ADD = 7;

/** `CLICKABLE_LAYERS` に対応する、透明で太い当たり判定専用の層。 */
export function clickableHitLayers() {
  const byId = new Map(routeLayers().map((l) => [l.id, l]));
  return CLICKABLE_LAYERS.map((id) => {
    const layer = byId.get(id);
    return {
      ...layer,
      id: hitLayerId(id),
      paint: {
        ...layer.paint,
        'line-color': '#000000',
        'line-opacity': 0,
        'line-width': widened(layer.paint['line-width'], HIT_ADD),
      },
    };
  });
}

/** `PREF_CLICKABLE_LAYERS` に対応する、透明で太い当たり判定専用の層。量が国道の
 *  7 割ほどなのは、都道府県道の線が国道のおよそ 0.65 倍しかなく、同じ量では線に
 *  対して太すぎるためである。 */
export function prefClickableHitLayers() {
  const byId = new Map(prefLineLayers().map((l) => [l.id, l]));
  return PREF_CLICKABLE_LAYERS.map((id) => {
    const layer = byId.get(id);
    return {
      ...layer,
      id: hitLayerId(id),
      paint: {
        ...layer.paint,
        'line-color': '#000000',
        'line-opacity': 0,
        'line-width': widened(layer.paint['line-width'], PREF_HIT_ADD),
      },
    };
  });
}
