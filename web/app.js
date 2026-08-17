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
 */
import {
  baseStyle,
  buildFilter,
  CLICKABLE_LAYERS,
  COLOR_CONSTRUCTION,
  COLOR_FERRY,
  COLOR_FOOT,
  FILTERED_LAYERS,
  hasRef,
  N_COLORS,
  N_LABELS,
  NOTHING,
  PMTILES_URL,
  routeLayers,
  routeSources,
  withKind,
} from './mapspec.mjs';

const state = {
  meta: null,
  routes: [],
  selected: new Set(),
  conc: 'off',
  labels: true,
  termini: true,
  special: true,
  ferry: true,
};

const $ = (sel) => document.querySelector(sel);

/* ---------------------------------------------------------------- shields --- */
/**
 * An inverted-triangle route marker ("おにぎり") with the number inside.
 *
 * Coloured like the real 国道番号標識 — a white number on the sign blue, inside
 * the white border the sign carries — rather than as blue text on the panel
 * colour, which left it competing with whatever the map showed behind a popup.
 *
 * The number is SVG text with `textLength` rather than an HTML span, because a
 * three-digit number is wider than the triangle at the height it sits: it used
 * to spill onto the panel behind, and white on white would be nothing at all.
 */
function shield(ref, small) {
  const digits = String(ref).length;
  const width = digits >= 3 ? 23 : digits === 2 ? 16 : 8;
  return (
    `<span class="shield${small ? ' sm' : ''}">` +
    `<svg viewBox="0 0 48 42" role="img" aria-label="国道${ref}号">` +
    '<path d="M3 4 H45 L24 39 Z" stroke-width="3" stroke-linejoin="round"/>' +
    `<text x="24" y="16.5" text-anchor="middle" textLength="${width}" ` +
    `lengthAdjust="spacingAndGlyphs">${ref}</text>` +
    '</svg></span>'
  );
}

const shieldRow = (refs, small) => refs.map((r) => shield(r, small)).join('');

/* ------------------------------------------------------------------- map --- */
// PMTiles is one archive read by byte range, so a static host serves the whole
// country without a tile server. Any host will do — but it must answer Range
// requests, which is why the development server is scripts/serve.py and not
// `python -m http.server`.
maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);

const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false,
  hash: true,
  style: baseStyle(),
  center: [138.0, 36.2],
  zoom: 7.6,
});

// exposed for debugging and for scripts/render_check.mjs
window.map = map;

map.addControl(
  new maplibregl.NavigationControl({ visualizePitch: false }),
  'top-right',
);
map.addControl(
  new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }),
  'bottom-right',
);
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

/* ------------------------------------------------------------ aggregates --- */
/**
 * The build ships one table: every distinct *combination* of designations, with
 * its length, arc count and extent. Everything the panel shows is a sum over a
 * subset of its rows.
 *
 * A per-route table would not do. Concurrency means an arc belongs to several
 * routes at once, so adding two route rows counts the shared arcs twice —
 * which is exactly the number the map exists to stop hiding.
 */
function routesOf(combos) {
  const by = new Map();
  for (const c of combos) {
    for (const ref of c.refs) {
      let e = by.get(ref);
      if (!e) {
        e = { ref, km: 0, arcs: 0, max_n: 1 };
        by.set(ref, e);
      }
      e.km += c.km;
      e.arcs += c.arcs;
      e.max_n = Math.max(e.max_n, c.n);
    }
  }
  const out = [...by.values()].sort((a, b) => a.ref - b.ref);
  for (const e of out) e.km = Math.round(e.km * 10) / 10;
  return out;
}

/** Totals over the combinations a selection touches. An empty selection means
 *  everything, which is what the map is already showing. */
function statsFor(selected) {
  let arcs = 0;
  let km = 0;
  let conc = 0;
  for (const c of state.meta.combinations) {
    if (selected.size && !c.refs.some((r) => selected.has(r))) continue;
    arcs += c.arcs;
    km += c.km;
    if (c.n >= 2) conc += c.arcs;
  }
  return { arcs, km, conc };
}

/* ----------------------------------------------------------------- boot --- */
async function boot() {
  const [index, meta] = await Promise.all([
    fetch('data/regions.json').then((r) => r.json()),
    fetch('data/national.meta.json').then((r) => r.json()),
  ]);
  if (!index.length) throw new Error('data/regions.json is empty');
  state.meta = meta;
  state.routes = routesOf(meta.combinations);

  await new Promise((res) => (map.loaded() ? res() : map.once('load', res)));

  // The archive is addressed absolutely: the protocol handler resolves the URL
  // itself and has no page to be relative to.
  const sources = routeSources(new URL(PMTILES_URL, location.href).href);
  for (const [id, src] of Object.entries(sources)) map.addSource(id, src);
  for (const layer of routeLayers()) map.addLayer(layer);

  wirePopups();
  wireControls();

  map.getSource('termini').setData(terminiFeatures(state.meta));

  buildUI();
  applyFilters();

  // A shared link's hash wins. Otherwise open on everything that is built, or
  // on one region if ?region= names it — a view hint, not a data switch.
  if (!location.hash) fitInitialView(index);

  $('#loading').classList.add('done');
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

function terminiFeatures(meta) {
  return {
    type: 'FeatureCollection',
    features: [
      ...meta.shared_termini.map((t) => ({
        type: 'Feature',
        properties: {
          refs: ',' + t.refs.join(',') + ',',
          label: t.refs.join('・'),
          shared: 1,
          count: t.refs.length,
        },
        geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      })),
      ...meta.termini.map((t) => ({
        type: 'Feature',
        properties: {
          refs: `,${t.ref},`,
          label: String(t.ref),
          shared: 0,
          count: 1,
        },
        geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      })),
    ],
  };
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

  const sel = [...state.selected];
  let tFilter = true;
  if (!state.termini) tFilter = ['==', ['get', 'count'], -1];
  else if (sel.length) tFilter = ['any', ...sel.map(hasRef)];
  map.setFilter('termini-dot', tFilter);
  map.setFilter('termini-label', tFilter);

  updateStats();
  renderRanking();
}

/* -------------------------------------------------------------------- ui --- */
function buildUI() {
  const list = $('#route-list');
  list.innerHTML = state.routes
    .map(
      (r) =>
        `<label data-ref="${r.ref}" title="${r.km} km / 最大 ${r.max_n} 重用">` +
        `<input type="checkbox" value="${r.ref}">` +
        `<span>${r.ref}</span>` +
        (r.max_n > 1 ? `<span class="mn">×${r.max_n}</span>` : '') +
        '</label>',
    )
    .join('');

  $('#route-filter').value = '';
  renderShared();
  renderFreshness();
}

/** Listeners and legends that are wired once. */
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
      applyFilters();
    });
  toggle('#t-labels', 'labels');
  toggle('#t-termini', 'termini');
  toggle('#t-special', 'special');
  toggle('#t-ferry', 'ferry');

  $('#legend-n').innerHTML = N_COLORS.map(
    (c, i) =>
      `<span class="item"><span class="swatch" style="border-top-color:${c}"></span>${N_LABELS[i]}</span>`,
  ).join('');

  $('#legend-kind').innerHTML = [
    [COLOR_FOOT, '点線国道（徒歩道・階段）'],
    [COLOR_CONSTRUCTION, '工事中・事業中'],
    [COLOR_FERRY, '海上国道（航路）'],
  ]
    .map(
      ([c, t]) =>
        `<span class="item"><span class="swatch" style="border-top-color:${c};` +
        `border-top-style:dashed"></span>${t}</span>`,
    )
    .join('');
}

/**
 * State plainly which day of OpenStreetMap this map shows.
 * Two different dates matter and are easy to confuse:
 *   osm_timestamp — the moment the OSM database was read (how current we are);
 *   the per-way edit dates — when each road was last touched by a mapper,
 *   which is what actually determines whether a new bypass is here yet.
 */
function renderFreshness() {
  const m = state.meta;
  const base = new Date(m.osm_timestamp);
  const ageDays = Math.floor((Date.now() - base.getTime()) / 86400000);
  const fmt = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:` +
    `${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

  const ageText =
    ageDays <= 0 ? '当日' : ageDays === 1 ? '1 日前' : `${ageDays} 日前`;
  const stale = ageDays > 7;

  $('#freshness').innerHTML =
    '<dt>データ基準</dt>' +
    `<dd class="${stale ? 'warn' : ''}">${fmt(base)}（${ageText}）</dd>` +
    '<dt>区間の更新</dt>' +
    `<dd>${m.oldest_edit} 〜 ${m.newest_edit}</dd>` +
    '<dt>取得元</dt>' +
    `<dd>${m.endpoints.join(' / ')}</dd>` +
    (stale
      ? '<dt></dt><dd class="warn">最近の開通は反映されていない可能性があります</dd>'
      : '');
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
  const { arcs, km, conc } = statsFor(sel);
  $('#stats').innerHTML =
    `<span>選択路線　${sel.size || state.routes.length} / ${state.routes.length}</span>` +
    `<span>対象アーク　${arcs.toLocaleString()}</span>` +
    `<span>延長　${km.toLocaleString(undefined, { maximumFractionDigits: 0 })} km</span>` +
    `<span>重用アーク　${conc.toLocaleString()}</span>`;
  // Nothing to say when nothing is picked: the map is already showing
  // everything, and the count above states it.
  $('#sel-hint').textContent = sel.size ? `${sel.size} 路線を選択中。` : '';
}

/** The ranking is folded away by default, so its size has to show on the tab. */
function renderRanking() {
  const sel = state.selected;
  const matching = state.meta.combinations.filter(
    (e) => e.n >= 2 && (!sel.size || e.refs.some((r) => sel.has(r))),
  );
  const rows = matching.slice(0, 25);
  $('#ranking-count').textContent = matching.length
    ? `${rows.length} / ${matching.length} 組`
    : '';

  const el = $('#ranking');
  if (!rows.length) {
    el.innerHTML = '<p class="empty">該当する重用区間はありません。</p>';
    return;
  }
  el.innerHTML = rows
    .map(
      (e) =>
        `<button type="button" class="row" data-refs="${e.refs.join(',')}">` +
        `<span class="shields">${shieldRow(e.refs, true)}</span>` +
        `<span class="km">${e.km.toFixed(1)} km</span>` +
        (e.names.length
          ? `<span class="nm">${e.names.join(' / ')}</span>`
          : '') +
        '</button>',
    )
    .join('');
}

/** Folded away like the ranking, so the summary has to carry its size. */
function renderShared() {
  const all = state.meta.shared_termini;
  const rows = all.slice(0, 20);
  $('#shared-count').textContent = all.length
    ? `${rows.length} / ${all.length} 地点`
    : '';

  const el = $('#shared');
  if (!rows.length) {
    el.innerHTML = '<p class="empty">該当地点はありません。</p>';
    return;
  }
  el.innerHTML = rows
    .map(
      (t) =>
        `<button type="button" class="row" data-refs="${t.refs.join(',')}" ` +
        `data-at="${t.lon},${t.lat}">` +
        `<span class="shields">${shieldRow(t.refs, true)}</span>` +
        `<span class="km">${t.refs.length} 路線</span>` +
        '</button>',
    )
    .join('');
}

// Clicking a ranking / shared-terminus row narrows the map to those routes.
document.addEventListener('click', (e) => {
  const row = e.target.closest('.ranking .row');
  if (!row) return;
  const refs = row.dataset.refs.split(',').map(Number);
  setSelection(refs);
  if (row.dataset.at) {
    const [lon, lat] = row.dataset.at.split(',').map(Number);
    map.flyTo({ center: [lon, lat], zoom: 12 });
  } else {
    zoomToRefs(refs);
  }
});

/**
 * Frame where the given routes actually run together.
 * The geometry is in tiles and mostly off screen, so the extent comes from the
 * combination table, which carries the bounding box of each combination.
 */
function zoomToRefs(refs) {
  const set = new Set(refs);
  const b = new maplibregl.LngLatBounds();
  let hit = false;
  for (const c of state.meta.combinations) {
    if (c.n < 2) continue;
    if (c.refs.filter((r) => set.has(r)).length < 2) continue;
    b.extend([
      [c.bbox[0], c.bbox[1]],
      [c.bbox[2], c.bbox[3]],
    ]);
    hit = true;
  }
  if (hit) map.fitBounds(b, { padding: 60, maxZoom: 13 });
}

/* ---------------------------------------------------------------- popups --- */
function wirePopups() {
  for (const id of CLICKABLE_LAYERS) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', (ev) => {
    const hits = map.queryRenderedFeatures(ev.point, {
      layers: CLICKABLE_LAYERS,
    });
    if (!hits.length) return;
    // A junction, a parallel alignment or a grade separation puts several arcs
    // under one pixel, and they come back in the tile's order, which is
    // arbitrary — a click on the four-fold stack in 福岡 reported 国道202号 alone.
    // The deepest arc under the cursor is the one drawn on top (line-sort-key)
    // and the one the map exists to keep, so that is the one described.
    const p = hits.reduce((a, b) =>
      b.properties.n > a.properties.n ? b : a,
    ).properties;
    // A vector tile has no array type, so the designations travel as the same
    // delimiter-wrapped key the filters test, and are split back out here.
    const refs = p.refs.split(',').filter(Boolean).map(Number);
    const kindText =
      {
        road: '車道',
        construction: '工事中・事業中',
        foot: '点線国道（徒歩道）',
        steps: '点線国道（階段）',
        ferry: '海上国道（航路）',
      }[p.kind] || p.kind;

    // Where the designation came from is worth showing: "refタグ" means no OSM
    // route relation lists this road, so the number is inferred from its tags.
    const srcText =
      {
        relation: 'ルートリレーション',
        name: '名称（国道N号）',
        tag: 'ref タグ（リレーション未登録）',
      }[p.src] || p.src;

    new maplibregl.Popup({ closeButton: true, maxWidth: '300px' })
      .setLngLat(ev.lngLat)
      .setHTML(
        `<div class="pop-hd">${shieldRow(refs)}` +
          `<span class="pop-n">${refs.length > 1 ? `${refs.length} 重用` : '単独指定'}</span></div>` +
          '<dl style="margin:0;display:grid;gap:3px">' +
          `<div class="pop-row"><dt>名称</dt><dd>${p.name || '—'}</dd></div>` +
          `<div class="pop-row"><dt>区分</dt><dd>${kindText}</dd></div>` +
          `<div class="pop-row"><dt>延長</dt><dd>${Number(p.km).toFixed(2)} km</dd></div>` +
          `<div class="pop-row"><dt>最終更新</dt><dd>${p.updated || '—'}</dd></div>` +
          `<div class="pop-row"><dt>根拠</dt><dd>${srcText}</dd></div>` +
          (Number(p.former)
            ? '<div class="pop-row"><dt>備考</dt><dd>旧道（指定解除前）</dd></div>'
            : '') +
          `<div class="pop-row"><dt>OSM</dt><dd><a href="https://www.openstreetmap.org/way/${p.id}" ` +
          `target="_blank" rel="noopener">way/${p.id}</a></dd></div>` +
          '</dl>',
      )
      .addTo(map);
  });
}

boot().catch((err) => {
  console.error(err);
  $('#loading').textContent = 'データの読み込みに失敗しました: ' + err.message;
});
