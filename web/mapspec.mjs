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
export const KIND_FERRY = ['ferry'];

// Kinds that are not driveable carriageway. Each gets its own dashed layer and
// is taken out of the solid road layers, so none of them can be mistaken for a
// road you could drive down.
export const SPECIAL_KINDS = [
  ...KIND_CONSTRUCTION,
  ...KIND_FOOT,
  ...KIND_FERRY,
];

export const COLOR_CONSTRUCTION = '#8A6A2F';
export const COLOR_FOOT = '#4B5A6C';
export const COLOR_FERRY = '#0E7490';

export const GSI_TILES =
  'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const GSI_GLYPHS =
  'https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf';

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

export function baseStyle() {
  return {
    version: 8,
    // Glyphs are required for any symbol layer. This is the GSI demo endpoint
    // (CJK-capable); self-host the PBFs before treating the map as production.
    glyphs: GSI_GLYPHS,
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
        paint: { 'raster-opacity': 0.82 },
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
      // A white casing keeps the lines legible over the raster basemap.
      id: 'casing',
      type: 'line',
      source: 'routes',
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
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colorByN,
        'line-width': lineWidth(),
      },
    },
    {
      id: 'construction',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': COLOR_CONSTRUCTION,
        'line-width': lineWidth({ add: 0.6, scaleByN: false }),
        'line-dasharray': [2, 2],
      },
    },
    {
      id: 'foot',
      type: 'line',
      source: 'routes',
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
      minzoom: 8,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'label'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 13],
        'symbol-spacing': 220,
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
  { id: 'casing', kinds: SPECIAL_KINDS, negate: true },
  { id: 'roads', kinds: SPECIAL_KINDS, negate: true },
  {
    id: 'construction',
    kinds: KIND_CONSTRUCTION,
    negate: false,
    toggle: 'special',
  },
  { id: 'foot', kinds: KIND_FOOT, negate: false, toggle: 'special' },
  { id: 'ferry', kinds: KIND_FERRY, negate: false, toggle: 'ferry' },
  { id: 'route-labels', kinds: null, negate: false, toggle: 'labels' },
];

export const CLICKABLE_LAYERS = ['roads', 'construction', 'foot', 'ferry'];
