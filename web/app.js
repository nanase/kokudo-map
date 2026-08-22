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
 * was moved out so it can be checked directly — see test/.
 *
 *   mapspec.mjs    style, layers, filter expressions
 *   aggregate.mjs  the panel's numbers, read off the combination table
 *   panel.mjs      the sidebar's markup
 *   popup.mjs      what a clicked arc says about itself
 *   termini.mjs    起点・終点 as a GeoJSON source
 *   shield.mjs     the 国道番号標識
 *   html.mjs       escaping, because OSM text is untrusted
 */

import { routesOf, statsFor } from './aggregate.mjs';
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
  concurrencies,
  countLabel,
  freshnessHTML,
  RANKING_ROWS,
  rankingHTML,
  routeListHTML,
  SHARED_ROWS,
  sharedHTML,
  shareSummaryHTML,
  statsHTML,
} from './panel.mjs';
import { deepest, popupHTML } from './popup.mjs';
import { terminiFeatures } from './termini.mjs';
import { decodeURLState, encodeState, MANAGED_KEYS } from './urlstate.mjs';

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
};

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------------- map --- */
// PMTiles is one archive read by byte range, so a static host serves the whole
// country without a tile server. Any host will do — but it must answer Range
// requests, which is why the development server is scripts/serve.py and not
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
});

// exposed for debugging and for scripts/render_check.mjs
window.map = map;

// Registered synchronously, before any fetch can let the map race ahead: `load`
// fires exactly once in the map's lifetime, while `map.loaded()` flips back to
// false whenever a source is mid-fetch. Branching on the latter risked
// attaching `once('load', ...)` after the one and only `load` had already
// fired — a hung `boot()` with no error, reproducible whenever the browser
// cache made everything else resolve fast enough to win the race (a reload,
// typically, unlike a cold first visit).
const mapLoaded = new Promise((res) => map.once('load', res));

map.addControl(
  new maplibregl.NavigationControl({ visualizePitch: false }),
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

function setHideBtnState(btn, hidden) {
  btn.innerHTML = hidden ? EYE_OFF_ICON : EYE_ICON;
  btn.classList.toggle('active', hidden);
  btn.setAttribute('aria-pressed', String(hidden));
  const label = hidden ? '国道の表示に戻す' : '国道を一時的に隠す';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function setRoutesHidden(hidden) {
  routesHidden = hidden;
  for (const { id } of routeLayers()) {
    map.setLayoutProperty(id, 'visibility', hidden ? 'none' : 'visible');
  }
  setHideBtnState($('#hide-routes-btn'), hidden);
}

// A MapLibre IControl, so `addControl(…, 'top-right')` stacks it in its own
// rounded group directly under the zoom buttons for free.
class HideRoutesControl {
  onAdd() {
    const container = document.createElement('div');
    container.className =
      'maplibregl-ctrl maplibregl-ctrl-group hide-routes-ctrl';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'hide-routes-btn';
    setHideBtnState(btn, false);
    btn.addEventListener('click', () => setRoutesHidden(!routesHidden));
    container.appendChild(btn);
    this._container = container;
    return container;
  }
  onRemove() {
    this._container.remove();
  }
}

/* -------------------------------------------------------------- gsi shade --- */
/** How full the drop sits for each shade — 濃い brims, 薄い is a third full. */
const SHADE_FILL = { light: 0.32, normal: 0.66, dark: 1 };

/**
 * A water drop, filled from the bottom by how dark the current shade is.
 * Ink/water density is a more immediate read of "how dark" than an abstract
 * gauge, and does not depend on already knowing the kanji for 濃い/薄い.
 */
function shadeIcon(level) {
  const drop =
    'M12 2.4C12 2.4 5 11.2 5 15.6a7 7 0 0 0 14 0C19 11.2 12 2.4 12 2.4Z';
  const top = 2.4;
  const bottom = 22.6; // 15.6 + 7 の半径ぶん下
  const fillH = (bottom - top) * SHADE_FILL[level];
  const fillY = (bottom - fillH).toFixed(2);
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    `<defs><clipPath id="shade-drop-clip"><path d="${drop}"/></clipPath></defs>` +
    `<path d="${drop}" fill="none" stroke="currentColor" stroke-width="1.7"/>` +
    '<g clip-path="url(#shade-drop-clip)">' +
    `<rect x="3" y="${fillY}" width="18" height="${fillH.toFixed(2)}" fill="currentColor"/>` +
    '</g>' +
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

class GsiShadeControl {
  onAdd() {
    const container = document.createElement('div');
    container.className =
      'maplibregl-ctrl maplibregl-ctrl-group gsi-shade-ctrl';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'gsi-shade-btn';
    const render = () => {
      btn.innerHTML = shadeIcon(gsiShade);
      const label = `地図の濃さ: ${GSI_SHADE_LABELS[gsiShade]}`;
      btn.title = label;
      btn.setAttribute('aria-label', label);
    };
    btn.addEventListener('click', () => {
      const i = GSI_SHADE_LEVELS.indexOf(gsiShade);
      applyGsiShade(GSI_SHADE_LEVELS[(i + 1) % GSI_SHADE_LEVELS.length]);
      render();
    });
    render();
    container.appendChild(btn);
    this._container = container;
    return container;
  }
  onRemove() {
    this._container.remove();
  }
}

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

class BasemapControl {
  onAdd() {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-ctrl';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'basemap-btn';
    const render = () => {
      btn.innerHTML = BASEMAP_ICONS[basemap];
      const label = `地図の種類: ${GSI_BASEMAPS[basemap].label}`;
      btn.title = label;
      btn.setAttribute('aria-label', label);
    };
    btn.addEventListener('click', () => {
      const i = GSI_BASEMAP_ORDER.indexOf(basemap);
      applyBasemap(GSI_BASEMAP_ORDER[(i + 1) % GSI_BASEMAP_ORDER.length]);
      render();
    });
    render();
    container.appendChild(btn);
    this._container = container;
    return container;
  }
  onRemove() {
    this._container.remove();
  }
}

/* ----------------------------------------------------------------- panel --- */
/**
 * Fold the sidebar away to give the map the whole window.
 *
 * The button is map chrome, not panel chrome: it has to stay on screen while
 * the panel is off it, or there would be no way back. Wired here rather than in
 * wireControls() so it answers before the data has arrived.
 *
 * `inert` is what actually takes the folded panel out of play — the CSS only
 * parks it past the left edge, and a checkbox sitting off screen is still
 * reachable by tab and still readable by a screen reader.
 */
(() => {
  const app = $('#app');
  const panel = $('#panel');
  const btn = $('#panel-toggle');

  const set = (open) => {
    app.classList.toggle('panel-off', !open);
    panel.inert = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.title = open ? 'サイドバーを隠す' : 'サイドバーを表示';
    try {
      localStorage.setItem('panel-open', open ? '1' : '0');
    } catch {
      /* private browsing: the choice simply does not outlive the tab */
    }
  };

  // The canvas follows a click on its own: MapLibre watches its container
  // with a ResizeObserver, and the panel changes width in one step (see
  // style.css on why it does not slide), so one observation is all it takes.
  btn.addEventListener('click', () => set(app.classList.contains('panel-off')));

  let open = true;
  try {
    open = localStorage.getItem('panel-open') !== '0';
  } catch {
    /* ditto */
  }
  set(open);
  // Applying the stored panel state above is a synchronous DOM mutation
  // that lands before the first paint, which the ResizeObserver comment
  // above does not cover — it only catches changes after the page has
  // settled. `map` (above) was still built against the panel-open layout,
  // so the canvas needs one explicit resize to pick up the collapsed one.
  map.resize();
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
  map.addControl(new HideRoutesControl(), 'top-right');
  map.addControl(new GsiShadeControl(), 'top-right');
  map.addControl(new BasemapControl(), 'top-right');

  wirePopups();
  wireControls();
  wireShare();

  map.getSource('termini').setData(terminiFeatures(state.meta));

  buildUI();
  syncControls();
  applyFilters();

  // A shared link's hash wins. Otherwise open on everything that is built, or
  // on one region if ?region= names it — a view hint, not a data switch.
  if (!location.hash) fitInitialView(index);

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
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: 24, duration: 0 },
  );
}

/* --------------------------------------------------------------- filters --- */
function applyFilters() {
  const base = buildFilter([...state.selected], state.conc);

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

/** Listeners that are wired once. */
function wireControls() {
  const list = $('#route-list');
  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    const ref = Number(cb.value);
    if (cb.checked) state.selected.add(ref);
    else state.selected.delete(ref);
    cb.closest('label').classList.toggle('on', cb.checked);
    applyFilters();
  });

  $('#sel-none').addEventListener('click', () => setSelection([]));

  $('#route-filter').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    for (const el of list.querySelectorAll('label')) {
      el.classList.toggle('hidden', q !== '' && !el.dataset.ref.startsWith(q));
    }
  });

  for (const el of document.querySelectorAll('input[name=conc]')) {
    el.addEventListener('change', () => {
      state.conc = document.querySelector('input[name=conc]:checked').value;
      applyFilters();
    });
  }

  const toggle = (id, key) =>
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.checked;
      // The shadow layer is not restricted by kind, so a toggle that takes the
      // picked arc off the map would otherwise leave its shadow lying on the
      // basemap with no road inside it.
      state.picked = null;
      applyFilters();
    });
  toggle('#t-labels', 'labels');
  toggle('#t-termini', 'termini');
  toggle('#t-expressway', 'expressway');
  toggle('#t-special', 'special');
  toggle('#t-ferry', 'ferry');
}

/* ------------------------------------------------------------------ share --- */
/**
 * The dialog only ever shows what is on screen right now — no controls of its
 * own to drift out of step with the map. `location.href` already carries the
 * filter/display state (syncURL keeps the query string current) and the map's
 * own hash, so it needs no assembly here.
 */
function wireShare() {
  const dialog = $('#share-dialog');

  $('#share-btn').addEventListener('click', () => {
    $('#share-url').value = location.href;
    $('#share-body').innerHTML = shareSummaryHTML(shareState());
    dialog.showModal();
    $('#share-url').select();
  });

  $('#share-copy').addEventListener('click', async () => {
    const input = $('#share-url');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      // Clipboard permission denied or unavailable (e.g. non-HTTPS origin):
      // the field is already selected, so the reader can still copy by hand.
      return;
    }
    const btn = $('#share-copy');
    const original = btn.innerHTML;
    btn.innerHTML = CHECK_ICON;
    btn.classList.add('copied');
    btn.setAttribute('aria-label', 'コピーしました');
    btn.disabled = true;
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('copied');
      btn.removeAttribute('aria-label');
      btn.disabled = false;
    }, 1500);
  });
}

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" ' +
  'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" ' +
  'stroke-linejoin="round"/></svg>';

/**
 * Read the display state straight off the controls rather than restating
 * their labels here — index.html is the one place those strings live, and a
 * second copy would be free to go stale when they change.
 */
function shareState() {
  const toggles = [...document.querySelectorAll('#panel .checks label')].map(
    (label) => ({
      label: label.textContent.trim(),
      checked: label.querySelector('input').checked,
    }),
  );
  const concLabel = document
    .querySelector('input[name=conc]:checked')
    .closest('label')
    .textContent.trim();
  return {
    selectedRefs: [...state.selected].sort((a, b) => a - b),
    totalRoutes: state.routes.length,
    concLabel,
    toggles,
  };
}

function setSelection(refs) {
  state.selected = new Set(refs);
  for (const cb of document.querySelectorAll('#route-list input')) {
    cb.checked = state.selected.has(Number(cb.value));
    cb.closest('label').classList.toggle('on', cb.checked);
  }
  applyFilters();
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

// A sign inside a popup narrows the map to that one route. Delegated because
// popups come and go: the element the click lands on did not exist when this
// was wired, and will not exist by the time the next popup opens.
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.shield-btn');
  if (btn) setSelection([Number(btn.dataset.ref)]);
});

boot().catch((err) => {
  console.error(err);
  $('#loading').textContent = `データの読み込みに失敗しました: ${err.message}`;
});
