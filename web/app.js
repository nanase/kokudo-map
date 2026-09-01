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
 *   dataurl.mjs    配信データの URL の基点
 *   mapspec.mjs    スタイル、層、絞り込み式
 *   aggregate.mjs  画面が出す数を組み合わせ表から読む
 *   panel.mjs      面の一覧・集計と、凡例の markup
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
  prefRankOf,
  routesOf,
  statsFor,
} from './aggregate.mjs';
import { dataURL } from './dataurl.mjs';
import {
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
  PREF_CLICKABLE_LAYERS,
  PREF_PICKED_LAYER,
  PREF_PMTILES_URL,
  PREF_POPUP_MINZOOM,
  pickedFilter,
  prefClickableHitLayers,
  prefLabelLayer,
  prefLineLayers,
  routeLayers,
  routeSources,
  shownSystems,
  terminiFilter,
  withKind,
  withPrefSelection,
} from './mapspec.mjs';
import {
  clearLabel,
  countLabel,
  freshnessHTML,
  prefConcurrencyHTML,
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
  NARROW_QUERY,
  showRouteOnly,
  syncRouteList,
  togglePrefOnly,
  wireControls,
  wireShare,
} from './wiring.mjs';

const state = {
  meta: null,
  routes: [],
  selected: new Set(),
  // 都道府県道の選択。中身は `nagano-63` の形の鍵である——番号は県の中でしか
  // 一意でないので、国道のように数では持てない(prefroute.mjs)。空は「すべて」を
  // 意味し、そこは国道の `selected` と同じである。
  prefSelected: new Set(),
  // 県の名前を引く表。regions.json を起動時に読んだもので、`nagano` から
  // 「長野県」を返す。都道府県道の標識も詳細も、県を伴わなければ路線を名指した
  // ことにならない。
  prefLabels: new Map(),
  // 県別 meta の置き場。県を初めて開いたときに 1 県ぶんだけ取りに行く
  // (prefMeta)。47 県ぶんは 3.45 MB あり、初期表示では読まない。
  prefMetas: new Map(),
  // 全国の県と番号だけの索引。「道路を選択」の面を初めて開いたときに 1 度だけ
  // 取る(14.4 kB)。県 → 番号の配列で、番号で絞り込むためだけに要る。届くまでは
  // null である。
  prefIndex: null,
  // 索引を取りに行って落ちたか。落ちたことを言わないと、待っている表示のまま
  // 止まって「いつまでも読み込み中」になる。開き直せば取り直す。
  prefIndexFailed: false,
  // 「道路を選択」の一覧に出す系統。地図に描く系統(下の national / pref)とは
  // 別の物で、こちらは探す先を絞るだけである。二つとも false にはならない。
  listNational: true,
  listPref: true,
  // ポップアップが開いているアークの OSM way id。開いていなければ null。
  // 使い道はその下に敷く影だけで、地図の他の物は 1 本に絞られていない。
  picked: null,
  // 同じものの都道府県道の側。層を分けてあるので状態も分ける——国道と重用する
  // 県道のアークは、二つのアーカイブに同じ way id で入っている。
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
/* 縮尺の目盛りはここにあった。地図の縮尺を数で述べても、この地図で読むもの
 * ——どの番号がどこを通るか——には効かない。右下は凡例と出典だけになる。 */

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
  // 当たり判定の透明な層は routeLayers() に含まれない別の層なので、ここで
  // 一緒に隠さないと、隠したはずの国道がカーソルとクリックには残り続ける。
  for (const { id } of [...routeLayers(), ...clickableHitLayers()]) {
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

/* -------------------------------------------------------- ボタンから出る面 --- */
/**
 * 地図の上のボタンを押すと、その台の脇から出る面。四つが同じ仕掛けで動く——
 * 左上の「道路を選択」「国道重用区間ランキング」「起点・終点を共有する地点」と、
 * 右上の「表示」である。
 *
 * 面は自分のボタンと同じ台の中に居る。だから位置合わせの計算はどこにも無く、
 * 面はボタンを追う(state-tip が同じ台に居るのと同じ仕掛けである)。CSS が向きを
 * 決め、左上の台からは右へ、右上の台からは左へ出る——どちらも外側に窓の端しか
 * 無い側を避ける形である。
 *
 * 一度に開くのは一つだけにする。四つとも地図の上に浮くので、二枚が並ぶと地図の
 * 見えている面積が急に減る。
 */
const PANE_GAP = 12;

/** 開け閉てを預かっている面。{ btn, pane, roots } の並びである。 */
const panes = [];

/**
 * 面の上端はボタンに合わせる。それで窓の下からはみ出すなら、はみ出したぶん
 * だけ引き上げる——低い窓では、ボタンの高さに揃えることより中身が見えること
 * が先である。引き上げても入らない高さは面の中が巻き取る (style.css の
 * max-height)。
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
 * ボタンと面を結ぶ。`root` は「その面の持ち物」の範囲で、外を押したときに
 * 閉じるかどうかをここで見分ける——台の中には面のほかにボタンも居るので、
 * 面そのものだけを見ると、同じ台の ✕ を押しただけで一覧が畳まれる。
 *
 * 普段は台一つで足りるが、「道路を選択」はボタン(#select-btn)と面
 * (#select-popover)が別の台に分かれている——面は選んだ本数の札で幅が
 * 変わらない #ranking-btn の台へ位置合わせのため移してある(index.html)。
 * 両方の台を渡せば、どちらを押しても「持ち物の中」と見なせる。 */
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

// 窓を掴んでいる最中に面が窓からはみ出さないように。
window.addEventListener('resize', () => {
  for (const e of panes) if (!e.pane.hidden) fitPane(e.pane);
});

// 面の持ち物の外を押したら閉じる。ボタン自身の click もここへ上がってくるが、
// その台は root の中なので素通りする。
document.addEventListener('click', (ev) => {
  for (const e of panes) {
    if (!e.pane.hidden && !e.roots.some((r) => r.contains(ev.target))) {
      setPane(e, false);
    }
  }
});

/* 左上の三つ。markup は index.html が持ち、データが届く前から state と結べる。 */
for (const [btnId, paneId] of [
  ['#ranking-btn', '#ranking-popover'],
  ['#shared-btn', '#shared-popover'],
]) {
  const btn = $(btnId);
  registerPane(btn, $(paneId), btn.closest('.ui-ctrl'));
}
// 「道路を選択」の面は #ranking-btn の台へ移してある(index.html)ので、
// 持ち物の範囲はボタン自身の台とその台の両方になる。
const selectBtn = $('#select-btn');
registerPane(selectBtn, $('#select-popover'), [
  selectBtn.closest('.ui-ctrl'),
  $('#ranking-btn').closest('.ui-ctrl'),
]);
// 「道路を選択」を開いたら、都道府県道の番号を取りに行く。開かない人には
// 取りに行かない。二度目以降は覚えてある物を返すだけである。
selectBtn.addEventListener('click', loadPrefIndex);

/* -------------------------------------------------------------- 表示の面 --- */
/**
 * 「何が地図に描かれるか」を決めるものは残らずここに集める——切り替えた結果は
 * 地図にしか現れないので、地図の側に置く。節を分けて一つの面に収めてあるのは、
 * 重用区間の見せ方も種別の出し入れも同じ問いの答えだからである。ボタンを分ける
 * と、どちらを押すか毎回考えることになる。
 */
const displayPane = $('#display-popover');

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
 * 詳細パネル (#detail) は、地図の要素を細くするのではなく上に浮かせてある
 * ——細くすると canvas の寸法が変わり、開け閉てのたびに全部描き直しになる。
 * 浮かせて padding をずらせば、地図が持っている絵はそのままで、fitBounds や
 * flyTo の行き先だけがパネルを避ける。
 *
 * 寸法と位置は style.css が持つので、ここは実測した矩形に隙間ぶんを足すだけに
 * する——同じ数を二箇所で言わない。
 */
const app = $('#app');
const detail = $('#detail');
const detailBody = $('#detail-body');
const narrowMq = window.matchMedia(NARROW_QUERY);

const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
/** パネルと地図のあいだに残す余白。 */
const BOX_GAP = 12;
/** 一辺で覆ってよい上限。これが無いと、低い窓では地図の中心が画面の外へ出る。 */
const MAX_SIDE_RATIO = 0.6;
const EASE_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ? 0
  : 260;

/**
 * 地図が中心と見なす点を、開いているパネルの外へ寄せる。
 *
 * 相手は詳細パネル一つである。地図の上に浮く物は他にもあるが——左上の見出しと
 * 台、右上のボタン、右下の凡例——どれも小さく、避けると地図がそのぶん寄って
 * かえって落ち着かない。面はボタンを押しているあいだだけの物なので、これも
 * 数えない。
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

/* ------------------------------------------------------------ 凡例を畳む --- */
/**
 * 凡例を畳んで、地図に角を返す。
 *
 * 詳細パネルと同じ形である——開いているあいだ閉じる口は凡例自身の ×、
 * 閉じているあいだ開き直す口は同じ角に残る #legend-open である。
 *
 * 状態は URL ではなく localStorage に残す。配色・下地図の種類と濃さと同じ、
 * 読む人の表示の好みだからである。地図に何が描かれているかを決める物ではない
 * ので、共有したリンクが相手の凡例まで決める理由が無い。
 *
 * 畳んだ状態を実際に効かせるのは CSS で、鍵は <html> の data-legend である。
 * ここが hidden を置かないのは、index.html の <head> が最初の描画の前に同じ
 * 属性を置いているためで、答えを二箇所に分けないためである。
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
  /* 都道府県道の線は国道より先に足す。後から足した層が上に載るので、この順が
   * そのまま「国道は都道府県道の上」になる——国道だけを見ている人にとって、
   * 地図は今までと同じ絵のままである。
   *
   * 県道の札だけは線より上でなければ国道の線に潜るので、線の層とは別に、
   * 国道の札のすぐ下へ差し込む。場所争いの優先も同時に決まる(prefLabelLayer)。 */
  for (const layer of prefLineLayers()) map.addLayer(layer);
  for (const layer of routeLayers()) map.addLayer(layer);
  map.addLayer(prefLabelLayer(), 'route-labels');
  // 当たり判定だけを太らせた透明な層。見た目の層より後に足す——不透明度 0 なので
  // 描く順に意味は無く、他の層の位置決め(prefLabelLayer の beforeId)を邪魔しない
  // 場所へまとめて置く。
  for (const layer of prefClickableHitLayers()) map.addLayer(layer);
  for (const layer of clickableHitLayers()) map.addLayer(layer);
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

  /* 共有されたリンクが都道府県道を 1 本名指しているなら、その詳細を開く。
   *
   * 操作面に都道府県道の節は無いので(#109)、絞っていることを述べる場所も、
   * 解除する口も、このパネルのほかに無い。開かずに出すと、地図に県道が 1 本
   * しか出ていない理由が画面のどこにも書かれていない状態になる——それは
   * 「絞られている」ではなく「壊れている」に見える。
   *
   * 2 本以上を名指した URL では開かない。パネルは 1 路線について述べる場所で、
   * どれを代表に選んでも残りを黙って落とすことになる。画面からその形は作れず、
   * 手で書いた URL だけが持ちうる。 */
  if (state.prefSelected.size === 1) {
    openPrefDetail([...state.prefSelected][0]);
  }

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
  // 都道府県道は県までを確かめる。47 県の一覧は regions.json が持っているが、
  // 県の中に何号があるかを述べる表は配っていない——13,234 組の索引を初期表示で
  // 読ませないための判断である(#109)。在らぬ番号は地図に何も出さないだけで、
  // 在らぬ県は「長野県道」の名すら出せないので、確かめるのはそこまでとする。
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
 * 自分では値を持たない部品すべてに `state` を押し出す。起動時に一度だけ呼ぶ。
 * applyURLState が markup に書いてある既定から state を動かした後である。以後の
 * 変化は逆向きに、listener から `state` へ流れるので、ここは二度と走らない。
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

/**
 * 都道府県道の各層が既定で持つ絞り込み。`national`/`pref` の切り替えを戻すとき
 * はこれに戻す——区分ごとの絞り込み(走れる車道か、破線の区分か)を mapspec.mjs
 * と二重に持たないよう、層の定義そのものから読む。
 */
const PREF_DEFAULT_FILTERS = new Map(
  [...prefLineLayers(), prefLabelLayer()]
    // 影の層はここに入れない。押されたアークが決めるものなので、系統の表示と
    // 一緒に戻すと押した印が消える。国道の `picked` を FILTERED_LAYERS が
    // 持たないのと同じ理由である。
    .filter((l) => l.id !== PREF_PICKED_LAYER)
    .map((l) => [l.id, l.filter ?? true]),
);

/* -------------------------------------------------------------- 絞り込み --- */
/**
 * いま地図に出す系統。規則そのものは mapspec.mjs の shownSystems が持つ
 * ——絞り込みの式と同じ場所に置いて、検査スクリプトが本物を読めるようにする。
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
    // 当たり判定の透明な層は、見た目の層と常に同じ絞り込みを持つ。消した区分の
    // 上にだけ判定が残ると、見えない道が押せてしまう。
    if (CLICKABLE_LAYERS.includes(id)) map.setFilter(hitLayerId(id), filter);
  }

  map.setFilter(
    'picked',
    national ? pickedFilter(base, state.picked) : NOTHING,
  );

  // 都道府県道の選択。層が既に持っている区分の式へ重ねる(withPrefSelection)。
  // 空なら全部出す——国道の buildFilter と同じ約束である。
  const prefSel = [...state.prefSelected];
  for (const [id, filter] of PREF_DEFAULT_FILTERS) {
    const resolved = pref ? withPrefSelection(filter, prefSel) : NOTHING;
    map.setFilter(id, resolved);
    if (PREF_CLICKABLE_LAYERS.includes(id)) {
      map.setFilter(hitLayerId(id), resolved);
    }
  }

  map.setFilter(
    PREF_PICKED_LAYER,
    pref
      ? pickedFilter(withPrefSelection(true, prefSel), state.prefPicked)
      : NOTHING,
  );

  const tFilter =
    !national || !state.termini
      ? ['==', ['get', 'count'], -1]
      : terminiFilter([...state.selected]);
  map.setFilter('termini-dot', tFilter);
  map.setFilter('termini-label', tFilter);

  syncLegend();
  // 系統を消したなら、その線の上に置いたままの指も押せなくなっている。
  syncCursor();
  updateStats();
  renderRanking();
  syncURL();
}

/**
 * 凡例を、地図に描かれている系統だけに絞る。`legend-kind`(点線国道・工事中・
 * 未開通・海上国道)は国道の区分の凡例なので、`legend-n` と同じく `national` に
 * 従う——国道を消した画面に、国道の区分だけの凡例が残っては元も子もない。
 * 都道府県道の破線は `legend-pref` の中にあるので、こちらは `pref` に従う。
 * 両方消えたときは帯そのものも隠す。空の角丸だけが地図に残らないためである。
 *
 * 読む人が凡例を畳んだかどうかは、ここが決めることではない。帯を隠せば畳んだ
 * ほうも道連れになるので、二つを一つの属性に押し込まずに分けてある——畳み方は
 * 「凡例を畳む」の節が <html> の data-legend で持つ。
 */
function syncLegend() {
  const { national, pref } = shown();
  $('#legend-n').hidden = !national;
  $('#legend-kind').hidden = !national;
  $('#legend-pref').hidden = !pref;
  $('#legend-bar').hidden = !national && !pref;
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

  // 選んでいる本数は両系統の合計である。「道路を選択」の台が国道と都道府県道の
  // 両方を引き受けるので、数える側も消す側も系統を分けない。
  const picked = sel.size + state.prefSelected.size;

  // 取り消す物が無いあいだ、✕ は居ない。押せない姿で居座らせるより、選んで
  // いるときだけ台が伸びるほうが、何が起きるかを地図の上で読み取りやすい。
  // 文字を持たないボタンなので、どれだけ取り消すかはラベルが述べる。
  const clear = $('#sel-none');
  clear.hidden = picked === 0;
  const clearText = clearLabel(picked);
  clear.title = clearText;
  clear.setAttribute('aria-label', clearText);

  // 面を開かなくても、絞り込んでいることは台の上で分かっていなければならない。
  // 数の札がそれを言う——0 のときは出さない。選択が空であることは「何も出て
  // いない」ではなく「全部出ている」を意味するので、0 と書くと地図と逆になる。
  const badge = $('#sel-count');
  badge.textContent = picked ? String(picked) : '';
  badge.hidden = picked === 0;
}

/** 面は押すまで開かないので、どれだけ入っているかは面の見出しが述べる。 */
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

/** ランキングと同じく、大きさは面の見出しが運ぶ。 */
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
 * 都道府県道を押せるかどうか。
 *
 * z8 未満のタイルは `id`・`name`・`km`・`src` を持たないので、ポップアップを
 * 組めない(mapspec.mjs の PREF_POPUP_MINZOOM)。国道はこの制限を持たず、
 * 今までどおり z0 から押せる。
 */
const prefPickable = () => map.getZoom() >= PREF_POPUP_MINZOOM;

/**
 * カーソルの形。押せる物の上でだけ指の形にする。
 *
 * 二つの系統で押せる条件が違うので、どちらの上にいるかを覚えておいて一箇所で
 * 決める。押せるかどうかは、線の上にいることだけでは決まらない——その系統が
 * 地図に出ているか、都道府県道なら縮尺が足りているかも要る。
 *
 * ズームと絞り込みでも見直す。線の上に指を置いたまま縮尺を動かすことも、系統を
 * 消すこともできるためである。`mouseleave` は指が動いたときにしか来ないので、
 * 指を止めたまま押せなくなったとき、指の形だけが残る。押せる物だと言ったままに
 * なる。
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

// 押せる範囲はここでだけ、当たり判定用の透明な層(hitLayerId)を通して問う。
// hover(mouseenter/mouseleave)と click を同じ層に対して行うことで、指の形が
// 変わる範囲と実際に押せる範囲が常に一致する——見た目の層(CLICKABLE_LAYERS /
// PREF_CLICKABLE_LAYERS)は太さが重用の深さを表しているので広げられない
// (mapspec.mjs の clickableHitLayers)。
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

    // 国道が先である。二つの系統が同じ画素の下に重なるところでは、上に描かれて
    // いるのは国道の線で、押した人が見ているのもそれである。ここで深さを比べて
    // 混ぜることはしない——`n` は国道では重用の深さ、県道でも重用の深さだが、
    // 数えている集合が違うので、二つを一つの尺度で比べたことにならない。
    // 国道だけを見ている人にとって、押した結果は今までと同じである。
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
 * 路線そのものについて述べるパネル。中身の組み立ては detail.mjs が持ち、ここに残る
 * のは地図が必要な三つ——開いたぶん地図をずらすこと、起終点へ飛ぶこと、選択を
 * 差し替えること——だけである。
 *
 * パネルの居場所は style.css の #detail が、地図をずらす量は applyMapPadding
 * が持つ(上の「地図をずらす」の節)。
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

/**
 * いま開いているパネルを名指す札。
 *
 * 都道府県道のパネルは県別 meta を取りに行くあいだ待つので、届いた頃には別の
 * 路線が開かれていることがある。取りに行く前に控えた札と、届いたときの札が同じ
 * であるときだけ書き込む。国道のパネルも札を進める——待っているあいだに国道へ
 * 開き直したら、遅れて届いた県道の中身がそれを上書きしてはならない。
 */
let detailSerial = 0;

function openDetail(ref) {
  const route = state.routes.find((r) => r.ref === ref);
  if (!route) return;
  detailSerial++;
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
  showDetail();
}

/**
 * 一つの都道府県道について述べるパネル。
 *
 * 数はどれも県別 meta の組み合わせ表から出す。国道の national.meta.json と同じ
 * 表なので、読み方(aggregate.mjs)も同じである。違うのは表の在りかだけで、県の
 * ぶんは県を初めて開いたときに取りに行く。
 *
 * 取りに行くあいだも見出しは出す。押した標識がどの路線だったかは、数が揃う前
 * から分かっていることである。
 */
async function openPrefDetail(key) {
  const region = prefRegionOf(key);
  const prefLabel = state.prefLabels.get(region);
  if (!prefLabel) return;
  const ref = prefRefOf(key);
  const serial = ++detailSerial;

  // 押した状態は state から読む。ボタンが自分の見た目を覚えるのではなく、
  // 選択そのものが一つあって、それを毎回描き直す形にする。
  const selected = state.prefSelected.has(key);
  closePopup();
  detailBody.innerHTML = prefDetailHTML({ region, prefLabel, ref, selected });
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
        selected,
        failed: true,
      });
      // 高さは中身に合わせて変わる。プレースホルダーぶんで計算した padding は
      // ここでは古いので、地図をずらす量を新しい高さで取り直す。
      showDetail();
    }
    return;
  }
  // 待っているあいだに別の路線が開かれていたら、届いた中身は捨てる。
  if (serial !== detailSerial) return;

  const combos = meta.combinations;
  const route = routesOf(combos, comparePrefKeys).find((r) => r.ref === key);
  // タイルに在る路線が県の表に無いのは、配ってある web/data が食い違っていると
  // きである。待っている表示のまま止めず、読めなかったと言う。
  if (!route) {
    detailBody.innerHTML = prefDetailHTML({
      region,
      prefLabel,
      ref,
      selected,
      failed: true,
    });
    showDetail();
    return;
  }
  const sel = new Set([key]);
  detailBody.innerHTML = prefDetailHTML({
    region,
    prefLabel,
    ref,
    selected,
    route,
    rank: prefRankOf(combos, key),
    kinds: kindsFor(combos, sel),
    related: relatedRoutesOf(meta, key, {
      system: '都道府県道',
      compare: comparePrefKeys,
      normalize: String,
    }),
    formerKm: formerKmFor(combos, sel),
  });
  showDetail();
}

/**
 * 全国の県と番号だけの索引を取る。一度取ったら覚えておく。
 *
 * 「道路を選択」の面を開いたときに呼ぶ。開かない人には取りに行かない——番号で
 * 絞り込むためだけの物で、地図を見るのに要らない。県別 meta 47 本 3.45 MB を
 * 読ませないために、ビルドが番号だけを抜いて 1 枚にしてある
 * (pipeline/pack_web_pref.mjs)。
 *
 * 畳み方は URL の選択と同じ範囲表記なので、開くのも同じ decodeRoutes である。
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
      // 在る県を決めるのは索引そのものである。regions.json を読んで作る
      // state.prefLabels で絞り込んではならない——あれは boot() が埋めるので、
      // 埋まる前にここが解決すると索引が空のまま残る。しかも成功しているぶん
      // prefIndexPending は解けず、開き直しても取り直さない。
      //
      // prefLabels は並べ替えにだけ使う。県の並びを regions.json の順に揃えて
      // おくと、一致した行の並びがその順を継ぐ(prefroute.mjs の
      // matchPrefRoutes)。まだ空なら順位が付かないので、索引の順のまま残る。
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

/**
 * 県別 meta を 1 県ぶんだけ取る。一度取ったら覚えておく。
 *
 * 取りに行っている最中の約束そのものを覚える。同じ県の路線を続けて開いたとき、
 * 二度目が一度目の到着を待つのではなく同じ約束に乗るためである。
 */
function prefMeta(region) {
  let pending = state.prefMetas.get(region);
  if (!pending) {
    pending = fetch(dataURL(`pref/${region}.meta.json`)).then((r) => {
      if (!r.ok) throw new Error(`pref/${region}.meta.json: ${r.status}`);
      return r.json();
    });
    // 失敗した約束を覚えたままにすると、二度と取り直せなくなる。
    pending.catch(() => state.prefMetas.delete(region));
    state.prefMetas.set(region, pending);
  }
  return pending;
}

/* パネルを出す。中身を入れ替えただけの開き直しでは、開いたときの居場所を
 * 取り直さない——動いた後に開き直した人が閉じたときに横へ滑るためである。 */
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
// キャンセルは document まで上がってくるので、ここで譲らないと後ろのパネルまで
// 一緒に閉じる。
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if ($('dialog[open]')) return; // ダイアログの Esc はそちらのものである
  // 開いている面が先に閉じる。Esc は一番手前のものを畳む鍵である。
  if (anyPaneOpen()) {
    closePanes();
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
    // 都道府県道の標識は県を伴う鍵を持つ。番号だけでは 47 本のどれか決まらない。
    if (shieldBtn.dataset.pref) openPrefDetail(shieldBtn.dataset.pref);
    else openDetail(Number(shieldBtn.dataset.ref));
    return;
  }

  // 選択の持ち主は state のままである。ここは wiring の関数を呼ぶだけで、
  // サイドパネルのチェックも系統のトグルもそちらが合わせる。
  const only = ev.target.closest('.detail-only');
  if (only) {
    if (only.dataset.pref) {
      togglePrefOnly(state, only.dataset.pref, applyFilters);
      // 押した状態はこのボタン自身が述べる。開き直して aria-pressed と
      // 名乗りを入れ替える——県別 meta は取得済みなので、待ちは挟まらない。
      openPrefDetail(only.dataset.pref);
    } else {
      showRouteOnly(document, state, Number(only.dataset.ref), applyFilters);
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
