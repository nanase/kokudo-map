/* 国道マップ
 *
 * The design premise from the feasibility study: every arc already carries the
 * complete set of route designations over it, wrapped in delimiters as
 * `refs = ",18,117,406,"`. So "show only route N" and "show only concurrent
 * sections" are both plain attribute filters, evaluated in the style — no
 * recomputation, no server.
 *
 * The build runs per region because both the OSM extract and, more importantly,
 * the corroboration guard are boxed by prefecture. The viewer is not: the
 * regions are merged at build time into one nationwide set of tiles, so there
 * is no prefecture to pick. Widening the coverage is a data change (add a
 * region, build it) and never a UI change.
 *
 * Nationwide that set is ~130,000 arcs, which is why the geometry arrives as
 * vector tiles: only what is on screen is ever in memory. The consequence is
 * that the panel cannot count features to fill itself in. Every total it shows
 * — the route list, the ranking, the selection stats — is read out of
 * national.meta.json, where the build wrote it after deduplicating the seams.
 *
 * Style and filter shapes live in mapspec.mjs so the build-time checker can
 * validate exactly what runs here.
 *
 * What is left in this file is the part that needs a live map and a live page:
 * the map itself, the one mutable `state`, the filters that state drives, the
 * listeners, and boot order. Everything that is a plain function of the data
 * was moved out so it can be checked directly — see test/. wireControls() and
 * wireShare() moved out too, to wiring.mjs, not because they are pure but
 * because they only need document/state/applyFilters — no map — so
 * test/wiring.test.mjs can wire them to a real index.html in happy-dom
 * without building a map.
 *
 *   mapspec.mjs    style, layers, filter expressions
 *   aggregate.mjs  the panel's numbers, read off the combination table
 *   panel.mjs      the sidebar's markup
 *   popup.mjs      what a clicked arc says about itself
 *   detail.mjs     what one route says about itself
 *   termini.mjs    起点・終点 as a GeoJSON source
 *   shield.mjs     the 国道番号標識
 *   html.mjs       escaping, because OSM text is untrusted
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
  // The OSM way id of the arc a popup is open on, or null. Its only use is the
  // shadow under it; nothing else on the map is scoped to one arc.
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

/* ------------------------------------------------------------------- map --- */
// PMTiles is one archive read by byte range, so a static host serves the whole
// country without a tile server. Any host will do — but it must answer Range
// requests, which is why the development server is pipeline/serve.py and not
// `python -m http.server`.
maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);

/**
 * Base map appearance the reader picked last time: which 地理院タイル and how
 * dark it sits under the routes. Read before the map is built, and fed
 * straight into its style, so the map is never built once at the shipped
 * default and then redrawn a moment later at the reader's own choice.
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

/**
 * 共有されたリンクが眺めを指定しているか。
 *
 * 地図を作る前に読む。`hash: true` の MapLibre は、地図を作った時点で既定の
 * 中心へ jumpTo し、その moveend で自分の hash を書き込む——しかもその書き込み
 * は同期に走る。作った後に読むと、共有されたリンクの hash と、地図が今しがた
 * 自分で書いた hash が見分けられない。
 *
 * 見分けが付かないあいだ、boot() の fitInitialView() は一度も呼ばれていなかった。
 * 全国の広がりに合わせる初期表示も、`?region=` が指す地域も、そこにあるだけで
 * 誰にも届いていない。
 */
const sharedView = Boolean(location.hash);

const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false,
  hash: true,
  // MapLibre otherwise draws anything in the CJK blocks with the reader's own
  // system font instead of asking the glyph server — a sensible default when
  // the alternative is megabytes of Japanese ranges. Here the whole alphabet
  // is ten digits and `・`, all of it already served, so local rendering only
  // buys a separator that changes shape from machine to machine and vanishes
  // where no CJK font is installed.
  localIdeographFontFamily: false,
  style: baseStyle(basemap, gsiShade),
  center: [138.0, 36.2],
  zoom: 7.6,
  // MapLibre 自身が作る釦の名札。この地図の釦は残らず日本語で名乗っている
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

// exposed for debugging and for pipeline/render_check.mjs
window.map = map;

// Registered synchronously, before any fetch can let the map race ahead: `load`
// fires exactly once in the map's lifetime, while `map.loaded()` flips back to
// false whenever a source is mid-fetch. Branching on the latter risked
// attaching `once('load', ...)` after the one and only `load` had already
// fired — a hung `boot()` with no error, reproducible whenever the browser
// cache made everything else resolve fast enough to win the race (a reload,
// typically, unlike a cold first visit).
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
/**
 * 現在位置。押すと端末に位置を尋ね、地図の上に点で出す。
 *
 * MapLibre 自身の部品を使う。点・精度の円・追従の解除まで一式を持っており、
 * この地図が足すことは何も無い。位置は端末から地図へ渡るだけで、どこへも
 * 送らない——`state` にも URL にも入らないので、共有したリンクが自分の
 * 居場所を連れて行くこともない。
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
map.addControl(
  new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }),
  'bottom-right',
);

/* ------------------------------------------------------------ hold-to-zoom --- */
/**
 * NavigationControl の拡大・縮小ボタンは、素のままではクリックのたびに 1 段階
 * ズームするだけ。ここでは押した瞬間に同じ 1 段階ズームをしたうえで、
 * HOLD_DELAY_MS を過ぎてもまだ押されていればゆっくり連続ズームへ移す。
 *
 * 単発の 1 段階も pointerdown 側で行うため、離したときに本来の click も
 * 発火すると 1 段階よけいにズームしてしまう。pointerdown が起きた押下は
 * 必ずその click を飲み込む——document の capture 段で止める。button 自身に
 * capture:true で listener を足しても、同じ要素上では登録順で呼ばれるため
 * NavigationControl 自身の click listener（bubble）より後に回り、間に合わない。
 * キーボード操作（Enter/Space）は pointerdown を経ないので、そちらは今まで
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
// The one place the sources are credited. The panel used to say the same thing
// in its footer, which is two answers to one question and one of them free to
// go stale; the map's own control is the copy that has to be there.
map.addControl(
  new maplibregl.AttributionControl({
    compact: false,
    customAttribution:
      '道路データ <a href="https://www.openstreetmap.org/copyright" ' +
      'target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL 1.0)',
  }),
  'bottom-right',
);

/* ------------------------------------------------------------- state tip --- */
/**
 * A label that flashes next to a control button right after it changes
 * state — the same confirmation a hover title gives, but for a tap, which
 * has no hover. Lives inside the button's own control group so it tracks
 * that group's position without any layout math of its own.
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
  return (text) => {
    tip.textContent = text;
    tip.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, STATE_TIP_MS);
  };
}

/* --------------------------------------------------------- control factory --- */
/**
 * The three top-right controls are all the same shape: a MapLibre IControl —
 * so `addControl(…, 'top-right')` stacks it in its own rounded group
 * directly under the zoom buttons for free — whose button steps through
 * `order` on click and re-renders its icon/title/aria-label from whatever
 * value is now current. `get`/`apply` reach into state that lives outside
 * the control (map layers, localStorage) — this factory only owns the
 * button.
 *
 * A two-value `order` is a toggle, not a cycle, and gets the `active` class
 * and `aria-pressed` that only a toggle needs; the two three-value controls
 * fall through untouched. `tip` defaults to `label`, since only the
 * hide-routes button needs a different phrasing for "what happens next" vs.
 * "what just happened" (see `hideStateTip`).
 *
 * `onExternalChange`, if given, is handed the button's own `render` so a
 * control can redraw when its state changes off-screen from any click —
 * the pitch button's state also moves via Ctrl+drag. `isPressed` likewise
 * defaults to exact equality with `order[1]`, which the two hard-toggle
 * buttons never need to override — but the pitch button's `get()` can land
 * on any angle a drag left it at, not just the two the button cycles
 * between, so it treats every non-zero pitch as pressed.
 */
function buildCycleControl({
  className,
  id,
  order,
  get,
  apply,
  icon,
  label,
  tip,
  isPressed = (value) => value === order[1],
  onExternalChange,
}) {
  const tipFor = tip ?? label;
  const isToggle = order.length === 2;
  return class CycleControl {
    onAdd() {
      const container = document.createElement('div');
      container.className = `maplibregl-ctrl maplibregl-ctrl-group ${className}`;
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
      const showTip = attachStateTip(container);
      btn.addEventListener('click', () => {
        const next = order[(order.indexOf(get()) + 1) % order.length];
        apply(next);
        render();
        showTip(tipFor(next));
      });
      render();
      onExternalChange?.(render);
      container.appendChild(btn);
      this._container = container;
      return container;
    }
    onRemove() {
      this._container.remove();
    }
  };
}

/* ----------------------------------------------------------------- pitch --- */
/**
 * Straight-down is the map's normal reading posture; 60° is a look at the
 * terrain. Ctrl+drag reaches any angle in between, so `mapPitch` (the
 * button's own idea of where it is) is resynced from the map's actual pitch
 * whenever a drag ends, via `onExternalChange`. Any pitch short of exactly
 * flat counts as "tilted" for the toggle: `order.indexOf` misses a
 * mid-drag angle and falls back to `order[0]`, which is flat — so the
 * button always offers to return to flat unless it is already there.
 *
 * The two icons are the same square seen from the two postures: face-on from
 * straight above, and foreshortened into a trapezoid — near edge long, far
 * edge short — from the tilted one. An isometric box was drawn here first,
 * but a box is a solid, and what the button turns is the angle the flat map
 * is looked at.
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

const PitchControl = buildCycleControl({
  className: 'pitch-ctrl',
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

/* ------------------------------------------------------------ hide-routes --- */
/**
 * A temporary "basemap only" view, for reading the terrain under the routes.
 * It is layout visibility, not filter state: turning it back on has to show
 * exactly what the checkboxes already say, so this never touches `state` or
 * the URL — sharing this view is not a thing a link should do.
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

const HideRoutesControl = buildCycleControl({
  className: 'hide-routes-ctrl',
  id: 'hide-routes-btn',
  order: [false, true],
  get: () => routesHidden,
  apply: setRoutesHidden,
  icon: (hidden) => (hidden ? EYE_OFF_ICON : EYE_ICON),
  label: (hidden) => (hidden ? '国道の表示に戻す' : '国道を一時的に隠す'),
  tip: hideStateTip,
});

/* -------------------------------------------------------------- gsi shade --- */
/**
 * How full the drop sits for each shade, and how tilted its liquid surface
 * is. 薄い has no liquid at all (empty outline). 濃い brims flat, so no tilt
 * is visible either way. 通常 sits just under half with a tilted surface —
 * the tilt is what reads as "liquid", distinguishing it from an abstract
 * gauge, at a glance and without already knowing the kanji for 濃い/薄い.
 */
const SHADE_FILL = { light: 0, normal: 0.42, dark: 1 };
const SHADE_TILT = { light: 0, normal: 10.4, dark: 0 }; // 幅18に対し約30度

/**
 * A water drop, filled from the bottom by how dark the current shade is.
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
 * How dark the base map sits under the routes: 薄い・通常・濃い, cycled by one
 * button. This is a display preference, not filter state — like the
 * hide-routes button, it never touches `state` or the URL — but unlike that
 * button it is worth remembering, so it is kept in localStorage instead of
 * resetting on every reload.
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
    /* private browsing: the choice simply does not outlive the tab */
  }
}

const GsiShadeControl = buildCycleControl({
  className: 'gsi-shade-ctrl',
  id: 'gsi-shade-btn',
  order: GSI_SHADE_LEVELS,
  get: () => gsiShade,
  apply: applyGsiShade,
  icon: shadeIcon,
  label: (level) => `地図の濃さ: ${GSI_SHADE_LABELS[level]}`,
});

/* --------------------------------------------------------------- basemap --- */
/**
 * One icon per basemap, each reaching for a different, unambiguous metaphor
 * rather than a shared shape varied by fill: a folded paper map for the
 * plain 淡色地図, a stack of layers for the more detailed 標準地図, and a
 * photo frame for 写真 (航空写真) — nothing here needs the label text to be
 * told apart.
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
 * Which 地理院タイル draws under the routes: 淡色地図・標準地図・写真
 * (航空写真). All three are always in the style (see baseStyle), so switching
 * is a layout-visibility flip between two layers, never a source rebuild —
 * and it carries whatever shade level is current, since the shade paint
 * property lives on every basemap layer, not just the one drawn today.
 */
function applyBasemap(id) {
  map.setLayoutProperty(gsiLayerId(basemap), 'visibility', 'none');
  basemap = id;
  map.setLayoutProperty(gsiLayerId(basemap), 'visibility', 'visible');
  try {
    localStorage.setItem('gsi-basemap', basemap);
  } catch {
    /* private browsing: the choice simply does not outlive the tab */
  }
}

const BasemapControl = buildCycleControl({
  className: 'basemap-ctrl',
  id: 'basemap-btn',
  order: GSI_BASEMAP_ORDER,
  get: () => basemap,
  apply: applyBasemap,
  icon: (bmId) => BASEMAP_ICONS[bmId],
  label: (bmId) => `地図の種類: ${GSI_BASEMAPS[bmId].label}`,
});

/* --------------------------------------------------------- 地図をずらす --- */
/**
 * 地図の上に浮いている箱のぶんだけ、地図の「中心」をずらす。
 *
 * 箱は #left-stack に縦に並んでいる。操作面 (#panel) も詳細 (#detail) も、
 * 地図の要素を細くするのではなく上に浮かせてある——細くすると canvas の寸法が
 * 変わり、開け閉てのたびに全部描き直しになる。浮かせて padding をずらせば、
 * 地図が持っている絵はそのままで、fitBounds や flyTo の行き先だけが箱を
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
/** 箱と地図のあいだに残す余白。 */
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
  const boxes = [];
  if (panelOpen()) boxes.push(panel.getBoundingClientRect());
  if (!detail.hidden) boxes.push(detail.getBoundingClientRect());
  if (!boxes.length) return { ...NO_PADDING };

  // 狭い画面では列が画面の幅いっぱいなので、避ける向きは上下になる。操作面が
  // 上を、詳細が下を覆う。広い画面では列は左端にあるので、左だけを空ける。
  if (!narrowMq.matches) {
    const right = Math.max(...boxes.map((b) => b.right));
    const left = Math.min(
      right - canvas.left + BOX_GAP,
      canvas.width * MAX_SIDE_RATIO,
    );
    return { ...NO_PADDING, left };
  }

  const cap = canvas.height * MAX_SIDE_RATIO;
  const pad = { ...NO_PADDING };
  if (panelOpen()) {
    const box = panel.getBoundingClientRect();
    pad.top = Math.min(box.bottom - canvas.top + BOX_GAP, cap);
  }
  if (!detail.hidden) {
    const box = detail.getBoundingClientRect();
    pad.bottom = Math.min(canvas.bottom - box.top + BOX_GAP, cap);
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
 *  いる絵はそのままで、地図が中心と見なす点だけが箱の外へ寄る。 */
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

/* ----------------------------------------------------------------- panel --- */
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
      /* private browsing: the choice simply does not outlive the tab */
    }
  };

  toggle.addEventListener('click', () => set(true, true));
  $('#panel-close').addEventListener('click', () => set(false, true));
  // 「この地図について」。中身は動かないので、開く口を結ぶだけでよい——
  // showModal() 自身が Esc とフォーカスの往復を面倒みる。
  $('#about-btn').addEventListener('click', () =>
    $('#about-dialog').showModal(),
  );

  // 狭い画面では畳んで始める。浮いた箱は画面の半分を占め、その下から地図が
  // 見えるわけではない——この幅で見に来た人がまず見たいのは地図である。
  // 一度でも自分で開け閉てした人の選択は、幅より優先する。
  let open = !narrowMq.matches;
  try {
    const stored = localStorage.getItem('panel-open');
    if (stored !== null) open = stored === '1';
  } catch {
    /* ditto */
  }
  set(open, false);
})();

/* ----------------------------------------------------------------- boot --- */
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

  // The archive is addressed absolutely: the protocol handler resolves the URL
  // itself and has no page to be relative to.
  const sources = routeSources(new URL(PMTILES_URL, location.href).href);
  for (const [id, src] of Object.entries(sources)) map.addSource(id, src);
  for (const layer of routeLayers()) map.addLayer(layer);
  map.addControl(new PitchControl(), 'top-right');
  map.addControl(new HideRoutesControl(), 'top-right');
  map.addControl(new GsiShadeControl(), 'top-right');
  map.addControl(new BasemapControl(), 'top-right');

  wirePopups();
  wireControls(document, state, applyFilters);
  wireShare(document, state);

  map.getSource('termini').setData(terminiFeatures(state.meta));

  buildUI();
  syncControls();
  applyFilters();

  // A shared link's hash wins. Otherwise open on everything that is built, or
  // on one region if ?region= names it — a view hint, not a data switch.
  if (!sharedView) fitInitialView(index);

  $('#loading').classList.add('done');
}

/**
 * Read the filter and display state a shared link carries, before the first
 * render. Only overwrites what the URL actually names — decodeURLState hands
 * back a diff, not a full state — and drops any selected route the data does
 * not have, since routes.length only grows with the build and an old link
 * naming a number since renumbered should not point at nothing.
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
 * Push `state` onto every control that does not already own its value —
 * called once at boot, after applyURLState may have moved state away from
 * the markup's hard-coded defaults. Later changes flow the other way, from a
 * listener into `state`, so this never runs again.
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
 * Open on the roads themselves, or on the box named by ?region=.
 *
 * The union of the region boxes is not the same thing: they are rectangles
 * drawn around prefecture outlines, and 東京都 reaches 南鳥島, so their union
 * spans a third of the Pacific. The extent of the arcs is what there is to see.
 */
function fitInitialView(index) {
  const wanted = new URLSearchParams(location.search).get('region');
  const box = index.find((r) => r.region === wanted)?.bbox || state.meta.bbox;
  const [w, s, e, n] = box;
  const bounds = [
    [w, s],
    [e, n],
  ];
  // 浮いている箱のぶんは、既に地図の padding が述べている。fitBounds に渡す
  // padding はそれを置き換えてしまうので、余白を足した形で渡し直す——そうし
  // ないと最初の眺めだけが操作面の下に潜る。
  const p = map.getPadding();
  const clear = {
    top: p.top + 24,
    bottom: p.bottom + 24,
    left: p.left + 24,
    right: p.right + 24,
  };
  // 箱を避けた残りに全国が入らない画面もある——縦に長い狭い画面では、操作面が
  // 高さの半分を占め、残りへ収めるには縮尺が足りない。そのとき
  // cameraForBounds は何も返さないので、避けるのをやめて窓いっぱいに合わせる。
  // 端が操作面の下に少し潜るが、全国が一枚に入っているほうがこの地図の趣旨に
  // 近い——箱は閉じられる。
  const padding = map.cameraForBounds(bounds, { padding: clear }) ? clear : 24;
  map.fitBounds(bounds, { padding, duration: 0 });
}

/* --------------------------------------------------------------- filters --- */
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
 * Keep the query string in step with `state`, leaving everything else in the
 * URL alone: MapLibre's own hash, which it writes to independently, and any
 * query param this module does not manage — `?region=` is read once at boot
 * and would otherwise be wiped by the first filter change.
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

/* -------------------------------------------------------------------- ui --- */
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

  // A button that cannot act should say so by being unavailable rather than by
  // doing nothing.
  const clear = $('#sel-none');
  clear.disabled = sel.size === 0;
  clear.textContent = clearLabel(sel.size);

  // 畳んだ一覧は中身を見せないので、選択がいくつあるかは見出しが述べる。
  $('#route-count').textContent = selectionLabel(sel.size, state.routes.length);
}

/** The ranking is folded away by default, so its size has to show on the tab. */
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

/** Folded away like the ranking, so the summary has to carry its size. */
function renderShared() {
  const all = state.meta.shared_termini;
  const rows = all.slice(0, SHARED_ROWS);
  $('#shared-count').textContent = countLabel(rows.length, all.length, '地点');
  $('#shared').innerHTML = sharedHTML(rows);
}

/**
 * Clicking a ranking / shared-terminus row goes to that place.
 *
 * Each row carries the extent of the one thing it names — the combination's own
 * bounding box, or the terminus' coordinate — and the camera is sent there and
 * nowhere else. It used to derive the extent by re-scanning the whole table for
 * every combination sharing two of the row's numbers, and the union of those
 * covered a quarter of a region: clicking 国道32・55・56・195・197・493, which
 * run together for 4 km in 高知市, framed 132.5°E–134.7°E, most of 四国.
 *
 * The click does not touch the selection either. The ranking is a view of the
 * selection, so selecting the row's routes rebuilt the list under the cursor
 * and the row that was just clicked moved or vanished. Narrowing to a route is
 * what the checkboxes are for; this list's job is to take you somewhere.
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
  // A short concurrency can be a few metres of carriageway, and one that is a
  // single arc long has no extent at all, so the box is only a hint about where
  // to point: maxZoom keeps a degenerate one from asking for infinite scale.
  const [w, s, e, n] = row.dataset.bbox.split(',').map(Number);
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: 80, maxZoom: 14 },
  );
});

/* ---------------------------------------------------------------- popups --- */
/**
 * At most one popup is open, and the shadow on the map belongs to it.
 *
 * MapLibre's own `closeOnClick` would close the previous popup from a click
 * handler registered after this file's, so the old popup's close would land
 * after the new one had already claimed the shadow and would take it away
 * again. Holding the popup here and closing it explicitly keeps the two in
 * step whichever way it ends: the close button, another arc, or empty map.
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

/* ---------------------------------------------------------------- detail --- */
/**
 * 路線そのものについて語る箱。中身の組み立ては detail.mjs が持ち、ここに残る
 * のは地図が要る三つ——開いたぶん地図をずらすこと、起終点へ飛ぶこと、選択を
 * 差し替えること——だけである。
 *
 * 箱の居場所と、地図をずらす量は #left-stack と applyMapPadding が持つ
 * (上の「地図をずらす」の節)。
 */
/**
 * 箱を開いた時点の居場所。閉じるときに、寄せたぶんを戻すかどうかを決める。
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
  // 箱を出すときは、後ろのポップアップを引き取る。ポップアップはアーク 1 本
  // について、箱は路線そのものについて述べるので、両方が出ていると同じ画面で
  // 二つが別のことを語る。箱は地図の左下を覆うから、狭い画面では重なりもする。
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
// キャンセルは document まで上がってくるので、ここで譲らないと後ろの箱まで
// 一緒に閉じる。
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('dialog[open]')) closeDetail();
});

// 箱の大きさは画面幅で変わる(狭い画面では下部の帯になる)ので、開いている
// あいだは幅の変化に padding を追随させる。開閉と違って利用者が窓を掴んで
// いる最中なので、滑らせずにその場で合わせる。
window.addEventListener('resize', () => applyMapPadding(false));

/**
 * 標識と、箱の中のボタン。
 *
 * どちらも委譲で受ける。ポップアップは開くたびに作り直され、箱の中身は
 * 路線が変わるたびに innerHTML ごと入れ替わるので、配線した時点の要素は
 * 押される時点には残っていない。
 */
document.addEventListener('click', (ev) => {
  // 箱の中の「関わりのある国道」も同じ .shield-btn である。押せばその路線に
  // 開き直る——箱は路線 1 本について述べる場所なので、隣の路線の話を同じ箱で
  // 続けるのではなく、その路線の箱に入れ替わるのが筋である。
  const shieldBtn = ev.target.closest('.shield-btn');
  if (shieldBtn) {
    openDetail(Number(shieldBtn.dataset.ref));
    return;
  }

  // 選択の持ち主は state.selected のままである。ここは setSelection を呼ぶ
  // だけで、サイドバーのチェックもそちらが合わせる。
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
