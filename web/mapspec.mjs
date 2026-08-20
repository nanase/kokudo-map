/* Style and filter definitions, kept free of any browser dependency so that
 * build/check_expressions.mjs validates the *same* objects the viewer uses.
 * An earlier version duplicated them, and the duplicate quietly passed while
 * the real layers were rejected by MapLibre.
 */

export const N_COLORS = ['#1B62C4', '#D98324', '#C2352B', '#7B3E9D']; // n = 1,2,3,4+
export const N_LABELS = ['単独指定', '二重用', '三重用', '四重用以上'];
export const FONT = ['NotoSansJP-Regular'];

export const KIND_FOOT = ['foot', 'steps'];
export const KIND_CONSTRUCTION = ['construction'];
export const KIND_UNOPENED = ['unopened'];
export const KIND_FERRY = ['ferry'];
export const KIND_EXPRESSWAY = ['expressway'];

// Kinds that are not driveable carriageway. Each gets its own dashed layer and
// is taken out of the solid road layers, so none of them can be mistaken for a
// road you could drive down.
export const SPECIAL_KINDS = [
  ...KIND_CONSTRUCTION,
  ...KIND_UNOPENED,
  ...KIND_FOOT,
  ...KIND_FERRY,
];

// `expressway` (highway=motorway: 第二神明道路, 神戸淡路鳴門自動車道, …) is real,
// driveable carriageway — it does not belong with the dashed kinds above — but
// it is its own layer rather than folding into `roads`, because it is a
// different kind of road (grade-separated, no at-grade access, its own route
// number) that a reader may want to switch off independently of construction
// or 点線国道.
export const EXCLUDE_FROM_ROADS_LAYER = [...SPECIAL_KINDS, ...KIND_EXPRESSWAY];

export const COLOR_CONSTRUCTION = '#8A6A2F';
export const COLOR_UNOPENED = '#7B4B94';
export const COLOR_FOOT = '#4B5A6C';
export const COLOR_FERRY = '#0E7490';

export const GSI_TILES =
  'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';

/* How dark the base map sits under the routes. Plain `raster-opacity` on the
 * `gsi` layer — there is no separate dimming layer, just this one paint
 * property. The site shipped for a while at a flat 0.82 with no control over
 * it; that is kept as `light` so existing impressions of the map do not
 * shift under anyone. */
export const GSI_SHADE_LEVELS = ['light', 'normal', 'dark'];
export const GSI_SHADE_OPACITY = { light: 0.82, normal: 0.91, dark: 1 };
export const GSI_SHADE_LABELS = { light: '薄い', normal: '通常', dark: '濃い' };
export const DEFAULT_SHADE = 'light';

/* Served from this site. The labels are route numbers joined with `・`, so the
 * whole alphabet is ten digits and one separator — eleven glyphs in two range
 * files, about 5 kB. scripts/make_glyphs.mjs bakes them from Noto Sans JP.
 *
 * It used to be 国土地理院's demo endpoint: someone else's Pages site, offered
 * as a demonstration, whose disappearance would take every label with it. */
const GLYPHS = 'glyphs/{fontstack}/{range}.pbf';

/* The arcs arrive as vector tiles. Nationwide they are ~130,000 features, so
 * the viewer cannot hold them: it draws what is on screen and reads every total
 * it displays out of national.meta.json instead. */
export const PMTILES_URL = 'data/national-routes.pmtiles';
export const SOURCE_LAYER = 'routes';

/** The sources the route layers expect. The checker builds its style from this
 *  same function, so a layer can never be validated against a source shape the
 *  viewer does not actually create. */
export function routeSources(url) {
  return {
    // No `maxzoom` here on purpose. The archive states its own, and the
    // protocol hands MapLibre a TileJSON that carries it. Repeating the number
    // here once made the style ask for a zoom the archive did not contain, and
    // everything below it silently stopped drawing.
    routes: { type: 'vector', url: `pmtiles://${url}` },
    // Termini are a few thousand points and every one of them is in the panel
    // already, so they stay plain GeoJSON.
    termini: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    },
  };
}

/* ------------------------------------------------------------- filtering --- */

/** Membership test that cannot be fooled by substrings: ",4," never hits ",14,". */
export const hasRef = (ref) => ['in', `,${ref},`, ['get', 'refs']];

/**
 * The filter every road layer shares.
 * `selected` narrows which routes are drawn; `conc` narrows to concurrency.
 *
 * Concurrency is a property of the road, not of the selection: an arc carrying
 * 18 and 117 is a 重用区間 whether or not both numbers happen to be ticked.
 */
export function buildFilter(selected, conc) {
  const parts = [];
  if (selected.length) parts.push(['any', ...selected.map(hasRef)]);
  if (conc === 'all') parts.push(['>=', ['get', 'n'], 2]);

  return parts.length ? ['all', ...parts] : true;
}

export const kindTest = (kinds) => ['in', ['get', 'kind'], ['literal', kinds]];

/** Combine the shared filter with a kind restriction. */
export function withKind(base, kinds, negate) {
  const k = negate ? ['!', kindTest(kinds)] : kindTest(kinds);
  return base === true ? k : ['all', base, k];
}

/** A filter that matches nothing, for hiding a layer without removing it. */
export const NOTHING = ['==', ['get', 'n'], -1];

/**
 * The shadow under the arc a popup is describing.
 *
 * The OSM way id identifies an arc on its own — the build keys its deduplication
 * on it — so no other test is needed to pick out one road. The shared filter is
 * still folded in: an arc the selection has taken off the map must not keep a
 * shadow where it used to be.
 */
export function pickedFilter(base, id) {
  if (id == null) return NOTHING;
  const test = ['==', ['get', 'id'], id];
  return base === true ? test : ['all', base, test];
}

/* ------------------------------------------------------------------ paint --- */

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

// Concurrency reads as weight as well as hue, so depth survives zooming out
// far enough that colour alone is hard to judge.
const N_MULT = ['match', ['get', 'n'], 1, 1, 2, 1.5, 3, 2, 2.4];
const ZOOM_STOPS = [
  [6, 0.9],
  [9, 1.8],
  [12, 3.2],
  [15, 6],
];

/**
 * Zoom-interpolated line width.
 *
 * A `zoom` expression is only legal as the direct input of a top-level
 * `interpolate`/`step`, so the per-route arithmetic has to live in the
 * interpolation *outputs* rather than wrapping the interpolation.
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

export function baseStyle(shade = DEFAULT_SHADE) {
  return {
    version: 8,
    // Glyphs are required for any symbol layer.
    glyphs: GLYPHS,
    sources: {
      gsi: {
        type: 'raster',
        tiles: [GSI_TILES],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
      },
    },
    layers: [
      {
        id: 'gsi',
        type: 'raster',
        source: 'gsi',
        paint: { 'raster-opacity': GSI_SHADE_OPACITY[shade] },
      },
    ],
  };
}

/**
 * The route layers, in draw order.
 * `line-dasharray` accepts no data-driven expression, so the dashed kinds get
 * one layer each rather than a `match` inside a single layer.
 */
export function routeLayers() {
  return [
    {
      // The one arc a popup is describing, lifted off the basemap by a shadow.
      // A map line takes no CSS drop-shadow, so the shadow is a line of its
      // own: wider than the road, blurred, black, drawn underneath everything
      // else so the road keeps its own colour on top. It draws nothing until
      // an arc is clicked; app.js narrows it to that arc's OSM way id.
      //
      // It has to clear the white casing, which is already 2.6 px wider than
      // the road: at +9 px and a 5 px blur the ring that was left outside the
      // casing was too thin and too diffuse to see at all. Widening it and
      // tightening the blur is what made it read.
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
      // A white casing keeps the lines legible over the raster basemap.
      id: 'casing',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#FFFFFF',
        'line-opacity': 0.85,
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
        // Concurrency draws over single designations. Without a sort key the
        // order is whatever the tile happens to hold, so a four-fold section
        // could be buried under a lone number — and clicked as one, which is
        // how a stack of four reported 国道202号 alone in 福岡. `line-sort-key`
        // sorts ascending and draws the highest last, so `n` puts the deepest
        // stack on top. One layer per depth would say the same thing four times.
        'line-sort-key': ['get', 'n'],
      },
      paint: {
        'line-color': colorByN,
        'line-width': lineWidth(),
      },
    },
    {
      // 高速道路として指定された国道 (highway=motorway): real carriageway, styled
      // exactly like `roads` — concurrency is still the point — but its own
      // layer so it can be switched off on its own, the same way 点線国道 or
      // 工事中 can.
      id: 'expressway-casing',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#FFFFFF',
        'line-opacity': 0.85,
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
        'line-width': lineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [2, 2],
      },
    },
    {
      // 未開通区間: `highway=planned`/`proposed`, a line drawn to keep the
      // route relation continuous where no road has been built. The finest
      // dash of the four, since less exists here than at any other kind —
      // even a foot path is a real thing to walk on.
      id: 'unopened',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': COLOR_UNOPENED,
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
        'line-width': lineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [1, 2],
      },
    },
    {
      // 海上国道: the designation continues across water with no road under
      // it. The longest dash of the three dashed kinds, because it is the one
      // that runs for kilometres at a stretch.
      id: 'ferry',
      type: 'line',
      source: 'routes',
      'source-layer': SOURCE_LAYER,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': COLOR_FERRY,
        'line-width': lineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [4, 2.5],
      },
    },
    {
      // The point of the whole project: numbers stay on screen regardless of
      // scale, and every designation is listed, not just the lowest.
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
        // Labels are placed in sort-key order and a label that collides with an
        // already-placed one is dropped. Negating `n` places the deepest stack
        // first, so the label a conventional map rounds down is the last one to
        // be given up rather than the first.
        'symbol-sort-key': ['-', 0, ['get', 'n']],
        'text-rotation-alignment': 'viewport',
        'text-pitch-alignment': 'viewport',
      },
      paint: {
        'text-color': colorByN,
        'text-halo-color': '#FFFFFF',
        'text-halo-width': 2,
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

/** Which layers the shared filter is applied to, and how. */
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
