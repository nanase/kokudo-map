/* Validate the *actual* style the viewer builds, then evaluate its filters
 * over the built data.
 *
 * This imports web/mapspec.mjs rather than restating the expressions, because
 * a restated copy already fooled this check once: the duplicate compiled fine
 * while the real layers were rejected by MapLibre for wrapping a `zoom`
 * interpolation in arithmetic and for a data-driven `line-dasharray`.
 *
 * Usage:  node pipeline/check_expressions.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REGIONS, ROOT } from './_paths.mjs';

// Imported by path rather than by a fixed relative depth: these scripts belong
// to the skill, so how far they sit below the project is not fixed.
const {
  baseStyle,
  routeLayers,
  routeSources,
  PMTILES_URL,
  buildFilter,
  withKind,
  hasRef,
  FILTERED_LAYERS,
  SPECIAL_KINDS,
} = await import(pathToFileURL(join(ROOT, 'web', 'mapspec.mjs')).href);

const require = createRequire(join(ROOT, 'package.json'));
const spec = require('@maplibre/maplibre-gl-style-spec');

/* This check has two halves, and only one of them needs a build.
 *
 * Section 1 asks whether the style and the filter expressions are legal
 * MapLibre — a question about the code, answerable anywhere, which is what
 * lets CI run it on a clone with no data in it. Sections 2 to 5 evaluate those
 * same expressions over real arcs and compare the result against plain JS,
 * which needs a region to have been built.
 *
 * `--spec-only` asks for the first half alone. Without it, missing data is an
 * error rather than a quietly smaller run: someone checking their work on a
 * built tree should hear about it, not be handed a pass that skipped the
 * comparison.
 */
const args = process.argv.slice(2);
const SPEC_ONLY = args.includes('--spec-only');
const REGION = args.find((a) => !a.startsWith('--')) || 'nagano';

let geo = null;
let meta = null;
if (SPEC_ONLY) {
  console.log('--spec-only: 仕様の検査だけを行う（データを読まない）');
} else {
  try {
    geo = JSON.parse(readFileSync(join(REGIONS, `${REGION}.geojson`), 'utf8'));
    meta = JSON.parse(
      readFileSync(join(REGIONS, `${REGION}.meta.json`), 'utf8'),
    );
  } catch {
    console.error(
      `build/regions/ に ${REGION} が無い。
` +
        `  作る:      mise run rebuild ${REGION}
` +
        '  仕様だけ:  bun run check --spec-only',
    );
    process.exit(1);
  }
  console.log(`region: ${REGION} (${meta.label})`);
}

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (!cond) {
    fails.push(`FAIL  ${msg}`);
    return;
  }
  pass++;
  console.log(`PASS  ${msg}`);
};

/* ---- 1. the whole style must satisfy the spec ----------------------------- */
function styleWith(filters) {
  const style = baseStyle();
  // The viewer's own source definitions, not stand-ins: a `source-layer` on a
  // layer is only valid against a vector source, so validating the layers over
  // invented GeoJSON sources would pass while the real map failed.
  Object.assign(style.sources, routeSources(PMTILES_URL));
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
      `FAIL  ${label}:\n    ${errs.map((e) => `${e.message}`).join('\n    ')}`,
    );
    return false;
  }
  pass++;
  console.log(`PASS  ${label}`);
  return true;
}

validate(
  styleWith(null),
  'style with no filters validates against the MapLibre spec',
);

// The archive states which zooms it holds and the protocol passes that on. A
// zoom range restated in the style is a second, silent answer to the same
// question: pinning maxzoom:14 against a z12 archive left every layer blank
// past z12 while the style still validated.
const src = routeSources(PMTILES_URL).routes;
ok(
  src.minzoom === undefined && src.maxzoom === undefined,
  `the vector source does not restate the archive's zoom range ` +
    `(${JSON.stringify(src)})`,
);
ok(
  routeLayers()
    .filter((l) => l.source === 'routes')
    .every((l) => l['source-layer'] === 'routes'),
  'every layer on the vector source names its source-layer',
);

// Every filter combination the UI can produce must also validate in place.
// Scenarios are derived from the region's own data so the same checks work
// wherever they are run. The deepest concurrency is the most demanding case.
// A prefecture with no concurrency at all would still have to produce a valid
// style, so the scenarios fall back to its longest route rather than throwing.
// With --spec-only there is no region to read them from. A stand-in does:
// this section asks whether a filter is legal MapLibre, and legality does not
// depend on which numbers are inside it. 18・117・406 is the concurrency this
// project has used as its worked example throughout.
const deepest = !meta
  ? [18, 117, 406]
  : meta.concurrency_ranking.length
    ? meta.concurrency_ranking[0].refs
    : [meta.routes[0].ref];
const single = deepest[0];
const pair = deepest.slice(0, 2);

const scenarios = [
  [[], 'off', true, 'no selection, no concurrency'],
  [[single], 'off', true, 'single route'],
  [deepest, 'off', true, 'multi route'],
  [[], 'all', true, 'all concurrency'],
  [pair, 'all', true, 'selection + all concurrency'],
  [deepest, 'all', true, 'deepest selection + all concurrency'],
  [[], 'off', false, 'former hidden, no other filter'],
  [
    deepest,
    'all',
    false,
    'former hidden + deepest selection + all concurrency',
  ],
];

for (const [selected, conc, showFormer, label] of scenarios) {
  const base = buildFilter(selected, conc, showFormer);
  const filters = {};
  for (const { id, kinds, negate } of FILTERED_LAYERS) {
    filters[id] = kinds ? withKind(base, kinds, negate) : base;
  }
  validate(styleWith(filters), `filters validate in the style — ${label}`);
}

if (SPEC_ONLY) {
  console.log(`
${pass} passed, ${fails.length} failed（仕様のみ）`);
  process.exit(fails.length ? 1 : 0);
}

/* ---- 2. do the filters select the same arcs as plain JS? ----------------- */
const compile = (expr) => {
  const r = spec.expression.createExpression(expr, { type: 'boolean' });
  if (r.result === 'error') {
    fails.push(`FAIL  compile: ${r.value.map((e) => e.message).join('; ')}`);
    return null;
  }
  return r.value;
};

const evaluate = (fn, f) =>
  fn.evaluate(
    { zoom: 10 },
    { type: 'Feature', properties: f.properties, geometry: f.geometry },
  );

function jsPredicate(selected, conc, showFormer) {
  const set = new Set(selected);
  return (p) => {
    if (set.size && !p.refs_list.some((r) => set.has(r))) return false;
    if (conc === 'all' && p.n < 2) return false;
    if (!showFormer && Number(p.former) === 1) return false;
    return true;
  };
}

for (const [selected, conc, showFormer, label] of scenarios) {
  const expr = buildFilter(selected, conc, showFormer);
  if (expr === true) {
    pass++;
    console.log(`PASS  ${label}: filter is literal true (everything shown)`);
    continue;
  }
  const fn = compile(expr);
  if (!fn) continue;
  const js = jsPredicate(selected, conc, showFormer);
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
// How deep the deepest stack goes is a fact about the country, not about every
// prefecture — verify_national.py asserts the six-fold one over the merged
// data. Here it only has to exist and be at the top of the ranking.
const top = meta.concurrency_ranking[0];
ok(
  top?.n >= 2,
  `deepest concurrency in ${meta.label} is ${top?.n}x ${JSON.stringify(top?.refs)}`,
);
// Every number of the deepest combination must land on the same arcs — the
// thing the map exists to show — and the filter primitive must agree with the
// stored list about which arcs those are.
const together = compile(['all', ...top.refs.map(hasRef)]);
const byExpr = geo.features.filter(
  (f) => evaluate(together, f) === true,
).length;
const byList = geo.features.filter((f) =>
  top.refs.every((r) => f.properties.refs_list.includes(r)),
).length;
ok(
  byExpr === byList && byExpr > 0,
  `${JSON.stringify(top.refs)} run together on ${byExpr} arcs (list agrees: ${byList})`,
);

console.log(fails.length ? `\n${fails.join('\n')}` : '');
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
