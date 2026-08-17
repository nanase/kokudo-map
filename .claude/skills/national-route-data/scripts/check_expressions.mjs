/* Validate the *actual* style the viewer builds, then evaluate its filters
 * over the built data.
 *
 * This imports web/mapspec.mjs rather than restating the expressions, because
 * a restated copy already fooled this check once: the duplicate compiled fine
 * while the real layers were rejected by MapLibre for wrapping a `zoom`
 * interpolation in arithmetic and for a data-driven `line-dasharray`.
 *
 * Usage:  node build/check_expressions.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from './_paths.mjs';

// Imported by path rather than by a fixed relative depth: these scripts belong
// to the skill, so how far they sit below the project is not fixed.
const {
  baseStyle,
  routeLayers,
  buildFilter,
  withKind,
  hasRef,
  selectedCount,
  FILTERED_LAYERS,
  SPECIAL_KINDS,
} = await import(pathToFileURL(join(ROOT, 'web', 'mapspec.mjs')).href);

const require = createRequire(join(ROOT, 'package.json'));
const spec = require('@maplibre/maplibre-gl-style-spec');

const REGION = process.argv[2] || 'nagano';
const geo = JSON.parse(
  readFileSync(join(ROOT, `web/data/${REGION}.geojson`), 'utf8'),
);
const meta = JSON.parse(
  readFileSync(join(ROOT, `web/data/${REGION}.meta.json`), 'utf8'),
);
console.log(`region: ${REGION} (${meta.label})`);

let pass = 0;
const fails = [];
const ok = (cond, msg) =>
  cond ? (pass++, console.log('PASS  ' + msg)) : fails.push('FAIL  ' + msg);

/* ---- 1. the whole style must satisfy the spec ----------------------------- */
function styleWith(filters) {
  const style = baseStyle();
  style.sources.routes = {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  };
  style.sources.termini = {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  };
  const layers = routeLayers();
  if (filters) {
    for (const l of layers)
      if (filters[l.id] !== undefined) l.filter = filters[l.id];
  }
  style.layers = [...style.layers, ...layers];
  return style;
}

function validate(style, label) {
  const errs = spec.validateStyleMin
    ? spec.validateStyleMin(style)
    : spec.validateStyle(style);
  if (errs.length) {
    fails.push(
      `FAIL  ${label}:\n    ` + errs.map((e) => `${e.message}`).join('\n    '),
    );
    return false;
  }
  pass++;
  console.log('PASS  ' + label);
  return true;
}

validate(
  styleWith(null),
  'style with no filters validates against the MapLibre spec',
);

// Every filter combination the UI can produce must also validate in place.
// Scenarios are derived from the region's own data so the same checks work
// wherever they are run. The deepest concurrency is the most demanding case.
const deepest = meta.concurrency_ranking[0].refs;
const single = deepest[0];
const pair = deepest.slice(0, 2);

const scenarios = [
  [[], 'off', 'no selection, no concurrency'],
  [[single], 'off', 'single route'],
  [deepest, 'off', 'multi route'],
  [[], 'all', 'all concurrency'],
  [pair, 'all', 'selection + all concurrency'],
  [deepest, 'sel', 'selection-scoped concurrency'],
  [[single], 'sel', 'selection-scoped with one route (falls back)'],
];

for (const [selected, conc, label] of scenarios) {
  const base = buildFilter(selected, conc);
  const filters = {};
  for (const { id, kinds, negate } of FILTERED_LAYERS) {
    filters[id] = kinds ? withKind(base, kinds, negate) : base;
  }
  validate(styleWith(filters), `filters validate in the style — ${label}`);
}

/* ---- 2. do the filters select the same arcs as plain JS? ----------------- */
const compile = (expr) => {
  const r = spec.expression.createExpression(expr, { type: 'boolean' });
  if (r.result === 'error') {
    fails.push('FAIL  compile: ' + r.value.map((e) => e.message).join('; '));
    return null;
  }
  return r.value;
};

const evaluate = (fn, f) =>
  fn.evaluate(
    { zoom: 10 },
    { type: 'Feature', properties: f.properties, geometry: f.geometry },
  );

function jsPredicate(selected, conc) {
  const set = new Set(selected);
  return (p) => {
    if (set.size && !p.refs_list.some((r) => set.has(r))) return false;
    if (conc === 'all') return p.n >= 2;
    if (conc === 'sel') {
      if (set.size >= 2)
        return p.refs_list.filter((r) => set.has(r)).length >= 2;
      return p.n >= 2;
    }
    return true;
  };
}

for (const [selected, conc, label] of scenarios) {
  const expr = buildFilter(selected, conc);
  if (expr === true) {
    pass++;
    console.log(`PASS  ${label}: filter is literal true (everything shown)`);
    continue;
  }
  const fn = compile(expr);
  if (!fn) continue;
  const js = jsPredicate(selected, conc);
  let diff = 0;
  let hits = 0;
  for (const f of geo.features) {
    const a = evaluate(fn, f) === true;
    if (a) hits++;
    if (a !== js(f.properties)) diff++;
  }
  ok(
    diff === 0,
    `${label}: matches the JS predicate on all ${geo.features.length} arcs (${hits} hits)`,
  );
}

/* ---- 3. the kind split must partition the arcs, not overlap or drop ------ */
const carriageway = compile(withKind(true, SPECIAL_KINDS, true));
const special = compile(withKind(true, SPECIAL_KINDS, false));
let both = 0;
let neither = 0;
for (const f of geo.features) {
  const a = evaluate(carriageway, f) === true;
  const b = evaluate(special, f) === true;
  if (a && b) both++;
  if (!a && !b) neither++;
}
ok(
  both === 0 && neither === 0,
  `carriageway / special layers partition all arcs (overlap ${both}, orphan ${neither})`,
);

/* ---- 4. the substring trap ----------------------------------------------- */
// Pick a route number that is absent here but whose digits appear inside a
// number that *is* present — 2 hides in 20, 1 hides in 17. Any hit at all then
// proves the delimiter guard failed.
const present = new Set(meta.routes.map((r) => r.ref));
const presentStr = meta.routes.map((r) => String(r.ref));
let probe = null;
for (let n = 1; n <= 507 && probe === null; n++) {
  if (present.has(n)) continue;
  const s = String(n);
  if (presentStr.some((p) => p !== s && p.includes(s))) probe = n;
}
ok(
  probe !== null,
  `found an absent route number that hides inside a present one (${probe})`,
);
if (probe !== null) {
  const fn = compile(hasRef(probe));
  const falseHits = geo.features.filter((f) => evaluate(fn, f) === true).length;
  ok(
    falseHits === 0,
    `route ${probe} matches nothing in ${meta.label} (substring guard holds; ${falseHits} hits)`,
  );
}

// The four longest routes here must resolve identically through both paths.
const busiest = [...meta.routes]
  .sort((a, b) => b.km - a.km)
  .slice(0, 4)
  .map((r) => r.ref);
for (const ref of busiest) {
  const fn = compile(hasRef(ref));
  const byExpr = geo.features.filter((f) => evaluate(fn, f) === true).length;
  const byList = geo.features.filter((f) =>
    f.properties.refs_list.includes(ref),
  ).length;
  ok(
    byExpr === byList && byExpr > 0,
    `route ${ref}: expression ${byExpr} arcs == list ${byList} arcs`,
  );
}

/* ---- 5. spot-check the deepest concurrency ------------------------------- */
const top = meta.concurrency_ranking[0];
ok(
  top.n >= 3,
  `deepest concurrency in ${meta.label} is ${top.n}x ${JSON.stringify(top.refs)}`,
);
const depth = compile(['>=', selectedCount(top.refs), 2]);
const depthHits = geo.features.filter(
  (f) => evaluate(depth, f) === true,
).length;
ok(
  depthHits > 0,
  `selected-depth expression finds ${depthHits} arcs shared by ${JSON.stringify(top.refs)}`,
);

console.log(fails.length ? '\n' + fails.join('\n') : '');
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
