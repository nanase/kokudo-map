/* Load the real page in Chromium and confirm it actually renders:
 * no console errors, layers present, features queryable, filters switching.
 *
 * The page joins every built region into one map, so the probes here are
 * derived from the same join rather than from a single region's file. */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { ROOT } from './_paths.mjs';

// Not named URL — that would shadow the global URL constructor used below.
const PAGE = 'http://localhost:8000/';

// The screenshots are evidence for one run, not a build product, so they are
// written outside the working tree. Pass a directory to keep them somewhere.
const OUTDIR =
  process.argv[2] || mkdtempSync(join(tmpdir(), 'national-route-map-'));
mkdirSync(OUTDIR, { recursive: true });
const shot = (name) => join(OUTDIR, `${name}.png`);

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// Same join the viewer performs: overlapping bounding boxes return the same
// way twice, and the OSM way id deduplicates them.
const index = read('web/data/regions.json');
const byId = new Map();
for (const r of index) {
  for (const f of read(`web/data/${r.region}.geojson`).features) {
    if (!byId.has(f.properties.id)) byId.set(f.properties.id, f);
  }
}
const features = [...byId.values()];
console.log(
  `regions built: ${index.map((r) => r.label).join(', ')} ` +
    `— ${features.length.toLocaleString()} arcs after dedupe`,
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const fails = [];
const ok = (cond, msg) =>
  cond ? console.log('PASS  ' + msg) : fails.push('FAIL  ' + msg);

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 90000 });

// The veil is display:none once boot() finishes, so wait on the class rather
// than on visibility.
await page.waitForFunction(
  () => document.querySelector('#loading')?.classList.contains('done'),
  null,
  { timeout: 90000 },
);
await page
  .waitForFunction(() => window.map && window.map.isStyleLoaded(), null, {
    timeout: 90000,
  })
  .catch(() => {});
await page.waitForTimeout(6000);

const report = await page.evaluate(() => {
  const m = window.map;
  const layers = [
    'casing',
    'roads',
    'construction',
    'foot',
    'route-labels',
    'termini-dot',
    'termini-label',
  ];
  const out = { layers: {}, styleLoaded: m.isStyleLoaded() };
  for (const id of layers) {
    const rendered = m.queryRenderedFeatures({ layers: [id] });
    out.layers[id] = { exists: !!m.getLayer(id), rendered: rendered.length };
  }
  out.routeCount = document.querySelectorAll('#route-list label').length;
  out.rankingRows = document.querySelectorAll('#ranking .row').length;
  out.sharedRows = document.querySelectorAll('#shared .row').length;
  out.stats = document.querySelector('#stats').innerText.replace(/\n/g, ' | ');
  // The three UI decisions this page is built around.
  out.regionPickers = document.querySelectorAll('select#region').length;
  out.concOptions = [...document.querySelectorAll('input[name=conc]')].map(
    (i) => i.value,
  );
  out.folded = ['ranking', 'shared'].map((name) => ({
    name,
    open: document.querySelector(`#${name}-block`).open,
    count: document.querySelector(`#${name}-count`).innerText,
  }));
  return out;
});

console.log('style loaded:', report.styleLoaded);
for (const [id, v] of Object.entries(report.layers)) {
  console.log(
    `  layer ${id.padEnd(14)} exists=${v.exists} renderedFeatures=${v.rendered}`,
  );
}
console.log('route checkboxes:', report.routeCount);
console.log(
  'ranking rows:',
  report.rankingRows,
  '| shared-termini rows:',
  report.sharedRows,
);
console.log('stats:', report.stats);

/* ---- the UI contract ------------------------------------------------------ */
ok(
  report.regionPickers === 0,
  'no region picker: the map is not scoped to one prefecture',
);
ok(
  report.routeCount >= Math.max(...index.map((r) => r.routes)),
  `the route list covers every region at once (${report.routeCount} routes)`,
);
ok(
  JSON.stringify(report.concOptions) === JSON.stringify(['off', 'all']),
  `concurrency has two modes, not three (${report.concOptions.join(', ')})`,
);
// Reference lists are folded shut, but a fold that hides its own existence is
// worse than the height it saves, so each summary must still state its size.
for (const b of report.folded) {
  ok(b.open === false, `the ${b.name} list starts folded`);
  ok(
    /\d/.test(b.count),
    `the folded ${b.name} list still states its size ("${b.count}")`,
  );
}

await page.screenshot({ path: shot('1-all') });

// --- switch to "concurrent sections only" -----------------------------------
await page.click('input[name=conc][value=all]');
await page.waitForTimeout(3500);
const concStats = await page.evaluate(() => ({
  roads: window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
  stats: document.querySelector('#stats').innerText.replace(/\n/g, ' | '),
}));
console.log('\nafter "重用区間のみ": renderedRoads=' + concStats.roads);
await page.screenshot({ path: shot('2-concurrent') });

// --- unfold the ranking and click its deepest row ---------------------------
await page.click('input[name=conc][value=off]');
await page.click('#ranking-block > summary');
await page.waitForTimeout(500);
ok(
  await page.evaluate(() => document.querySelector('#ranking-block').open),
  'the ranking unfolds when its summary is clicked',
);
await page.click('#ranking .row');
await page.waitForTimeout(4000);
const selStats = await page.evaluate(() => ({
  checked: [...document.querySelectorAll('#route-list input:checked')].map(
    (i) => i.value,
  ),
  roads: window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
  stats: document.querySelector('#stats').innerText.replace(/\n/g, ' | '),
}));
console.log(
  'after clicking top ranking row: selected=' +
    JSON.stringify(selStats.checked),
);
console.log('  ' + selStats.stats);
await page.screenshot({ path: shot('3-selected') });

// --- zoom in where the most routes run together -----------------------------
// The route-number labels have a minzoom, so they only prove themselves close
// in. The spot is derived from the data rather than hard-coded to one region.
await page.click('#sel-none');
const deepest = features.reduce((a, b) =>
  b.properties.n > a.properties.n ? b : a,
);
const at =
  deepest.geometry.coordinates[
    Math.floor(deepest.geometry.coordinates.length / 2)
  ];
console.log(
  `\ndeepest concurrency anywhere: ${deepest.properties.n}x ` +
    `${JSON.stringify(deepest.properties.refs_list)} — ${deepest.properties.name}`,
);
await page.evaluate((c) => window.map.jumpTo({ center: c, zoom: 12.4 }), at);
await page.waitForTimeout(6000);
const labelled = await page.evaluate(() => {
  const m = window.map;
  const feats = m.queryRenderedFeatures({ layers: ['route-labels'] });
  const texts = [...new Set(feats.map((f) => f.properties.label))];
  return {
    count: feats.length,
    sample: texts.slice(0, 12),
    multi: texts.filter((t) => t.includes('・')).slice(0, 8),
    termini: m.queryRenderedFeatures({ layers: ['termini-label'] }).length,
  };
});
console.log('zoomed in at z12.4:');
console.log('  rendered route labels: ' + labelled.count);
console.log('  label values: ' + labelled.sample.join(' , '));
console.log(
  '  multi-designation labels: ' + (labelled.multi.join(' , ') || 'none'),
);
console.log('  rendered terminus labels: ' + labelled.termini);
await page.screenshot({ path: shot('4-labels') });

// --- 点線国道 / 工事中: locate them from the data instead of guessing -------
const midOf = (f) =>
  f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
const firstOf = (kind) => features.find((f) => f.properties.kind === kind);

for (const [kind, layer, caption] of [
  ['foot', 'foot', '点線国道（徒歩道）'],
  ['construction', 'construction', '工事中区間'],
]) {
  const f = firstOf(kind);
  if (!f) {
    console.log(`\n${caption}: no arc of kind=${kind} in the data`);
    continue;
  }
  const at = midOf(f);
  await page.evaluate((c) => window.map.jumpTo({ center: c, zoom: 13.5 }), at);
  await page.waitForTimeout(5000);
  const seen = await page.evaluate(
    (id) =>
      window.map.queryRenderedFeatures({ layers: [id] }).map((x) => ({
        label: x.properties.label,
        name: x.properties.name,
        kind: x.properties.kind,
      })),
    layer,
  );
  console.log(
    `\n${caption} — 国道${f.properties.refs_list.join('・')} @ ${at[1].toFixed(4)},${at[0].toFixed(4)}`,
  );
  console.log(
    `  layer "${layer}" rendered ${seen.length} arcs` +
      (seen.length ? ': ' + JSON.stringify(seen[0]) : ''),
  );
  await page.screenshot({ path: shot(`5-${kind}`) });
}

// --- every region's data must actually be on the map ------------------------
// One region loading and the rest silently failing would look almost the same
// from the panel, so each box is visited and its roads counted.
console.log('');
for (const r of index) {
  const [w, s, e, n] = r.bbox;
  await page.evaluate(
    (b) => window.map.fitBounds(b, { padding: 10, duration: 0 }),
    [
      [w, s],
      [e, n],
    ],
  );
  await page.waitForTimeout(4000);
  const roads = await page.evaluate(
    () => window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
  );
  ok(roads > 0, `${r.label} renders roads without being selected (${roads})`);
}
await page.screenshot({ path: shot('6-nationwide') });

console.log(fails.length ? '\n' + fails.join('\n') : '');
console.log(
  '\nconsole errors: ' +
    (errors.length ? '\n  ' + errors.join('\n  ') : 'none'),
);
console.log('screenshots: ' + OUTDIR);
await browser.close();
process.exit(errors.length || fails.length ? 1 : 0);
