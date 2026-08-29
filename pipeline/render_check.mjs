/* Load the real page in Chromium and confirm it actually renders:
 * no console errors, layers present, features queryable, filters switching.
 *
 * The page joins every built region into one map, so the probes here are
 * derived from the same join rather than from a single region's file. */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

import { DATA, REGIONS, ROOT } from './_paths.mjs';

// Read the basemap URL from the real style rather than restating it, for the
// same reason the expression checker imports mapspec: a copy stops checking
// the thing it was written to check.
const { GSI_TILES } = await import(
  pathToFileURL(join(ROOT, 'web', 'mapspec.mjs')).href
);
// Same reason: the box's three sections are a rule over three meta fields, and
// a copy of that rule here would stop checking the one the page runs.
// detailHTML is imported alongside it so the former-designation check below
// can build its expected row through the real formatting rule (fmtKm, and
// formerRowHTML's "0.0 → no row") instead of retyping that rule here.
const { relatedRoutesOf, detailHTML } = await import(
  pathToFileURL(join(ROOT, 'web', 'detail.mjs')).href
);
// Same reason again: former_km's meta → DOM path (#84) is otherwise the one
// part of the detail box bun test never walks with a real field name — it
// only ever hands detailHTML() a literal. formerKmFor() is the function that
// actually reads the field, so importing it is what lets this file notice a
// rename the way it already notices one in decree.routes or crossings.
// routesOf comes along because detailHTML() needs a route object, not just
// the former_km number.
const { formerKmFor, routesOf } = await import(
  pathToFileURL(join(ROOT, 'web', 'aggregate.mjs')).href
);
const TILE_HOST = new URL(GSI_TILES).host;

// Not named URL — that would shadow the global URL constructor used below.
// PORT follows serve.py, for when something else already holds 8000.
const PAGE =
  process.env.MAP_URL || `http://localhost:${process.env.PORT || 8000}/`;

// The screenshots are evidence for one run, not a build product, so they are
// written outside the working tree. Pass a directory to keep them somewhere.
const OUTDIR =
  process.argv[2] || mkdtempSync(join(tmpdir(), 'national-route-map-'));
mkdirSync(OUTDIR, { recursive: true });
const shot = (name) => join(OUTDIR, `${name}.png`);

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// The same join the packer performed. It is redone here from the per-region
// builds rather than read back out of the tiles, so the probes below are
// derived from what the build decided and not from what the archive happens to
// contain — the point of the run is to find out whether those agree.
const index = read(join(DATA, 'regions.json'));
const meta = read(join(DATA, 'national.meta.json'));
const byId = new Map();
// Where each region's roads actually are. A region's box is a rectangle drawn
// around a prefecture outline — 東京都 reaches 南鳥島 — so flying to the box
// would point the camera at open sea.
const extents = new Map();
for (const r of index) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of read(join(REGIONS, `${r.region}.geojson`)).features) {
    for (const [x, y] of f.geometry.coordinates) {
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    }
    if (!byId.has(f.properties.id)) byId.set(f.properties.id, f);
  }
  extents.set(r.region, box);
}
const features = [...byId.values()];
console.log(
  `regions built: ${index.length} — ${features.length.toLocaleString()} arcs after dedupe`,
);
console.log(
  `national.meta.json: ${meta.arc_count.toLocaleString()} arcs, ` +
    `${meta.combinations.length.toLocaleString()} combinations, ` +
    `${meta.termini.length.toLocaleString()} termini`,
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const fails = [];
const ok = (cond, msg) =>
  cond ? console.log(`PASS  ${msg}`) : fails.push(`FAIL  ${msg}`);

/* 地図が落ち着くまで待つ。
 *
 * ここは以前、押すたびに `waitForTimeout` で決め打ちの秒数を数えていた。
 * 27 か所で合計 69 秒。数はどれも「たぶんこれだけあれば足りる」であって、
 * 何かが終わったことを述べてはいない。遅い日には足りずに偽の失敗を出し、
 * 速い日には待ちすぎる。
 *
 * MapLibre は落ち着いたときにそう言う。待つのは `idle` だけである。
 *
 * `idle` は _render の最後で、汚れが一つも残っておらず、動いてもいないとき
 * にだけ出る。この「汚れ」には symbol の配置(_placementDirty)も入る。
 * `loaded() && !isMoving()` は同じ条件ではない——配置が済んでいなくても
 * その二つは真になりうるので、`render` を合図にしてこの式で判定すると、
 * ラベルがまだ置かれていない絵を数えることがある。だから `render` は聞かず、
 * MapLibre 自身の判断だけを待つ。
 *
 * 代わりに triggerRepaint() で描画を 1 回促す。`idle` は状態ではなく出来事
 * なので、何も変わっていない回に待つだけでは二度と来ない——サイドバーの
 * 折りたたみのように地図を触らない操作がそれである。促せば、次の描画で
 * 「汚れが無い」と分かってその場で出る。
 *
 * 上限は残す。タイルが 1 枚返ってこないだけで検査が止まるより、待つのを
 * やめて、その後の検査に失敗させるほうがよい——それが本当に見たい失敗である。
 * requestAnimationFrame は使わない。画面が伏せられて rAF が止まる回に、
 * 上限そのものが動かなくなる。
 */
const SETTLE_CAP_MS = 30000;
const settle = () =>
  page.evaluate(
    (cap) =>
      new Promise((resolve) => {
        const m = window.map;
        /* 地図が無ければ待つ相手がいない。手前の isStyleLoaded 待ちは
         * `.catch(() => {})` で握りつぶすので、地図が起動しなかった回は
         * そのままここへ来る。待たずに戻り、後の検査に失敗させる——
         * page.evaluate に時限は無いので、ここで止まると何も報告されない
         * まま固まる。 */
        if (!m) {
          resolve();
          return;
        }
        const done = () => {
          clearTimeout(timer);
          resolve();
          m.off('idle', done);
        };
        const timer = setTimeout(done, cap);
        m.on('idle', done);
        m.triggerRepaint();
      }),
    SETTLE_CAP_MS,
  );

// 国土地理院 serves no raster tile where there is nothing to draw, so panning
// out over open sea answers 404. That is the basemap working as designed, and
// the ferry checks go there deliberately. Every *other* failed request is a
// real fault and is reported with its URL.
const blankTiles = [];

page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // Resource failures carry no URL in the console text. They are caught below
  // with one, so keeping both would only duplicate them.
  if (m.text().startsWith('Failed to load resource')) return;
  errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
  if (r.status() < 400) return;
  if (new URL(r.url()).host === TILE_HOST) blankTiles.push(r.url());
  else errors.push(`${r.status()} ${r.url()}`);
});

await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 90000 });

// The veil is display:none once boot() finishes, so wait on the class rather
// than on visibility.
await page.waitForFunction(
  () => document.querySelector('#loading')?.classList.contains('done'),
  null,
  { timeout: 90000 },
);
await page
  .waitForFunction(() => window.map?.isStyleLoaded(), null, {
    timeout: 90000,
  })
  .catch(() => {});
await settle();

const report = await page.evaluate(() => {
  const m = window.map;
  const layers = [
    'casing',
    'roads',
    'construction',
    'unopened',
    'foot',
    'ferry',
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
  // #stats now lives inside the 国道マップについて dialog, which is closed —
  // a closed <dialog> renders nothing, and `innerText` reports empty for
  // anything unrendered. `textContent` does not care about layout, so the
  // four numbers are read straight off the <dd>s.
  out.stats = [...document.querySelectorAll('#stats dd')]
    .map((s) => s.textContent)
    .join(' | ');
  // The three UI decisions this page is built around.
  out.regionPickers = document.querySelectorAll('select#region').length;
  out.concOptions = [...document.querySelectorAll('input[name=conc]')].map(
    (i) => i.value,
  );
  // 地図の上の釦。現在位置は MapLibre 自身の部品なので、あるかどうかだけを見る
  // (押すと端末の許可を求めるので、ここでは押さない)。方位は拡大・縮小とは
  // 別の台に乗っている——同じ群に並んでいると、拡大を連打する指が地図を回す。
  out.geolocateButtons = document.querySelectorAll(
    '.maplibregl-ctrl-geolocate',
  ).length;
  const groupOf = (sel) =>
    document.querySelector(sel)?.closest('.maplibregl-ctrl-group');
  const zoomGroup = groupOf('.maplibregl-ctrl-zoom-in');
  const compassGroup = groupOf('.maplibregl-ctrl-compass');
  out.compassApart =
    !!zoomGroup && !!compassGroup && zoomGroup !== compassGroup;
  out.folded = ['route', 'ranking', 'shared'].map((name) => ({
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
// The panel no longer counts features — it cannot, since most of them are not
// loaded — so what it states has to be the build's number rather than whatever
// happened to be on screen when it was drawn.
ok(
  report.stats.includes(meta.arc_count.toLocaleString()),
  `the panel states the nationwide arc count, not the loaded one ` +
    `(${meta.arc_count.toLocaleString()} in "${report.stats}")`,
);
ok(
  JSON.stringify(report.concOptions) === JSON.stringify(['off', 'all']),
  `concurrency has two modes, not three (${report.concOptions.join(', ')})`,
);
// データがいつのものかは「国道マップについて」の中にある。操作面には無い。
const about = await page.evaluate(async () => {
  const dialog = document.querySelector('#about-dialog');
  const before = dialog.open;
  document.querySelector('#about-btn').click();
  const opened = dialog.open;
  dialog.close();
  return {
    before,
    opened,
    inPanel: !!document.querySelector('#panel #stats'),
  };
});
ok(
  !about.before && about.opened,
  'the info button opens the 国道マップについて dialog',
);
ok(
  !about.inPanel,
  'the data provenance is stated in that dialog, not also in the sidebar',
);

ok(
  report.geolocateButtons === 1,
  `the map carries one 現在位置 button (${report.geolocateButtons})`,
);
ok(
  report.compassApart,
  'the compass sits on its own group, apart from the zoom buttons',
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

/* 操作面は地図の上に浮いている。畳んでも canvas の寸法は変わらない——変わる
 * のは地図の padding、つまり「地図が中心と見なす点」が箱をどれだけ避けるか
 * である。ここが守るのはその対応で、畳めば padding が消え、開き直せば戻る。
 *
 * 開いているあいだ閉じる口はパネル自身の × で、閉じているあいだ開き直す口は
 * 地図の上の釦である。どちらか一方だけが出ていることも併せて見る。 */
const folding = await page.evaluate(async () => {
  /* padding の変化は easeTo なので、押した瞬間はまだ途中である。MapLibre が
   * 落ち着いたと言うまで待つ。上限を置いて、来なければそのまま返す——下の
   * ok() がそれを失敗として述べる。 */
  const settled = () =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      window.map.once('idle', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  const left = () => Math.round(window.map.getPadding().left);
  const shown = (sel) => !!document.querySelector(sel).offsetParent;

  const open = {
    padding: left(),
    toggleShown: shown('#panel-toggle'),
    closeShown: shown('#panel-close'),
  };
  document.querySelector('#panel-close').click();
  await settled();
  const folded = {
    padding: left(),
    inert: document.querySelector('#panel').inert,
    toggleShown: shown('#panel-toggle'),
  };
  document.querySelector('#panel-toggle').click();
  await settled();
  return { open, folded, back: left() };
});
ok(
  folding.open.padding > 0,
  `the open panel pushes the map centre clear of it (${folding.open.padding}px)`,
);
ok(
  folding.folded.padding === 0,
  `folding the panel hands the map the whole window (${folding.folded.padding}px)`,
);
ok(
  folding.folded.inert,
  'the folded panel is inert, so tab cannot reach the controls parked behind it',
);
ok(
  folding.open.closeShown && !folding.open.toggleShown,
  'while open, the panel is closed by its own × and the map button is out of the way',
);
ok(
  folding.folded.toggleShown,
  'while folded, the map still carries the button that opens the panel again',
);
ok(
  folding.back === folding.open.padding,
  `unfolding puts the map back (${folding.back} vs ${folding.open.padding})`,
);

// The clear button is the only place the size of the selection is stated. A
// hint line under the list used to say "1 路線を選択中。" as well — a second
// answer to one question, and the one free to go stale. The button also has to
// go unavailable when there is nothing to undo rather than sit there doing
// nothing when pressed.
const clearBtn = () =>
  page.evaluate(() => {
    const b = document.querySelector('#sel-none');
    return { text: b.textContent, disabled: b.disabled };
  });
const idle = await clearBtn();
ok(
  idle.disabled && idle.text === '選択解除',
  `with nothing picked the clear button is unavailable ("${idle.text}", disabled=${idle.disabled})`,
);
// 一覧は畳んだ状態で始まるので、押す前に開く。
await page.click('#route-block > summary');
await settle();
await page.locator('#route-list input').first().check();
await settle();
const one = await clearBtn();
ok(
  !one.disabled && one.text === '1 路線を選択解除',
  `the clear button states how much it would undo ("${one.text}")`,
);
await page.click('#sel-none');
await settle();
const back = await clearBtn();
ok(
  back.disabled &&
    back.text === '選択解除' &&
    (await page.evaluate(
      () => document.querySelectorAll('#route-list input:checked').length === 0,
    )),
  `pressing it clears the selection and goes quiet again ("${back.text}")`,
);
ok(
  await page.evaluate(() => !document.querySelector('#sel-hint')),
  'the selection size is not also stated in a hint under the list',
);

await page.screenshot({ path: shot('1-all') });

// --- switch to "concurrent sections only" -----------------------------------
await page.click('input[name=conc][value=all]');
await settle();
const concStats = await page.evaluate(() => ({
  roads: window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
  stats: [...document.querySelectorAll('#stats dd')]
    .map((s) => s.textContent)
    .join(' | '),
}));
console.log(`\nafter "重用区間のみ": renderedRoads=${concStats.roads}`);
await page.screenshot({ path: shot('2-concurrent') });

// --- unfold the ranking and click its deepest row ---------------------------
await page.click('input[name=conc][value=off]');
await page.click('#ranking-block > summary');
await settle();
ok(
  await page.evaluate(() => document.querySelector('#ranking-block').open),
  'the ranking unfolds when its summary is clicked',
);
// A row names one concurrency and states where it is. Clicking it has to go
// there and leave the list alone — both used to fail. The camera was framed on
// the union of every combination sharing two of the row's numbers, which for
// the 高知市 row spanned 132.5°E–134.7°E, most of 四国; and selecting the row's
// routes rebuilt the list under the cursor, moving the row that was clicked.
const before = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#ranking .row')];
  return {
    refs: rows.map((r) => r.dataset.refs),
    bbox: rows[0].dataset.bbox.split(',').map(Number),
  };
});
await page.click('#ranking .row');
await settle();
await page
  .waitForFunction(() => !window.map.isMoving(), null, { timeout: 30000 })
  .catch(() => {});
await settle();
const jumped = await page.evaluate(() => ({
  center: window.map.getCenter().toArray(),
  zoom: window.map.getZoom(),
  refs: [...document.querySelectorAll('#ranking .row')].map(
    (r) => r.dataset.refs,
  ),
  marked: document.querySelectorAll('#ranking .row.on').length,
  checked: document.querySelectorAll('#route-list input:checked').length,
  roads: window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
}));
const [bw, bs, be, bn] = before.bbox;
const [clng, clat] = jumped.center;
console.log('');
console.log(
  `clicked ranking row 国道${before.refs[0].split(',').join('・')} — ` +
    `camera ${clng.toFixed(4)}, ${clat.toFixed(4)} @z${jumped.zoom.toFixed(2)}, ` +
    `${jumped.roads} roads on screen`,
);
// A degenerate box — one arc long, no extent at all — leaves the camera on its
// own centre, so the tolerance is what the padding can move it by.
ok(
  clng >= bw - 0.02 &&
    clng <= be + 0.02 &&
    clat >= bs - 0.02 &&
    clat <= bn + 0.02,
  `clicking a ranking row goes to that section (in ${before.bbox.join(', ')})`,
);
ok(
  JSON.stringify(jumped.refs) === JSON.stringify(before.refs),
  'the ranking list does not rebuild under the cursor',
);
ok(
  jumped.marked === 1,
  `the row that was clicked is marked (${jumped.marked})`,
);
ok(
  jumped.checked === 0,
  `going to a row leaves the route selection alone (${jumped.checked} ticked)`,
);
await page.screenshot({ path: shot('3-ranking-jump') });

// --- zoom in where the most routes run together -----------------------------
// The route-number labels have a minzoom, so they only prove themselves close
// in. The spot is derived from the data rather than hard-coded to one region.
// Nothing to clear here: going to a ranking row no longer selects anything.
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
await settle();
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
console.log(`  rendered route labels: ${labelled.count}`);
console.log(`  label values: ${labelled.sample.join(' , ')}`);
console.log(
  `  multi-designation labels: ${labelled.multi.join(' , ') || 'none'}`,
);
console.log(`  rendered terminus labels: ${labelled.termini}`);
await page.screenshot({ path: shot('4-labels') });

// --- clicking an arc: what the popup says, and the shadow that marks it -----
// The camera is on the deepest concurrency, so the arc under the middle of the
// canvas is the demanding case: several designations, one popup.
const target = await page.evaluate(() => {
  const m = window.map;
  const r = m.getCanvas().getBoundingClientRect();
  // 浮いている箱のぶん、地図の中心は画面の真ん中には無い。据えた地点が
  // 実際に落ちる画素から探し始める。
  const pad = m.getPadding();
  const cx = Math.round((r.width + pad.left - pad.right) / 2);
  const cy = Math.round((r.height + pad.top - pad.bottom) / 2);
  const ring = (d) => [
    [d, 0],
    [0, d],
    [-d, 0],
    [0, -d],
    [d, d],
    [-d, -d],
    [d, -d],
    [-d, d],
  ];
  for (let d = 0; d < 320; d += 5) {
    for (const [dx, dy] of ring(d)) {
      const f = m.queryRenderedFeatures([cx + dx, cy + dy], {
        layers: ['roads'],
      })[0];
      if (f)
        return {
          x: cx + dx + r.x,
          y: cy + dy + r.y,
          id: f.properties.id,
          refs: f.properties.refs.split(',').filter(Boolean),
        };
    }
  }
  return null;
});
if (!target) {
  fails.push('FAIL  no arc under the canvas centre to click');
} else {
  await page.mouse.click(target.x, target.y);
  await settle();
  const opened = await page.evaluate(() => {
    const el = document.querySelector('.maplibregl-popup-content');
    return {
      text: el ? el.innerText.replace(/\n/g, ' | ') : null,
      shields: [...document.querySelectorAll('.shield-btn')].map(
        (b) => b.dataset.ref,
      ),
      shadow: window.map
        .queryRenderedFeatures({ layers: ['picked'] })
        .map((f) => f.properties.id),
    };
  });
  console.log('');
  console.log(`clicked an arc: ${opened.text}`);
  ok(opened.text !== null, 'clicking an arc opens a popup');
  // The figure is one OSM way's length, not the route's, and the label has to
  // say so: as 延長 it read as though 国道4号 were 0.13 km long.
  ok(
    /区間長/.test(opened.text ?? '') && !/延長/.test(opened.text ?? ''),
    'the popup calls the arc length 区間長, not 延長',
  );
  ok(/典拠/.test(opened.text ?? ''), 'the popup calls the tagging 典拠');
  ok(
    JSON.stringify(opened.shields) === JSON.stringify(target.refs),
    `every designation on the arc is a button (${opened.shields.join(', ')})`,
  );
  ok(
    opened.shadow.length > 0 && opened.shadow.every((id) => id === target.id),
    `the shadow marks the arc that was clicked and nothing else ` +
      `(${opened.shadow.length} parts of way ${target.id})`,
  );
  await page.screenshot({ path: shot('7-picked') });

  /* 吹き出しの角は border で描いた三角形なので、色を差し替える辺は尖る向きで
   * 変わる——下向きなら border-top、左向きなら border-right である。残る二辺
   * は透明のままでなければ、三角ではなく四角になる。
   *
   * 上下の辺だけを差し替えていたころ、左右へ出た角は MapLibre 既定の白のまま
   * で、しかも塗られた上下が加わって四角に見えていた。出る向きは吹き出しが
   * 画面のどこに立つかで決まるので、普通に触っていて出会うのは八方向のうちの
   * 一つだけである。八つとも作って、幅を持つ辺のうち塗られているのがちょうど
   * 一つで、その色が吹き出しの地の色であることを見る。残りの辺が透明であること
   * は、この二つが言えれば同じことである。
   *
   * 幅を持つ辺が何本あるかは数えない。尖る向きと逆の辺を MapLibre が落とすの
   * で、四方は三本、四隅は二本になる——「三本あるはず」と書いて四隅で落ちた。 */
  const tips = await page.evaluate(() => {
    const anchors = [
      'top',
      'bottom',
      'left',
      'right',
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ];
    const clear = (c) => /^rgba\(.*,\s*0\)$/.test(c);
    return anchors.map((anchor) => {
      const p = new maplibregl.Popup({
        anchor,
        closeButton: false,
        closeOnClick: false,
      })
        .setLngLat(window.map.getCenter())
        .setHTML('<div style="width:80px;height:30px"></div>')
        .addTo(window.map);
      const el = p.getElement();
      // 地の色は書き写さず、その吹き出し自身から読む。style.css が var(--panel)
      // を両方に配っているので、食い違えばここで出る。
      const want = getComputedStyle(
        el.querySelector('.maplibregl-popup-content'),
      ).backgroundColor;
      const s = getComputedStyle(el.querySelector('.maplibregl-popup-tip'));
      const sides = ['Top', 'Bottom', 'Left', 'Right']
        .map((side) => ({
          side,
          width: Number.parseFloat(s[`border${side}Width`]),
          color: s[`border${side}Color`],
        }))
        .filter((x) => x.width > 0);
      p.remove();
      const painted = sides.filter((x) => !clear(x.color));
      return {
        anchor,
        why:
          painted.length !== 1
            ? `${painted.length} painted of ${sides.length} sides`
            : painted[0].color !== want
              ? `${painted[0].side} is ${painted[0].color}, not ${want}`
              : '',
      };
    });
  });
  const badTips = tips.filter((t) => t.why);
  ok(
    badTips.length === 0,
    `every popup tip is one panel-coloured triangle ` +
      `(${badTips.map((t) => `${t.anchor}: ${t.why}`).join('; ') || 'all 8 anchors'})`,
  );

  // Closing the popup has to take the shadow with it, or the map keeps a dark
  // smear over a road nothing is describing any more.
  await page.click('.maplibregl-popup-close-button');
  await settle();
  const closed = await page.evaluate(
    () => window.map.queryRenderedFeatures({ layers: ['picked'] }).length,
  );
  ok(closed === 0, `closing the popup clears the shadow (${closed} left)`);

  // 同じアークをもう一度開く。ここから先は標識を押して箱を出すところを見るが、
  // 箱を出すこと自体がポップアップを閉じるので、開き直さないと押す標識が無い。
  await page.mouse.click(target.x, target.y);
  await settle();

  // The sign is the button: pressing it opens the box that talks about that one
  // route. It used to narrow the selection instead, and this check still said
  // so long after #65 moved that to the box's own 「…だけを表示」 — the page had
  // changed and the check had not, so it failed on a page that was working.
  const ref = target.refs[0];
  // 箱を開ける前の padding。閉じたときにここへ戻ることが、下の「滑らない」と
  // 対になる不変条件である——左の列には操作面も居るので、戻る先は 0 とは
  // 限らない。
  const paddingBeforeBox = await page.evaluate(() => window.map.getPadding());
  await page.click('.shield-btn');
  await settle();
  const box = await page.evaluate(() => {
    const el = document.querySelector('#detail');
    return {
      open: el ? !el.hidden : false,
      text: el ? el.innerText.replace(/\s+/g, ' ') : '',
      popups: document.querySelectorAll('.maplibregl-popup').length,
      shadow: window.map.queryRenderedFeatures({ layers: ['picked'] }).length,
    };
  });
  ok(box.open, `pressing a sign opens the detail box (国道${ref}号)`);
  ok(
    box.text.includes(`国道${ref}号`),
    `the box names the route whose sign was pressed (国道${ref}号)`,
  );
  // 箱はアーク 1 本ではなく路線そのものについて述べる。ポップアップを後ろに
  // 残すと同じ画面で二つが別のことを語るので、箱を出すときに引き取る。
  ok(
    box.popups === 0,
    `opening the box closes the popup behind it (${box.popups} left)`,
  );
  ok(box.shadow === 0, `and takes the shadow with it (${box.shadow} left)`);

  /* 起終点は政令の別表から来る。書く側(pack_web.mjs の decree 欄)と読む側
   * (detail.mjs の decreeTerminiOf)が同じ名前を指しているかは、実データを
   * 通してしか分からない。名前が食い違っても例外は出ず、欄が黙って空になる
   * だけである。実際 #64 と #65 は違う名前を選び、両方が main に乗ったまま
   * 誰も転ばなかった。meta が持っている地名を、画面に出ているか直接見る。 */
  const decreeRow = meta.decree?.routes?.find((r) => String(r.ref) === ref);
  const wanted = [decreeRow?.start?.name, decreeRow?.end?.name].filter(Boolean);
  ok(
    wanted.length === 2,
    `the meta carries both decree termini for 国道${ref}号 (${wanted.join(' / ') || 'none'})`,
  );
  const missing = wanted.filter((n) => !box.text.includes(n));
  ok(
    wanted.length === 2 && missing.length === 0,
    `the box shows the decree termini the meta gave it ` +
      `(${wanted.join(' / ')}${missing.length ? `; missing ${missing.join(' / ')}` : ''})`,
  );

  /* 関わりのある国道は、meta の三つの欄——組み合わせ表・起終点の共有・交差の
   * 表——を突き合わせて出る。その読み方をここに書き写すと、写したほうを検査
   * することになるので、画面が使う関数をそのまま呼んで突き合わせる。
   *
   * 交差の表(`crossings`)は pack_web.mjs が書く欄である。古い web/data には
   * 無く、無ければ交差の節が出ないのが正しい振る舞いなので、meta がその欄を
   * 持っていること自体もここで言う。 */
  ok(
    Array.isArray(meta.crossings) && meta.crossings.length > 0,
    `the meta carries the crossing table (${meta.crossings?.length ?? 0} pairs)`,
  );
  const wantRel = relatedRoutesOf(meta, Number(ref));
  const shownRel = await page.evaluate(() =>
    [...document.querySelectorAll('.detail-rel')].map((el) => ({
      label: el.querySelector('.detail-sub').textContent,
      refs: [...el.querySelectorAll('.shield-btn')].map((b) =>
        Number(b.dataset.ref),
      ),
    })),
  );
  const want = wantRel.map((g) => ({ label: g.label, refs: g.refs }));
  ok(
    JSON.stringify(shownRel) === JSON.stringify(want),
    `the box lists the related routes the meta implies ` +
      `(${want.map((g) => `${g.label} ${g.refs.length}`).join(', ') || 'none'})`,
  );

  /* 並べた標識は押せる。押せばその路線の箱に開き直る。
   *
   * 関わりは相互なので、開いた先には必ず元の路線の標識がある——重用も、起終点
   * の共有も、交差も、どちらから見ても同じ関わりだからである。押して戻れる
   * ことまで見て、この後の検査を元の路線の箱で続ける。 */
  if (want.length) {
    const other = want[0].refs[0];
    await page.click(`.detail-rel .shield-btn[data-ref="${other}"]`);
    await settle();
    const switched = await page.evaluate(() =>
      document.querySelector('#detail').innerText.replace(/\s+/g, ' '),
    );
    ok(
      switched.includes(`国道${other}号`),
      `pressing a related sign opens that route's box (国道${other}号)`,
    );
    const back = await page
      .locator(`.detail-rel .shield-btn[data-ref="${ref}"]`)
      .count();
    ok(
      back === 1,
      `and that box lists the one we came from, because the relation goes ` +
        `both ways (国道${ref}号)`,
    );
    if (back) {
      await page.click(`.detail-rel .shield-btn[data-ref="${ref}"]`);
      await settle();
    }
  }

  // Narrowing the map to one route moved into the box with #65.
  await page.click('.detail-only');
  await settle();
  const narrowed = await page.evaluate(() =>
    [...document.querySelectorAll('#route-list input:checked')].map(
      (i) => i.value,
    ),
  );
  ok(
    JSON.stringify(narrowed) === JSON.stringify([ref]),
    `the box's 「だけを表示」 selects that route alone (${narrowed.join(', ')})`,
  );

  /* 箱は地図の一部を覆うので、開くあいだ地図は覆われたぶん脇へ寄る。開けて
   * 読んで閉じるだけなら、閉じたときに寄せたぶんが戻るのが正しい——開く前の
   * 眺めに戻ることだからである。
   *
   * 開いているあいだに地図を動かしたなら話が変わる。今の眺めは利用者が選んだ
   * ものなので、閉じた拍子に横へ滑るのはただのずれである。寄せ幅は padding
   * で、画面には出ない。絵が動いたかどうかは、画面の真ん中に写っている地点が
   * 変わったかで見る。 */
  const midpoint = () =>
    page.evaluate(() => {
      const r = document.querySelector('#map').getBoundingClientRect();
      const p = window.map.unproject([r.width / 2, r.height / 2]);
      return [p.lng, p.lat];
    });
  const apart = (from, to) =>
    page.evaluate(
      ([from, to]) => {
        const a = window.map.project(from);
        const b = window.map.project(to);
        return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
      },
      [from, to],
    );

  const canvasBox = await page.locator('#map').boundingBox();
  const at = (fx, fy) => [
    canvasBox.x + canvasBox.width * fx,
    canvasBox.y + canvasBox.height * fy,
  ];
  await page.mouse.move(...at(0.7, 0.6));
  await page.mouse.down();
  await page.mouse.move(...at(0.55, 0.45), { steps: 12 });
  await page.mouse.up();
  await settle();
  const before = await midpoint();
  await page.click('#detail-close');
  await settle();
  const slid = await apart(before, await midpoint());
  ok(
    slid === 0,
    `closing the box after moving the map leaves the view where it is ` +
      `(${slid}px)`,
  );
  // 滑らなかったのは padding を外し忘れたからではない、と言えるようにする。
  const padding = await page.evaluate(() => window.map.getPadding());
  ok(
    JSON.stringify(padding) === JSON.stringify(paddingBeforeBox),
    `and the box's padding is gone (${JSON.stringify(padding)} vs ` +
      `${JSON.stringify(paddingBeforeBox)})`,
  );
}

// Back to everything: the checks below count what each prefecture draws.
await page.evaluate(() => {
  for (const cb of document.querySelectorAll('#route-list input:checked')) {
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await settle();

// --- 点線国道 / 工事中: locate them from the data instead of guessing -------
const midOf = (f) =>
  f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
const firstOf = (kind) => features.find((f) => f.properties.kind === kind);

for (const [kind, layer, caption] of [
  ['foot', 'foot', '点線国道（徒歩道）'],
  ['construction', 'construction', '工事中区間'],
  ['unopened', 'unopened', '未開通区間'],
  ['expressway', 'expressway', '自動車専用道路'],
  ['ferry', 'ferry', '海上国道（航路）'],
]) {
  const f = firstOf(kind);
  if (!f) {
    console.log(`\n${caption}: no arc of kind=${kind} in the data`);
    continue;
  }
  const at = midOf(f);
  await page.evaluate((c) => window.map.jumpTo({ center: c, zoom: 13.5 }), at);
  await settle();
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
      (seen.length ? `: ${JSON.stringify(seen[0])}` : ''),
  );
  ok(
    seen.length > 0,
    `${caption} draws on its own dashed layer (${seen.length} arcs)`,
  );
  await page.screenshot({ path: shot(`5-${kind}`) });
}

// --- 自動車専用道路 must switch off on its own -------------------------------
// Unlike the dashed kinds, this one is ordinary driveable carriageway styled
// exactly like `roads` — the toggle is the only thing distinguishing it, so
// it is the only thing worth exercising here. Navigated explicitly rather than
// relying on wherever the kind loop above left the camera, so this check does
// not depend on its position in that loop.
const expresswayArc = firstOf('expressway');
if (expresswayArc) {
  await page.evaluate(
    (c) => window.map.jumpTo({ center: c, zoom: 13.5 }),
    midOf(expresswayArc),
  );
  await settle();
  const expressways = () =>
    page.evaluate(
      () => window.map.queryRenderedFeatures({ layers: ['expressway'] }).length,
    );
  const shown = await expressways();
  await page.uncheck('#t-expressway');
  await settle();
  const hidden = await expressways();
  await page.check('#t-expressway');
  await settle();
  const back = await expressways();
  ok(
    shown > 0 && hidden === 0 && back === shown,
    `自動車専用道路 switches off and back on (${shown} → ${hidden} → ${back})`,
  );
} else {
  console.log(
    '\n自動車専用道路: no expressway arc built — the toggle is not exercised',
  );
}

// --- 海上国道 must switch off on its own ------------------------------------
// The sea sections are the one kind with no road underneath, so taking them
// off the map is exactly what the toggle is for. Navigated explicitly — the
// expressway check above already moved the camera off wherever the kind loop
// left it, so this can no longer assume it is still there either.
const ferryArc = firstOf('ferry');
if (ferryArc) {
  await page.evaluate(
    (c) => window.map.jumpTo({ center: c, zoom: 13.5 }),
    midOf(ferryArc),
  );
  await settle();
  const ferries = () =>
    page.evaluate(
      () => window.map.queryRenderedFeatures({ layers: ['ferry'] }).length,
    );
  const shown = await ferries();
  await page.uncheck('#t-ferry');
  await settle();
  const hidden = await ferries();
  await page.check('#t-ferry');
  await settle();
  const back = await ferries();
  ok(
    shown > 0 && hidden === 0 && back === shown,
    `海上国道 switches off and back on (${shown} → ${hidden} → ${back})`,
  );
} else {
  console.log('\n海上国道: no ferry arc built — the toggle is not exercised');
}

// --- former designations (#84): the one meta → DOM path bun test never walks
// former_km lives in each combination row next to kinds, and formerKmFor()
// (aggregate.mjs) sums it exactly the way kindsFor() sums kinds. bun test only
// ever hands detailHTML() a literal former_km, so it never reads the field by
// name — a rename in pack_web.mjs (the #64/#65 shape of bug: the field still
// exists, just under a different name than the code reads) would make
// formerKmFor() return 0 forever and the row vanish from the box. No
// exception, no console error, bun test still green throughout.
//
// 国道10号 has 30.8 km of former designation; 国道4号 has none. Picking by ref
// rather than by whatever the cursor lands on (as the arc click above does)
// means both branches — row shown, row omitted — run every time this check
// does, instead of only when the dice land on a route that happens to have one.
const arcOf = (ref) =>
  features.find(
    (f) => f.properties.kind === 'road' && f.properties.refs_list.includes(ref),
  );

const formerRowFor = async (ref) => {
  const arc = arcOf(ref);
  if (!arc) return undefined; // no arc for this ref in the build at all
  await page.evaluate(
    (c) => window.map.jumpTo({ center: c, zoom: 13.5 }),
    midOf(arc),
  );
  await settle();
  // Same ring search as the arc-click test above (473 行), but aimed at a
  // specific ref instead of whatever sits under the canvas centre.
  const hit = await page.evaluate((wantRef) => {
    const m = window.map;
    const r = m.getCanvas().getBoundingClientRect();
    // 浮いている箱のぶん、地図の中心は画面の真ん中には無い。据えた地点が
    // 実際に落ちる画素から探し始める。
    const pad = m.getPadding();
    const cx = Math.round((r.width + pad.left - pad.right) / 2);
    const cy = Math.round((r.height + pad.top - pad.bottom) / 2);
    const ring = (d) => [
      [d, 0],
      [0, d],
      [-d, 0],
      [0, -d],
      [d, d],
      [-d, -d],
      [d, -d],
      [-d, d],
    ];
    for (let d = 0; d < 320; d += 5) {
      for (const [dx, dy] of ring(d)) {
        const feat = m
          .queryRenderedFeatures([cx + dx, cy + dy], { layers: ['roads'] })
          .find((f) => f.properties.refs.split(',').includes(String(wantRef)));
        if (feat) return { x: cx + dx + r.x, y: cy + dy + r.y };
      }
    }
    return null;
  }, ref);
  if (!hit) return undefined; // in the data, but nothing rendered there
  await page.mouse.click(hit.x, hit.y);
  await settle();
  await page.click(`.shield-btn[data-ref="${ref}"]`);
  await settle();
  const dd = await page.evaluate(() => {
    const dt = [...document.querySelectorAll('#detail dt')].find(
      (d) => d.textContent === 'うち旧道',
    );
    return dt ? dt.nextElementSibling.textContent : null;
  });
  await page.click('#detail-close');
  await settle();
  return dd; // "30.8 km", or null if the row is absent
};

// Both sides of the comparison below read meta.combinations through
// formerKmFor() — once because that is what the running page calls, once to
// compute what the page ought to show. If pack_web.mjs renamed the field,
// formerKmFor() would return 0 on *both* sides and they would agree, green,
// on the wrong answer — the same shape of self-agreeing check f694172 fixed
// for the dl-position test. 国道10号 having a nonzero former_km is a fact
// about the real network, independent of what this file's meta happens to
// contain, so it is asserted here on its own, first: if this comes back 0,
// the field is gone or renamed, not that 10号 lost its former road.
const anchorKm = formerKmFor(meta.combinations, new Set([10]));
ok(
  anchorKm > 0,
  `the meta still carries former_km for 国道10号 (${anchorKm} km) — 0 would ` +
    `mean the field was dropped or renamed, not that 10号 has no former road`,
);

// The expected row's text comes from detailHTML() itself, not from retyping
// fmtKm's rounding and formerRowHTML's "0.0 → no row" rule here (CLAUDE.md:
// 検証スクリプトは本物の定義を読み込んで検査する). Only former_km needs to be
// the real, freshly-read value; the rest of `route` just has to be a route
// that exists, so detailHTML has something to build the rest of the box from.
const expectedFormerRow = (ref) => {
  const route = routesOf(meta.combinations).find((r) => r.ref === ref);
  if (!route) return undefined; // ref not in this build at all
  const html = detailHTML({
    route,
    formerKm: formerKmFor(meta.combinations, new Set([ref])),
  });
  return html.match(/<dt>うち旧道<\/dt><dd>([^<]*)<\/dd>/)?.[1] ?? null;
};

for (const ref of [10, 4]) {
  const shownRow = await formerRowFor(ref);
  if (shownRow === undefined) {
    fails.push(
      `FAIL  no clickable arc for 国道${ref}号 (former-designation check)`,
    );
    continue;
  }
  const wantRow = expectedFormerRow(ref);
  if (wantRow === undefined) {
    fails.push(
      `FAIL  国道${ref}号 is missing from routesOf() (former-designation check)`,
    );
    continue;
  }
  ok(
    shownRow === wantRow,
    `国道${ref}号's box shows うち旧道 the way the meta has it ` +
      `(want ${wantRow ?? 'no row'}, got ${shownRow ?? 'no row'})`,
  );
}

// --- every region's data must actually be on the map ------------------------
// One region failing to make it into the archive would look almost the same
// from the panel, so every prefecture is visited and its roads counted.
console.log('');
const empty = [];
for (const r of index) {
  const [w, s, e, n] = extents.get(r.region);
  await page.evaluate(
    (b) => window.map.fitBounds(b, { padding: 10, duration: 0 }),
    [
      [w, s],
      [e, n],
    ],
  );
  await settle();
  const roads = await page.evaluate(
    () => window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
  );
  if (roads === 0) empty.push(r.label);
  process.stdout.write(
    `\r  ${r.label.padEnd(6)} ${String(roads).padStart(6)} roads   `,
  );
}
process.stdout.write('\n');
ok(
  empty.length === 0,
  `every prefecture renders roads from the archive (${empty.length ? empty.join(', ') : `all ${index.length}`})`,
);

// The whole country at once is the view the project exists for, and the zoom
// where a missing low-zoom tile pyramid would show.
await page.evaluate(
  (b) =>
    window.map.fitBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      { padding: 20, duration: 0 },
    ),
  meta.bbox,
);
await settle();
const wide = await page.evaluate(
  () => window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
);
ok(wide > 0, `the whole country draws at the overview zoom (${wide} roads)`);
await page.screenshot({ path: shot('6-nationwide') });

console.log(fails.length ? `\n${fails.join('\n')}` : '');
console.log(
  `\nbasemap tiles with nothing to draw (open sea etc.): ${blankTiles.length}`,
);
console.log(
  `console errors: ${errors.length ? `\n  ${errors.join('\n  ')}` : 'none'}`,
);
console.log(`screenshots: ${OUTDIR}`);
await browser.close();
process.exit(errors.length || fails.length ? 1 : 0);
