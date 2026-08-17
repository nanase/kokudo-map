/* Load the real page in Chromium and confirm it actually renders:
 * no console errors, layers present, features queryable, filters switching. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { ROOT } from './_paths.mjs';

// Not named URL — that would shadow the global URL constructor used below.
const OUT = process.argv[2] || 'shot';
const REGION = process.argv[3] || 'nagano';
const PAGE = `http://localhost:8000/?region=${REGION}`;

const geo = JSON.parse(
  readFileSync(join(ROOT, `web/data/${REGION}.geojson`), 'utf8'),
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
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

await page.screenshot({ path: `${OUT}-1-all.png` });

// --- switch to "concurrent sections only" -----------------------------------
await page.click('input[name=conc][value=all]');
await page.waitForTimeout(3500);
const concStats = await page.evaluate(() => ({
  roads: window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
  stats: document.querySelector('#stats').innerText.replace(/\n/g, ' | '),
}));
console.log('\nafter "重用区間のみ": renderedRoads=' + concStats.roads);
await page.screenshot({ path: `${OUT}-2-concurrent.png` });

// --- click the deepest concurrency row (18/117/406) --------------------------
await page.click('input[name=conc][value=off]');
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
await page.screenshot({ path: `${OUT}-3-selected.png` });

// --- selection-scoped concurrency -------------------------------------------
await page.click('input[name=conc][value=sel]');
await page.waitForTimeout(3500);
const scoped = await page.evaluate(
  () => window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
);
console.log('after "選択路線どうしの重用のみ": renderedRoads=' + scoped);
await page.screenshot({ path: `${OUT}-4-scoped.png` });

// --- zoom in where the most routes run together -----------------------------
// The route-number labels have a minzoom, so they only prove themselves close
// in. The spot is derived from the data rather than hard-coded to one region.
await page.click('input[name=conc][value=off]');
await page.click('#sel-none');
const deepest = geo.features.reduce((a, b) =>
  b.properties.n > a.properties.n ? b : a,
);
const at =
  deepest.geometry.coordinates[
    Math.floor(deepest.geometry.coordinates.length / 2)
  ];
console.log(
  `\ndeepest concurrency here: ${deepest.properties.n}x ` +
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
await page.screenshot({ path: `${OUT}-5-labels.png` });

// --- 点線国道 / 工事中: locate them from the data instead of guessing -------
const midOf = (f) =>
  f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
const firstOf = (kind) => geo.features.find((f) => f.properties.kind === kind);

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
  await page.screenshot({ path: `${OUT}-6-${kind}.png` });
}

// --- switching region must swap the data, not stack listeners ----------------
const others = await page.evaluate(
  (cur) =>
    [...document.querySelectorAll('#region option')]
      .map((o) => o.value)
      .filter((v) => v !== cur),
  REGION,
);
if (others.length) {
  const other = others[0];
  const before = await page.innerText('#stats');
  await page.selectOption('#region', other);
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => ({
    stats: document.querySelector('#stats').innerText.replace(/\n/g, ' | '),
    sub: document.querySelector('#region-sub').innerText,
    routes: document.querySelectorAll('#route-list label').length,
    roads: window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
  }));
  console.log(`\nswitched region to ${other}:`);
  console.log('  ' + after.sub + ' / route checkboxes ' + after.routes);
  console.log('  ' + after.stats);
  console.log('  rendered roads: ' + after.roads);
  if (before.replace(/\n/g, ' | ') === after.stats) {
    console.log(
      '  WARNING: stats did not change — the switch may not have loaded new data',
    );
  }
  await page.screenshot({ path: `${OUT}-7-switched.png` });
}

console.log(
  '\nconsole errors: ' +
    (errors.length ? '\n  ' + errors.join('\n  ') : 'none'),
);
await browser.close();
process.exit(errors.length ? 1 : 0);
