/* 国道マップ
 *
 * The design premise from the feasibility study: every arc already carries the
 * complete set of route designations over it, wrapped in delimiters as
 * `refs = ",18,117,406,"`. So "show only route N" and "show only concurrent
 * sections" are both plain attribute filters, evaluated in the style — no
 * recomputation, no server.
 *
 * The build runs per region because Overpass is queried by bounding box. The
 * viewer is not: it loads every region that has been built and joins them into
 * one dataset, so there is no prefecture to pick. Widening the coverage is
 * therefore a data change (add a region, build it) and never a UI change.
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
  routeLayers,
  withKind,
} from './mapspec.mjs';

const EMPTY = { type: 'FeatureCollection', features: [] };

const state = {
  meta: null,
  geo: null,
  selected: new Set(),
  conc: 'off',
  labels: true,
  termini: true,
  special: true,
  ferry: true,
};

const $ = (sel) => document.querySelector(sel);

/* ---------------------------------------------------------------- shields --- */
/** An inverted-triangle route marker ("おにぎり") with the number inside. */
function shield(ref, small) {
  return (
    `<span class="shield${small ? ' sm' : ''}">` +
    '<svg viewBox="0 0 44 40" aria-hidden="true">' +
    '<path d="M4 5 H40 L22 35 Z" stroke="#00449E" stroke-width="4" ' +
    'stroke-linejoin="round" style="fill:var(--panel)"/>' +
    '</svg>' +
    `<span>${ref}</span></span>`
  );
}

const shieldRow = (refs, small) => refs.map((r) => shield(r, small)).join('');

/* ------------------------------------------------------------------- map --- */
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
map.addControl(
  new maplibregl.AttributionControl({
    compact: false,
    customAttribution: '道路データ © OpenStreetMap contributors (ODbL 1.0)',
  }),
  'bottom-right',
);

/* ----------------------------------------------------------------- merge --- */
/**
 * Join every built region into one set of arcs.
 *
 * The bounding boxes are rectangles, so neighbouring boxes overlap at the
 * seams and hand back the same road twice. The OSM way id is the identity and
 * deduplicates them exactly — no geometry comparison is needed.
 */
function mergeArcs(parts) {
  const byId = new Map();
  for (const { geo } of parts) {
    for (const f of geo.features) {
      if (byId.has(f.properties.id)) continue;
      // Label text is derived once here rather than stored per feature on disk.
      f.properties.label = f.properties.refs_list.join('・');
      byId.set(f.properties.id, f);
    }
  }
  return { type: 'FeatureCollection', features: [...byId.values()] };
}

/**
 * Per-route totals over the merged arcs.
 *
 * These are recomputed rather than summed from the per-region masters: an arc
 * returned by two overlapping boxes is counted once here and twice there.
 */
function routesOf(features) {
  const by = new Map();
  for (const f of features) {
    const p = f.properties;
    for (const ref of p.refs_list) {
      let e = by.get(ref);
      if (!e) {
        e = { ref, km: 0, arcs: 0, max_n: 1 };
        by.set(ref, e);
      }
      e.km += p.km;
      e.arcs++;
      e.max_n = Math.max(e.max_n, p.n);
    }
  }
  const out = [...by.values()].sort((a, b) => a.ref - b.ref);
  for (const e of out) e.km = Math.round(e.km * 10) / 10;
  return out;
}

/** Concurrency combinations over the merged arcs: deepest first, then longest. */
function rankingOf(features) {
  const by = new Map();
  for (const f of features) {
    const p = f.properties;
    if (p.n < 2) continue;
    // `refs` is already sorted and delimiter-wrapped, so it is the combination.
    let e = by.get(p.refs);
    if (!e) {
      e = { refs: p.refs_list, n: p.n, km: 0, arcs: 0, names: new Map() };
      by.set(p.refs, e);
    }
    e.km += p.km;
    e.arcs++;
    if (p.name) e.names.set(p.name, (e.names.get(p.name) || 0) + 1);
  }
  const out = [...by.values()].sort((a, b) => b.n - a.n || b.km - a.km);
  for (const e of out) {
    e.names = [...e.names.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n]) => n);
  }
  return out;
}

/**
 * Termini merged across regions.
 * A terminus inside an overlap is reported by both regions, so points are
 * keyed by rounded position; shared points union their route numbers.
 */
function mergeTermini(parts) {
  const at = (t) => `${t.lat.toFixed(5)},${t.lon.toFixed(5)}`;
  const single = new Map();
  const shared = new Map();
  for (const { meta } of parts) {
    for (const t of meta.termini) single.set(`${at(t)}/${t.ref}`, t);
    for (const t of meta.shared_termini) {
      const cur = shared.get(at(t));
      if (cur) {
        cur.refs = [...new Set([...cur.refs, ...t.refs])].sort((a, b) => a - b);
      } else {
        shared.set(at(t), { lat: t.lat, lon: t.lon, refs: [...t.refs] });
      }
    }
  }
  return {
    termini: [...single.values()],
    shared_termini: [...shared.values()].sort(
      (a, b) => b.refs.length - a.refs.length,
    ),
  };
}

/**
 * One metadata record for the whole map.
 * Freshness is reported at its worst: the map is only as current as its
 * stalest region, and saying otherwise would overstate it.
 */
function mergeMeta(parts, features) {
  const metas = parts.map((p) => p.meta);
  const min = (vals) => vals.filter(Boolean).sort()[0] || null;
  const max = (vals) => vals.filter(Boolean).sort().slice(-1)[0] || null;
  return {
    osm_timestamp: min(metas.map((m) => m.osm_timestamp)),
    oldest_edit: min(metas.map((m) => m.oldest_edit)),
    newest_edit: max(metas.map((m) => m.newest_edit)),
    endpoints: [...new Set(metas.map((m) => new URL(m.endpoint).host))],
    total_km: features.reduce((s, f) => s + f.properties.km, 0),
    arc_count: features.length,
    routes: routesOf(features),
    concurrency_ranking: rankingOf(features),
    ...mergeTermini(parts),
  };
}

/* ----------------------------------------------------------------- boot --- */
async function boot() {
  const index = await fetch('data/regions.json').then((r) => r.json());
  if (!index.length) throw new Error('data/regions.json is empty');

  const parts = await Promise.all(
    index.map(async (r) => ({
      meta: await fetch(`data/${r.region}.meta.json`).then((x) => x.json()),
      geo: await fetch(`data/${r.region}.geojson`).then((x) => x.json()),
    })),
  );

  state.geo = mergeArcs(parts);
  state.meta = mergeMeta(parts, state.geo.features);

  await new Promise((res) => (map.loaded() ? res() : map.once('load', res)));

  map.addSource('routes', { type: 'geojson', data: EMPTY });
  map.addSource('termini', { type: 'geojson', data: EMPTY });
  for (const layer of routeLayers()) map.addLayer(layer);

  wirePopups();
  wireControls();

  map.getSource('routes').setData(state.geo);
  map.getSource('termini').setData(terminiFeatures(state.meta));

  buildUI();
  applyFilters();

  // A shared link's hash wins. Otherwise open on everything that is built, or
  // on one region if ?region= names it — a view hint, not a data switch.
  if (!location.hash) fitInitialView(index);

  $('#loading').classList.add('done');
}

/** Open on the union of the built regions, or on the one named by ?region=. */
function fitInitialView(index) {
  const wanted = new URLSearchParams(location.search).get('region');
  const boxes = index.filter((r) => r.region === wanted);
  const use = boxes.length ? boxes : index;
  const [w, s, e, n] = use.reduce(
    ([w, s, e, n], r) => [
      Math.min(w, r.bbox[0]),
      Math.min(s, r.bbox[1]),
      Math.max(e, r.bbox[2]),
      Math.max(n, r.bbox[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
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
  list.innerHTML = state.meta.routes
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

  $('#sel-all').addEventListener('click', () =>
    setSelection(state.meta.routes.map((r) => r.ref)),
  );
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
  let arcs = 0;
  let km = 0;
  let conc = 0;
  for (const f of state.geo.features) {
    const p = f.properties;
    if (sel.size && !p.refs_list.some((r) => sel.has(r))) continue;
    arcs++;
    km += p.km;
    if (p.n >= 2) conc++;
  }
  $('#stats').innerHTML =
    `<span>選択路線　${sel.size || state.meta.routes.length} / ${state.meta.routes.length}</span>` +
    `<span>対象アーク　${arcs.toLocaleString()}</span>` +
    `<span>延長　${km.toFixed(0)} km</span>` +
    `<span>重用アーク　${conc.toLocaleString()}</span>`;
  $('#sel-hint').textContent = sel.size
    ? `${sel.size} 路線を選択中。`
    : '未選択のときは全路線を表示します。';
}

/** The ranking is folded away by default, so its size has to show on the tab. */
function renderRanking() {
  const sel = state.selected;
  const matching = state.meta.concurrency_ranking.filter(
    (e) => !sel.size || e.refs.some((r) => sel.has(r)),
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

function zoomToRefs(refs) {
  const set = new Set(refs);
  const b = new maplibregl.LngLatBounds();
  let hit = false;
  for (const f of state.geo.features) {
    if (f.properties.n < 2) continue;
    if (f.properties.refs_list.filter((r) => set.has(r)).length < 2) continue;
    for (const c of f.geometry.coordinates) b.extend(c);
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
    const p = hits[0].properties;
    // GeoJSON sources keep arrays, but a round-trip through the tile
    // serialiser can hand them back as JSON strings.
    const refs =
      typeof p.refs_list === 'string' ? JSON.parse(p.refs_list) : p.refs_list;
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
