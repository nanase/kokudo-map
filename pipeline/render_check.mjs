/* 本物のページを Chromium で開き、実際に描かれることを確かめる。コンソールに
 * エラーが出ないこと、層が在ること、特徴量を問い合わせられること、絞り込みが
 * 切り替わることである。
 *
 * ページは生成済みの地域を全部 1 枚の地図に結合するので、ここで使う手掛かりも、
 * 1 地域のファイルではなく同じ結合から作る。 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

import { DATA, REGIONS, ROOT } from './_paths.mjs';

// 下地図の URL は書き写さず本物のスタイルから読む。式の検査スクリプトが
// mapspec を import するのと同じ理由である。写しは、検査するために書いた当の
// 物を検査しなくなる。
const { GSI_TILES } = await import(
  pathToFileURL(join(ROOT, 'web', 'mapspec.mjs')).href
);
// 同じ理由である。パネルの三つの節は meta の三つの欄に対する規則で、その写しを
// ここに置けば、ページが走らせている当の規則を検査しなくなる。detailHTML を
// 併せて import してあるのは、下の旧道の検査が、期待する行を本物の整形規則
// (fmtKm と、formerRowHTML の「0.0 なら行を出さない」)を通して組めるように
// するためである。規則をここへ書き写さずに済む。
const { relatedRoutesOf, detailHTML } = await import(
  pathToFileURL(join(ROOT, 'web', 'detail.mjs')).href
);
// これも同じ理由である。former_km の meta から DOM までの経路(#84)は、bun test
// が実際の欄名で辿ることのない、詳細パネルの唯一の部分である——bun test が
// detailHTML() に渡すのはいつも直値だからである。欄を実際に読む関数は
// formerKmFor() なので、それを import することで、decree.routes や crossings の
// 改名に気付くのと同じようにこのファイルが気付ける。routesOf が一緒に来るのは、
// detailHTML() が former_km の数だけでなく路線のオブジェクトを必要とするためで
// ある。
const { formerKmFor, routesOf } = await import(
  pathToFileURL(join(ROOT, 'web', 'aggregate.mjs')).href
);
const TILE_HOST = new URL(GSI_TILES).host;

// URL という名前は付けない。下で使うグローバルの URL を隠してしまう。PORT は
// serve.py に合わせる。8000 を他が既に握っている場合のためである。
const PAGE =
  process.env.MAP_URL || `http://localhost:${process.env.PORT || 8000}/`;

// 画面写真は 1 回の実行の証拠であって生成物ではないので、作業ツリーの外へ書く。
// 手元に残したいときは、置き場所をディレクトリで渡す。
const OUTDIR =
  process.argv[2] || mkdtempSync(join(tmpdir(), 'national-route-map-'));
mkdirSync(OUTDIR, { recursive: true });
const shot = (name) => join(OUTDIR, `${name}.png`);

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// パックした側が行ったのと同じ結合である。タイルから読み戻さず、地域ごとの
// 生成物からここでやり直す。下の手掛かりが、アーカイブにたまたま入っている物
// ではなく、ビルドが決めた物から作られるようにするためである——この実行の目的は、
// その二つが一致するかを知ることである。
const index = read(join(DATA, 'regions.json'));
const meta = read(join(DATA, 'national.meta.json'));
const byId = new Map();
// 地域の道が実際にどこに在るか。地域の bbox は県の輪郭に外接する矩形で——
// 東京都は南鳥島まで及ぶ——bbox へ飛ぶと視点が大海原を向く。
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

// 国土地理院は描く物が無い場所にラスタタイルを置かないので、大海原へ引くと
// 404 が返る。それは下地図が設計どおりに動いている姿であり、海上国道の検査は
// そこへ意図して行く。それ以外の失敗した要求は本物の不具合なので、URL 付きで
// 報告する。
const blankTiles = [];

page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // 資源の取得失敗はコンソールの文面に URL を持たない。下で URL 付きで捕まえる
  // ので、両方を残すと同じ物が二度並ぶだけである。
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

// 覆いは boot() が終われば display:none になるので、見えるかどうかではなく
// クラスで待つ。
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
  // #stats は今、閉じている「国道マップについて」のダイアログの中に居る。
  // 閉じた <dialog> は何も描かず、描かれていない物に対して `innerText` は空を
  // 返す。`textContent` は配置を気にしないので、四つの数は <dd> から直接読む。
  out.stats = [...document.querySelectorAll('#stats dd')]
    .map((s) => s.textContent)
    .join(' | ');
  // このページが土台にしている、画面についての三つの判断。
  out.regionPickers = document.querySelectorAll('select#region').length;
  out.concOptions = [...document.querySelectorAll('input[name=conc]')].map(
    (i) => i.value,
  );
  // 地図の上のボタン。現在位置は MapLibre 自身の部品なので、あるかどうかだけを見る
  // (押すと端末の許可を求めるので、ここでは押さない)。方位は拡大・縮小とは
  // 別の台に乗っている——同じ群に並んでいると、拡大を連打する指が地図を回す。
  // 重用区間と表示は地図の側にある。同じものが操作面にも残っていれば、
  // どちらを押したかで結果が変わる二つの口ができてしまう。
  out.togglesInPanel = document.querySelectorAll(
    '#panel .checks input, #panel input[name=conc]',
  ).length;
  out.paneButtons = document.querySelectorAll('#display-btn').length;
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

/* ---- 画面が守るべきこと -------------------------------------------------- */
ok(
  report.regionPickers === 0,
  'no region picker: the map is not scoped to one prefecture',
);
ok(
  report.routeCount >= Math.max(...index.map((r) => r.routes)),
  `the route list covers every region at once (${report.routeCount} routes)`,
);
// 操作面はもう特徴量を数えない——大半が読み込まれていないので数えられない——
// ので、そこが述べる数は、描いた時点でたまたま画面に出ていた物ではなく、ビルド
// が出した数でなければならない。
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
  report.paneButtons === 1 && report.togglesInPanel === 0,
  'the concurrency and display switches are on the map, not also in the sidebar',
);
/* 配色は同じ面の中から選ぶ。色そのものは style.css の light-dark() が両方
 * 述べているので、ここが確かめるのは「選んだ側が data-theme に出て、面の地の
 * 色がそれで変わる」ことだけである。 */
const themed = await page.evaluate(() => {
  const root = document.documentElement;
  const panelBg = () =>
    getComputedStyle(document.querySelector('#panel')).backgroundColor;
  const pick = (value) => {
    const el = document.querySelector(`input[name=theme][value="${value}"]`);
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { attr: root.dataset.theme, panel: panelBg() };
  };
  const dark = pick('dark');
  const light = pick('light');
  pick('auto'); // 検査のために選んだだけなので、端末任せに戻しておく
  return { dark, light, auto: root.dataset.theme };
});
ok(
  themed.dark.attr === 'dark' && themed.light.attr === 'light',
  `picking a colour scheme writes it on the root (${themed.dark.attr} / ${themed.light.attr})`,
);
ok(
  themed.dark.panel !== themed.light.panel,
  `and the panel actually changes ground with it (${themed.dark.panel} vs ${themed.light.panel})`,
);
ok(
  themed.auto === 'light' || themed.auto === 'dark',
  `following the device still resolves to one side (${themed.auto})`,
);

ok(
  report.geolocateButtons === 1,
  `the map carries one 現在位置 button (${report.geolocateButtons})`,
);
ok(
  report.compassApart,
  'the compass sits on its own group, apart from the zoom buttons',
);
// 参照用の一覧は畳んであるが、畳んだこと自体を隠す畳み方は、節約した高さより
// 害が大きい。だからどの見出しも自分の大きさを述べ続けなければならない。
for (const b of report.folded) {
  ok(b.open === false, `the ${b.name} list starts folded`);
  ok(
    /\d/.test(b.count),
    `the folded ${b.name} list still states its size ("${b.count}")`,
  );
}

/* 操作面は地図の上に浮いている。畳んでも canvas の寸法は変わらない——変わる
 * のは地図の padding、つまり「地図が中心と見なす点」がパネルをどれだけ避けるか
 * である。ここが守るのはその対応で、畳めば padding が消え、開き直せば戻る。
 *
 * 開いているあいだ閉じる口はパネル自身の × で、閉じているあいだ開き直す口は
 * 地図の上のボタンである。どちらか一方だけが出ていることも併せて見る。 */
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

// 選択の大きさを述べるのは、選択解除のボタンだけである。かつては一覧の下の
// 補助の行も「1 路線を選択中。」と述べていた。一つの問いへの二つ目の答えで、
// しかも古くなり放題だった。取り消す物が無いとき、ボタンは押しても何も起きない
// のではなく、押せなくならなければならない。
// 文字を持たないボタンなので、どれだけ取り消すかはラベル (title/aria-label)
// が述べる。
const clearBtn = () =>
  page.evaluate(() => {
    const b = document.querySelector('#sel-none');
    return {
      text: b.title,
      aria: b.getAttribute('aria-label'),
      disabled: b.disabled,
      open: document.querySelector('#route-block').open,
    };
  });
const idle = await clearBtn();
ok(
  idle.disabled && idle.text === '選択解除' && idle.aria === '選択解除',
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
// ボタンは summary の中に居る。押して折りたたみまで開け閉てしては、押した人が
// 頼んでいないことが起きる。
ok(back.open, 'clearing the selection does not fold the list away');
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

/* 重用区間と表示は、地図の上のボタンから出る面の中にある。中の操作は面が開いて
 * いなければ届かないので、押す前に開ける。開いていれば何もしない——もう一度
 * 押すと畳んでしまう。 */
const openPane = async (btn) => {
  const shut = await page.evaluate(
    (sel) =>
      document.querySelector(sel).getAttribute('aria-expanded') !== 'true',
    btn,
  );
  if (shut) await page.click(btn);
};

// --- 「重用区間のみ」へ切り替える -------------------------------------------
await openPane('#display-btn');
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

// --- 重用ランキングを開き、最も深い行を押す --------------------------------
await openPane('#display-btn');
await page.click('input[name=conc][value=off]');
await page.click('#ranking-block > summary');
await settle();
ok(
  await page.evaluate(() => document.querySelector('#ranking-block').open),
  'the ranking unfolds when its summary is clicked',
);
// 行は 1 つの重用を名指しし、それがどこに在るかを述べる。押したらそこへ行き、
// 一覧には手を触れないことが必要である——かつてはどちらも破れていた。視点は、
// 番号のうち 2 つを共有する組み合わせ全部の和に合わされ、高知市の行では東経
// 132.5 度から 134.7 度、四国の大半に及んだ。しかも行の路線が選択されるので、
// 指の下で一覧が組み直され、押した行そのものが動いた。
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
// 潰れた bbox——アーク 1 本ぶんで広がりを持たない——では視点はその中心に留まる
// ので、許容差は padding が動かしうる量である。
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

// --- 最も多くの路線が一緒に走る場所へ寄る ----------------------------------
// 路線番号のラベルは minzoom を持つので、寄らなければ自分を証明できない。場所は
// 1 地域に決め打ちせず、データから作る。ここで解除する物は無い。ランキングの行へ
// 行っても、もう何も選択されない。
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

// --- アークを押す。ポップアップが述べることと、押した印の影 ----------------
// 視点は最も深い重用の上に在るので、canvas の中央の下にあるアークは厳しい場合に
// なる。指定が複数あって、ポップアップは 1 つである。
const target = await page.evaluate(() => {
  const m = window.map;
  const r = m.getCanvas().getBoundingClientRect();
  // 浮いているパネルのぶん、地図の中心は画面の真ん中には無い。据えた地点が
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
  // この数は OSM の way 1 本の長さであって路線の延長ではない。ラベルもそう述べ
  // なければならない。「延長」と書くと、国道 4 号が 0.13 km に読めた。
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

  // ポップアップを閉じたら影も一緒に消えなければならない。そうでないと、もう
  // 誰も説明していない道の上に、黒い滲みが残る。
  await page.click('.maplibregl-popup-close-button');
  await settle();
  const closed = await page.evaluate(
    () => window.map.queryRenderedFeatures({ layers: ['picked'] }).length,
  );
  ok(closed === 0, `closing the popup clears the shadow (${closed} left)`);

  // 同じアークをもう一度開く。ここから先は標識を押してパネルを出すところを見るが、
  // パネルを出すこと自体がポップアップを閉じるので、開き直さないと押す標識が無い。
  await page.mouse.click(target.x, target.y);
  await settle();

  // 標識がボタンである。押せば、その路線 1 本について述べるパネルが開く。以前は
  // 代わりに選択を絞っており、#65 がその役目をパネル自身の「…だけを表示」へ
  // 移した後も、この検査は長らく絞り込みを求め続けていた。動いているページに
  // 対して落ちたのは、画面が変わり、検査が変わっていなかったからである。
  const ref = target.refs[0];
  // パネルを開ける前の padding。閉じたときにここへ戻ることが、下の「滑らない」と
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
  // パネルはアーク 1 本ではなく路線そのものについて述べる。ポップアップを後ろに
  // 残すと同じ画面で二つが別のことを述べるので、パネルを出すときに引き取る。
  ok(
    box.popups === 0,
    `opening the box closes the popup behind it (${box.popups} left)`,
  );
  ok(box.shadow === 0, `and takes the shadow with it (${box.shadow} left)`);

  /* 起終点は政令の別表から来る。書く側(pack_web.mjs の decree 欄)と読む側
   * (detail.mjs の decreeTerminiOf)が同じ名前を指しているかは、実データを
   * 通してしか分からない。名前が食い違っても例外は出ず、欄が気付かないまま空になる
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

  /* 並べた標識は押せる。押せばその路線のパネルに開き直る。
   *
   * 関わりは相互なので、開いた先には必ず元の路線の標識がある——重用も、起終点
   * の共有も、交差も、どちらから見ても同じ関わりだからである。押して戻れる
   * ことまで見て、この後の検査を元の路線のパネルで続ける。 */
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

  // 地図を 1 路線に絞る操作は、#65 で詳細パネルの中へ移った。
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

  /* パネルは地図の一部を覆うので、開くあいだ地図は覆われたぶん脇へ寄る。開けて
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

// すべてに戻す。以下の検査は、県ごとに何が描かれるかを数える。
await page.evaluate(() => {
  for (const cb of document.querySelectorAll('#route-list input:checked')) {
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
await settle();

// --- 点線国道・工事中。当てずっぽうではなくデータから場所を求める ---------
const midOf = (f) =>
  f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
const firstOf = (kind) => features.find((f) => f.properties.kind === kind);

for (const [kind, layer, caption] of [
  ['foot', 'foot', '点線国道(徒歩道)'],
  ['construction', 'construction', '工事中区間'],
  ['unopened', 'unopened', '未開通区間'],
  ['expressway', 'expressway', '自動車専用道路'],
  ['ferry', 'ferry', '海上国道(航路)'],
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

// --- 自動車専用道路が単独で消せること ---------------------------------------
// 破線の区分と違い、これは `roads` とまったく同じ体裁で描かれる、走れるふつうの
// 車道である——見分けるのは表示の切り替えだけなので、ここで動かす値打ちがあるの
// もそれだけである。上の区分の繰り返しが視点をどこへ置いたかに頼らず、明示的に
// 移動する。この検査が繰り返しの中での位置に依存しないようにするためである。
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
  await openPane('#display-btn');
  await page.uncheck('#t-expressway');
  await settle();
  const hidden = await expressways();
  await openPane('#display-btn');
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

// --- 海上国道が単独で消せること --------------------------------------------
// 海上区間は、下に道が無い唯一の区分である。地図から外せることこそ、この切り替え
// の役目である。ここも明示的に移動する——上の自動車専用道路の検査が既に視点を
// 動かしているので、区分の繰り返しが残した位置に居るとは、こちらも仮定できない。
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
  await openPane('#display-btn');
  await page.uncheck('#t-ferry');
  await settle();
  const hidden = await ferries();
  await openPane('#display-btn');
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

// --- 旧道(#84)。bun test が辿らない、meta から DOM への唯一の経路
// former_km は組み合わせの各行に kinds と並んで載っており、formerKmFor()
// (aggregate.mjs)が kindsFor() の kinds とまったく同じやり方で足す。bun test が
// detailHTML() に渡すのは直値の former_km だけなので、欄を名前で読むことが無い
// ——pack_web.mjs での改名(#64・#65 と同じ形の不具合。欄は在るが、コードが読む
// 名前と違う名前になっている)が起きると、formerKmFor() は永遠に 0 を返し、行は
// パネルから消える。例外も出ず、コンソールにも何も出ず、bun test は緑のままで
// ある。
//
// 国道 10 号は旧道を 30.8 km 持ち、国道 4 号は持たない。上のアークの押下のように
// 指の落ちた先で選ばず ref で選ぶので、行が出る側と出ない側の両方が、この検査の
// たびに毎回走る。たまたま旧道を持つ路線に当たった回だけ、ではない。
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
  // 上のアークの押下の検査(473 行)と同じ輪の探索だが、canvas の中央の下に在る
  // 物ではなく、特定の ref を狙う。
  const hit = await page.evaluate((wantRef) => {
    const m = window.map;
    const r = m.getCanvas().getBoundingClientRect();
    // 浮いているパネルのぶん、地図の中心は画面の真ん中には無い。据えた地点が
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

// 下の比較は、両側とも formerKmFor() を通して meta.combinations を読む——片方は
// 走っているページが呼ぶのがそれだからで、もう片方はページが出すべき値を求める
// ためである。pack_web.mjs が欄を改名すれば、formerKmFor() は両側とも 0 を返し、
// 二つは誤った答えの上で一致して緑になる——f694172 が dl の位置の検査で直した
// のと同じ、自分と一致するだけの検査である。国道 10 号が 0 でない former_km を
// 持つことは、このファイルの meta にたまたま何が入っているかとは無関係な、実在
// の道路網についての事実である。だからそれだけを先に断定する。0 が返ってきたら、
// 10 号が旧道を失ったのではなく、欄が消えたか改名されたのである。
const anchorKm = formerKmFor(meta.combinations, new Set([10]));
ok(
  anchorKm > 0,
  `the meta still carries former_km for 国道10号 (${anchorKm} km) — 0 would ` +
    `mean the field was dropped or renamed, not that 10号 has no former road`,
);

// 期待する行の文面は detailHTML() 自身から得る。fmtKm の丸めと formerRowHTML の
// 「0.0 なら行を出さない」規則をここへ書き写すのではない(CLAUDE.md の
// 「検証スクリプトは本物の定義を読み込んで検査する」)。本物でなければならないの
// は former_km だけで、それはいま読んだ値である。`route` の残りは実在する路線で
// ありさえすればよい。detailHTML がパネルの残りを組む材料になるためである。
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

// --- どの地域のデータも実際に地図に載っていること --------------------------
// 1 地域がアーカイブに入り損ねても、操作面から見た姿はほとんど変わらない。だから
// 県を全部訪ね、その道を数える。
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

// 全国が一度に入る眺めは、このプロジェクトが存在する理由そのものであり、低い
// ズームのタイルのピラミッドが欠けていれば、それが現れるズームでもある。
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
