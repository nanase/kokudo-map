/* 国道マップ
 *
 * 前提: アークは、その上に載る指定の全体を `refs = ",18,117,406,"` の形で
 * 最初から持つ。「N 号だけを出す」も「重用区間だけを出す」も属性の
 * 絞り込みであり、スタイルの式で評価できる。再計算もサーバも不要である。
 *
 * ビルドは地域ごとに走る(裏取りが都道府県で閉じているため)が、閲覧側は全国
 * 1 組のタイルを読むので、県を選ぶ場面は無い。範囲を広げるのはデータの
 * 変更であって、画面の変更ではない。
 *
 * 全国で約 13 万アークあり、ベクタタイルで届くので、手元にあるのは画面に
 * 出ている物だけである。操作パネルが出す合計(路線の一覧、重用ランキング、選択の
 * 集計)はすべて national.meta.json から読む。継ぎ目を重複排除したうえでビルドが
 * 書く。
 *
 * スタイルと絞り込み式は mapspec.mjs にある。検査スクリプトが本物をそのまま
 * 検査するためである。
 *
 * このファイルに残るのは、生きた地図とページが必要な部分である。地図、唯一の
 * 可変な `state`、絞り込み、listener、起動の順である。データの純関数は test/ で
 * 直接検査できるよう外へ出した。wireControls() と wireShare() は
 * 純粋ではないが、document・state・applyFilters しか必要とせず地図が
 * 不要なので、wiring.mjs に置いて happy-dom の index.html で検査する。
 *
 *   dataurl.mjs    配信データの URL の基点
 *   mapspec.mjs    スタイル、層、絞り込み式
 *   aggregate.mjs  画面が出す数を組み合わせ表から読む
 *   panel.mjs      ポップオーバーの一覧・集計と、凡例の markup
 *   popup.mjs      押したアークのポップアップ
 *   detail.mjs     一つの路線の詳細パネル
 *   termini.mjs    起点・終点を GeoJSON にする
 *   shield.mjs     国道番号標識
 *   html.mjs       エスケープ。OSM の文字は信用できない
 *   wiring.mjs     index.html の要素と state の対応づけ
 */

import {
  concurrencies,
  formerKmFor,
  kindsFor,
  prefRankOf,
  routesOf,
  statsFor,
} from './aggregate.mjs';
import { dataURL } from './dataurl.mjs';
import {
  continuationOf,
  decreeTerminiOf,
  detailHTML,
  prefDetailHTML,
  relatedRoutesOf,
} from './detail.mjs';
import {
  baseStyle,
  buildFilter,
  CLICKABLE_LAYERS,
  clickableHitLayers,
  DEFAULT_BASEMAP,
  DEFAULT_SHADE,
  FILTERED_LAYERS,
  GSI_BASEMAP_ORDER,
  GSI_BASEMAPS,
  GSI_SHADE_LABELS,
  GSI_SHADE_LEVELS,
  GSI_SHADE_PAINT,
  gsiLayerId,
  hitLayerId,
  NOTHING,
  PMTILES_URL,
  PREF_CASING_LAYER,
  PREF_CLICKABLE_LAYERS,
  PREF_DEFAULT_FILTERS,
  PREF_FILTERED_LAYERS,
  PREF_PICKED_LAYER,
  PREF_PMTILES_URL,
  PREF_POPUP_MINZOOM,
  pickedFilter,
  prefCasingColor,
  prefClickableHitLayers,
  prefLabelLayer,
  prefLayers,
  prefLineLayers,
  resolvedPrefFilter,
  routeLayers,
  routeSources,
  shownSystems,
  terminiFilter,
  withKind,
} from './mapspec.mjs';
import {
  clearLabel,
  countLabel,
  freshnessHTML,
  prefConcurrencyHTML,
  prefStatsHTML,
  RANKING_ROWS,
  rankingHTML,
  routeListHTML,
  SHARED_ROWS,
  sharedHTML,
  statsHTML,
} from './panel.mjs';
import { deepest, popupHTML, prefPopupHTML } from './popup.mjs';
import { comparePrefKeys, prefRefOf, prefRegionOf } from './prefroute.mjs';
import { terminiFeatures } from './termini.mjs';
import {
  decodeRoutes,
  decodeURLState,
  encodeState,
  MANAGED_KEYS,
} from './urlstate.mjs';
import {
  applyRouteFilter,
  isOnly,
  isOnlyGroup,
  NARROW_QUERY,
  syncDetailOnly,
  syncRouteList,
  togglePrefGroup,
  togglePrefOnly,
  toggleRouteOnly,
  wireControls,
  wireShare,
} from './wiring.mjs';

const state = {
  meta: null,
  routes: [],
  selected: new Set(),
  // 都道府県道の選択。`nagano-63` の形のキーである。番号は県の中でしか
  // 一意でないので、国道のように数では持てない(prefroute.mjs)。空は「すべて」を
  // 意味し、国道の `selected` と同じである。
  prefSelected: new Set(),
  // 県名の表。regions.json から `nagano` → 「長野県」を引く。都道府県道は県を
  // 伴わなければ路線を名指したことにならない。
  prefLabels: new Map(),
  // 県別 meta。県を初めて開いたときに 1 県ぶんだけ取る(prefMeta)。47 県ぶんは
  // 3.45 MB あり、初期表示では読まない。
  prefMetas: new Map(),
  // 全国の県と番号だけの索引(14.4 kB)。「道路を選択」を初めて開いたときに
  // 1 度だけ取る。番号で絞り込むためだけに使う。届くまでは null。
  prefIndex: null,
  // 索引の取得に失敗したか。伝えないと「いつまでも読み込み中」になる。
  // 開き直せば取り直す。
  prefIndexFailed: false,
  // 都道府県道の全国集計(対象アーク・延長・重用アーク・路線数)。
  // 「この地図について」を初めて開いたときに 1 度だけ取る(pref/summary.json、
  // loadPrefSummary)。県別 meta と同じく、初期表示では読まない。届くまでは
  // null で、この間 #pref-stats は空のままにする。
  prefSummary: null,
  prefSummaryFailed: false,
  // 「道路を選択」の一覧に出す系統。地図に描く系統(national / pref)とは別で、
  // 探す先を絞るだけである。二つとも false にはならない。
  listNational: true,
  listPref: true,
  // ポップアップが開いているアークの OSM way id。開いていなければ null。その
  // 下に敷く影だけが使う。
  picked: null,
  // 同じものの都道府県道の側。国道と重用する県道のアークは二つのアーカイブに
  // 同じ way id で入っているので、層と同じく状態も分ける。
  prefPicked: null,
  conc: 'off',
  labels: true,
  termini: true,
  special: true,
  ferry: true,
  expressway: true,
  former: true,
  national: true,
  pref: true,
  // 都道府県道側の「走行不能区間」。国道の special・ferry に当たるが、
  // 都道府県道は pref-special 1 層にまとまっているので 1 つのトグルにする
  // (mapspec.mjs の PREF_FILTERED_LAYERS)。
  prefSpecial: true,
};

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------------ 地図 --- */
// PMTiles はバイト範囲で読む 1 つのアーカイブなので、Range 要求に答えられる
// 静的ホストなら全国を配れる。開発用サーバが `python -m http.server` ではなく
// pipeline/serve.py なのはそのためである。
maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);

/**
 * 前回選んだ下地図の種類と濃さ。地図を作る前に読んでスタイルへ渡し、既定で
 * 描いてから描き直す形にしない。
 */
function readStored(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback; // プライベートブラウズでは保存が無いので、配る既定にする
  }
}
let basemap = readStored('gsi-basemap', GSI_BASEMAP_ORDER, DEFAULT_BASEMAP);
let gsiShade = readStored('gsi-shade', GSI_SHADE_LEVELS, DEFAULT_SHADE);

/* ------------------------------------------------------------------ 配色 --- */
/**
 * 明るい配色か暗い配色か。
 *
 * 色は style.css の light-dark() が両方定義し、`color-scheme` がどちらを使うか
 * 決める。ここが置くのは `data-theme` だけである。置かなければ端末の設定が効く
 * ので、最初の描画は JavaScript を待たない。端末と違う側を選んでいる人には
 * index.html の <head> が先に置き直す。書くのも 'auto' を解くのもここである。
 *
 * 置くのは解いた側('light'/'dark')で、選んだ側('auto' を含む)ではない。色でない
 * 切り替え(MapLibre のボタンのアイコンの反転)は媒体クエリでは書けず、
 * `data-theme` を見るしかないためである。
 *
 * 選択は localStorage に残す。表示の好みであって絞り込みではないので、`state`
 * にも URL にも入れない。
 */
const THEME_MODES = ['auto', 'light', 'dark'];
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
let theme = readStored('theme', THEME_MODES, 'auto');

function applyTheme() {
  document.documentElement.dataset.theme =
    theme === 'auto' ? (darkMq.matches ? 'dark' : 'light') : theme;
}

// 端末の設定が変わったとき。自分で選んでいるあいだは applyTheme が無視する。
darkMq.addEventListener('change', applyTheme);
applyTheme();

for (const el of document.querySelectorAll('input[name=theme]')) {
  el.checked = el.value === theme;
  el.addEventListener('change', () => {
    theme = document.querySelector('input[name=theme]:checked').value;
    applyTheme();
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* プライベートブラウズ: 選択がタブより長く残らないだけである。 */
    }
  });
}

/**
 * 共有されたリンクが表示位置を指定しているか。
 *
 * 地図を作る前に読む。`hash: true` の MapLibre は作った時点で既定の中心へ
 * jumpTo し、その moveend で自分の hash を同期に書く。作った後に読むと、
 * 共有された hash と地図が書いた hash を見分けられない。見分けが付かないあいだ
 * fitInitialView()は呼ばれず、`?region=` は誰にも届いていなかった。
 */
const sharedView = Boolean(location.hash);

const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false,
  hash: true,
  // 切らないと、MapLibre は CJK の字をグリフサーバに訊かず端末の書体で描く。
  // ここで使う字は数字と `・` だけで、すべて配ってあるので、端末で描いても得る
  // のは機械ごとに形の変わる区切りと、CJK の書体が無い端末での消失だけである。
  localIdeographFontFamily: false,
  style: baseStyle(basemap, gsiShade),
  // 既定の表示位置。全国が一枚に収まり、北海道から沖縄まで切れない位置を目で
  // 決めた(`#4.62/35.79/137.92`)。meta.bbox に自動で合わせると、南鳥島のような
  // 離れた点まで入れようとして日本が小さく片寄る。
  center: [137.92, 35.79],
  zoom: 4.62,
  // MapLibre 自身のボタンのラベル。他のボタンはすべて日本語なので揃える。
  // ここに無いキー(縮尺の単位など)は既定のままである。
  locale: {
    'NavigationControl.ZoomIn': '拡大',
    'NavigationControl.ZoomOut': '縮小',
    'NavigationControl.ResetBearing': '北を上に戻す',
    'GeolocateControl.FindMyLocation': '現在位置を表示',
    'GeolocateControl.LocationNotAvailable': '現在位置を取得できません',
    'Popup.Close': '閉じる',
  },
});

// 調査用と pipeline/render_check.mjs のために出しておく
window.map = map;

// 同期で登録する。`load` は一度しか発生しないが、`map.loaded()` はソースの
// 取得中に false へ戻る。後者で場合分けすると、`load` が済んだ後に
// `once('load')` を足して `boot()` がエラーも出さずに止まる。ブラウザの
// キャッシュが効く再読み込みで再現した。
const mapLoaded = new Promise((res) => map.once('load', res));

// 拡大・縮小と方位を別のグループに分ける。既定では三つが一つの
// 角丸にまとまるが、拡大・縮小は範囲を変え、方位は北を戻すだけで、押す場面も
// 頻度も違う。同じグループだと拡大を連打した指が方位に触れて地図が回る。二つ
// addControl すれば MapLibre がグループごとに積んで隙間を空ける。
map.addControl(
  new maplibregl.NavigationControl({ showCompass: false }),
  'top-right',
);
map.addControl(
  new maplibregl.NavigationControl({ showZoom: false, visualizePitch: false }),
  'top-right',
);
/* 縮尺の目盛りは置かない。この地図で読むのは番号がどこを通るかで、縮尺の数は
 * 効かない。右下は凡例と出典だけである。 */

/* -------------------------------------------------------- 押し続けて拡大 --- */
/**
 * NavigationControl の拡大・縮小ボタンは、素のままではクリックのたびに 1 段階
 * ズームする。ここでは押した瞬間に 1 段階ズームし、HOLD_DELAY_MS を過ぎても
 * 押されていれば連続ズームへ移す。
 *
 * 1 段階も pointerdown 側で行うので、離したときの click が届くと 1 段階よけいに
 * ズームする。pointerdown が起きた押下は document の capture 段でその click を
 * 止める。button 自身に capture:true で足しても、同じ要素上では登録順なので
 * NavigationControl の click listener より後になり、間に合わない。キーボード
 * (Enter/Space)は pointerdown を経ないので、click がそのまま届く。
 */
const HOLD_DELAY_MS = 500;
const HOLD_ZOOM_RATE = 0.8; // ズームレベル/秒

const suppressClickFor = new Set();
document.addEventListener(
  'click',
  (e) => {
    for (const button of suppressClickFor) {
      if (button.contains(e.target)) {
        suppressClickFor.delete(button);
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    }
  },
  true,
);

function attachHoldToZoom(button, zoomOnce, sign) {
  let holdTimer = null;
  let rafId = null;
  let prevTime = 0;
  // 2 本指の同時タップなどで 2 つ目の pointerdown が holdTimer を上書きすると、
  // 片方を離してもタイマーと rAF が残る。先着のポインターだけを追う。
  let activePointerId = null;

  function frame(now) {
    const dt = (now - prevTime) / 1000;
    prevTime = now;
    map.setZoom(map.getZoom() + sign * HOLD_ZOOM_RATE * dt);
    rafId = requestAnimationFrame(frame);
  }

  function stopContinuous(e) {
    if (e.pointerId !== activePointerId) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    activePointerId = null;
  }

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || activePointerId !== null) return; // 左ボタン・タッチ・ペンのみ
    button.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
    suppressClickFor.add(button);
    zoomOnce(e);
    holdTimer = setTimeout(() => {
      prevTime = performance.now();
      rafId = requestAnimationFrame(frame);
    }, HOLD_DELAY_MS);
  });
  button.addEventListener('pointerup', stopContinuous);
  button.addEventListener('pointercancel', (e) => {
    const wasActive = e.pointerId === activePointerId;
    stopContinuous(e);
    // pointercancel の後に click は来ないので、ここで畳む。
    if (wasActive) suppressClickFor.delete(button);
  });
  button.addEventListener('lostpointercapture', stopContinuous);
}

for (const [selector, zoomOnce, sign] of [
  ['.maplibregl-ctrl-zoom-in', (e) => map.zoomIn({}, { originalEvent: e }), 1],
  [
    '.maplibregl-ctrl-zoom-out',
    (e) => map.zoomOut({}, { originalEvent: e }),
    -1,
  ],
]) {
  const btn = document.querySelector(selector);
  if (btn) attachHoldToZoom(btn, zoomOnce, sign);
}
// 出典を定義する唯一の場所。操作パネルも同じことを書いていたが、二箇所にあると
// 片方が古くなる。必ず置くのは地図自身の部品のほうである。
// 「国道マップについて」が出典を繰り返さないのも同じ理由である。
map.addControl(
  new maplibregl.AttributionControl({
    compact: false,
    customAttribution:
      '道路データ <a href="https://www.openstreetmap.org/copyright" ' +
      'target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL 1.0)',
  }),
  'bottom-right',
);

/* ---------------------------------------------------------- 状態のラベル --- */
/**
 * ボタンの状態が変わった直後に、脇へ一瞬だけ出すラベル。ホバーの title と同じ
 * 確認を、ホバーの無い指の操作に与える。ボタンと同じグループの中にあるので、
 * 位置合わせの計算を持たない。
 */
const STATE_TIP_MS = 2400;

function attachStateTip(container) {
  const tip = document.createElement('div');
  tip.className = 'state-tip';
  container.appendChild(tip);
  let hideTimer;
  const hide = () => {
    clearTimeout(hideTimer);
    tip.classList.remove('show');
  };
  tip.addEventListener('click', (ev) => {
    ev.stopPropagation();
    hide();
  });
  // グループにボタンが二つ載ることがある。押されたボタンの高さに合わせないと、
  // どちらの返事か分からない。
  return (text, btn) => {
    tip.style.top = `${btn.offsetTop}px`;
    tip.textContent = text;
    tip.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, STATE_TIP_MS);
  };
}

/* ------------------------------------------------------------ ボタン工場 --- */
/**
 * 地図の右上のボタンは同じ形をしている。押すと `order` を一つ進め、値から
 * アイコンとラベルを描き直す。`get`/`apply` はボタンの外の状態(地図の層、
 * localStorage)を触るので、ここが持つのはボタンだけである。
 *
 * `order` が二値なら切り替えなので、`active` と `aria-pressed` を付ける。三値は
 * 付けない。`tip` は既定で `label` と同じで、「次に押すと何が起きるか」と「いま
 * 何になったか」で言い方を変えるボタンだけが別に渡す(`pitchStateTip`、
 * `hideStateTip`)。
 *
 * `onExternalChange` を渡すと `render` を手渡す。押していないところで状態が
 * 動くボタン(視点は Ctrl+ドラッグでも変わる)が描き直すために使う。`isPressed`
 * も同じ事情で、視点の `get()` はドラッグが残した任意の角度を返しうるので、
 * 真上でない限り「押されている」と見なす。
 */
function cycleButton(
  {
    id,
    order,
    get,
    apply,
    icon,
    label,
    tip,
    isPressed = (value) => value === order[1],
    onExternalChange,
  },
  showTip,
) {
  const tipFor = tip ?? label;
  const isToggle = order.length === 2;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = id;
  const render = () => {
    const value = get();
    btn.innerHTML = icon(value);
    const text = label(value);
    btn.title = text;
    btn.setAttribute('aria-label', text);
    if (isToggle) {
      const pressed = isPressed(value);
      btn.classList.toggle('active', pressed);
      btn.setAttribute('aria-pressed', String(pressed));
    }
  };
  btn.addEventListener('click', () => {
    const next = order[(order.indexOf(get()) + 1) % order.length];
    apply(next);
    render();
    showTip(tipFor(next), btn);
  });
  render();
  onExternalChange?.(render);
  return btn;
}

/**
 * 一つのグループにボタンを一つ以上載せる MapLibre の IControl。
 * `addControl(…, 'top-right')` するだけで角丸のグループごと縦に積まれる。
 *
 * グループを分けるかどうかがボタンの近さの表し方である。地図の種類と濃さの
 * ように同じ絵の見え方を決める二つは一つに載せ、役目の違うものは分ける。
 */
function buildCycleControl(className, ...specs) {
  return class CycleControl {
    onAdd() {
      const container = document.createElement('div');
      container.className = `maplibregl-ctrl maplibregl-ctrl-group ${className}`;
      const showTip = attachStateTip(container);
      for (const spec of specs)
        container.appendChild(cycleButton(spec, showTip));
      this._container = container;
      return container;
    }
    onRemove() {
      this._container.remove();
    }
  };
}

/* ------------------------------------------------------------------ 傾き --- */
/**
 * 真上が普段の姿勢で、60 度は地形を眺める姿勢である。Ctrl+ドラッグはその間の
 * 任意の角度に届くので、`mapPitch` はドラッグが終わるたび `onExternalChange`
 * 経由で地図の実際の傾きから取り直す。`order.indexOf` はドラッグ途中の角度を
 * 見つけられず `order[0]`(真上)へ落ちるので、ボタンは真上以外ではつねに真上へ
 * 戻すことを申し出る。
 *
 * 二つのアイコンは同じ正方形を二つの姿勢から見た絵である。真上からは正面、
 * 傾けると手前の辺が長い台形になる。等角の立体は物を描いてしまうので使わない。
 * このボタンが変えるのは平らな地図を見る角度である。
 */
const PITCH_TILT_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M8 6h8l5 12H3L8 6Z" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
  '</svg>';
const PITCH_FLAT_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="4" y="4" width="16" height="16" rx="1" fill="none" ' +
  'stroke="currentColor" stroke-width="2"/>' +
  '</svg>';

let mapPitch = map.getPitch();

function pitchStateTip(pitch) {
  return pitch === 0 ? '視点: 真上' : '視点: 斜め 60°';
}

function applyPitch(pitch) {
  mapPitch = pitch;
  map.easeTo({ pitch, duration: 400 });
}

const PitchControl = buildCycleControl('pitch-ctrl', {
  id: 'pitch-btn',
  order: [0, 60],
  get: () => mapPitch,
  apply: applyPitch,
  icon: (pitch) => (pitch === 0 ? PITCH_FLAT_ICON : PITCH_TILT_ICON),
  label: (pitch) => (pitch === 0 ? '視点を斜めにする' : '視点を真上に戻す'),
  tip: pitchStateTip,
  isPressed: (pitch) => pitch !== 0,
  onExternalChange: (render) => {
    map.on('pitchend', () => {
      mapPitch = map.getPitch();
      render();
    });
  },
});

/* ------------------------------------------------------------ 道路を隠す --- */
/**
 * 下地図だけを一時的に見る。道路の下の地形を読むためのものである。国道と
 * 都道府県道の両方を隠し、片方だけ地形の上に残さない。表示・非表示であって
 * 絞り込みではないので、`state` にも URL にも触れない。戻したときは
 * チェックボックスのとおりを出す。
 */
const EYE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" fill="none" ' +
  'stroke="currentColor" stroke-width="2.1" stroke-linecap="round" ' +
  'stroke-linejoin="round"/>' +
  '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2.1"/>' +
  '</svg>';
const EYE_OFF_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M9.9 5.2A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a15.6 15.6 0 0 1-3.4 4.3M6.5 ' +
  '6.5A15.7 15.7 0 0 0 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.9-.8" fill="none" ' +
  'stroke="currentColor" stroke-width="2.1" stroke-linecap="round" ' +
  'stroke-linejoin="round"/>' +
  '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" fill="none" stroke="currentColor" ' +
  'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round"/>' +
  '</svg>';

let routesHidden = false;

// label は次に押すと起きる動作(動詞)なので、押した直後の状態を示す state-tip
// にはそのまま使えない。
function hideStateTip(hidden) {
  return hidden ? '道路: 非表示' : '道路: 表示';
}

function setRoutesHidden(hidden) {
  routesHidden = hidden;
  // 当たり判定の透明な層は routeLayers()/prefLayers() に含まれない。一緒に
  // 隠さないと、隠したはずの道路がカーソルとクリックには残る。
  const layers = [
    ...routeLayers(),
    ...clickableHitLayers(),
    ...prefLayers(),
    ...prefClickableHitLayers(),
  ];
  for (const { id } of layers) {
    map.setLayoutProperty(id, 'visibility', hidden ? 'none' : 'visible');
  }
}

const HideRoutesControl = buildCycleControl('hide-routes-ctrl', {
  id: 'hide-routes-btn',
  order: [false, true],
  get: () => routesHidden,
  apply: setRoutesHidden,
  icon: (hidden) => (hidden ? EYE_OFF_ICON : EYE_ICON),
  label: (hidden) => (hidden ? '道路の表示に戻す' : '道路を一時的に隠す'),
  tip: hideStateTip,
});

/* -------------------------------------------------------- ボタンから出る面 --- */
/**
 * 地図の上のボタンを押すと、そのグループの脇から出るポップオーバー。左上の
 * 「道路を選択」「国道重用区間ランキング」「起点・終点を共有する地点」と、
 * 右上の「表示」の四つが同じ仕掛けで動く。
 *
 * ポップオーバーはボタンと同じグループの中にあるので、位置合わせの計算は
 * 無くボタンを追う(state-tip と同じ)。CSS が向きを決め、左上からは右へ、
 * 右上からは左へ出る。窓の端しか無い側を避ける。
 *
 * 一度に開くのは一つだけにする。四つとも地図の上に浮くので、二枚並ぶと地図の
 * 見える面積が急に減る。
 */
const PANE_GAP = 12;

/** 開け閉てを預かっているポップオーバー。{ btn, pane, roots } の並びである。 */
const panes = [];

/**
 * 上端はボタンに合わせる。窓の下からはみ出すなら、はみ出したぶんだけ
 * 引き上げる。低い窓ではボタンに揃えることより中身が見えることが先である。
 * 引き上げても入らない高さは中でスクロールする(style.css の max-height)。
 */
function fitPane(pane) {
  pane.style.top = '-1px';
  const over =
    pane.getBoundingClientRect().bottom - (window.innerHeight - PANE_GAP);
  if (over > 0) pane.style.top = `${-1 - over}px`;
}

function setPane(entry, open) {
  entry.pane.hidden = !open;
  entry.btn.classList.toggle('active', open);
  entry.btn.setAttribute('aria-expanded', String(open));
  if (open) fitPane(entry.pane);
}

const anyPaneOpen = () => panes.some((e) => !e.pane.hidden);

function closePanes() {
  for (const e of panes) setPane(e, false);
}

/**
 * ボタンとポップオーバーを結ぶ。`root` は「そのポップオーバーの持ち物」の
 * 範囲で、外を押したときに閉じるかどうかをこれで見分ける。グループには
 * ボタンもあるので、ポップオーバーだけを見ると、同じグループの ✕ を
 * 押しただけで一覧が畳まれる。
 *
 * 「道路を選択」はボタン(#select-btn)とポップオーバー(#select-popover)が別の
 * グループにある。選んだ本数のバッジで幅が変わらない #ranking-btn のグループへ
 * 位置合わせのため移してある(index.html)。両方のグループを渡せば、どちらを
 * 押しても「持ち物の中」と見なせる。 */
function registerPane(btn, pane, root) {
  const roots = Array.isArray(root) ? root : [root];
  const entry = { btn, pane, roots };
  panes.push(entry);
  btn.addEventListener('click', () => {
    const willOpen = pane.hidden;
    closePanes();
    if (willOpen) setPane(entry, true);
  });
  return entry;
}

// 窓を掴んでいる最中にポップオーバーが窓からはみ出さないように。
window.addEventListener('resize', () => {
  for (const e of panes) if (!e.pane.hidden) fitPane(e.pane);
});

// 持ち物の外を押したら閉じる。ボタン自身の click もここへ来るが、そのグループ
// は root の中なので通る。
document.addEventListener('click', (ev) => {
  for (const e of panes) {
    if (!e.pane.hidden && !e.roots.some((r) => r.contains(ev.target))) {
      setPane(e, false);
    }
  }
});

/* 左上の三つ。markup は index.html が持ち、データが届く前から state と
 * 結べる。 */
for (const [btnId, paneId] of [
  ['#ranking-btn', '#ranking-popover'],
  ['#shared-btn', '#shared-popover'],
]) {
  const btn = $(btnId);
  registerPane(btn, $(paneId), btn.closest('.ui-ctrl'));
}
// 「道路を選択」のポップオーバーは #ranking-btn のグループへ移してある
// (index.html)ので、持ち物の範囲は両方のグループになる。
const selectBtn = $('#select-btn');
registerPane(selectBtn, $('#select-popover'), [
  selectBtn.closest('.ui-ctrl'),
  $('#ranking-btn').closest('.ui-ctrl'),
]);
// 開いたときに都道府県道の番号を取る。開かない人には取らない。二度目以降は
// 覚えた物を返す。
selectBtn.addEventListener('click', loadPrefIndex);

/* -------------------------------------------------------------- 表示の面 --- */
/**
 * 「何が地図に描かれるか」を決めるものはすべてここに集める。結果は地図にしか
 * 現れないので地図の側に置き、節を分けて一つに収める。ボタンを分けると、
 * どちらを押すか毎回考えることになる。
 */
const displayPane = $('#display-popover');

/** つまみの付いた二本のスライダー。表示を決めるポップオーバーの、ありふれた
 *  アイコンである。 */
const DISPLAY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M3 8h8M17.5 8H21M3 16h4.5M14 16h7" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
  '<circle cx="14.2" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<circle cx="10.7" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '</svg>';

class DisplayControl {
  onAdd() {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group display-ctrl';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'display-btn';
    btn.innerHTML = DISPLAY_ICON;
    btn.title = '表示';
    btn.setAttribute('aria-label', '表示');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'display-popover');
    container.append(btn, displayPane);
    registerPane(btn, displayPane, container);
    this._container = container;
    return container;
  }
  onRemove() {
    this._container.remove();
  }
}

/* ------------------------------------------------------------ 地図の濃さ --- */
/**
 * 濃さごとの、しずくの満ち方と水面の傾き。薄いは輪郭だけ、濃いは縁まで満ちて
 * 平ら。通常は半分より少し下に傾いた水面を置く。この傾きが「液体」に読め、
 * 抽象的な目盛りと見分けが付く。
 */
const SHADE_FILL = { light: 0, normal: 0.42, dark: 1 };
const SHADE_TILT = { light: 0, normal: 10.4, dark: 0 }; // 幅18に対し約30度

/** しずく。いまの濃さのぶんだけ下から満ちる。 */
function shadeIcon(level) {
  const drop =
    'M12 2.4C12 2.4 5 11.2 5 15.6a7 7 0 0 0 14 0C19 11.2 12 2.4 12 2.4Z';
  const top = 2.4;
  const bottom = 22.6; // 15.6 + 7 の半径ぶん下
  const fillH = (bottom - top) * SHADE_FILL[level];
  const fillY = bottom - fillH;
  const halfTilt = SHADE_TILT[level] / 2;
  const leftY = (fillY + halfTilt).toFixed(2); // 左下から右上へ上がる液面
  const rightY = (fillY - halfTilt).toFixed(2);
  const below = (bottom + 3).toFixed(2); // クリップの外まで伸ばして隙間をなくす
  const liquid =
    fillH <= 0
      ? ''
      : '<g clip-path="url(#shade-drop-clip)">' +
        `<polygon points="3,${below} 3,${leftY} 21,${rightY} 21,${below}" fill="currentColor"/>` +
        '</g>';
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    `<defs><clipPath id="shade-drop-clip"><path d="${drop}"/></clipPath></defs>` +
    liquid +
    `<path d="${drop}" fill="none" stroke="currentColor" stroke-width="1.7"/>` +
    '</svg>'
  );
}

/**
 * 下地図の濃さ。薄い・通常・濃いをボタン 1 つで回す。表示の好みであって絞り込み
 * ではないので `state` にも URL にも触れないが、道路を隠すボタンと違って覚えて
 * おく値打ちがあるので localStorage に残す。
 */
function applyGsiShade(level) {
  gsiShade = level;
  const { opacity, brightnessMax } = GSI_SHADE_PAINT[level];
  for (const id of GSI_BASEMAP_ORDER) {
    map.setPaintProperty(gsiLayerId(id), 'raster-opacity', opacity);
    map.setPaintProperty(
      gsiLayerId(id),
      'raster-brightness-max',
      brightnessMax,
    );
  }
  try {
    localStorage.setItem('gsi-shade', level);
  } catch {
    /* プライベートブラウズ: 選択がタブより長く残らないだけである。 */
  }
}

const SHADE_BUTTON = {
  id: 'gsi-shade-btn',
  order: GSI_SHADE_LEVELS,
  get: () => gsiShade,
  apply: applyGsiShade,
  icon: shadeIcon,
  label: (level) => `地図の濃さ: ${GSI_SHADE_LABELS[level]}`,
};

/* ---------------------------------------------------------------- 下地図 --- */
/**
 * 下地図ごとのアイコン。同じ形を塗り分けるのではなく、別の見立てにする。淡色
 * 地図は折り畳んだ紙の地図、標準地図は重ねた層、写真は写真の枠である。ラベルを
 * 読まずに見分けられる。
 */
const BASEMAP_ICONS = {
  pale:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2Z" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linejoin="round" ' +
    'stroke-linecap="round"/>' +
    '<path d="M9 3v16M15 5v16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round"/>' +
    '</svg>',
  std:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 2 2 7l10 5 10-5-10-5Z" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<path d="M2 17l10 5 10-5M2 12l10 5 10-5" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linejoin="round" ' +
    'stroke-linecap="round"/>' +
    '</svg>',
  photo:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" ' +
    'stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="8.5" cy="8.5" r="1.6" fill="currentColor"/>' +
    '<path d="M21 15l-5-5-9 9" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>',
};

/**
 * 下地図の切り替え。三つとも常にスタイルの中にあるので(baseStyle)、層の表示・
 * 非表示の反転であって、ソースの作り直しではない。濃さの paint 属性は下地図の
 * 層すべてに載せてあるので、そのまま引き継ぐ。
 */
function applyBasemap(id) {
  map.setLayoutProperty(gsiLayerId(basemap), 'visibility', 'none');
  basemap = id;
  map.setLayoutProperty(gsiLayerId(basemap), 'visibility', 'visible');
  // 下地図が替わると、都道府県道の縁取りの色も替わる(mapspec.mjs の
  // prefCasingColor)。起動時の色は boot が同じ関数から入れる。
  map.setPaintProperty(
    PREF_CASING_LAYER,
    'line-color',
    prefCasingColor(basemap),
  );
  try {
    localStorage.setItem('gsi-basemap', basemap);
  } catch {
    /* プライベートブラウズ: 選択がタブより長く残らないだけである。 */
  }
}

const BASEMAP_BUTTON = {
  id: 'basemap-btn',
  order: GSI_BASEMAP_ORDER,
  get: () => basemap,
  apply: applyBasemap,
  icon: (bmId) => BASEMAP_ICONS[bmId],
  label: (bmId) => `地図の種類: ${GSI_BASEMAPS[bmId].label}`,
};

/**
 * 下地図の種類と濃さは同じ一枚の見え方なので、一つのグループに載せる。種類が
 * 先で、濃さがその下に付く。
 */
const BasemapControl = buildCycleControl(
  'basemap-ctrl',
  BASEMAP_BUTTON,
  SHADE_BUTTON,
);

/* ---------------------------------------------------------- 地図をずらす --- */
/**
 * 地図の上に浮いているパネルのぶんだけ、地図の「中心」をずらす。
 *
 * 詳細パネル(#detail)は地図の要素を細くせず上に浮かせる。細くすると canvas の
 * 寸法が変わり、開け閉てのたびに全部描き直しになる。padding をずらせば、絵は
 * そのままで fitBounds や flyTo の行き先だけがパネルを避ける。
 *
 * 寸法と位置は style.css が持つので、ここは実測した矩形に隙間ぶんを足すだけに
 * する。
 */
const app = $('#app');
const detail = $('#detail');
const detailBody = $('#detail-body');
const narrowMq = window.matchMedia(NARROW_QUERY);

const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
/** パネルと地図のあいだに残す余白。 */
const BOX_GAP = 12;
/** 一辺で覆ってよい上限。これが無いと、低い窓では地図の中心が画面の外へ
 * 出る。 */
const MAX_SIDE_RATIO = 0.6;
const EASE_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ? 0
  : 260;

/**
 * 地図が中心と見なす点を、開いているパネルの外へ寄せる。避けるのは詳細パネル
 * だけである。他に浮く物(左上の見出しとグループ、右上のボタン、右下の凡例)は
 * 小さく、避けると地図が寄ってかえって落ち着かない。ポップオーバーはボタンを
 * 押しているあいだだけの物なので数えない。
 */
function mapPadding() {
  const canvas = $('#map').getBoundingClientRect();
  if (detail.hidden) return { ...NO_PADDING };
  const box = detail.getBoundingClientRect();

  // 広い画面では詳細は左下にあるので、左だけを空ける。
  if (!narrowMq.matches) {
    const left = Math.min(
      box.right - canvas.left + BOX_GAP,
      canvas.width * MAX_SIDE_RATIO,
    );
    return { ...NO_PADDING, left };
  }

  // 狭い画面では幅いっぱいの帯が下端に出るので、避ける向きは下になる。
  const bottom = Math.min(
    canvas.bottom - box.top + BOX_GAP,
    canvas.height * MAX_SIDE_RATIO,
  );
  return { ...NO_PADDING, bottom };
}

/** 渡すのは padding だけである。center も zoom も渡さないので、絵はそのままで
 *  中心と見なす点だけがパネルの外へ寄る。 */
function applyMapPadding(animate) {
  const padding = mapPadding();
  if (animate) map.easeTo({ padding, duration: EASE_MS });
  else map.setPadding(padding);
}

/**
 * padding を変えても絵を動かさない。padding は中心と見なす点をずらすので、
 * 変えると絵は逆へ滑る。新しい padding のもとで中心になる画素に今写っている
 * 地点を、そのまま新しい中心に据え直す。
 */
function setPaddingKeepingView() {
  const padding = mapPadding();
  const canvas = $('#map').getBoundingClientRect();
  const x = canvas.width / 2 + (padding.left - padding.right) / 2;
  const y = canvas.height / 2 + (padding.top - padding.bottom) / 2;
  map.jumpTo({ padding, center: map.unproject([x, y]) });
}

/* ------------------------------------------------------------ 凡例を畳む --- */
/**
 * 凡例を畳んで、地図に角を返す。閉じるのは凡例自身の ×、開き直すのは同じ角に
 * 残る #legend-open である。
 *
 * 状態は localStorage に残す。配色や下地図と同じ表示の好みなので、共有した
 * リンクが相手の凡例まで決める理由が無い。
 *
 * 畳んだ状態を効かせるのは CSS で、キーは <html> の data-legend である。
 * index.html の <head> が最初の描画の前に同じ属性を置くので、ここは hidden を
 * 置かない。
 */
(() => {
  const open = $('#legend-open');
  const set = (isOpen) => {
    document.documentElement.dataset.legend = isOpen ? 'on' : 'off';
    open.setAttribute('aria-expanded', String(isOpen));
    try {
      localStorage.setItem('legend-open', isOpen ? '1' : '0');
    } catch {
      /* プライベートブラウズ: 選択がタブより長く残らないだけである。 */
    }
  };
  open.addEventListener('click', () => set(true));
  $('#legend-close').addEventListener('click', () => set(false));
  // <head> が既に読んでいる。ここは aria-expanded を初回だけ合わせ直す。
  open.setAttribute(
    'aria-expanded',
    String(document.documentElement.dataset.legend !== 'off'),
  );
})();

/* ------------------------------------------------------ この地図について --- */
/**
 * データがいつのものか、どこで作られているかを出すダイアログ。中身は buildUI()
 * が一度入れたきりなので、開くボタンを結ぶだけでよい。showModal() が Esc と
 * フォーカスの往復を面倒みる。
 */
$('#about-btn').addEventListener('click', () => {
  $('#about-dialog').showModal();
  // 都道府県道の全国集計は、県別 meta と同じく初期表示では読まない
  // (loadPrefSummary)。読むきっかけがここしか無いので、開くたびに呼ぶ。
  // 取得済みなら Promise を覚えているので取り直さない。
  loadPrefSummary();
});

/**
 * backdrop を押したら閉じる。<dialog> にとって backdrop は自分の領域で、中身は
 * <form> が隅まで埋めている。押されたのが <dialog> そのものなら backdrop を
 * 押したということで、位置を測る必要が無い。
 */
for (const dialog of document.querySelectorAll('dialog.sheet')) {
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
}

/* ------------------------------------------------------------------ 起動 --- */
async function boot() {
  const [index, meta] = await Promise.all([
    fetch(dataURL('regions.json')).then((r) => r.json()),
    fetch(dataURL('national.meta.json')).then((r) => r.json()),
  ]);
  if (!index.length) throw new Error(`${dataURL('regions.json')} is empty`);
  state.meta = meta;
  state.routes = routesOf(meta.combinations);
  state.prefLabels = new Map(index.map((r) => [r.region, r.label]));
  applyURLState();

  await mapLoaded;

  // アーカイブの所在は絶対で指す。protocol の handler が自分で URL を解くので、
  // 相対の基準にできるページを持たない。
  const sources = routeSources(
    new URL(PMTILES_URL, location.href).href,
    new URL(PREF_PMTILES_URL, location.href).href,
  );
  for (const [id, src] of Object.entries(sources)) map.addSource(id, src);
  /* 都道府県道の線は国道より先に足す。後から足した層が上に載るので、国道は
   * 都道府県道の上になり、国道だけを見ている人には今までと同じ絵である。
   *
   * 県道のラベルだけは線より上でなければ国道の線に潜るので、国道のラベルの
   * すぐ下へ差し込む。場所争いの優先も同時に決まる(prefLabelLayer)。 */
  for (const layer of prefLineLayers(basemap)) map.addLayer(layer);
  for (const layer of routeLayers()) map.addLayer(layer);
  map.addLayer(prefLabelLayer(), 'route-labels');
  // 当たり判定だけを太らせた透明な層。不透明度 0 なので描く順に意味は無く、他の
  // 層の位置決め(prefLabelLayer の beforeId)を邪魔しない場所へまとめて置く。
  for (const layer of prefClickableHitLayers()) map.addLayer(layer);
  for (const layer of clickableHitLayers()) map.addLayer(layer);
  map.addControl(new PitchControl(), 'top-right');
  map.addControl(new HideRoutesControl(), 'top-right');
  map.addControl(new DisplayControl(), 'top-right');
  map.addControl(new BasemapControl(), 'top-right');
  /**
   * 現在位置。MapLibre 自身の部品を使う。点・精度の円・追従の解除まで一式を
   * 持つ。位置は端末から地図へ渡るだけで、`state` にも URL にも入らない。
   *
   * 並びの一番下に置く。上のボタンはどれも「地図をどう見せるか」を決めるだけ
   * だが、これは押した瞬間に地図が飛ぶ。
   *
   * `trackUserLocation` で、一度押せば動くたびに点が付いてくる。全国の縮尺で
   * 点だけ打たれても居場所は読めないので、寄る先は街の見える z15 までとする。
   */
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserLocation: true,
      showAccuracyCircle: true,
      fitBoundsOptions: { maxZoom: 15 },
    }),
    'top-right',
  );

  wirePopups();
  wireControls(document, state, applyFilters);
  wireShare(document, state);

  map.getSource('termini').setData(terminiFeatures(state.meta));

  buildUI();
  syncControls();
  applyFilters();

  /* 共有されたリンクが都道府県道を名指しているなら、その詳細を開く。
   * 操作パネルに都道府県道の節は無いので(#109)、絞っていることを示す場所も
   * 解除するボタンもこのパネルのほかに無い。開かずに出すと、県道が数本しか
   * 出ていない理由が画面のどこにも無く、「壊れている」に見える。 */
  openSharedPrefDetail();

  // 共有されたリンクの hash が優先する。無ければ `?region=` の地域を使う。表示
  // 位置の指定であって、データの切り替えではない。どちらも無ければ、作られた
  // ときの表示位置のままである。
  if (!sharedView) fitInitialView(index);

  $('#loading').classList.add('done');
}

/**
 * 共有されたリンクが運ぶ絞り込みと表示の状態を、最初の描画の前に読む。
 * decodeURLState が返すのは差分なので、URL が名指しした項目だけを上書きする。
 * データに無い路線は選択から落とし、番号が変わった後の古いリンクが何も指さない
 * ままになるのを避ける。
 */
function applyURLState() {
  const diff = decodeURLState(location.search);
  if (diff.selected) {
    const known = new Set(state.routes.map((r) => r.ref));
    diff.selected = new Set([...diff.selected].filter((r) => known.has(r)));
  }
  // 都道府県道は県までを確かめる。県の中に何号があるかの表は配っていない。
  // 13,234 組の索引を初期表示で読ませないためである(#109)。無い番号は地図に
  // 何も出さないだけだが、無い県は「長野県道」の名すら出せない。
  if (diff.prefSelected) {
    diff.prefSelected = new Set(
      [...diff.prefSelected].filter((key) =>
        state.prefLabels.has(prefRegionOf(key)),
      ),
    );
  }
  Object.assign(state, diff);
}

/**
 * 自分では値を持たない部品すべてに `state` を押し出す。起動時に、applyURLState
 * が markup の既定から state を動かした後に一度だけ呼ぶ。以後の変化は listener
 * から `state` へ流れる。
 */
function syncControls() {
  syncRouteList(document, state);
  $(`input[name=conc][value="${state.conc}"]`).checked = true;
  $('#t-national').checked = state.national;
  $('#t-pref').checked = state.pref;
  $('#t-labels').checked = state.labels;
  $('#t-termini').checked = state.termini;
  $('#t-expressway').checked = state.expressway;
  $('#t-special').checked = state.special;
  $('#t-ferry').checked = state.ferry;
  $('#t-former').checked = state.former;
  $('#t-pref-special').checked = state.prefSpecial;
}

/**
 * `?region=` が地域を名指していれば、そこへ寄る。全国の表示位置は地図を作る
 * ときの center/zoom が既定である。例外は縦長の狭い画面で、既定の縮尺では九州と
 * 北海道が両端で切れるので、データの広がりに合わせる。
 */
function fitInitialView(index) {
  const wanted = new URLSearchParams(location.search).get('region');
  const box =
    index.find((r) => r.region === wanted)?.bbox ??
    (narrowMq.matches ? state.meta.bbox : null);
  if (!box) return;
  const [w, s, e, n] = box;
  const bounds = [
    [w, s],
    [e, n],
  ];
  // 浮いているパネルのぶんは地図の padding が持つ。fitBounds の padding
  // はそれを置き換えるので、余白を足した形で渡し直す。
  const p = map.getPadding();
  const clear = {
    top: p.top + 24,
    bottom: p.bottom + 24,
    left: p.left + 24,
    right: p.right + 24,
  };
  // パネルを避けた残りに地域が入らない画面(縦に長い狭い画面)では
  // cameraForBounds が何も返さないので、避けるのをやめて窓いっぱいに合わせる。
  // 端が操作パネルの下に少し潜るが、パネルは閉じられる。
  const padding = map.cameraForBounds(bounds, { padding: clear }) ? clear : 24;
  map.fitBounds(bounds, { padding, duration: 0 });
}

/* -------------------------------------------------------------- 絞り込み --- */
/**
 * いま地図に出す系統。規則は mapspec.mjs の shownSystems が持つ。絞り込みの式と
 * 同じ場所に置いて、検査スクリプトが本物を読めるようにする。
 */
const shown = () =>
  shownSystems({
    national: state.national,
    pref: state.pref,
    selected: state.selected.size,
    prefSelected: state.prefSelected.size,
  });

function applyFilters() {
  const base = buildFilter([...state.selected], state.conc, state.former);
  const { national, pref } = shown();

  for (const { id, kinds, negate, toggle } of FILTERED_LAYERS) {
    const filter =
      !national || (toggle && !state[toggle])
        ? NOTHING
        : kinds
          ? withKind(base, kinds, negate)
          : base;
    map.setFilter(id, filter);
    // 当たり判定の透明な層は見た目の層と同じ絞り込みを持つ。消した区分の上に
    // 判定が残ると、見えない道が押せる。
    if (CLICKABLE_LAYERS.includes(id)) map.setFilter(hitLayerId(id), filter);
  }

  map.setFilter(
    'picked',
    national ? pickedFilter(base, state.picked) : NOTHING,
  );

  // 都道府県道の選択・重用・旧道。共有の buildFilter を都道府県道の選択で
  // 呼び直し、層が持つ既定の区分の式へ重ねる(resolvedPrefFilter)。空選択は
  // 全部出す、国道の buildFilter と同じ約束である。
  const prefBase = buildFilter(
    [...state.prefSelected],
    state.conc,
    state.former,
  );
  for (const {
    id,
    excludeKinds,
    excludeToggle,
    toggle,
  } of PREF_FILTERED_LAYERS) {
    const defaultFilter = PREF_DEFAULT_FILTERS.get(id);
    // `toggle` は層ごと消す(pref-special・pref-labels)。`excludeToggle` は
    // 層は残したまま区分だけ外す(pref-roads・pref-casing の自動車専用道路)。
    // 後者を層ごと消すと、その層が持つ他の区分(road)まで道連れに消える。
    const resolved =
      !pref || (toggle && !state[toggle])
        ? NOTHING
        : resolvedPrefFilter(
            defaultFilter,
            prefBase,
            excludeToggle && !state[excludeToggle] ? excludeKinds : null,
          );
    map.setFilter(id, resolved);
    if (PREF_CLICKABLE_LAYERS.includes(id)) {
      map.setFilter(hitLayerId(id), resolved);
    }
  }

  map.setFilter(
    PREF_PICKED_LAYER,
    pref ? pickedFilter(prefBase, state.prefPicked) : NOTHING,
  );

  const tFilter =
    !national || !state.termini
      ? ['==', ['get', 'count'], -1]
      : terminiFilter([...state.selected]);
  map.setFilter('termini-dot', tFilter);
  map.setFilter('termini-label', tFilter);

  syncLegend();
  // 系統を消したなら、その線の上の指も押せなくなっている。
  syncCursor();
  // 開いているパネルのボタンの押した状態も、選択が変わればここで更新する
  // (wiring.mjs)。
  syncDetailOnly(document, state);
  updateStats();
  renderRanking();
  syncURL();
}

/**
 * 凡例を、地図に描かれている系統だけに絞る。`legend-kind`(点線国道・工事中・
 * 未開通・海上国道)は国道の区分なので `legend-n` と同じく `national` に従い、
 * 都道府県道の破線は `legend-pref` の中にあるので `pref` に従う。両方消えたら
 * 帯そのものも隠し、空の角丸を残さない。
 *
 * 畳んでいるかどうかは別の属性(<html> の data-legend)が持つ。帯を隠す属性と
 * 一つにすると、畳んだほうも道連れになる。
 */
function syncLegend() {
  const { national, pref } = shown();
  $('#legend-n').hidden = !national;
  $('#legend-kind').hidden = !national;
  $('#legend-pref').hidden = !pref;
  $('#legend-bar').hidden = !national && !pref;
}

/**
 * クエリ文字列を `state` に合わせ続ける。MapLibre が書く hash と、この
 * モジュールが管理しないキーには触れない。`?region=` は起動時に
 * 一度読むだけなので、触れば最初の絞り込みで消える。
 */
function syncURL() {
  const params = new URLSearchParams(location.search);
  for (const key of MANAGED_KEYS) params.delete(key);
  for (const [key, value] of new URLSearchParams(encodeState(state))) {
    params.set(key, value);
  }
  const q = params.toString();
  const url = `${location.pathname}${q ? `?${q}` : ''}${location.hash}`;
  history.replaceState(null, '', url);
}

/* -------------------------------------------------------- 画面の組み立て --- */
function buildUI() {
  $('#rl-national-list').innerHTML = routeListHTML(state.routes);
  $('#route-filter').value = '';
  applyRouteFilter(document, state);
  $('#freshness').innerHTML = freshnessHTML(state.meta);
  $('#pref-concurrency').innerHTML = prefConcurrencyHTML();
  renderShared();
}

function updateStats() {
  const sel = state.selected;
  const totals = statsFor(state.meta.combinations, sel);
  $('#stats').innerHTML = statsHTML(sel.size, state.routes.length, totals);

  // 都道府県道は合算せず、独立した数を出す(issue #171)。summary は「この地図
  // について」を開くまで届かない(loadPrefSummary)ので、届くまでは読み込み中
  // か失敗かを一行だけ示す。loadPrefIndex が #rl-pref-rows にする案内と同じ
  // 作法である。
  $('#pref-stats').innerHTML = state.prefSummary
    ? prefStatsHTML(
        state.prefSelected.size,
        state.prefSummary.routes,
        state.prefSummary,
      )
    : `<dt>状態</dt><dd>${
        state.prefSummaryFailed
          ? '読み込めませんでした。開き直すと取り直します。'
          : '読み込んでいます…'
      }</dd>`;

  // 選んでいる本数は両系統の合計である。「道路を選択」が国道と都道府県道の
  // 両方を引き受けるので、数える側も消す側も系統を分けない。
  const picked = sel.size + state.prefSelected.size;

  // 取り消す物が無いあいだ ✕ は出さない。押せない姿で置くより、選んでいるとき
  // だけグループが伸びるほうが、何が起きるかを読み取りやすい。文字を持たない
  // ボタンなので、どれだけ取り消すかはラベルが示す。
  const clear = $('#sel-none');
  clear.hidden = picked === 0;
  const clearText = clearLabel(picked);
  clear.title = clearText;
  clear.setAttribute('aria-label', clearText);

  // ポップオーバーを開かなくても、絞っていることはグループの上で分かるように
  // する。数のバッジがそれを示す。0 は出さない。空の選択は「全部出ている」を
  // 意味するので、0 と書くと地図と逆になる。
  const badge = $('#sel-count');
  badge.textContent = picked ? String(picked) : '';
  badge.hidden = picked === 0;
}

/** ポップオーバーは押すまで開かないので、件数は見出しに出す。 */
function renderRanking() {
  const matching = concurrencies(state.meta.combinations, state.selected);
  const rows = matching.slice(0, RANKING_ROWS);
  $('#ranking-count').textContent = countLabel(
    rows.length,
    matching.length,
    '組',
  );
  $('#ranking').innerHTML = rankingHTML(rows);
}

/** ランキングと同じく、件数は見出しに出す。 */
function renderShared() {
  const all = state.meta.shared_termini;
  const rows = all.slice(0, SHARED_ROWS);
  $('#shared-count').textContent = countLabel(rows.length, all.length, '地点');
  $('#shared').innerHTML = sharedHTML(rows);
}

/**
 * 重用ランキングと起終点共有の行を押すと、その場所へ飛ぶ。
 *
 * どの行も自分が名指しする 1 つの物の広がり(組み合わせの bbox か、起終点の座標)
 * を持つので、視点はそこへだけ送る。以前は行の番号のうち 2 つを共有する
 * 組み合わせを表から拾い直して広がりを求めており、高知市で 4 km を一緒に
 * 走る国道 32・55・56・195・197・493 号を押すと四国の大半(東経 132.5〜134.7 度)
 * が入った。
 *
 * 押しても選択は変えない。ランキングは選択を映すので、行の路線を選ぶと指の下で
 * 一覧が組み直され、押した行が動くか消える。1 路線に絞るのはチェックボックスの
 * 仕事である。
 */
document.addEventListener('click', (ev) => {
  const row = ev.target.closest('.ranking .row');
  if (!row) return;

  for (const other of row.parentElement.querySelectorAll('.row.on')) {
    other.classList.remove('on');
  }
  row.classList.add('on');

  if (row.dataset.at) {
    const [lon, lat] = row.dataset.at.split(',').map(Number);
    map.flyTo({ center: [lon, lat], zoom: 12 });
    return;
  }
  // 短い重用区間は数 m の車道でありうるし、アーク 1 本ぶんなら広がりを
  // 持たない。潰れた bbox が無限の縮尺を要求しないよう、maxZoom で止める。
  const [w, s, e, n] = row.dataset.bbox.split(',').map(Number);
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: 80, maxZoom: 14 },
  );
});

/* ---------------------------------------------------------- ポップアップ --- */
/**
 * 開いているポップアップは多くても 1 つで、地図の上の影はその
 * ポップアップのものである。MapLibre の `closeOnClick` は使わない(showPopup が
 * false を渡す)。それはこのファイルより後に登録された click の handler から前の
 * ポップアップを閉じるので、古いほうの後始末が、新しいポップアップが影を
 * 受け取った後に届いて影を奪う。代わりに wirePopups の click の handler が、
 * 開く前に closePopup() を呼ぶ。閉じ方によらず歩調が揃う。
 */
let popup = null;

function pick(id, prefId = null) {
  state.picked = id;
  state.prefPicked = prefId;
  applyFilters();
}

function closePopup() {
  const p = popup;
  popup = null;
  p?.remove();
  if (state.picked !== null || state.prefPicked !== null) pick(null);
}

/**
 * 都道府県道を押せるか。z8 未満のタイルは `id`・`name`・`km`・`src` を持たず、
 * ポップアップを組めない(mapspec.mjs の PREF_POPUP_MINZOOM)。国道は z0 から
 * 押せる。
 */
const prefPickable = () => map.getZoom() >= PREF_POPUP_MINZOOM;

/**
 * カーソルの形。押せる物の上でだけ指の形にする。二つの系統で押せる条件が違う
 * ので、どちらの上にいるかを覚えて一箇所で決める。押せるかどうかは、その系統が
 * 地図に出ているか、都道府県道なら縮尺が足りているかにもよる。
 *
 * ズームと絞り込みでも見直す。線の上に指を置いたまま縮尺を動かすことも系統を
 * 消すこともでき、`mouseleave` は指が動いたときにしか来ないためである。
 */
let overNational = false;
let overPref = false;

function syncCursor() {
  const { national, pref } = shown();
  const on = (overNational && national) || (overPref && pref && prefPickable());
  const want = on ? 'pointer' : '';
  // ズームは 1 フレームごとに届く。同じ値を書き直さない。
  const canvas = map.getCanvas();
  if (canvas.style.cursor !== want) canvas.style.cursor = want;
}

// 押せる範囲は当たり判定用の透明な層(hitLayerId)で問う。hover と click を同じ
// 層に対して行うので、指の形が変わる範囲と押せる範囲が一致する。見た目の層は
// 太さが重用の深さを表すので広げられない(mapspec.mjs の clickableHitLayers)。
const CLICKABLE_HIT_LAYERS = CLICKABLE_LAYERS.map(hitLayerId);
const PREF_CLICKABLE_HIT_LAYERS = PREF_CLICKABLE_LAYERS.map(hitLayerId);

function wirePopups() {
  for (const id of CLICKABLE_HIT_LAYERS) {
    map.on('mouseenter', id, () => {
      overNational = true;
      syncCursor();
    });
    map.on('mouseleave', id, () => {
      overNational = false;
      syncCursor();
    });
  }
  for (const id of PREF_CLICKABLE_HIT_LAYERS) {
    map.on('mouseenter', id, () => {
      overPref = true;
      syncCursor();
    });
    map.on('mouseleave', id, () => {
      overPref = false;
      syncCursor();
    });
  }
  map.on('zoom', syncCursor);

  map.on('click', (ev) => {
    closePopup();

    // 国道が先である。二つの系統が重なるところでは上に描かれているのは国道で、
    // 押した人が見ているのもそれである。`n` は国道と県道で数えている集合が違う
    // ので、深さを一つの尺度で比べない。国道だけを見ている人には今までと同じ
    // 結果である。
    const hits = map.queryRenderedFeatures(ev.point, {
      layers: CLICKABLE_HIT_LAYERS,
    });
    if (hits.length) {
      const p = deepest(hits);
      showPopup(ev.lngLat, popupHTML(p));
      pick(p.id);
      return;
    }

    if (!prefPickable()) return;
    const prefHits = map.queryRenderedFeatures(ev.point, {
      layers: PREF_CLICKABLE_HIT_LAYERS,
    });
    if (!prefHits.length) return;
    const p = deepest(prefHits);
    const label = state.prefLabels.get(p.pref);
    if (!label) return;
    showPopup(ev.lngLat, prefPopupHTML(p, label));
    pick(null, p.id);
  });
}

function showPopup(lngLat, html) {
  popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false,
    maxWidth: '300px',
  })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
  popup.on('close', closePopup);
}

/* ------------------------------------------------------------------ 詳細 --- */
/**
 * 路線そのものの詳細パネル。中身の組み立ては detail.mjs が持ち、ここに残るのは
 * 地図が必要な三つ(開いたぶん地図をずらす、起終点へ飛ぶ、選択を差し替える)だけ
 * である。居場所は style.css の #detail が、ずらす量は applyMapPadding が持つ。
 */
/**
 * パネルを開いた時点の表示位置。閉じるときに、寄せたぶんを戻すかどうかを
 * 決める。
 *
 * padding を外せば地図は中心を画面の真ん中へ戻すので、絵は寄せたときと逆へ
 * 動く。開けて読んで閉じるだけなら開く前に戻るのが正しい。開いているあいだに
 * 動いた(掴んで送った、起終点へ飛んだ)なら、今の表示位置は利用者が
 * 選んだものなので、padding を外しても絵を動かさない。
 *
 * 見るのは中心と縮尺だけである。padding だけの ease はどちらも変えない。傾きと
 * 向きは場所ではないので数えない。
 */
let detailOpenedAt = null;

const cameraNow = () => ({ ...map.getCenter(), zoom: map.getZoom() });

/* 度で 1e-6 は 10 cm ほど。padding だけの ease が中心に残すのは丸め誤差だけ
 * なので、これを超えていれば本当に動いている。 */
const CAMERA_EPS = 1e-6;

const cameraMoved = (a, b) =>
  Math.abs(a.lng - b.lng) > CAMERA_EPS ||
  Math.abs(a.lat - b.lat) > CAMERA_EPS ||
  Math.abs(a.zoom - b.zoom) > CAMERA_EPS;

/**
 * いま開いているパネルの通し番号。都道府県道のパネルは県別 meta を待つので、
 * 届いた頃には別の路線が開かれていることがある。取りに行く前の番号と届いたとき
 * の番号が同じときだけ書き込む。国道のパネルも番号を進め、遅れて届いた県道の
 * 中身に上書きされないようにする。
 */
let detailSerial = 0;

function openDetail(ref) {
  const route = state.routes.find((r) => r.ref === ref);
  if (!route) return;
  detailSerial++;
  // パネルを出すときはポップアップを閉じる。ポップアップはアーク 1 本、パネルは
  // 路線について述べるので、両方出ていると同じ画面で別のことを述べる。狭い画面
  // では重なりもする。影はポップアップのものなので closePopup() が一緒に消す。
  closePopup();
  // kinds と former は必ず同じ絞り方で読む(aggregate.mjs の touched() が
  // 一箇所にある理由と同じ)。Set を二回作ると食い違いの第一歩になるので、一つを
  // 両方に渡す。
  const sel = new Set([ref]);
  detailBody.innerHTML = detailHTML({
    route,
    kinds: kindsFor(state.meta.combinations, sel),
    termini: decreeTerminiOf(state.meta, ref),
    related: relatedRoutesOf(state.meta, ref),
    formerKm: formerKmFor(state.meta.combinations, sel),
    // 押した状態は state から読む。ボタンが見た目を覚えるのではなく、
    // 選択そのものを毎回描き直す(openPrefDetail も同じ)。
    selected: isOnly(state.selected, state.prefSelected, ref),
  });
  showDetail();
}

/**
 * 一つの都道府県道の詳細パネル。数は県別 meta の組み合わせ表から出す。
 * national.meta.json と同じ表なので読み方(aggregate.mjs)も同じで、違うのは
 * 県を初めて開いたときに取りに行くことだけである。取りに行くあいだも見出しは
 * 出す。押した標識がどの路線かは、数が揃う前から分かっている。
 */
async function openPrefDetail(key) {
  const region = prefRegionOf(key);
  const prefLabel = state.prefLabels.get(region);
  if (!prefLabel) return;
  const ref = prefRefOf(key);
  const serial = ++detailSerial;

  // 押した状態は state から読み、書き込む直前に毎回聞く。県別 meta を
  // 待つあいだにボタンは押せるので、開いた時点の値を控えると、届いた中身が
  // 古い姿へ塗り戻し、次の押下がラベルと逆に働く。
  const selected = () => isOnly(state.prefSelected, state.selected, key);
  closePopup();
  detailBody.innerHTML = prefDetailHTML({
    region,
    prefLabel,
    ref,
    selected: selected(),
  });
  showDetail();

  let meta;
  try {
    meta = await prefMeta(region);
  } catch (err) {
    console.error(err);
    if (serial === detailSerial) {
      detailBody.innerHTML = prefDetailHTML({
        region,
        prefLabel,
        ref,
        selected: selected(),
        failed: true,
      });
      // 高さは中身で変わる。プレースホルダーで計算した padding は古いので、
      // 新しい高さで取り直す。
      showDetail();
    }
    return;
  }
  // 待っているあいだに別の路線が開かれていたら、届いた中身は捨てる。
  if (serial !== detailSerial) return;

  const combos = meta.combinations;
  const route = routesOf(combos, comparePrefKeys).find((r) => r.ref === key);
  // タイルにある路線が県の表に無いのは、配ってある web/data が食い違っている
  // ときである。待っている表示のまま止めず、読めなかったと伝える。
  if (!route) {
    detailBody.innerHTML = prefDetailHTML({
      region,
      prefLabel,
      ref,
      selected: selected(),
      failed: true,
    });
    showDetail();
    return;
  }
  const sel = new Set([key]);
  // 県境で番号が変わらずに続く路線の群(#155)。相手は別の県なので、カードに
  // 出す県名のために 47 県ぶんの対応表ごと渡す。
  const cont = continuationOf(meta, key);
  detailBody.innerHTML = prefDetailHTML({
    region,
    prefLabel,
    ref,
    selected: selected(),
    route,
    rank: prefRankOf(combos, key),
    kinds: kindsFor(combos, sel),
    related: relatedRoutesOf(meta, key, {
      system: '都道府県道',
      compare: comparePrefKeys,
      normalize: String,
    }),
    continuation: cont,
    prefLabels: state.prefLabels,
    // 節の漏斗の押した状態。見出しの漏斗と同じく、書き込む直前に毎回聞く。
    // 県別 meta を待つあいだにも選択は変わりうる。
    groupSelected: cont
      ? isOnlyGroup(state.prefSelected, state.selected, cont.refs)
      : false,
    formerKm: formerKmFor(combos, sel),
  });
  showDetail();
}

/**
 * 共有されたリンクが名指した都道府県道の詳細を開く。最初の描画の後に一度だけ
 * 呼ぶ。
 *
 * 1 本ならそれを開く。2 本以上のときは、それが県境で続く路線の群とちょうど
 * 一致する場合だけ開く(#155)。節の漏斗が作れる形はそれだけで、押した人に
 * とっては 1 つの選択だからである。開かないと、県道が 3 本だけ出ている理由も
 * 解除する口も画面から消える。
 *
 * 開く先は群の先頭にする。URL は押した路線を運ばないので、どれを代表にしても
 * 同じであり、並べ方が決まっていれば開き直すたびに同じ画面になる。
 *
 * 群でない 2 本以上では開かない。パネルは 1 路線について述べる場所で、どれを
 * 代表にしても残りを落とすことになる。画面からその形は作れず、手で書いた URL
 * だけが持ちうる。
 */
async function openSharedPrefDetail() {
  const keys = [...state.prefSelected].sort(comparePrefKeys);
  if (!keys.length) return;
  if (keys.length === 1) {
    openPrefDetail(keys[0]);
    return;
  }
  /* 県別 meta を待つあいだにも、人はアークを押してパネルを開ける。届いた頃に
   * 別の路線が開いていたら、共有リンクの側は引き下がる。openPrefDetail が
   * 遅れて届いた中身を捨てるのと同じ約束である(detailSerial)。 */
  const serial = detailSerial;
  let meta;
  try {
    meta = await prefMeta(prefRegionOf(keys[0]));
  } catch (err) {
    // 数が読めなければ開かない。開いても述べることが無い。
    console.error(err);
    return;
  }
  if (serial !== detailSerial) return;
  const cont = continuationOf(meta, keys[0]);
  if (cont && isOnlyGroup(state.prefSelected, state.selected, cont.refs)) {
    openPrefDetail(keys[0]);
  }
}

/**
 * 全国の県と番号だけの索引を取る。一度取ったら覚えておく。「道路を選択」を
 * 開いたときに呼び、開かない人には取らない。県別 meta 47 本 3.45 MB を
 * 読ませないために、ビルドが番号だけを抜いて 1 枚にしてある
 * (pipeline/pack_web_pref.mjs)。畳み方は URL の選択と同じ範囲表記なので、
 * 開くのも同じ decodeRoutes である。
 */
let prefIndexPending = null;

function loadPrefIndex() {
  if (prefIndexPending) return prefIndexPending;
  state.prefIndexFailed = false;
  prefIndexPending = fetch(dataURL('pref/index.json'))
    .then((r) => {
      if (!r.ok) throw new Error(`pref/index.json: ${r.status}`);
      return r.json();
    })
    .then((raw) => {
      // ある県を決めるのは索引そのものである。state.prefLabels で
      // 絞ってはならない。あれは boot() が埋めるので、埋まる前にここが
      // 解決すると索引が空のまま残り、成功しているぶん prefIndexPending は
      // 解けず、開き直しても取り直さない。
      //
      // prefLabels は並べ替えにだけ使う。県の並びを regions.json の順に
      // 揃えると、一致した行もその順を継ぐ(prefroute.mjs の matchPrefRoutes)。
      // まだ空なら索引の順のまま残る。
      const rank = new Map([...state.prefLabels.keys()].map((r, i) => [r, i]));
      const at = (region) => rank.get(region) ?? Number.MAX_SAFE_INTEGER;
      state.prefIndex = new Map(
        Object.keys(raw)
          .sort((a, b) => at(a) - at(b) || (a < b ? -1 : a > b ? 1 : 0))
          .map((region) => [region, decodeRoutes(raw[region])]),
      );
      applyRouteFilter(document, state);
    })
    .catch((err) => {
      console.error(err);
      // 覚えたままにすると二度と取り直せない。prefMeta と同じ作法である。
      prefIndexPending = null;
      state.prefIndexFailed = true;
      applyRouteFilter(document, state);
    });
  return prefIndexPending;
}

let prefSummaryPending = null;

/**
 * 都道府県道の全国集計(pref/summary.json)を 1 度だけ取る。loadPrefIndex と
 * 同じ作法で、「この地図について」を開くたびに呼ばれるが、取得済み・取得中の
 * 間は Promise を覚えていて取り直さない。
 */
function loadPrefSummary() {
  if (prefSummaryPending) return prefSummaryPending;
  state.prefSummaryFailed = false;
  prefSummaryPending = fetch(dataURL('pref/summary.json'))
    .then((r) => {
      if (!r.ok) throw new Error(`pref/summary.json: ${r.status}`);
      return r.json();
    })
    .then((summary) => {
      state.prefSummary = summary;
      // #about-btn は boot() を待たずに配線されるので、national.meta.json の
      // 取得が終わる前にここへ来ることがありうる。state.meta が無い間は
      // updateStats() が読む combinations も無く、boot() 側の最初の
      // applyFilters() が後から描く。
      if (state.meta) updateStats();
    })
    .catch((err) => {
      console.error(err);
      // 覚えたままにすると二度と取り直せない。prefMeta と同じ作法である。
      prefSummaryPending = null;
      state.prefSummaryFailed = true;
      if (state.meta) updateStats();
    });
  return prefSummaryPending;
}

/**
 * 県別 meta を 1 県ぶんだけ取る。取りに行っている最中の Promise を覚えるので、
 * 同じ県の路線を続けて開いても同じ Promise に乗る。
 */
function prefMeta(region) {
  let pending = state.prefMetas.get(region);
  if (!pending) {
    pending = fetch(dataURL(`pref/${region}.meta.json`)).then((r) => {
      if (!r.ok) throw new Error(`pref/${region}.meta.json: ${r.status}`);
      return r.json();
    });
    // 失敗した Promise を覚えたままにすると、二度と取り直せなくなる。
    pending.catch(() => state.prefMetas.delete(region));
    state.prefMetas.set(region, pending);
  }
  return pending;
}

/* パネルを出す。中身を入れ替えただけの開き直しでは開いたときの表示位置を取り
 * 直さない。動いた後に開き直した人が閉じたときに横へ滑るためである。 */
function showDetail() {
  if (detail.hidden) detailOpenedAt = cameraNow();
  detail.hidden = false;
  app.classList.add('detail-open');
  applyMapPadding(true);
}

function closeDetail() {
  if (detail.hidden) return;
  // 閉じた後に、待っていた中身が届いて書き込まれることがないようにする。
  detailSerial++;
  const moved = detailOpenedAt && cameraMoved(detailOpenedAt, cameraNow());
  detailOpenedAt = null;
  detail.hidden = true;
  app.classList.remove('detail-open');
  if (moved) setPaddingKeepingView();
  else applyMapPadding(true);
}

$('#detail-close').addEventListener('click', closeDetail);

// ダイアログが開いているあいだの Esc はそちらのものである。<dialog> の
// キャンセルは document まで上がるので、譲らないと後ろのパネルまで閉じる。
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if ($('dialog[open]')) return; // ダイアログの Esc はそちらのものである
  // 開いているポップオーバーが先に閉じる。Esc は一番手前のものを畳む。
  if (anyPaneOpen()) {
    closePanes();
    return;
  }
  closeDetail();
});

// パネルの大きさは画面幅で変わる(狭い画面では下部の帯になる)ので、開いている
// あいだは幅の変化に padding を追随させる。窓を掴んでいる最中なので、滑らせず
// その場で合わせる。
window.addEventListener('resize', () => applyMapPadding(false));

/**
 * 標識と、パネルの中のボタン。どちらも委譲で受ける。ポップアップは開くたびに
 * 作り直され、パネルの中身は路線が変わるたびに innerHTML ごと入れ替わる。
 */
document.addEventListener('click', (ev) => {
  // パネルの中の「関わりのある国道」も同じ .shield-btn である。押せばその路線の
  // パネルに入れ替わる。パネルは路線 1 本について述べる場所である。
  const shieldBtn = ev.target.closest('.shield-btn');
  if (shieldBtn) {
    // 都道府県道の標識は県を伴うキーを持つ。番号だけでは 47 本のどれか
    // 決まらない。
    if (shieldBtn.dataset.pref) openPrefDetail(shieldBtn.dataset.pref);
    else openDetail(Number(shieldBtn.dataset.ref));
    return;
  }

  // 選択の持ち主は state のままである。wiring の関数を呼ぶだけで、一覧の
  // チェックも系統のトグルもそちらが合わせる。
  const only = ev.target.closest('.detail-only');
  if (only) {
    // 押した状態の描き直しはしない。選択が変われば applyFilters が
    // syncDetailOnly を通るので、一覧のチェックや ✕ から変わったときと
    // 同じ経路になる。
    // 節の漏斗は群を名指す(#155)。押した路線のパネルは開いたままにする。
    // 解除する口はこの漏斗のほかに無い。
    if (only.dataset.prefs) {
      togglePrefGroup(
        document,
        state,
        only.dataset.prefs.split(','),
        applyFilters,
      );
    } else if (only.dataset.pref) {
      togglePrefOnly(document, state, only.dataset.pref, applyFilters);
    } else {
      toggleRouteOnly(document, state, Number(only.dataset.ref), applyFilters);
    }
    return;
  }

  const terminus = ev.target.closest('.detail-termini .end[data-at]');
  if (terminus) {
    const [lon, lat] = terminus.dataset.at.split(',').map(Number);
    map.flyTo({ center: [lon, lat], zoom: 12 });
  }
});

boot().catch((err) => {
  console.error(err);
  $('#loading').textContent = `データの読み込みに失敗しました: ${err.message}`;
});
