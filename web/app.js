/* 国道マップ
 *
 * 実現可能性の調査で決めた前提。アークはどれも、その上に載る指定の全体を
 * 最初から持っており、区切り文字で囲んだ `refs = ",18,117,406,"` の形をしている。
 * だから「N 号だけを出す」も「重用区間だけを出す」も、ただの属性の絞り込みで
 * あり、スタイルの中で評価される——再計算もサーバも不要である。
 *
 * ビルドが地域ごとに走るのは、OSM の切り出しと、それ以上に裏取りが都道府県で
 * 区切られているためである。閲覧側はそうではない。地域はビルド時に全国 1 組の
 * タイルへ結合されるので、県を選ぶ場面が無い。範囲を広げるのはデータの変更
 * (地域を足して生成する)であって、画面の変更ではない。
 *
 * 全国では約 13 万アークになる。形をベクタタイルで届けるのはそのためで、
 * 画面に出ている物しか手元に載らない。結果として操作面は、特徴量を数えて
 * 自分を埋めることができない。出す合計——路線の一覧、重用ランキング、選択の
 * 集計——はすべて national.meta.json から読む。継ぎ目を重複排除したうえで
 * ビルドが書いた物である。
 *
 * スタイルと絞り込み式の形は mapspec.mjs にある。ビルド時の検査スクリプトが、
 * ここで実際に走る物をそのまま検査できるようにするためである。
 *
 * このファイルに残るのは、生きた地図と生きたページが必要な部分である。地図
 * 自身、唯一の可変な `state`、state が動かす絞り込み、listener、起動の順である。
 * データの純関数であるものは、直接検査できるよう外へ出した(test/ を参照)。
 * wireControls() と wireShare() も wiring.mjs へ移したが、こちらは純粋だから
 * ではない。document・state・applyFilters しか必要とせず、地図が不要なので、
 * test/wiring.test.mjs が地図を作らずに happy-dom の実物の index.html へ
 * 配線できるからである。
 *
 *   mapspec.mjs    スタイル、層、絞り込み式
 *   aggregate.mjs  画面が出す数を組み合わせ表から読む
 *   panel.mjs      サイドパネルの markup
 *   popup.mjs      押したアークが自分について述べること
 *   detail.mjs     一つの路線が自分について述べること
 *   termini.mjs    起点・終点を GeoJSON にする
 *   shield.mjs     国道番号標識
 *   html.mjs       エスケープ。OSM の文字は信用できない
 *   wiring.mjs     index.html の要素と state の対応づけ
 */

import {
  concurrencies,
  formerKmFor,
  kindsFor,
  routesOf,
  statsFor,
} from './aggregate.mjs';
import { decreeTerminiOf, detailHTML, relatedRoutesOf } from './detail.mjs';
import {
  baseStyle,
  buildFilter,
  CLICKABLE_LAYERS,
  DEFAULT_BASEMAP,
  DEFAULT_SHADE,
  FILTERED_LAYERS,
  GSI_BASEMAP_ORDER,
  GSI_BASEMAPS,
  GSI_SHADE_LABELS,
  GSI_SHADE_LEVELS,
  GSI_SHADE_PAINT,
  gsiLayerId,
  hasRef,
  NOTHING,
  PMTILES_URL,
  pickedFilter,
  routeLayers,
  routeSources,
  withKind,
} from './mapspec.mjs';
import {
  clearLabel,
  countLabel,
  freshnessHTML,
  RANKING_ROWS,
  rankingHTML,
  routeListHTML,
  SHARED_ROWS,
  selectionLabel,
  sharedHTML,
  statsHTML,
} from './panel.mjs';
import { deepest, popupHTML } from './popup.mjs';
import { terminiFeatures } from './termini.mjs';
import { decodeURLState, encodeState, MANAGED_KEYS } from './urlstate.mjs';
import {
  NARROW_QUERY,
  setSelection,
  wireControls,
  wireShare,
} from './wiring.mjs';

const state = {
  meta: null,
  routes: [],
  selected: new Set(),
  // ポップアップが開いているアークの OSM way id。開いていなければ null。
  // 使い道はその下に敷く影だけで、地図の他の物は 1 本に絞られていない。
  picked: null,
  conc: 'off',
  labels: true,
  termini: true,
  special: true,
  ferry: true,
  expressway: true,
  former: true,
};

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------------ 地図 --- */
// PMTiles はバイト範囲で読む 1 つのアーカイブなので、タイルサーバ無しで全国を
// 静的なホストから配れる。ホストは何でもよい——ただし Range 要求に答えられる
// 必要がある。開発用サーバが `python -m http.server` ではなく
// pipeline/serve.py なのはそのためである。
maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);

/**
 * 読む人が前回選んだ下地図の見え方。どの地理院タイルを敷くか、どれだけ濃く
 * 敷くかである。地図を作る前に読み、そのままスタイルへ渡す。既定で一度描いて
 * から、少し遅れて本人の選択で描き直す、という形にしないためである。
 */
function readStored(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback; // private browsing: no storage, so the shipped default
  }
}
let basemap = readStored('gsi-basemap', GSI_BASEMAP_ORDER, DEFAULT_BASEMAP);
let gsiShade = readStored('gsi-shade', GSI_SHADE_LEVELS, DEFAULT_SHADE);

/* ------------------------------------------------------------------ 配色 --- */
/**
 * 明るい面か暗い面か。
 *
 * 色そのものは style.css の light-dark() が両方述べており、どちらを採用するかは
 * `color-scheme` が決める。ここが置く `data-theme` はその一言だけである
 * ——置かなければ端末の設定がそのまま効くので、最初に描かれる絵は JavaScript
 * を待たない。端末と違う側を選んでいる人にだけは、ここが走るまで選んでいない
 * 側が出るので、index.html の <head> の数行がその選択を先に置き直す。書くのも
 * 'auto' を解くのもここなので、答えが二箇所に分かれるわけではない。
 *
 * 置くのは解いた側('light'/'dark')であって、人が選んだ側('auto' を含む)では
 * ない。色でない切り替え——MapLibre のボタンの絵の反転——は媒体クエリでは書け
 * ず、`data-theme` を見るしかないからである。端末に合わせているあいだも解いた
 * 側を置いておけば、見る場所が一つで済む。
 *
 * 選択は localStorage に残す。地図の濃さや種類と同じ表示の好みで、絞り込みの
 * 状態ではないので `state` にも URL にも入らない——共有したリンクが相手の配色
 * まで決める理由が無い。
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
 * 共有されたリンクが眺めを指定しているか。
 *
 * 地図を作る前に読む。`hash: true` の MapLibre は、地図を作った時点で既定の
 * 中心へ jumpTo し、その moveend で自分の hash を書き込む——しかもその書き込み
 * は同期に走る。作った後に読むと、共有されたリンクの hash と、地図が今しがた
 * 自分で書いた hash が見分けられない。
 *
 * 見分けが付かないあいだ、boot() の fitInitialView() は一度も呼ばれておらず、
 * `?region=` が指す地域は、そこにあるだけで誰にも届いていなかった。
 */
const sharedView = Boolean(location.hash);

const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false,
  hash: true,
  // これを切らないと、MapLibre は CJK の範囲の字をグリフサーバに訊かず、読む人
  // の端末の書体で描く。日本語の範囲を何 MB も取りに行く代わりと考えれば妥当な
  // 既定である。ここで使う字は数字十個と `・` だけで、どれも既に配ってあるので、
  // 端末側で描いても得られるのは、機械ごとに形の変わる区切りと、CJK の書体が
  // 入っていない端末での消失だけである。
  localIdeographFontFamily: false,
  style: baseStyle(basemap, gsiShade),
  // 何も指定されていないときの眺め。全国が一枚に収まり、北海道から沖縄まで
  // 端が切れない位置を目で決めてある——`#4.62/35.79/137.92` を開いたときと
  // 同じ絵である。データの広がり (meta.bbox) に自動で合わせると、南鳥島の
  // ような離れた点まで入れようとして日本が小さく片寄る。
  center: [137.92, 35.79],
  zoom: 4.62,
  // MapLibre 自身が作るボタンのラベル。この地図のボタンは残らず日本語で名乗っている
  // ので、拡大・方位・現在位置だけが英語で名乗る理由が無い。ここに無い鍵
  // (縮尺の単位など)は MapLibre の既定のままである。
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

// fetch が地図を先に行かせる前に、同期で登録する。`load` は地図の一生に一度
// しか発生しないが、`map.loaded()` はソースが取得中になるたび false に戻る。
// 後者で場合分けすると、ただ一度の `load` が済んだ後に `once('load', ...)` を
// 足しかねない——エラーも出ないまま `boot()` が止まる形で、ブラウザのキャッシュ
// が他を十分速く解決したときに再現した(初回の訪問ではなく、たいていは再読み
// 込みである)。
const mapLoaded = new Promise((res) => map.once('load', res));

// 拡大・縮小と方位を別の台に分ける。NavigationControl は既定では三つを
// 一つの角丸の群にまとめるが、拡大・縮小が「今見ている範囲」を変えるのに対し、
// 方位は「北がどちらか」を戻すだけで、押す場面も頻度も違う。同じ群に並んで
// いると、拡大を連打している指がそのまま方位に触れて地図が回る。
// 二つ addControl すれば、MapLibre が群ごとに積んで隙間を空ける。
map.addControl(
  new maplibregl.NavigationControl({ showCompass: false }),
  'top-right',
);
map.addControl(
  new maplibregl.NavigationControl({ showZoom: false, visualizePitch: false }),
  'top-right',
);
map.addControl(
  new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }),
  'bottom-right',
);

/* -------------------------------------------------------- 押し続けて拡大 --- */
/**
 * NavigationControl の拡大・縮小ボタンは、素のままではクリックのたびに 1 段階
 * ズームするだけ。ここでは押した瞬間に同じ 1 段階ズームをしたうえで、
 * HOLD_DELAY_MS を過ぎてもまだ押されていればゆっくり連続ズームへ移す。
 *
 * 単発の 1 段階も pointerdown 側で行うため、離したときに本来の click も
 * 発火すると 1 段階よけいにズームしてしまう。pointerdown が起きた押下は
 * 必ずその click を飲み込む——document の capture 段で止める。button 自身に
 * capture:true で listener を足しても、同じ要素上では登録順で呼ばれるため
 * NavigationControl 自身の click listener(bubble)より後に回り、間に合わない。
 * キーボード操作(Enter/Space)は pointerdown を経ないので、そちらは今まで
 * 通り click がそのまま届く。
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
  // 2 本指の同時タップなど、2 つ目の pointerdown が乗ると holdTimer を
  // 上書きしてしまい、片方だけ離してももう片方のタイマー/rAF が残り続ける。
  // 押下中は先着のポインターだけを追い、他は無視する。
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
    // pointercancel の後に click は来ないので、届かないまま残り続けないよう
    // ここで畳んでおく。
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
// 出典を述べる唯一の場所。操作面も自分の足元で同じことを述べていたが、それは
// 一つの問いへの二つの答えで、片方は古くなり放題だった。必ず置かねばならない
// のは地図自身の部品のほうである——「国道マップについて」が出典を繰り返さない
// のも同じ理由である。
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
 * ボタンの状態が変わった直後に、その脇へ一瞬だけ出すラベル。ホバーの title が
 * 与える確認と同じものを、ホバーの無い指の操作に与える。ボタンと同じ台の中に
 * 居るので、位置合わせの計算を自分では持たずに台へ付いていく。
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
  // 台にボタンが二つ載ることがある。ラベルは押されたボタンの高さに合わせる——
  // 台の真ん中に出すと、二つのあいだから出てどちらの返事か分からない。
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
 * 地図の右上のボタンは、どれも同じ形をしている。押すと `order` を一つ進め、いま
 * の値から絵とラベルを描き直す。`get`/`apply` はボタンの外にある状態(地図の層、
 * localStorage)へ手を伸ばすので、ここが持つのはボタンだけである。
 *
 * `order` が二値なら循環ではなく切り替えなので、切り替えにだけ必要な `active`
 * と `aria-pressed` が付く。三値のものはそこを素通りする。`tip` は既定で
 * `label` と同じ——「次に押すと何が起きるか」と「いま何になったか」で言い方を
 * 変える必要があるのは、国道を隠すボタンだけである(`hideStateTip`)。
 *
 * `onExternalChange` を渡すと、そのボタンの `render` が手渡される。押していない
 * ところで状態が動くボタン——視点は Ctrl+ドラッグでも変わる——が描き直すために
 * 使う。`isPressed` も同じ事情で、視点の `get()` はドラッグが残した任意の角度
 * を返しうるので、真上でない限りすべて「押されている」と見なす。
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
 * 一つの台に、ボタンを一つ以上載せる。MapLibre の IControl なので、
 * `addControl(…, 'top-right')` するだけで角丸の台ごと縦に積まれる。
 *
 * 台を分けるか一つにするかが、ボタンどうしの近さの唯一の表し方である。地図の
 * 種類と濃さのように「同じ絵の見え方」を決める二つは一つの台に載せ、役目の
 * 違うものは別の台にする。
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
 * 真上から見るのが地図の普段の姿勢で、60 度は地形を眺める姿勢である。Ctrl+
 * ドラッグはその間の任意の角度に届くので、ボタン自身が持つ現在地
 * (`mapPitch`)は、ドラッグが終わるたび `onExternalChange` 経由で地図の実際の
 * 傾きから取り直す。真上でない傾きはすべて「傾いている」と見なす。
 * `order.indexOf` はドラッグ途中の角度を見つけられず `order[0]`、つまり真上へ
 * 落ちるので、ボタンは真上にいるとき以外つねに真上へ戻すことを申し出る。
 *
 * 二つのアイコンは、同じ正方形を二つの姿勢から見た絵である。真上からは正面、
 * 傾いた側からは手前の辺が長く奥の辺が短い台形になる。最初はここに等角の立体
 * を描いていたが、立体は物であって、このボタンが変えるのは平らな地図を見る
 * 角度である。
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

/* ------------------------------------------------------------ 国道を隠す --- */
/**
 * 下地図だけを一時的に見る眺め。国道の下にある地形を読むためのものである。
 * これは表示・非表示であって絞り込みの状態ではない。戻したときにチェック
 * ボックスが述べているとおりを出さねばならないので、`state` にも URL にも
 * 触れない——この眺めを共有することは、リンクのすべきことではない。
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

// title/aria-label 用の label は次に押すと起きる動作(動詞)なので、押した
// 直後の状態を示す state-tip にはそのまま使えない。この一箇所だけで結ぶ。
function hideStateTip(hidden) {
  return hidden ? '国道: 非表示' : '国道: 表示';
}

function setRoutesHidden(hidden) {
  routesHidden = hidden;
  for (const { id } of routeLayers()) {
    map.setLayoutProperty(id, 'visibility', hidden ? 'none' : 'visible');
  }
}

const HideRoutesControl = buildCycleControl('hide-routes-ctrl', {
  id: 'hide-routes-btn',
  order: [false, true],
  get: () => routesHidden,
  apply: setRoutesHidden,
  icon: (hidden) => (hidden ? EYE_OFF_ICON : EYE_ICON),
  label: (hidden) => (hidden ? '国道の表示に戻す' : '国道を一時的に隠す'),
  tip: hideStateTip,
});

/* -------------------------------------------------------------- 表示の面 --- */
/**
 * ボタンを押すと出る面。「何が地図に描かれるか」を決めるものは残らずここに集める
 * ——切り替えた結果は地図にしか現れないので、操作面ではなく地図の側に置く。
 * 節を分けて一つの面に収めてあるのは、重用区間の見せ方も種別の出し入れも同じ
 * 問いの答えだからである。ボタンを分けると、どちらを押すか毎回考えることになる。
 *
 * 中身の markup は index.html が持ち、ここは開け閉てだけを持つ。onAdd がその
 * 要素をボタンと同じ台へ移すので、面の位置はボタンを追う——位置合わせの計算は
 * どこにも無い。state-tip が同じ台に居るのと同じ仕掛けである。
 */
const displayPane = $('#display-popover');
let displayBtn = null;

const displayPaneOpen = () => !displayPane.hidden;

/**
 * 面の上端はボタンに合わせる。それで窓の下からはみ出すなら、はみ出したぶん
 * だけ引き上げる——低い窓では、ボタンの高さに揃えることより中身が見えること
 * が先である。引き上げても入らない高さは面の中が巻き取る (style.css の
 * max-height)。
 */
const PANE_GAP = 12;

function fitDisplayPane() {
  displayPane.style.top = '-1px';
  const over =
    displayPane.getBoundingClientRect().bottom -
    (window.innerHeight - PANE_GAP);
  if (over > 0) displayPane.style.top = `${-1 - over}px`;
}

function setDisplayPane(open) {
  displayPane.hidden = !open;
  displayBtn.classList.toggle('active', open);
  displayBtn.setAttribute('aria-expanded', String(open));
  if (open) fitDisplayPane();
}

// 窓を掴んでいる最中に面が窓からはみ出さないように。
window.addEventListener('resize', () => {
  if (displayPaneOpen()) fitDisplayPane();
});

// 面の外を押したら閉じる。ボタン自身の click はそこで止めてあるので、ここへは
// 上がってこない。
document.addEventListener('click', (ev) => {
  if (displayPaneOpen() && !displayPane.contains(ev.target))
    setDisplayPane(false);
});

/** つまみの付いた二本のスライダー。何を出すかを決める面の、ありふれた印である。 */
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
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setDisplayPane(!displayPaneOpen());
    });
    displayBtn = btn;
    container.append(btn, displayPane);
    this._container = container;
    return container;
  }
  onRemove() {
    this._container.remove();
  }
}

/* ------------------------------------------------------------ 地図の濃さ --- */
/**
 * 濃さごとに、しずくがどれだけ満ちているかと、水面がどれだけ傾いているか。
 * 薄いは中身が無い(輪郭だけ)。濃いは縁まで満ちて平らなので、どちらにしても
 * 傾きは見えない。通常は半分より少し下に、傾いた水面を置く——この傾きが
 * 「液体」に読め、抽象的な目盛りと見分けが付く。濃い・薄いの字を先に知って
 * いなくても、一目で分かる。
 */
const SHADE_FILL = { light: 0, normal: 0.42, dark: 1 };
const SHADE_TILT = { light: 0, normal: 10.4, dark: 0 }; // 幅18に対し約30度

/**
 * しずく。いまの濃さのぶんだけ下から満ちる。
 */
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
 * 国道の下に敷く地図をどれだけ濃くするか。薄い・通常・濃いを、ボタン 1 つで
 * 回す。これは表示の好みであって絞り込みの状態ではない——国道を
 * 隠すボタンと同じく、`state` にも URL にも触れない——が、あちらと違って覚えて
 * おく値打ちがあるので、読み込みのたびに戻さず localStorage に残す。
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
 * 下地図ごとに 1 つのアイコン。同じ形を塗り分けるのではなく、それぞれ紛れの
 * 無い別の見立てにする。淡色地図には折り畳んだ紙の地図、より詳しい標準地図には
 * 重ねた層、写真(航空写真)には写真の枠である——どれもラベルの文字を読まずに
 * 見分けられる。
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
 * 国道の下にどの地理院タイルを敷くか。淡色地図・標準地図・写真(航空写真)で
 * ある。三つとも常にスタイルの中にあるので(baseStyle を参照)、切り替えは二つの
 * 層の表示・非表示の反転であって、ソースの作り直しではない。濃さもそのまま
 * 引き継ぐ。濃さの paint 属性は、今日描いている層だけでなく、下地図の層すべてに
 * 載せてあるためである。
 */
function applyBasemap(id) {
  map.setLayoutProperty(gsiLayerId(basemap), 'visibility', 'none');
  basemap = id;
  map.setLayoutProperty(gsiLayerId(basemap), 'visibility', 'visible');
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
 * 下に敷く地図について決めることは二つ——どれを敷くかと、どれだけ濃く敷くか
 * ——で、どちらも同じ一枚の見え方の話である。台を一つにして、その二つが並んで
 * いることを形で述べる。種類が先で、濃さがその下に付く。
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
 * パネルは #left-stack に縦に並んでいる。操作面 (#panel) も詳細 (#detail) も、
 * 地図の要素を細くするのではなく上に浮かせてある——細くすると canvas の寸法が
 * 変わり、開け閉てのたびに全部描き直しになる。浮かせて padding をずらせば、
 * 地図が持っている絵はそのままで、fitBounds や flyTo の行き先だけがパネルを
 * 避ける。
 *
 * 寸法と位置は style.css が持つので、ここは実測した矩形に隙間ぶんを足すだけに
 * する——同じ数を二箇所で言わない。
 */
const app = $('#app');
const panel = $('#panel');
const detail = $('#detail');
const detailBody = $('#detail-body');
const narrowMq = window.matchMedia(NARROW_QUERY);

const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
/** パネルと地図のあいだに残す余白。 */
const BOX_GAP = 12;
/** 一辺で覆ってよい上限と、向かい合う二辺の和の上限。狭い画面では操作面が上を、
 *  詳細が下を覆うので、これが無いと和が canvas の高さを超え、地図の中心が画面の
 *  外へ出る。 */
const MAX_SIDE_RATIO = 0.6;
const MAX_OPPOSITE_RATIO = 0.8;
const EASE_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ? 0
  : 260;

const panelOpen = () => !app.classList.contains('panel-off');

function mapPadding() {
  const canvas = $('#map').getBoundingClientRect();
  const panelBox = panelOpen() ? panel.getBoundingClientRect() : null;
  const detailBox = detail.hidden ? null : detail.getBoundingClientRect();
  if (!panelBox && !detailBox) return { ...NO_PADDING };

  // 広い画面では列は左端にあるので、左だけを空ける。
  if (!narrowMq.matches) {
    const right = Math.max(panelBox?.right ?? 0, detailBox?.right ?? 0);
    const left = Math.min(
      right - canvas.left + BOX_GAP,
      canvas.width * MAX_SIDE_RATIO,
    );
    return { ...NO_PADDING, left };
  }

  // 狭い画面では列が画面の幅いっぱいなので、避ける向きは上下になる。操作面が
  // 上を、詳細が下を覆う。
  const cap = canvas.height * MAX_SIDE_RATIO;
  const pad = { ...NO_PADDING };
  if (panelBox) {
    pad.top = Math.min(panelBox.bottom - canvas.top + BOX_GAP, cap);
  }
  if (detailBox) {
    pad.bottom = Math.min(canvas.bottom - detailBox.top + BOX_GAP, cap);
  }
  // 二つとも出ているときは、和のほうが先に効く。
  const both = pad.top + pad.bottom;
  const room = canvas.height * MAX_OPPOSITE_RATIO;
  if (both > room) {
    pad.top *= room / both;
    pad.bottom *= room / both;
  }
  return pad;
}

/** 渡すのは padding だけである。center も zoom も渡さないので、地図が持って
 *  いる絵はそのままで、地図が中心と見なす点だけがパネルの外へ寄る。 */
function applyMapPadding(animate) {
  const padding = mapPadding();
  if (animate) map.easeTo({ padding, duration: EASE_MS });
  else map.setPadding(padding);
}

/**
 * padding を変えても絵を動かさない。
 *
 * padding は「地図が中心と見なす点」をずらす仕組みなので、変えるとその点は
 * 別の画素へ移り、絵は逆へ滑る。滑らせないためには、新しい padding のもとで
 * 中心が置かれることになる画素に今写っている地点を、そのまま新しい中心に
 * 据え直せばよい。
 */
function setPaddingKeepingView() {
  const padding = mapPadding();
  const canvas = $('#map').getBoundingClientRect();
  const x = canvas.width / 2 + (padding.left - padding.right) / 2;
  const y = canvas.height / 2 + (padding.top - padding.bottom) / 2;
  map.jumpTo({ padding, center: map.unproject([x, y]) });
}

/* ---------------------------------------------------------------- 操作面 --- */
/**
 * 操作面を畳んで、地図に窓を丸ごと渡す。
 *
 * 開いているあいだ閉じる口はパネル自身の × で、閉じているあいだ開き直す口は
 * 地図の上の #panel-toggle である。後者は地図側の部品なので、データが届く前
 * から答えられるよう wireControls() ではなくここで配線する。
 *
 * 畳んだパネルを実際に無効化するのは `inert` である。CSS は visibility で
 * 伏せるだけで、伏せた要素も読み上げには残りうる。
 */
(() => {
  const toggle = $('#panel-toggle');

  const set = (open, animate) => {
    app.classList.toggle('panel-off', !open);
    panel.inert = !open;
    toggle.setAttribute('aria-expanded', String(open));
    applyMapPadding(animate);
    try {
      localStorage.setItem('panel-open', open ? '1' : '0');
    } catch {
      /* プライベートブラウズ: 選択がタブより長く残らないだけである。 */
    }
  };

  toggle.addEventListener('click', () => set(true, true));
  $('#panel-close').addEventListener('click', () => set(false, true));

  // 狭い画面では畳んで始める。浮いたパネルは画面の半分を占め、その下から地図が
  // 見えるわけではない——この幅で見に来た人がまず見たいのは地図である。
  // 一度でも自分で開け閉てした人の選択は、幅より優先する。
  let open = !narrowMq.matches;
  try {
    const stored = localStorage.getItem('panel-open');
    if (stored !== null) open = stored === '1';
  } catch {
    /* 同上 */
  }
  set(open, false);
})();

/* ------------------------------------------------------ この地図について --- */
/**
 * データがいつのものか、どこで作られているかを出す紙。中身は buildUI() が
 * 一度入れたきり動かないので、ここは開く口を結ぶだけでよい——showModal()
 * 自身が Esc とフォーカスの往復を面倒みる。
 */
$('#about-btn').addEventListener('click', () => $('#about-dialog').showModal());

/**
 * 紙の外——後ろの暗がり——を押したら閉じる。
 *
 * <dialog> にとって暗がりは自分の領域のうちにあり、紙のほうは中の <form> が
 * 隅まで埋めている。だから押されたのが <dialog> そのものだったなら、それは紙ではなく
 * 暗がりを押したということである。位置を測る必要が無い。
 */
for (const dialog of document.querySelectorAll('dialog.sheet')) {
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
}

/* ------------------------------------------------------------------ 起動 --- */
async function boot() {
  const [index, meta] = await Promise.all([
    fetch('data/regions.json').then((r) => r.json()),
    fetch('data/national.meta.json').then((r) => r.json()),
  ]);
  if (!index.length) throw new Error('data/regions.json is empty');
  state.meta = meta;
  state.routes = routesOf(meta.combinations);
  applyURLState();

  await mapLoaded;

  // アーカイブの所在は絶対で指す。protocol の handler が自分で URL を解くので、
  // 相対の基準にできるページを持たない。
  const sources = routeSources(new URL(PMTILES_URL, location.href).href);
  for (const [id, src] of Object.entries(sources)) map.addSource(id, src);
  for (const layer of routeLayers()) map.addLayer(layer);
  map.addControl(new PitchControl(), 'top-right');
  map.addControl(new HideRoutesControl(), 'top-right');
  map.addControl(new DisplayControl(), 'top-right');
  map.addControl(new BasemapControl(), 'top-right');
  /**
   * 現在位置。押すと端末に位置を尋ね、地図の上に点で出す。
   *
   * MapLibre 自身の部品を使う。点・精度の円・追従の解除まで一式を持っており、
   * この地図が足すことは何も無い。位置は端末から地図へ渡るだけで、どこへも
   * 送らない——`state` にも URL にも入らないので、共有したリンクが自分の
   * 居場所を連れて行くこともない。
   *
   * 並びでは一番下に置く。上に積んであるボタンはどれも「地図をどう見せるか」を
   * 決めるだけで眺めは動かないが、これは押した瞬間に地図が飛ぶ。役目が違う
   * ものを混ぜず、端に置く。
   *
   * `trackUserLocation` は、一度押したら動くたびに点が付いてくる形である。
   * 走りながら国道を辿るのに、押し直しを求める理由が無い。
   * 全国が入る縮尺のまま点だけ打たれても居場所は読めないので、寄る先は
   * 街の見える縮尺までとする。
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

  // 共有されたリンクの hash が優先する。無ければ `?region=` が地域を名指しして
  // いる場合にそれを使う——眺めの指定であって、データの切り替えではない。
  // どちらも無ければ、地図は作られたときの眺めのままである。
  if (!sharedView) fitInitialView(index);

  $('#loading').classList.add('done');
}

/**
 * 共有されたリンクが運ぶ絞り込みと表示の状態を、最初の描画の前に読む。URL が
 * 実際に名指しした項目だけを上書きする——decodeURLState が返すのは差分であって
 * 状態の全体ではない——うえで、データに無い路線は選択から落とす。routes の数は
 * ビルドとともに増えるだけなので、番号が変わった後の古いリンクが何も指さない
 * ままになるのを避ける。
 */
function applyURLState() {
  const diff = decodeURLState(location.search);
  if (diff.selected) {
    const known = new Set(state.routes.map((r) => r.ref));
    diff.selected = new Set([...diff.selected].filter((r) => known.has(r)));
  }
  Object.assign(state, diff);
}

/**
 * 自分では値を持たない部品すべてに `state` を押し出す。起動時に一度だけ呼ぶ。
 * applyURLState が markup に書いてある既定から state を動かした後である。以後の
 * 変化は逆向きに、listener から `state` へ流れるので、ここは二度と走らない。
 */
function syncControls() {
  for (const cb of document.querySelectorAll('#route-list input')) {
    const checked = state.selected.has(Number(cb.value));
    cb.checked = checked;
    cb.closest('label').classList.toggle('on', checked);
  }
  $(`input[name=conc][value="${state.conc}"]`).checked = true;
  $('#t-labels').checked = state.labels;
  $('#t-termini').checked = state.termini;
  $('#t-expressway').checked = state.expressway;
  $('#t-special').checked = state.special;
  $('#t-ferry').checked = state.ferry;
  $('#t-former').checked = state.former;
}

/**
 * `?region=` が地域を名指していれば、そこへ寄る。
 *
 * 全国の眺めはふつうここで決めない——地図を作るときの center/zoom が既定で、
 * 名指しが無ければそれがそのまま残る。例外は縦長の狭い画面で、既定の縮尺の
 * ままだと九州と北海道が両端で切れる。そこだけはデータの広がりに合わせる。
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
  // 浮いているパネルのぶんは、既に地図の padding が述べている。fitBounds に渡す
  // padding はそれを置き換えてしまうので、余白を足した形で渡し直す——そうし
  // ないと最初の眺めだけが操作面の下に潜る。
  const p = map.getPadding();
  const clear = {
    top: p.top + 24,
    bottom: p.bottom + 24,
    left: p.left + 24,
    right: p.right + 24,
  };
  // パネルを避けた残りに地域が入らない画面もある——縦に長い狭い画面では、操作面が
  // 高さの半分を占め、残りへ収めるには縮尺が足りない。そのとき
  // cameraForBounds は何も返さないので、避けるのをやめて窓いっぱいに合わせる。
  // 端が操作面の下に少し潜るが、地域が一枚に入っているほうがよい——パネルは
  // 閉じられる。
  const padding = map.cameraForBounds(bounds, { padding: clear }) ? clear : 24;
  map.fitBounds(bounds, { padding, duration: 0 });
}

/* -------------------------------------------------------------- 絞り込み --- */
function applyFilters() {
  const base = buildFilter([...state.selected], state.conc, state.former);

  for (const { id, kinds, negate, toggle } of FILTERED_LAYERS) {
    if (toggle && !state[toggle]) {
      map.setFilter(id, NOTHING);
      continue;
    }
    map.setFilter(id, kinds ? withKind(base, kinds, negate) : base);
  }

  map.setFilter('picked', pickedFilter(base, state.picked));

  const sel = [...state.selected];
  let tFilter = true;
  if (!state.termini) tFilter = ['==', ['get', 'count'], -1];
  else if (sel.length) tFilter = ['any', ...sel.map(hasRef)];
  map.setFilter('termini-dot', tFilter);
  map.setFilter('termini-label', tFilter);

  updateStats();
  renderRanking();
  syncURL();
}

/**
 * クエリ文字列を `state` に合わせ続ける。URL の他の部分には触れない。MapLibre
 * が独立に書き込む hash と、このモジュールが管理しないクエリの鍵である——
 * `?region=` は起動時に一度読むだけなので、触れば最初の絞り込みで消えてしまう。
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
  $('#route-list').innerHTML = routeListHTML(state.routes);
  $('#route-filter').value = '';
  $('#freshness').innerHTML = freshnessHTML(state.meta);
  renderShared();
}

function updateStats() {
  const sel = state.selected;
  const totals = statsFor(state.meta.combinations, sel);
  $('#stats').innerHTML = statsHTML(sel.size, state.routes.length, totals);

  // 何もできないボタンは、押しても何も起きないのではなく、押せないことでそれを
  // 述べる。文字を持たないボタンなので、どれだけ取り消すかはラベルが述べる。
  const clear = $('#sel-none');
  clear.disabled = sel.size === 0;
  const clearText = clearLabel(sel.size);
  clear.title = clearText;
  clear.setAttribute('aria-label', clearText);

  // 畳んだ一覧は中身を見せないので、選択がいくつあるかは見出しが述べる。
  $('#route-count').textContent = selectionLabel(sel.size, state.routes.length);
}

/** 重用ランキングは既定で畳んであるので、大きさは見出しに出す。 */
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

/** ランキングと同じく畳んであるので、大きさは見出しが運ぶ。 */
function renderShared() {
  const all = state.meta.shared_termini;
  const rows = all.slice(0, SHARED_ROWS);
  $('#shared-count').textContent = countLabel(rows.length, all.length, '地点');
  $('#shared').innerHTML = sharedHTML(rows);
}

/**
 * 重用ランキングと起終点共有の行を押すと、その場所へ飛ぶ。
 *
 * どの行も、自分が名指しする 1 つの物の広がりを持っている——組み合わせ自身の
 * bbox か、起終点の座標である——ので、視点はそこへだけ送る。以前は、行が持つ
 * 番号のうち 2 つを共有する組み合わせを表から拾い直して広がりを求めており、
 * その和は地域の四分の一を覆った。高知市で 4 km を一緒に走る国道 32・55・56・
 * 195・197・493 号を押すと、東経 132.5 度から 134.7 度、四国の大半が入った。
 *
 * 押しても選択は変わらない。ランキングは選択を映したものなので、行の路線を
 * 選ぶと指の下で一覧が組み直され、いま押した行が動くか消えるかしていた。1 路線
 * に絞るのはチェックボックスの仕事で、この一覧の仕事はその場所へ連れて行く
 * ことである。
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
  // 短い重用区間は数 m の車道でありうるし、アーク 1 本ぶんなら広がりを持たない。
  // だから bbox はどこを向くかの手掛かりでしかない。潰れた bbox が無限の縮尺を
  // 要求しないよう、maxZoom で止める。
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
 * 開いているポップアップは多くても 1 つで、地図の上の影はそのポップアップの
 * ものである。
 *
 * MapLibre 自身の `closeOnClick` は、このファイルより後に登録された click の
 * handler から前のポップアップを閉じる。そのため古いほうの後始末は、新しい
 * ポップアップが影を受け取った後に届き、その影を奪ってしまう。ポップアップを
 * ここで持って明示的に閉じれば、閉じ方——閉じるボタン、別のアーク、何も無い
 * 地図——によらず二つの歩調が揃う。
 */
let popup = null;

function pick(id) {
  state.picked = id;
  applyFilters();
}

function closePopup() {
  const p = popup;
  popup = null;
  p?.remove();
  if (state.picked !== null) pick(null);
}

function wirePopups() {
  for (const id of CLICKABLE_LAYERS) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', (ev) => {
    const hits = map.queryRenderedFeatures(ev.point, {
      layers: CLICKABLE_LAYERS,
    });
    closePopup();
    if (!hits.length) return;

    const p = deepest(hits);
    popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: '300px',
    })
      .setLngLat(ev.lngLat)
      .setHTML(popupHTML(p))
      .addTo(map);
    popup.on('close', closePopup);
    pick(p.id);
  });
}

/* ------------------------------------------------------------------ 詳細 --- */
/**
 * 路線そのものについて述べるパネル。中身の組み立ては detail.mjs が持ち、ここに残る
 * のは地図が必要な三つ——開いたぶん地図をずらすこと、起終点へ飛ぶこと、選択を
 * 差し替えること——だけである。
 *
 * パネルの居場所と、地図をずらす量は #left-stack と applyMapPadding が持つ
 * (上の「地図をずらす」の節)。
 */
/**
 * パネルを開いた時点の居場所。閉じるときに、寄せたぶんを戻すかどうかを決める。
 *
 * padding を外せば地図は中心を画面の真ん中へ戻すので、絵は寄せたときと逆へ
 * 動く。開けて読んで閉じるだけなら、それは開く前の眺めに戻ることであり、
 * 戻すのが正しい。
 *
 * 開いているあいだに動いた——地図を掴んで送った、起終点へ飛んだ——なら話が
 * 変わる。今の眺めは利用者が選んだものなので、閉じた拍子に横へ滑るのはただ
 * のずれである。だから動いていたら、padding を外しても絵を動かさない。
 *
 * 見るのは中心と縮尺だけである。padding だけの ease はどちらも変えないので、
 * 差が出れば場所が動いたということになる。傾きと向きは場所ではないので数え
 * ない。
 */
let detailOpenedAt = null;

const cameraNow = () => ({ ...map.getCenter(), zoom: map.getZoom() });

/* 度で 1e-6 は 10 cm ほどである。padding だけの ease が中心に残しうるのは
 * 丸め誤差だけなので、これを超えていれば地図は本当に動いている。 */
const CAMERA_EPS = 1e-6;

const cameraMoved = (a, b) =>
  Math.abs(a.lng - b.lng) > CAMERA_EPS ||
  Math.abs(a.lat - b.lat) > CAMERA_EPS ||
  Math.abs(a.zoom - b.zoom) > CAMERA_EPS;

function openDetail(ref) {
  const route = state.routes.find((r) => r.ref === ref);
  if (!route) return;
  // パネルを出すときは、後ろのポップアップを引き取る。ポップアップはアーク 1 本
  // について、パネルは路線そのものについて述べるので、両方が出ていると同じ画面で
  // 二つが別のことを述べる。パネルは地図の左下を覆うから、狭い画面では重なりもする。
  // 影はポップアップのものなので、closePopup() が一緒に消す。
  closePopup();
  // kinds と former の二つは必ず同じ絞り方で読まなければならない
  // (aggregate.mjs の touched() が一箇所にある理由もそれ)。Set を二回作ると
  // 生成が食い違う第一歩になるので、一つを両方に渡す。
  const sel = new Set([ref]);
  detailBody.innerHTML = detailHTML({
    route,
    kinds: kindsFor(state.meta.combinations, sel),
    termini: decreeTerminiOf(state.meta, ref),
    related: relatedRoutesOf(state.meta, ref),
    formerKm: formerKmFor(state.meta.combinations, sel),
  });
  // 別の路線に開き直しただけなら、居場所は開いたときのままにしておく。
  // ここで取り直すと、動いた後に開き直した人が閉じたときに横へ滑る。
  if (detail.hidden) detailOpenedAt = cameraNow();
  detail.hidden = false;
  app.classList.add('detail-open');
  applyMapPadding(true);
}

function closeDetail() {
  if (detail.hidden) return;
  const moved = detailOpenedAt && cameraMoved(detailOpenedAt, cameraNow());
  detailOpenedAt = null;
  detail.hidden = true;
  app.classList.remove('detail-open');
  if (moved) setPaddingKeepingView();
  else applyMapPadding(true);
}

$('#detail-close').addEventListener('click', closeDetail);

// ダイアログが開いているあいだの Esc はそちらのものである。<dialog> の
// キャンセルは document まで上がってくるので、ここで譲らないと後ろのパネルまで
// 一緒に閉じる。
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if ($('dialog[open]')) return; // ダイアログの Esc はそちらのものである
  // 開いている面が先に閉じる。Esc は一番手前のものを畳む鍵である。
  if (displayPaneOpen()) {
    setDisplayPane(false);
    return;
  }
  closeDetail();
});

// パネルの大きさは画面幅で変わる(狭い画面では下部の帯になる)ので、開いている
// あいだは幅の変化に padding を追随させる。開閉と違って利用者が窓を掴んで
// いる最中なので、滑らせずにその場で合わせる。
window.addEventListener('resize', () => applyMapPadding(false));

/**
 * 標識と、パネルの中のボタン。
 *
 * どちらも委譲で受ける。ポップアップは開くたびに作り直され、パネルの中身は
 * 路線が変わるたびに innerHTML ごと入れ替わるので、配線した時点の要素は
 * 押される時点には残っていない。
 */
document.addEventListener('click', (ev) => {
  // パネルの中の「関わりのある国道」も同じ .shield-btn である。押せばその路線に
  // 開き直る——パネルは路線 1 本について述べる場所なので、隣の路線の話を同じパネルで
  // 続けるのではなく、その路線のパネルに入れ替わるのが筋である。
  const shieldBtn = ev.target.closest('.shield-btn');
  if (shieldBtn) {
    openDetail(Number(shieldBtn.dataset.ref));
    return;
  }

  // 選択の持ち主は state.selected のままである。ここは setSelection を呼ぶ
  // だけで、サイドパネルのチェックもそちらが合わせる。
  const only = ev.target.closest('.detail-only');
  if (only) {
    setSelection(document, state, [Number(only.dataset.ref)], applyFilters);
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
