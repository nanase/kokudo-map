/* Turn the per-region builds into the two files the viewer actually fetches.
 *
 * Nationwide the arcs come to tens of megabytes of GeoJSON, which is neither
 * shippable as one file nor loadable as 47. So the viewer stops holding the
 * features at all:
 *
 *   national-routes.pmtiles  vector tiles — only what is on screen is in memory
 *   national.meta.json       every total the panel shows, computed here instead
 *
 * The second file is what makes the first possible. app.js used to derive the
 * route list, the concurrency ranking and the selection totals by walking every
 * feature. With tiles it never has the full set, so those totals are computed
 * once here, over the deduplicated arcs, and shipped as data.
 *
 * The aggregate is one table: every distinct *combination* of designations,
 * with its length, arc count, extent, and what that length is made of — split
 * by `kind` and by 旧道. Route totals, the ranking and the selection stats are
 * all sums over its rows, so there is one set of numbers rather than three that
 * can disagree. Concurrency is why a per-route table would not do: an arc
 * carrying 18 and 117 belongs to both, and adding the two route rows would
 * count it twice.
 *
 * Tiles are cut with geojson-vt — the same code MapLibre uses for GeoJSON
 * sources, so the geometry the browser draws is arrived at the same way it
 * always was. tippecanoe has no Windows build; this does not need one.
 *
 * Usage:  node pipeline/pack_web.mjs [--maxzoom 14]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

import { DATA, DECREE, REGIONS, ROOT } from './_paths.mjs';

const TILEDIR = join(ROOT, 'build', 'tiles');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : Number(process.argv[i + 1]);
};
// The deepest zoom cut. Below it MapLibre overzooms, keeping this zoom's
// geometry, so this is where the detail stops improving. Nothing else states
// it: the archive carries it and the style asks the archive.
const MAXZOOM = arg('--maxzoom', 14);
// Above this zoom the country is cut into independent pyramids, one per tile,
// so geojson-vt never holds the whole deep pyramid at once.
const SPLIT = 8;
const EXTENT = 4096;

/* ------------------------------------------------------------------ merge --- */
const index = JSON.parse(readFileSync(join(REGIONS, 'regions.json'), 'utf8'));
if (!index.length) throw new Error('build/regions/regions.json is empty');

const byId = new Map();
const metas = [];
for (const r of index) {
  metas.push(
    JSON.parse(readFileSync(join(REGIONS, `${r.region}.meta.json`), 'utf8')),
  );
  const geo = JSON.parse(
    readFileSync(join(REGIONS, `${r.region}.geojson`), 'utf8'),
  );
  for (const f of geo.features) {
    // Boxes are rectangles, so seams hand back the same road twice. The OSM way
    // id is the identity; no geometry comparison is needed.
    if (byId.has(f.properties.id)) continue;
    byId.set(f.properties.id, f);
  }
}
const features = [...byId.values()];
console.log(
  `${index.length} regions -> ${features.length.toLocaleString()} arcs after dedupe`,
);

/* Tile properties. `refs_list` is dropped: MVT has no array type, and the list
 * is recoverable from the delimiter-wrapped key that the filters already use.
 * `label` is materialised here because a symbol layer needs a plain property. */
for (const f of features) {
  const p = f.properties;
  const list = p.refs_list;
  f.properties = {
    id: p.id,
    refs: p.refs,
    label: list.join('・'),
    n: p.n,
    kind: p.kind,
    src: p.src,
    former: p.former,
    // A region built before `revoked` existed has no such key (it arrived
    // with #51, and most of build/regions predates it). 0 is what the field
    // means when nobody has checked — 未確認, not 現役 — so it is the honest
    // stand-in as well as the only one MVT can carry.
    revoked: p.revoked || 0,
    name: p.name || '',
    updated: p.updated,
    km: p.km,
  };
  f.bbox = bboxOf(f.geometry.coordinates);
  f.refs_list = list;
}

/* MVT has no null. vt-pbf writes a missing property as a value with no field
 * set, and MapLibre answers "unknown feature value" and throws the whole tile
 * away — so one absent property on one arc costs every road in that tile. It
 * fails in the browser, long after the build said it was done, which is why it
 * is worth a pass over 130,000 features to say it here instead. */
for (const f of features) {
  for (const [k, v] of Object.entries(f.properties)) {
    if (v === null || v === undefined) {
      throw new Error(
        `arc ${f.properties.id}: property "${k}" is ${v}. MVT cannot carry ` +
          'it, and MapLibre drops every tile that contains it.',
      );
    }
  }
}

function bboxOf(coords) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

const dataBbox = features.reduce(
  (a, f) => [
    Math.min(a[0], f.bbox[0]),
    Math.min(a[1], f.bbox[1]),
    Math.max(a[2], f.bbox[2]),
    Math.max(a[3], f.bbox[3]),
  ],
  [Infinity, Infinity, -Infinity, -Infinity],
);

/* -------------------------------------------------------------- aggregate --- */
const km2 = (v) => Math.round(v * 100) / 100;

/** One row per distinct set of designations. Everything the panel shows is a
 *  sum over a subset of these rows.
 *
 *  A row also carries what its length is made of, because the total on its own
 *  cannot answer "how much of 国道152号 can you actually drive". `kinds` splits
 *  the length by the same `kind` the tiles carry, and `former_km` says how much
 *  of it is 旧道. The two are separate keys because they are separate axes: a
 *  旧道 is a road of some kind that is no longer the current alignment, so
 *  folding it into `kinds` would lose the expressway and foot 旧道 (#26).
 *
 *  Zero is written as absence in both. There are ~1,200 rows and seven kinds,
 *  and a row names one or two of them; spelling out the five that are zero
 *  would triple the table to say nothing. */
function combinationsOf(feats) {
  const by = new Map();
  for (const f of feats) {
    const p = f.properties;
    let e = by.get(p.refs);
    if (!e) {
      e = {
        refs: f.refs_list,
        n: p.n,
        km: 0,
        arcs: 0,
        kinds: new Map(),
        former: 0,
        names: new Map(),
        bbox: [Infinity, Infinity, -Infinity, -Infinity],
      };
      by.set(p.refs, e);
    }
    e.km += p.km;
    e.arcs++;
    e.kinds.set(p.kind, (e.kinds.get(p.kind) || 0) + p.km);
    if (p.former) e.former += p.km;
    if (p.name) e.names.set(p.name, (e.names.get(p.name) || 0) + 1);
    e.bbox = [
      Math.min(e.bbox[0], f.bbox[0]),
      Math.min(e.bbox[1], f.bbox[1]),
      Math.max(e.bbox[2], f.bbox[2]),
      Math.max(e.bbox[3], f.bbox[3]),
    ];
  }
  return [...by.values()]
    .map((e) => {
      // Rounded first, then dropped: a kind that rounds away is under 5 m and
      // has nothing to say. The names are whatever the build classified the
      // arcs as; nothing here invents a vocabulary of its own.
      const kinds = [...e.kinds.entries()]
        .map(([k, v]) => [k, km2(v)])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const former = km2(e.former);
      return {
        refs: e.refs,
        n: e.n,
        km: km2(e.km),
        arcs: e.arcs,
        kinds: Object.fromEntries(kinds),
        ...(former > 0 ? { former_km: former } : {}),
        names: [...e.names.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([n]) => n),
        bbox: e.bbox.map((v) => Math.round(v * 1e5) / 1e5),
      };
    })
    .sort((a, b) => b.n - a.n || b.km - a.km);
}

/** Termini merged across regions: a point inside an overlap is reported twice,
 *  and points keyed by position union the route numbers that meet there. */
function mergeTermini(ms) {
  const at = (t) => `${t.lat.toFixed(5)},${t.lon.toFixed(5)}`;
  const single = new Map();
  const shared = new Map();
  for (const m of ms) {
    for (const t of m.termini) single.set(`${at(t)}/${t.ref}`, t);
    for (const t of m.shared_termini) {
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

/* The decree's own 起点 / 終点 / 重要な経過地, put here by pipeline/decree.py.
 * It is a column beside the endpoints, not a replacement: the endpoints say
 * where a route's arcs stop, this says where the route legally begins. Routes
 * whose coordinate could not be found keep their place name and say why. */
const decree = JSON.parse(
  readFileSync(join(DECREE, 'decree.json'), 'utf8'),
);
if (decree.routes.length !== 459)
  throw new Error(
    `build/decree/decree.json has ${decree.routes.length} routes, not 459`,
  );

const min = (v) => v.filter(Boolean).sort()[0] || null;
const max = (v) => v.filter(Boolean).sort().slice(-1)[0] || null;

const combos = combinationsOf(features);
const termini = mergeTermini(metas);
const meta = {
  // Freshness is reported at its worst: the map is only as current as its
  // stalest region, and saying otherwise would overstate it.
  osm_timestamp: min(metas.map((m) => m.osm_timestamp)),
  oldest_edit: min(metas.map((m) => m.oldest_edit)),
  newest_edit: max(metas.map((m) => m.newest_edit)),
  endpoints: [...new Set(metas.map((m) => new URL(m.endpoint).host))],
  arc_count: features.length,
  total_km:
    Math.round(features.reduce((s, f) => s + f.properties.km, 0) * 10) / 10,
  bbox: dataBbox.map((v) => Math.round(v * 1e5) / 1e5),
  source: {
    type: 'vector',
    tiles: 'https://data.nanase.cc/national-routes.pmtiles',
    maxzoom: MAXZOOM,
  },
  combinations: combos,
  ...termini,
  decree,
};

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'national.meta.json'), JSON.stringify(meta));
writeFileSync(join(DATA, 'regions.json'), JSON.stringify(index));

const routes = new Set(combos.flatMap((c) => c.refs));
console.log(
  `combinations: ${combos.length.toLocaleString()} | routes: ${routes.size} | ` +
    `termini: ${termini.termini.length.toLocaleString()} ` +
    `(shared ${termini.shared_termini.length.toLocaleString()})`,
);
const located = decree.routes.filter(
  (r) => r.start.lat !== undefined && r.end.lat !== undefined,
).length;
console.log(
  `decree: ${decree.routes.length} routes, both termini located for ${located}`,
);

/* ------------------------------------------------------------------ tiles --- */
const lonX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};

/** Tile ranges the data covers at one zoom. */
function tileRange(bbox, z) {
  const n = 2 ** z;
  const clamp = (v) => Math.max(0, Math.min(n - 1, Math.floor(v)));
  return {
    x0: clamp(lonX(bbox[0], z)),
    x1: clamp(lonX(bbox[2], z)),
    y0: clamp(latY(bbox[3], z)),
    y1: clamp(latY(bbox[1], z)),
  };
}

const tileBounds = (z, x, y) => {
  const n = 2 ** z;
  const lon = (v) => (v / n) * 360 - 180;
  const lat = (v) => {
    const m = Math.PI * (1 - (2 * v) / n);
    return (180 / Math.PI) * Math.atan(Math.sinh(m));
  };
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
};

const overlaps = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const fc = (feats) => ({
  type: 'FeatureCollection',
  features: feats.map((f) => ({
    type: 'Feature',
    properties: f.properties,
    geometry: f.geometry,
  })),
});

const chunks = [];
let total = 0;
let bytes = 0;

function emit(z, x, y, tile) {
  if (!tile?.features.length) return;
  const buf = vtpbf.fromGeojsonVt(
    { routes: tile },
    { version: 2, extent: EXTENT },
  );
  chunks.push({ z, x, y, buf: Buffer.from(buf) });
  total++;
  bytes += buf.length;
}

/* Zooms 0..SPLIT-1 come from one index over everything. Few tiles, and each is
 * simplified hard enough that holding them all is nothing. */
console.log(`tiling z0-${SPLIT - 1} (whole country)`);
const low = geojsonvt(fc(features), {
  maxZoom: SPLIT - 1,
  indexMaxZoom: SPLIT - 1,
  tolerance: 3,
  extent: EXTENT,
  buffer: 64,
});
for (let z = 0; z < SPLIT; z++) {
  const r = tileRange(dataBbox, z);
  for (let x = r.x0; x <= r.x1; x++) {
    for (let y = r.y0; y <= r.y1; y++) emit(z, x, y, low.getTile(z, x, y));
  }
}
console.log(`  ${total} tiles`);

/* Below that, one pyramid per SPLIT-level tile. Features are selected by
 * bounding box, never cut: geojson-vt does its own clipping, and pre-cutting
 * would leave seams it could not heal. */
const r8 = tileRange(dataBbox, SPLIT);
const cells = [];
for (let x = r8.x0; x <= r8.x1; x++) {
  for (let y = r8.y0; y <= r8.y1; y++) cells.push([x, y]);
}
console.log(`tiling z${SPLIT}-${MAXZOOM} in ${cells.length} cells`);

let done = 0;
for (const [cx, cy] of cells) {
  const b = tileBounds(SPLIT, cx, cy);
  const margin = (b[2] - b[0]) * 0.05;
  const box = [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin];
  const sub = features.filter((f) => overlaps(f.bbox, box));
  done++;
  if (!sub.length) continue;
  const idx = geojsonvt(fc(sub), {
    maxZoom: MAXZOOM,
    indexMaxZoom: SPLIT,
    tolerance: 3,
    extent: EXTENT,
    buffer: 64,
  });
  for (let z = SPLIT; z <= MAXZOOM; z++) {
    const s = 2 ** (z - SPLIT);
    for (let x = cx * s; x < (cx + 1) * s; x++) {
      for (let y = cy * s; y < (cy + 1) * s; y++)
        emit(z, x, y, idx.getTile(z, x, y));
    }
  }
  process.stdout.write(
    `\r  cell ${done}/${cells.length}  ${sub.length} arcs  ` +
      `${total.toLocaleString()} tiles  ${(bytes / 1e6).toFixed(1)} MB   `,
  );
}
process.stdout.write('\n');

/* The packer takes one blob and one index rather than a hundred thousand small
 * files, which Windows would spend longer creating than we spent tiling. */
mkdirSync(TILEDIR, { recursive: true });
const idxRows = [];
let offset = 0;
for (const c of chunks) {
  idxRows.push([c.z, c.x, c.y, offset, c.buf.length]);
  offset += c.buf.length;
}
writeFileSync(
  join(TILEDIR, 'tiles.bin'),
  Buffer.concat(chunks.map((c) => c.buf)),
);
writeFileSync(
  join(TILEDIR, 'tiles.json'),
  JSON.stringify({
    minzoom: 0,
    maxzoom: MAXZOOM,
    extent: EXTENT,
    bbox: meta.bbox,
    layer: 'routes',
    tiles: idxRows,
  }),
);
console.log(
  `wrote ${total.toLocaleString()} tiles, ${(bytes / 1e6).toFixed(1)} MB uncompressed`,
);
console.log(`meta: ${(JSON.stringify(meta).length / 1e6).toFixed(2)} MB`);
