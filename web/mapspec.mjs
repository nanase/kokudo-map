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

/* 都道府県道は別のアーカイブで届く(#100)。国道の 55.9 MB を県道を直すたびに
 * 上げ直さずに済むこと、県道側が壊れても国道の地図は出ることが理由である。
 * 層の名前は国道と同じ `routes` で、ソースの id だけが違う。 */
export const PREF_PMTILES_URL = dataURL('prefectural-routes.pmtiles');
export const PREF_SOURCE = 'prefectural';

/** 国道と都道府県道の層が前提とするソース。検査スクリプトもこの同じ関数から
 *  スタイルを組むので、閲覧側が実際には作らないソースの形に対して層を検査する
 *  ことがない。 */
export function routeSources(url, prefURL) {
  return {
    // `maxzoom` を意図して書かない。アーカイブが自分で述べており、protocol が
    // それを載せた TileJSON を MapLibre に渡す。ここへ数を書き写したせいで、
    // アーカイブに無いズームをスタイルが要求し、それより下が何も描かれなく
    // なったことがある。
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
 * 残るのは選んだ道路だけになる——国道を選べば都道府県道は消え、都道府県道を
 * 選べば国道が消える。二つのどちらかが上位ということはなく、「道路を選択」は
 * その名のとおり道路を選ぶ。
 *
 * 以前は選んだ系統の側だけを絞っていたので、国道を 1 本選んだ地図に都道府県道
 * 13,234 組が網として残り、何を選んだのかが地図から読めなかった。詳細パネルの
 * 「この路線だけ表示」だけが、系統トグルを裏で倒してその形を避けていた——同じ
 * 選択が、押した場所によって違う絵になっていた。
 *
 * 選択が空なら両方とも全部出す。空であることは「何も出ていない」ではなく
 * 「全部出ている」を意味する。
 *
 * `national` と `pref` は表示の面の系統トグルである。あれは選択に関わりなく
 * 系統ごと消す切り替えなので、ここでは最後に掛け合わせるだけでよい。
 *
 * 数える対象は本数だけなので、Set ではなく個数を受け取る。
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

/**
 * 都道府県道の層が既に持っている絞り込みに、路線の選択を重ねる。
 *
 * 国道の buildFilter に当たるものだが、重ねる先が違う。国道は共有の式を組んで
 * から区分を足すのに対し、都道府県道は層そのものが区分の式を持っている
 * (prefLineLayers)ので、その式を土台にして選択を足す。
 *
 * 選択の鍵は `nagano-63` の形で、タイルの `refs` もその鍵を並べているので、
 * 検査は国道と同じ hasRef で足りる。空の選択は「全部出す」を意味する——国道側
 * (buildFilter)と同じ約束である。
 */
export function withPrefSelection(base, selected) {
  if (!selected.length) return base;
  const any = ['any', ...selected.map(hasRef)];
  return base === true ? any : ['all', base, any];
}

/** 何にも当たらない式。層を消さずに隠すのに使う。 */
export const NOTHING = ['==', ['get', 'n'], -1];

/**
 * 起終点の絞り込み式。単独区間の端点は片方しか路線が無く、地図の上で意味を
 * 持たないので出さない——2 つ以上の国道が出会う地点だけを描く。
 * `selected` があれば、その路線が絡む共有地点だけにさらに絞る。
 */
export function terminiFilter(selected) {
  const shared = ['==', ['get', 'shared'], 1];
  return selected.length
    ? ['all', shared, ['any', ...selected.map(hasRef)]]
    : shared;
}

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
      // termini-dot は必ず terminiFilter() 経由で shared=1 の地点だけに絞られる
      // （単独の起終点は #117 で地図から落とした）ので、shared による場合分けは
      // もう要らない。
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
 * 都道府県道の配色。国道が既に青・橙・赤・紫を重用の深さに使っているので、
 * 残っている強い色相は緑しかない。同じ色相の中で、明るさと彩度をはっきり離した
 * 二色を格に当てる——細い線では、明るさの差より色相の差のほうが読めるが、緑の
 * 内側で色相を動かせる幅は狭いためである。
 *
 * 格(主要地方道か一般都道府県道か)を色に、重用の深さを持たせないのは、国道の
 * 四色と合わせて八色になると、どの色が何を述べているかが読めなくなるためである。
 * 都道府県道の重用は太さで述べる(`prefLineWidth`)。
 */
export const PREF_MAJOR = '#1B7A3E';
export const PREF_GENERAL = '#8CBF4A';
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
 * 番号の札に使う一般都道府県道の色。線の `PREF_GENERAL` より暗い。
 *
 * 線としての #8CBF4A は淡色地図の上でよく読めるが、字としては白い地に対して
 * 2.15:1 しかない。線は幅を持つので薄くても形が出るが、字は画線が細く、同じ
 * 明るさでは読めなくなる。色相はそのままに暗くして 5.1:1 にする。主要地方道の
 * #1B7A3E は字のままでも 4.5:1 あるので、動かさない。
 *
 * 凡例が出すのは線の色である(panel.mjs)。凡例は線が何かを述べる物であって、
 * 札の字の色を述べる物ではない。
 */
export const PREF_GENERAL_INK = '#4F7A1E';

export const inkByRank = [
  'match',
  ['get', 'rank'],
  'major',
  PREF_MAJOR,
  PREF_GENERAL_INK,
];

/* 都道府県道は国道の下に敷く。同じ太さで引くと、上に載る国道が県道の網に
 * 埋もれる——アークの数は国道の 151,004 に対して 290,529 である。国道の
 * ZOOM_STOPS に対しておよそ 0.65 倍を基準にし、格で細み分ける。 */
const PREF_ZOOM_STOPS = [
  [6, 0.55],
  [9, 1.1],
  [12, 2.1],
  [15, 4],
];
const PREF_RANK_MULT = ['match', ['get', 'rank'], 'major', 1.2, 0.85];
// 重用は色ではなく太さだけが述べる。国道の N_MULT より刻みが浅いのは、県道の
// 重用が二重までにほぼ収まるためである——290,529 アークの内訳は 単独 276,433、
// 二重 13,424、三重 646、四重 26 で、三重以上は 0.23% しかない。深さの段を
// 大きく開いても、開いたぶんが描かれる場所がほとんど無い。
const PREF_N_MULT = ['match', ['get', 'n'], 1, 1, 2, 1.35, 1.6];

/** 都道府県道の線の太さ。`lineWidth` と同じ理由で、掛け算は補間の出力側に置く。 */
function prefLineWidth({ add = 0, scaleByN = true } = {}) {
  const out = ['interpolate', ['linear'], ['zoom']];
  for (const [z, w] of PREF_ZOOM_STOPS) {
    let base = ['*', w, PREF_RANK_MULT];
    if (scaleByN) base = ['*', base, PREF_N_MULT];
    out.push(z, add ? ['+', base, add] : base);
  }
  return out;
}

/**
 * 影を敷く層の id。国道の `picked` と同じ役目だが、二つを一つの層で兼ねられ
 * ない——鍵にするのは OSM の way id で、国道と重用する都道府県道のアークは
 * 二つのアーカイブに同じ id で入っているためである。一つの層にすると、県道を
 * 押したときに国道の線が光る。
 */
export const PREF_PICKED_LAYER = 'pref-picked';

/**
 * 都道府県道のポップアップを組める、最も浅いズーム。
 *
 * z0-7 のタイルは `id`・`name`・`km`・`src` を落としてある
 * (pipeline/pack_web_pref.mjs の `LOW_ZOOM_FIELDS`)。落とした理由は低ズームの
 * タイルの大きさで、覆せない。押しても何も出せないので、押せそうにも見せない
 * ——カーソルを変えるのは app.js である。
 *
 * 国道は今までどおり z0 から出る。この非対称はそのままでよい。z7 は 1 画素が
 * 約 1.2 km で、県道の網はその縮尺では網目になり、どの線を掴んだかが読み手にも
 * 決められない。国道側を z8 に揃えるのは、いまの見え方を変えることになる。
 */
export const PREF_POPUP_MINZOOM = 8;

/** 押されたら答える都道府県道の層。破線の層も押せる——工事中の区間も、その
 *  区間について述べることを持っている。縁取りと札は押しても路線を指さない。 */
export const PREF_CLICKABLE_LAYERS = ['pref-roads', 'pref-special'];

/**
 * 都道府県道の線の層を、描く順に並べる。国道のどの層よりも下に入れる
 * (app.js の boot)。国道の見え方を変えないための順序である。
 *
 * 国道と違って区分ごとに層を分けない。走れない区分は 290,529 アーク中 1,037
 * しかなく、そのうえ「点線国道」「海上国道」のような、区分ごとに定まった呼び名を
 * 都道府県道は持たない。破線であること自体が「走れない」の印なので、色は格の
 * ままにして、1 層にまとめる——`line-dasharray` はデータ駆動にできないが、
 * `line-color` はできるので、分ける必要があるのは破線の形だけである。
 */
export function prefLineLayers() {
  return [
    {
      // 国道の `picked` と同じで、ポップアップが説明している 1 本を下地図から
      // 浮かせる。都道府県道の層すべてより下に敷く。太らせる量が国道の +11 では
      // なく +8 なのは、県道の線が国道のおよそ 0.65 倍しかないためである——
      // 同じ +11 では、影が線に対して太すぎて輪ではなく帯になった。
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
      // 白い縁取り。国道の `casing` と同じ役目で、ラスタの下地図の上でも線が
      // 読めるようにする。破線の区分には敷かない——国道側も敷いていない。
      id: 'pref-casing',
      type: 'line',
      source: PREF_SOURCE,
      'source-layer': SOURCE_LAYER,
      filter: kindTest(PREF_KIND_DRIVEABLE),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#FFFFFF',
        'line-opacity': formerOpacity(0.85),
        'line-width': prefLineWidth({ add: 1.8 }),
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
 * 都道府県道の番号の札。国道の `route-labels` のすぐ下に入れる
 * (app.js の boot)。二つの理由が同じ場所を指している。
 *
 *   描く順   線より上でなければ、国道の線に潜って読めなくなる
 *   場所争い MapLibre は上の層から順に札を置き、置けなかった札を捨てる。
 *            国道の札が上に在るかぎり、県道の札に押しのけられることはない
 *
 * 出す字は番号だけである。県名を載せると日本語 1 書体ぶんのグリフが要る——
 * いまのラベルは数字と `・` の 11 字、約 5 kB で済んでいる。国道か都道府県道か
 * は色が述べ、その色が何かは凡例が述べる。
 *
 * `minzoom` は国道と同じ 8 である。ズーム下限を置かないのはアーカイブの側で、
 * 線は z0 から出る。z8 は札が出る縮尺であって、路線が現れる縮尺ではない。
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
      // 国道の札と同じ考えである。深い重用の番号ほど先に置き、諦めるのは最後に
      // する。同点は主要地方道を先にする。
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

/** 都道府県道の層すべて。層が在ることだけを問う側(検査、表示の切り替え)が使う。 */
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
