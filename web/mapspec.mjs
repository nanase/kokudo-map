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

// `expressway`(highway=motorway: 第二神明道路、神戸淡路鳴門自動車道 など)は
// 走れる本物の車道なので、上の破線の区分には入らない。それでも `roads` に畳まず
// 自分の層を持つのは、平面交差が無く、平面からの出入りも無く、高速道路としての
// 路線番号を別に持つ、別種の道だからである。工事中や点線国道とは独立に消したい
// 読み手がいる。
export const EXCLUDE_FROM_ROADS_LAYER = [...SPECIAL_KINDS, ...KIND_EXPRESSWAY];

export const COLOR_CONSTRUCTION = '#8A6A2F';
export const COLOR_UNOPENED = '#7B4B94';
export const COLOR_FOOT = '#4B5A6C';
export const COLOR_FERRY = '#0E7490';

export const GSI_TILES =
  'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';

/* 下地図のタイルは、上に載る国道に触れないまま別の地理院タイルへ差し替えられる
 * ——タイルの切り方も出典の持ち主も同じで、違うのは絵だけである。三つとも
 * それぞれのラスタ層として描くので(baseStyle を参照)、切り替えは表示・非表示の
 * 反転であって、ソースの作り直しではない。 */
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

/* 国道の下に敷く地図をどれだけ濃くするか。三つの下地図の層が同じ値を使うので、
 * 下地図を切り替えても選んだ濃さは残る。暗くするための層は別に持たない。
 *
 * `raster-opacity` だけでは確かに決まらない。これはタイルを canvas の後ろに
 * ある物、つまりページの地と混ぜる。明るい配色では白に近く、暗い配色では黒に
 * 近いので、不透明度を上げると、ある人には明るく、別の人には暗くなった——
 * 半分の人にはちょうど逆である。`raster-brightness-max` は混ぜる前にタイル自身の
 * 画素を縮めるので、下げればどの地の上でもタイルが暗くなる。不透明度は、この
 * サイトがずっと配ってきた 0.82 のままにする——`light` はその値をそのまま保つ
 * ので、今まで見えていた絵は誰の手元でも動かない——濃い側の二段だけが明るさを
 * 動かす。 */
export const GSI_SHADE_LEVELS = ['light', 'normal', 'dark'];
export const GSI_SHADE_PAINT = {
  light: { opacity: 0.82, brightnessMax: 1 },
  normal: { opacity: 0.82, brightnessMax: 0.82 },
  dark: { opacity: 0.82, brightnessMax: 0.62 },
};
export const GSI_SHADE_LABELS = { light: '薄い', normal: '通常', dark: '濃い' };
export const DEFAULT_SHADE = 'light';

/* このサイトから配る。ラベルは路線番号を `・` で繋いだ物なので、使う字は数字
 * 十個と区切り一つ、合わせて 11 字しかない。2 つの範囲ファイル、約 5 kB である。
 * scripts/make_glyphs.mjs が Noto Sans JP から焼く。
 *
 * 以前は国土地理院のデモ用の配布元を指していた。他人の Pages サイトが実演として
 * 出している物で、それが消えればラベルも全部消える。 */
const GLYPHS = 'glyphs/{fontstack}/{range}.pbf';

/* アークはベクタタイルとして届く。全国で約 13 万件あり、閲覧側は手元に持てない。
 * 画面に出ている物だけを描き、出す合計はすべて national.meta.json から読む。 */
export const PMTILES_URL = dataURL('national-routes.pmtiles');
export const SOURCE_LAYER = 'routes';

/** 国道の層が前提とするソース。検査スクリプトもこの同じ関数からスタイルを組む
 *  ので、閲覧側が実際には作らないソースの形に対して層を検査することがない。 */
export function routeSources(url) {
  return {
    // `maxzoom` を意図して書かない。アーカイブが自分で述べており、protocol が
    // それを載せた TileJSON を MapLibre に渡す。ここへ数を書き写したせいで、
    // アーカイブに無いズームをスタイルが要求し、それより下が何も描かれなく
    // なったことがある。
    routes: { type: 'vector', url: `pmtiles://${url}` },
    // 起終点は数千点しかなく、どれも操作面に既に出ているので、素の GeoJSON の
    // まま置く。
    termini: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    },
  };
}

/* ------------------------------------------------------------- filtering --- */

/** 部分文字列に騙されない所属の検査。`,4,` が `,14,` に当たることはない。 */
export const hasRef = (ref) => ['in', `,${ref},`, ['get', 'refs']];

/**
 * どの道路層も共有する絞り込み式。
 * `selected` はどの路線を描くかを絞り、`conc` は重用区間に絞り、`showFormer`
 * (既定は入)は切ったときに旧道を落とす。
 *
 * 重用は道の性質であって選択の結果ではない。18 号と 117 号を持つアークは、
 * 両方に印が付いているかどうかに関わらず重用区間である。
 *
 * 旧道も層ではなく道の性質である。`kind` を横切る(road・expressway・foot・
 * construction のどれにも旧道のアークがある)ので、FILTERED_LAYERS ではなく
 * ここに置く。共有の式に畳んでおくと pickedFilter もそのまま従う——地図から
 * 外れた旧道のアークは、他と一緒に影も失う。
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

/** 何にも当たらない式。層を消さずに隠すのに使う。 */
export const NOTHING = ['==', ['get', 'n'], -1];

/**
 * ポップアップが説明しているアークの下に敷く影。
 *
 * OSM の way id はそれだけでアークを一意に指す——ビルドの重複排除もこれを鍵に
 * している——ので、1 本を選び出すのに他の検査は不要である。それでも共有の式を
 * 畳み込む。選択によって地図から外れたアークが、元の場所に影だけを残しては
 * ならないためである。
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
 * 取らないので、破線にするには区分ごとに層を複製することになる。そのうえ新しい
 * 破線は、破線が既に持っている意味とぶつかる——点線国道・工事中・海上国道・
 * 未開通は「走れない」の印に破線を使っており、旧道が述べたいことはそこではない
 * (旧道のアークはほとんどが普通に走れる車道で、区分と旧道かどうかは別々の
 * 事実である)。色は既に重用の深さを、太さは深さとズームの両方を運んでいるので、
 * 残るのは不透明度である。 */
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
 * ズームで補間する線の太さ。
 *
 * `zoom` の式は、最上位の `interpolate`・`step` の直接の入力としてしか書けない。
 * だから路線ごとの掛け算は、補間を包むのではなく補間の出力の側に置く。
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
  // 三つの下地図は常にスタイルの中にあり、見えるのは一度に一つである。
  // 切り替えはソースの作り直しではなく `setLayoutProperty('visibility', …)` に
  // なる——画面に出ているラスタ層のソースは、その場では差し替えられない。
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
      // ポップアップが説明している 1 本を、影で下地図から浮かせる。地図の線に
      // CSS の drop-shadow は効かないので、影も線として持つ。道より太く、ぼかし、
      // 黒く、他のすべての下に描くので、道は自分の色のまま上に残る。アークが
      // 押されるまで何も描かない。押されたら app.js がその way id に絞る。
      //
      // 影は白い縁取りの外へ出なければならない。縁取りは既に道より 2.6 px 太い。
      // +9 px、ぼかし 5 px では、縁取りの外に残る輪が細く淡すぎて見えなかった。
      // 太くしてぼかしを締めたことで、ようやく読めるようになった。
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
        // 重用は単独指定の上に描く。並べ替えの鍵が無いとタイルが持っている順
        // のままになり、四重用の区間が単独指定の下に埋もれる——押したときも
        // そう扱われ、福岡の四重用が国道 202 号の単独指定と報告された。
        // `line-sort-key` は昇順に並べて最後に一番大きい物を描くので、`n` を
        // 渡せば最も深い重なりが上に来る。深さごとに層を分けると、同じことを
        // 四度言うことになる。
        'line-sort-key': ['get', 'n'],
      },
      paint: {
        'line-color': colorByN,
        'line-opacity': formerOpacity(),
        'line-width': lineWidth(),
      },
    },
    {
      // 高速道路として指定された国道(highway=motorway)。走れる本物の車道なので
      // `roads` とまったく同じ体裁で描く——重用を見せることに変わりはない——が、
      // 点線国道や工事中と同じように単独で消せるよう、層は分けてある。
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
      // 未開通区間。`highway=planned`・`proposed` で、道が造られていない場所で
      // ルートリレーションを繋ぐために引かれた線である。四つのうち最も細かい
      // 破線にする。どの区分よりも実体が薄いためで、徒歩道でさえ実際に歩ける
      // 道ではある。
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
        // ラベルは並べ替えの鍵の順に置かれ、既に置かれたラベルとぶつかった物は
        // 捨てられる。`n` の符号を反転すると最も深い重なりから置かれるので、
        // ふつうの地図が丸めてしまうラベルが、真っ先にではなく最後に諦められる。
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
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          7,
          ['case', ['==', ['get', 'shared'], 1], 5, 3],
          13,
          ['case', ['==', ['get', 'shared'], 1], 9, 5],
        ],
        'circle-color': [
          'case',
          ['==', ['get', 'shared'], 1],
          '#C2352B',
          '#FFFFFF',
        ],
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
