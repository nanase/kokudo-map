/* 本物のページを Chromium で開き、実際に描かれることを確かめる。コンソールに
 * エラーが出ないこと、層が在ること、特徴量を問い合わせられること、絞り込みが
 * 切り替わることである。
 *
 * ページは生成済みの地域を全部 1 枚の地図に結合するので、ここで使う手掛かりも
 * 同じ結合から作る。 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

import { DATA, PREFECTURAL, REGIONS, ROOT } from './_paths.mjs';

// 下地図の URL は書き写さず本物のスタイルから読む。写しは、検査するために書いた
// 当の物を検査しなくなる(check_expressions.mjs が mapspec を import するのと
// 同じ理由)。
const { GSI_TILES } = await import(
  pathToFileURL(join(ROOT, 'web', 'mapspec.mjs')).href
);
// 同じ理由で detail.mjs も import する。パネルの三つの節は meta の三つの欄に
// 対する規則で、その写しをここに置けば、ページが走らせている規則を検査しなく
// なる。detailHTML は、下の旧道の検査が期待する行を本物の整形規則(fmtKm と、
// formerRowHTML の「0.0 なら行を出さない」)で組むために使う。
const { relatedRoutesOf, detailHTML, continuationOf, continuationCountOf } =
  await import(pathToFileURL(join(ROOT, 'web', 'detail.mjs')).href);
// former_km の meta から DOM までの経路(#84)は、bun test が実際の欄名で辿らない
// 詳細パネルの唯一の部分である(bun test は detailHTML() に直値を渡す)。欄を
// 実際に読む formerKmFor() を import すれば、decree.routes や crossings の
// 改名に気付くのと同じようにこのファイルが気付く。routesOf は detailHTML() が
// 路線のオブジェクトを必要とするからである。
const { formerKmFor, routesOf } = await import(
  pathToFileURL(join(ROOT, 'web', 'aggregate.mjs')).href
);
const TILE_HOST = new URL(GSI_TILES).host;

// URL という名前は付けない。下で使うグローバルの URL を隠す。PORT は serve.py
// に合わせる。8000 を他が握っている場合のためである。
const PAGE =
  process.env.MAP_URL || `http://localhost:${process.env.PORT || 8000}/`;

// 画面写真は 1 回の実行の証拠であって生成物ではないので、作業ツリーの外へ書く。
// 手元に残したいときは、置き場所をディレクトリで渡す。
const OUTDIR =
  process.argv[2] || mkdtempSync(join(tmpdir(), 'national-route-map-'));
mkdirSync(OUTDIR, { recursive: true });
const shot = (name) => join(OUTDIR, `${name}.png`);

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// パックした側と同じ結合を、タイルから読み戻さず地域ごとの生成物からやり直す。
// 下の手掛かりを、アーカイブにたまたま入っている物ではなくビルドが決めた物から
// 作るためである。この実行の目的は、その二つが一致するかを知ることである。
const index = read(join(DATA, 'regions.json'));
const meta = read(join(DATA, 'national.meta.json'));
const byId = new Map();
// 地域の道が実際にどこに在るか。地域の bbox は県の輪郭に外接する矩形で(東京都は
// 南鳥島まで及ぶ)、bbox へ飛ぶと視点が大海原を向く。
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
 * かつては押すたびに `waitForTimeout` で決め打ちの秒数を数えていた。27 か所で
 * 合計 69 秒。どれも「たぶん足りる」であって、何かが終わったことを
 * 述べていない。遅い日には偽の失敗を出し、速い日には待ちすぎる。
 *
 * 待つのは MapLibre の `idle` だけである。`idle` は _render の最後で、汚れが
 * 一つも残っておらず動いてもいないときにだけ出る。この「汚れ」には symbol の
 * 配置(_placementDirty)も入る。`loaded() && !isMoving()` は配置が
 * 済んでいなくても真になりうるので、`render` を合図にするとラベルがまだ
 * 置かれていない絵を数えることがある。
 *
 * triggerRepaint() で描画を 1 回促す。`idle` は状態ではなく出来事なので、何も
 * 変わっていない回(サイドバーの折りたたみなど地図を触らない操作)に待つだけでは
 * 二度と来ない。促せば次の描画で「汚れが無い」と分かってその場で出る。
 *
 * 上限は残す。タイルが 1 枚返らないだけで検査が止まるより、待つのをやめて後の
 * 検査に失敗させるほうがよい。requestAnimationFrame は使わない。画面が
 * 伏せられて rAF が止まる回に、上限そのものが動かなくなる。
 */
const SETTLE_CAP_MS = 30000;
const settle = () =>
  page.evaluate(
    (cap) =>
      new Promise((resolve) => {
        const m = window.map;
        /* 地図が無ければ待つ相手がいない。手前の isStyleLoaded 待ちは
         * `.catch(() => {})` で握りつぶすので、地図が起動しなかった
         * 回はそのままここへ来る。待たずに戻り、後の検査に失敗させる。
         * page.evaluate に時限は無いので、ここで止まると何も報告されないまま
         * 固まる。 */
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

// 国土地理院は描く物が無い場所にラスタタイルを置かないので、大海原へ引くと 404
// が返る。下地図が設計どおりに動いている姿で、海上国道の検査は意図してそこへ
// 行く。それ以外の失敗した要求は本物の不具合なので、URL 付きで報告する。
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
  out.routeCount = document.querySelectorAll('#rl-national-list label').length;
  out.rankingRows = document.querySelectorAll('#ranking .row').length;
  out.sharedRows = document.querySelectorAll('#shared .row').length;
  // #stats は閉じている「国道マップについて」のダイアログの中にある。閉じた
  // <dialog> は描かれず、描かれていない物の `innerText` は空を返す。
  // `textContent` は配置を気にしないので、四つの数は <dd> から直接読む。
  out.stats = [...document.querySelectorAll('#stats dd')]
    .map((s) => s.textContent)
    .join(' | ');
  // このページが土台にしている、画面についての三つの判断。
  out.regionPickers = document.querySelectorAll('select#region').length;
  out.concOptions = [...document.querySelectorAll('input[name=conc]')].map(
    (i) => i.value,
  );
  // 地図の上のボタン。現在位置は MapLibre の部品なので、あるかどうかだけを見る
  // (押すと端末の許可を求める)。方位は拡大・縮小とは別のグループに乗せる。
  // 同じグループに並ぶと、拡大を連打する指が地図を回す。重用区間と表示は
  // 「表示」のポップオーバー 1 つが持つ。他にも残っていれば、どちらを押したかで
  // 結果が変わる二つの操作ができる。
  out.togglesOutsidePane = [
    ...document.querySelectorAll('.checks input, input[name=conc]'),
  ].filter((i) => !i.closest('#display-popover')).length;
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
  // 左上の三つのポップオーバー。押すまで開かないが、閉じたまま自分の大きさは
  // 示し続ける。数まで隠す畳み方は、節約した面積より害が大きい。閉じた
  // ポップオーバーの innerText は空なので、数は textContent から読む。「道路を
  // 選択」は例外で、選んでいる本数は外の #sel-count・#sel-none が示す。
  out.panes = ['select', 'ranking', 'shared'].map((name) => ({
    name,
    open: !document.querySelector(`#${name}-popover`).hidden,
    count:
      name === 'select'
        ? null
        : document.querySelector(`#${name}-count`).textContent,
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
// 操作パネルはもう特徴量を数えない(大半が読み込まれていない)ので、そこが示す数
// は、描いた時点でたまたま画面に出ていた物ではなくビルドが出した数でなければ
// ならない。
ok(
  report.stats.includes(meta.arc_count.toLocaleString()),
  `the panel states the nationwide arc count, not the loaded one ` +
    `(${meta.arc_count.toLocaleString()} in "${report.stats}")`,
);
ok(
  JSON.stringify(report.concOptions) === JSON.stringify(['off', 'all']),
  `concurrency has two modes, not three (${report.concOptions.join(', ')})`,
);
// データがいつのものかは「国道マップについて」の中にある。操作パネルには無い。
const about = await page.evaluate(async () => {
  const dialog = document.querySelector('#about-dialog');
  const before = dialog.open;
  document.querySelector('#about-btn').click();
  const opened = dialog.open;
  dialog.close();
  return {
    before,
    opened,
    onMap: !!document.querySelector('#map-ui #stats'),
  };
});
ok(
  !about.before && about.opened,
  'the info button opens the 国道マップについて dialog',
);
ok(
  !about.onMap,
  'the data provenance is stated in that dialog, not also on the map',
);

ok(
  report.paneButtons === 1 && report.togglesOutsidePane === 0,
  'the concurrency and display switches live in one pane, not in two places',
);
/* 配色は同じポップオーバーの中から選ぶ。色そのものは style.css の light-dark()
 * が両方定義しているので、ここが確かめるのは「選んだ側が data-theme に出て、
 * パネルの地の色がそれで変わる」ことだけである。 */
const themed = await page.evaluate(() => {
  const root = document.documentElement;
  const panelBg = () =>
    getComputedStyle(document.querySelector('#brand')).backgroundColor;
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
// 参照用の一覧はポップオーバーの中にあり、押すまで開かない。ただし、開いてみる
// まで中身の見当が付かない畳み方は害が大きい。ランキングと起終点は動かない一覧
// なので、閉じたままでも件数を示し続けなければならない。「道路を選択」は選んで
// いる本数を外の #sel-count・#sel-none が示すので、ポップオーバー自身が数を持つ
// かは見ない。
for (const b of report.panes) {
  ok(b.open === false, `the ${b.name} pane starts closed`);
  if (b.name !== 'select') {
    ok(
      /\d/.test(b.count),
      `the closed ${b.name} pane still states what is inside ("${b.count}")`,
    );
  }
}

/* 左上のグループはポップオーバーを開く。四つのポップオーバー(道路を選択・
 * ランキング・起終点・表示)はどれも地図の上に浮くだけなので、開いても canvas の
 * 寸法は変わらず、地図の padding も動かない。かつては 340px の
 * サイドパネルがあり、padding がその幅ぶん左に寄っていた。
 *
 * 一度に開くのは一つだけである。二枚が並ぶと、地図の見えている面積が急に
 * 減る。 */
const panes = await page.evaluate(async () => {
  const open = (sel) => {
    document.querySelector(sel).click();
    return {
      btn: sel,
      shown: [
        '#select-popover',
        '#ranking-popover',
        '#shared-popover',
        '#display-popover',
      ].filter((p) => !document.querySelector(p).hidden),
      padding: Math.round(window.map.getPadding().left),
      pressed: document.querySelector(sel).getAttribute('aria-expanded'),
    };
  };
  const first = open('#select-btn');
  const second = open('#ranking-btn');
  // 外を押せば閉じる。地図そのものがポップオーバーの外である。
  document.querySelector('#map').click();
  const closed = [
    '#select-popover',
    '#ranking-popover',
    '#shared-popover',
    '#display-popover',
  ].filter((p) => !document.querySelector(p).hidden);
  return { first, second, closed };
});
ok(
  panes.first.shown.length === 1 &&
    panes.first.shown[0] === '#select-popover' &&
    panes.first.pressed === 'true',
  `pressing 道路を選択 opens its pane and says so (${panes.first.shown.join(', ')})`,
);
ok(
  panes.second.shown.length === 1 &&
    panes.second.shown[0] === '#ranking-popover',
  `opening another pane closes the first (${panes.second.shown.join(', ')})`,
);
ok(
  panes.closed.length === 0,
  `clicking the map closes the open pane (${panes.closed.join(', ') || 'none open'})`,
);
ok(
  panes.first.padding === 0 && panes.second.padding === 0,
  `the panes float over the map without moving its centre ` +
    `(${panes.first.padding}px)`,
);

// 選択の大きさを示すのは、選択解除のボタンとその隣の数のバッジだけである。
// かつては一覧の下の補助の行も「1 路線を選択中。」と述べていた。一つの問いへの
// 二つ目の答えで、しかも古くなり放題だった。取り消す物が無いあいだ、ボタンは
// 押せない姿で居座るのではなく消えなければならない。文字を持たない
// ボタンなので、どれだけ取り消すかはラベル(title/aria-label)が示す。
const clearBtn = () =>
  page.evaluate(() => {
    const b = document.querySelector('#sel-none');
    return {
      text: b.title,
      aria: b.getAttribute('aria-label'),
      hidden: b.hidden,
      badge: document.querySelector('#sel-count').textContent,
      paneOpen: !document.querySelector('#select-popover').hidden,
    };
  });
const idle = await clearBtn();
ok(
  idle.hidden && idle.text === '選択解除' && idle.aria === '選択解除',
  `with nothing picked the clear button is not there ("${idle.text}", hidden=${idle.hidden})`,
);
// 一覧はポップオーバーの中にあるので、押す前に開く。
await page.click('#select-btn');
await settle();
await page.locator('#route-list input').first().check();
await settle();
const one = await clearBtn();
ok(
  !one.hidden && one.text === '1 路線を選択解除',
  `the clear button states how much it would undo ("${one.text}")`,
);
ok(
  one.badge === '1',
  `and the count beside it says the same without opening anything ("${one.badge}")`,
);
await page.click('#sel-none');
await settle();
const back = await clearBtn();
// ✕ はポップオーバーの外、同じグループの中にある。押してポップオーバーまで
// 畳んでは、押した人が頼んでいないことが起きる。
ok(back.paneOpen, 'clearing the selection does not close the pane');
ok(
  back.hidden &&
    back.text === '選択解除' &&
    (await page.evaluate(
      () => document.querySelectorAll('#route-list input:checked').length === 0,
    )),
  `pressing it clears the selection and goes away again ("${back.text}")`,
);

/* 絞り込み欄は一つで、国道にも都道府県道にも当たる。都道府県道の番号は
 * pref/index.json が持ち、このポップオーバーを開いたときに 1 度だけ取る
 * (14.4 kB)。県別 meta 47 本 3.45 MB を読ませないためである。
 *
 * 打つまで都道府県道は出さない。13,234 組は眺めて選ぶ数ではなく、並べれば DOM
 * も打つたびに走る絞り込みも持たない。 */
const quiet = await page.evaluate(
  () => document.querySelectorAll('#rl-pref-rows input').length,
);
ok(
  quiet === 0,
  `with nothing typed the prefectural list stays empty (${quiet})`,
);

await page.fill('#route-filter', '18');
await page
  .waitForFunction(
    () => document.querySelectorAll('#rl-pref-rows input').length > 0,
    null,
    { timeout: 20000 },
  )
  .catch(() => {});
const typed = await page.evaluate(() => ({
  rows: document.querySelectorAll('#rl-pref-rows input').length,
  head: document.querySelector('#rl-pref-head').textContent,
  nat: [...document.querySelectorAll('#rl-national-list label')].filter(
    (l) => !l.classList.contains('hidden'),
  ).length,
}));
ok(
  typed.nat > 0 && typed.rows > 0,
  `one field finds both systems (${typed.nat} national, ${typed.rows} prefectural)`,
);
ok(
  /\d/.test(typed.head),
  `the prefectural group states how many it found ("${typed.head}")`,
);

// 都道府県道を選べば、地図に残るのはその 1 本だけになる。国道の側と対称である。
await page.locator('#rl-pref-rows input').first().check();
await settle();
const pickedPref = await page.evaluate(() => ({
  roads: window.map.queryRenderedFeatures({ layers: ['roads'] }).length,
  url: location.search,
  badge: document.querySelector('#sel-count').textContent,
}));
ok(
  pickedPref.roads === 0 && pickedPref.url.includes('proutes='),
  `picking a prefectural route takes the national ones off the map ` +
    `(${pickedPref.roads} arcs, "${pickedPref.url}")`,
);
ok(
  pickedPref.badge === '1',
  `and the count beside the button counts it like any other road ` +
    `("${pickedPref.badge}")`,
);

/* 一覧に出す系統は三状態しかない。どちらも外れると一覧が空になる。 */
const seg = await page.evaluate(() => {
  const press = (sel) => document.querySelector(sel).click();
  press('#sys-pref');
  const one = {
    pref: document.querySelector('#rl-pref').hidden,
    national: document.querySelector('#rl-national').hidden,
  };
  press('#sys-national'); // 最後の一枚は外れない
  const still = document
    .querySelector('#sys-national')
    .getAttribute('aria-pressed');
  press('#sys-pref'); // どちらもに戻す
  return { one, still };
});
ok(
  seg.one.pref && !seg.one.national,
  'pressing a system button drops just that system from the list',
);
ok(seg.still === 'true', 'the last one cannot be switched off');

await page.click('#sel-none');
await page.fill('#route-filter', '');
await settle();

ok(
  await page.evaluate(() => !document.querySelector('#sel-hint')),
  'the selection size is not also stated in a hint under the list',
);

await page.screenshot({ path: shot('1-all') });

/* 重用区間と表示は、地図の上のボタンから出るポップオーバーの中にある。中の操作
 * は開いていなければ届かないので、押す前に開ける。開いていれば何もしない。
 * もう一度押すと畳む。 */
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
await openPane('#ranking-btn');
await settle();
ok(
  await page.evaluate(() => !document.querySelector('#ranking-popover').hidden),
  'the ranking pane opens when its button is pressed',
);
// 行は 1 つの重用を名指しし、それがどこに在るかを示す。押したらそこへ行き、
// 一覧には手を触れない。かつてはどちらも破れていた。視点は番号のうち 2 つを
// 共有する組み合わせ全部の和に合わされ、高知市の行では東経 132.5 度から
// 134.7 度、四国の大半に及んだ。しかも行の路線が選択されるので、指の下で一覧が
// 組み直され、押した行そのものが動いた。
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
// 潰れた bbox(アーク 1 本ぶんで広がりを持たない)では視点はその中心に
// 留まるので、許容差は padding が動かしうる量である。
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
// 1 地域に決め打ちせずデータから作る。ランキングの行へ行っても何も選択されない
// ので、ここで解除する物は無い。
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

// --- アークを押す。ポップアップが示すことと、押した印の影 ----------------
// 視点は最も深い重用の上に在るので、canvas の中央の下にあるアークは厳しい場合
// になる。指定が複数あって、ポップアップは 1 つである。
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
   * 変わる(下向きなら border-top、左向きなら border-right)。残る二辺は
   * 透明のままでなければ四角になる。上下の辺だけを差し替えていたころ、左右へ
   * 出た角は MapLibre 既定の白のままで、塗られた上下が加わって四角に
   * 見えていた。出る向きは吹き出しが画面のどこに立つかで決まるので、普通に
   * 触っていて出会うのは八方向のうち一つだけである。八つとも作って、幅を
   * 持つ辺のうち塗られているのがちょうど一つで、その色が吹き出しの地の
   * 色であることを見る。
   *
   * 幅を持つ辺の数は数えない。尖る向きと逆の辺を MapLibre が落とすので、四方は
   * 三本、四隅は二本になる。「三本あるはず」と書いて四隅で落ちた。 */
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

  // 同じアークをもう一度開く。ここから先は標識を押してパネルを出すが、パネルを
  // 出すこと自体がポップアップを閉じるので、開き直さないと押す標識が無い。
  await page.mouse.click(target.x, target.y);
  await settle();

  // 標識はボタンで、押せばその路線 1 本のパネルが開く。以前は選択を絞っており、
  // #65 がその役目をパネルの「…だけを表示」へ移した後も、この検査は長らく
  // 絞り込みを求め続けていた。画面が変わり、検査が変わっていなかった。
  const ref = target.refs[0];
  // パネルを開ける前の padding。閉じたときにここへ戻ることが、下の「滑らない」
  // と対になる不変条件である。左の列には操作パネルもあるので、戻る先は 0 とは
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
   * 通してしか分からない。名前が食い違っても例外は出ず、欄が
   * 空になるだけである。実際 #64 と #65 は違う名前を選び、両方が main に
   * 乗ったまま誰も転ばなかった。meta が持つ地名が画面に出ているかを
   * 直接見る。 */
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

  /* 関わりのある国道は、meta の三つの欄(組み合わせ表・起終点の共有・交差の表)を
   * 突き合わせて出る。その読み方を書き写すと写しを検査することになるので、
   * 画面が使う関数をそのまま呼ぶ。
   *
   * 交差の表(`crossings`)は pack_web.mjs が書く。古い web/data には無く、
   * 無ければ交差の節が出ないのが正しいので、meta がその欄を持つこと自体もここで
   * 言う。 */
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

  /* 並べた標識は押せる。押せばその路線のパネルに開き直る。関わりは相互なので
   * (重用も起終点の共有も交差もどちらから見ても同じ)、開いた先には必ず元の路線
   * の標識がある。押して戻れることまで見て、以降の検査を元の路線のパネルで
   * 続ける。 */
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

  /* 「だけ」は文字どおりの意味である(#109)。押した後の地図に残るのはその 1 本
   * だけで、もう一方の系統(ここでは都道府県道)は消える。
   *
   * 消すのは選択そのものであって、系統トグルではない(mapspec.mjs の
   * shownSystems)。かつてはボタンが裏でトグルを倒しており、同じ 1 本の選択が
   * 一覧のチェックボックスから入ったときだけ都道府県道を残していた。同じ選択が
   * 押した場所で違う絵になっていた。だからトグルが立ったまま地図から消えている
   * こと、URL に `pref=0` が乗らないことの両方を見る。 */
  const prefOff = await page.evaluate(() => ({
    checked: document.querySelector('#t-pref').checked,
    drawn: window.map.queryRenderedFeatures({ layers: ['pref-roads'] }).length,
    url: location.search,
  }));
  ok(
    prefOff.checked && prefOff.drawn === 0 && !prefOff.url.includes('pref=0'),
    `and hides the prefectural routes without touching the system toggle ` +
      `(toggle ${prefOff.checked}, ${prefOff.drawn} arcs, "${prefOff.url}")`,
  );

  // 一覧のチェックボックスから選んでも同じ絵になる。押す場所で変わらない。
  await page.click('#select-btn');
  await page.locator(`#route-list input[value="${ref}"]`).uncheck();
  await page.locator(`#route-list input[value="${ref}"]`).check();
  await page.keyboard.press('Escape');
  await settle();
  const viaList = await page.evaluate(
    () => window.map.queryRenderedFeatures({ layers: ['pref-roads'] }).length,
  );
  ok(
    viaList === 0,
    `picking the same route from the list draws the same map (${viaList} arcs)`,
  );

  /* ボタンは押した状態を持ち、もう一度押せば解ける。同じ場所で戻せなければ、
   * 押せるのに解けないボタンである。都道府県道の側は初めから戻せたので、国道
   * だけがそうなっていた。
   *
   * 見た目(active)と読み上げ(aria-pressed)とラベル(aria-label)の三つを見る。
   * どれか一つが取り残されると、押した結果が画面か読み上げのどちらかから
   * 分からなくなる。 */
  const onlyButton = () =>
    page.evaluate(() => {
      const b = document.querySelector('#detail .detail-only');
      return {
        pressed: b?.getAttribute('aria-pressed'),
        active: b?.classList.contains('active') ?? false,
        label: b?.getAttribute('aria-label') ?? '',
        picked: document.querySelectorAll('#route-list input:checked').length,
      };
    });
  const held = await onlyButton();
  ok(
    held.pressed === 'true' && held.active && held.label.includes('解除'),
    `the pressed 「だけを表示」 says so (aria-pressed ${held.pressed}, ` +
      `active ${held.active}, "${held.label}")`,
  );
  await page.click('.detail-only');
  await settle();
  const released = await onlyButton();
  ok(
    released.pressed === 'false' && !released.active && released.picked === 0,
    `pressing it again releases the route (aria-pressed ${released.pressed}, ` +
      `${released.picked} still checked)`,
  );

  // 選び直して、今度は地図の左上の ✕ で解く。選択を変える経路はボタンだけでは
  // ないので、そちらから変わったときもラベルが追いつかなければならない。
  await page.click('.detail-only');
  await settle();

  // 選択を解けば、都道府県道は戻る。
  await page.click('#sel-none');
  await settle();
  const prefBack = await page.evaluate(() => ({
    checked: document.querySelector('#t-pref').checked,
    drawn: window.map.queryRenderedFeatures({ layers: ['pref-roads'] }).length,
  }));
  ok(
    prefBack.checked && prefBack.drawn > 0,
    `clearing the selection brings the prefectural routes back (${prefBack.drawn} arcs)`,
  );

  const afterClear = await onlyButton();
  ok(
    afterClear.pressed === 'false' &&
      !afterClear.active &&
      afterClear.label.includes('だけを表示'),
    `and the open box stops claiming to be pressed ` +
      `(aria-pressed ${afterClear.pressed}, "${afterClear.label}")`,
  );

  /* パネルは地図の一部を覆うので、開くあいだ地図は覆われたぶん脇へ寄る。開けて
   * 読んで閉じるだけなら、閉じたときに寄せたぶんが戻るのが正しい。開く前の
   * 表示位置に戻ることだからである。
   *
   * 開いているあいだに地図を動かしたなら話が変わる。今の表示位置は利用者が
   * 選んだ物なので、閉じた拍子に横へ滑るのはただのずれである。寄せ幅は padding
   * で、画面には出ない。絵が動いたかは、画面の真ん中に写る地点が変わったかで
   * 見る。 */
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
// 破線の区分と違い、これは `roads` と同じ体裁で描かれる走れる車道である。
// 見分けるのは表示の切り替えだけなので、ここで動かす
// 値打ちがあるのもそれだけである。上の区分の繰り返しが視点をどこへ置いたかに
// 頼らず、明示的に移動する。
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
// 海上区間は下に道が無い唯一の区分で、地図から外せることがこの切り替えの
// 役目である。ここも明示的に移動する。上の検査が視点を動かしているので、区分の
// 繰り返しが残した位置に居るとは仮定できない。
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

// --- 旧道(#84) -----------------------------------------------------------
// bun test が辿らない、meta から DOM への唯一の経路。former_km は組み合わせの
// 各行に kinds と並んで載り、formerKmFor()(aggregate.mjs)が kindsFor() と
// 同じやり方で足す。bun test が detailHTML() に渡すのは直値の former_km
// だけで、欄を名前で読まない。pack_web.mjs での改名(#64・#65 と同じ形。欄は
// 在るがコードが読む名前と違う)が起きると、formerKmFor() は永遠に 0 を返し、
// 行はパネルから消える。例外もコンソールの出力も無く、bun test は
// 緑のままである。
//
// 国道 10 号は旧道を 30.8 km 持ち、国道 4 号は持たない。指の落ちた先ではなく
// ref で選ぶので、行が出る側と出ない側の両方が毎回走る。
const arcOf = (ref) =>
  features.find(
    (f) => f.properties.kind === 'road' && f.properties.refs_list.includes(ref),
  );

// 実際にアークをクリックしてパネルを開き、「うち旧道」の行の文面を読み取る。
// 戻り値は三通りである。`undefined` は ref のアークがビルドに無いか描画されて
// おらず押せなかった(検査が成立しない)、文字列は行の値(例: "30.8 km")、`null`
// は旧道を持たず行が出ていない。呼ぶ側は undefined と null の違いで、打ち切るか
// 判定を続けるかを分ける。
const formerRowFor = async (ref) => {
  const arc = arcOf(ref);
  if (!arc) return undefined; // no arc for this ref in the build at all
  await page.evaluate(
    (c) => window.map.jumpTo({ center: c, zoom: 13.5 }),
    midOf(arc),
  );
  await settle();
  // 上のアークの押下の検査と同じ輪の探索だが、canvas の中央の下に在る物ではなく
  // 特定の ref を狙う。
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

// 下の比較は、両側とも formerKmFor() を通して meta.combinations を読む。片方は
// ページが呼ぶのがそれだからで、もう片方はページが出すべき値を
// 求めるためである。pack_web.mjs が欄を改名すれば両側とも 0 を返し、誤った
// 答えの上で一致して緑になる(f694172 が dl の位置の検査で直したのと同じ、自分と
// 一致するだけの検査)。国道 10 号が 0 でない former_km を持つことは、meta の
// 中身と無関係な実在の道路網の事実なので、それだけを先に断定する。0 なら、
// 10 号が旧道を失ったのではなく欄が消えたか改名されたのである。
const anchorKm = formerKmFor(meta.combinations, new Set([10]));
ok(
  anchorKm > 0,
  `the meta still carries former_km for 国道10号 (${anchorKm} km) — 0 would ` +
    `mean the field was dropped or renamed, not that 10号 has no former road`,
);

// 期待する行の文面は detailHTML() 自身から得る。fmtKm の丸めと formerRowHTML の
// 「0.0 なら行を出さない」規則を書き写さない(CLAUDE.md「検証スクリプトは本物の
// 定義を読み込んで検査する」)。本物でなければならないのは former_km だけで、
// `route` の残りは実在する路線でありさえすればよい。
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

// --- 複数の都道府県にわたる路線の節 ----------------------------------------
/* 節が読む `continuations` は pack_web_pref.mjs が書く。書く側と読む側が同じ
 * 名前を指しているかは、実データを通してしか分からない。名前が食い違っても例外
 * は出ず、節が出ないだけである(#64 の起終点がまさにそれで、欄はあるのに空の
 * ままだった)。だから meta が持つ群と、画面に出た文字を直接突き合わせる。
 *
 * 見出しの数え方(「3県」「3都県」「2府」)も書き写さない。ページが呼ぶ
 * continuationCountOf() をそのまま呼ぶ。写せば、検査するために書いた当の規則を
 * 検査しなくなる。 */
{
  const prefLabels = new Map(index.map((r) => [r.region, r.label]));
  const groups = [];
  // 路線ごとの外接矩形も一緒に拾う。群の全員が描かれたことを見るには、その
  // 全員が入る眺めへ寄らなければならない(下の「群の眺めへ寄る」を参照)。
  const boxOf = new Map();
  for (const r of index) {
    const pm = read(join(DATA, 'pref', `${r.region}.meta.json`));
    for (const c of pm.continuations ?? []) groups.push(c);
    for (const c of pm.combinations) {
      for (const k of c.refs) {
        const b = boxOf.get(k);
        boxOf.set(
          k,
          b
            ? [
                Math.min(b[0], c.bbox[0]),
                Math.min(b[1], c.bbox[1]),
                Math.max(b[2], c.bbox[2]),
                Math.max(b[3], c.bbox[3]),
              ]
            : [...c.bbox],
        );
      }
    }
  }
  ok(
    groups.length > 0,
    `the prefectural metas carry the continuation table ` +
      `(${groups.length} rows across ${index.length} prefectures)`,
  );

  /* 出す群はデータから決める。県を書き決めると、その県の群が消えた日に検査が
   * 静かに止まる。いちばん多くの県にまたがり、路線名を持つ群を採る。並べ替えは
   * 全順序にしておく。 */
  const pick = groups
    .filter((c) => c.name)
    .sort(
      (a, b) =>
        b.refs.length - a.refs.length ||
        b.km - a.km ||
        (a.refs.join() < b.refs.join() ? -1 : 1),
    )[0];
  if (!pick) {
    fails.push('FAIL  no named continuation group in the prefectural metas');
  } else {
    const key = pick.refs[0];
    const region = key.slice(0, key.lastIndexOf('-'));
    /* ページが群を引くのは continuationOf() である。表を上から数えた物と、
     * あちらが引いた物が同じであることも見る。欄の名前を取り違えていれば、
     * ここで何も返らない。 */
    const found = continuationOf(
      read(join(DATA, 'pref', `${region}.meta.json`)),
      key,
    );
    ok(
      found?.refs.join() === pick.refs.join(),
      `continuationOf() finds ${key} in the group the table lists it in ` +
        `(${found?.refs.join(' / ') ?? 'nothing'})`,
    );
    const count = continuationCountOf(
      pick.refs.map((k) => prefLabels.get(k.slice(0, k.lastIndexOf('-')))),
    );
    console.log(
      `\ncontinuation group: ${pick.refs.join(' / ')} — ${pick.name} ` +
        `${pick.km} km (${count})`,
    );

    /* 押すアークは判定の生成物から探す。タイルから読み戻すと、そのアークが
     * 載っていることを、載っているタイルで確かめることになる。 */
    const arc = read(join(PREFECTURAL, `${region}.geojson`))
      .features.filter((f) => f.properties.refs_list.includes(key))
      .sort((a, b) => b.properties.km - a.properties.km)[0];
    if (!arc) {
      fails.push(`FAIL  no arc for ${key} in build/prefectural/${region}`);
    } else {
      const mid =
        arc.geometry.coordinates[
          Math.floor(arc.geometry.coordinates.length / 2)
        ];
      await page.evaluate(
        (c) => window.map.jumpTo({ center: c, zoom: 14 }),
        mid,
      );
      await settle();
      const hit = await page.evaluate((want) => {
        const m = window.map;
        const r = m.getCanvas().getBoundingClientRect();
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
        for (let d = 0; d < 320; d += 4) {
          for (const [dx, dy] of ring(d)) {
            const f = m
              .queryRenderedFeatures([cx + dx, cy + dy], {
                layers: ['pref-roads'],
              })
              .find((x) => x.properties.refs.includes(`,${want},`));
            if (f) return { x: cx + dx + r.x, y: cy + dy + r.y };
          }
        }
        return null;
      }, key);
      if (!hit) {
        fails.push(`FAIL  no rendered arc of ${key} to click`);
      } else {
        await page.mouse.click(hit.x, hit.y);
        await settle();
        await page.click(`.maplibregl-popup .shield-btn[data-pref="${key}"]`);
        await settle();
        const shown = await page.evaluate(() => {
          const el = document.querySelector('.detail-cont');
          if (!el) return null;
          return {
            head: el.querySelector('.detail-sub').textContent,
            km: el.querySelector('.cont-km').textContent,
            name: el.querySelector('.cont-name')?.textContent ?? null,
            chips: [...el.querySelectorAll('.cont-chip')].map(
              (b) => b.dataset.pref,
            ),
          };
        });
        ok(
          shown !== null,
          `the box for ${key} carries the continuation section ` +
            `("${shown?.head ?? 'missing'}")`,
        );
        if (shown) {
          ok(
            shown.head === `${count}にわたる都道府県道`,
            `and its heading counts the prefectures the group actually spans ` +
              `("${shown.head}")`,
          );
          ok(
            shown.km.includes(String(pick.km)),
            `and states the summed length the meta gave it ("${shown.km}")`,
          );
          ok(
            shown.name === pick.name,
            `and names the route ("${shown.name ?? 'no name row'}")`,
          );
          const want = pick.refs.filter((k) => k !== key);
          ok(
            JSON.stringify(shown.chips) === JSON.stringify(want),
            `and lists the rest of the group as cards ` +
              `(${shown.chips.join(', ')})`,
          );

          /* カードは押せる。押せばその県の詳細に開き直る。群は相互なので、
           * 開いた先の節には必ず元の路線が居る。 */
          const other = want[0];
          await page.click(`.cont-chip[data-pref="${other}"]`);
          await settle();
          const back = await page.evaluate(
            (self) =>
              document.querySelectorAll(
                `.detail-cont .cont-chip[data-pref="${self}"]`,
              ).length,
            key,
          );
          ok(
            back === 1,
            `pressing a card opens that prefecture's box, and that box lists ` +
              `the one we came from (${other} → ${key})`,
          );
          await page.screenshot({ path: shot('8-continuation') });

          /* 節の漏斗は群をまとめて地図に残す(#155)。「だけ」は文字どおりで、
           * 押した後の地図に残るのは群の全員だけであり、国道は消える。押した
           * 路線のパネルは開いたままで、解除する口もそこにある。 */
          const drawn = () =>
            page.evaluate(() => ({
              pref: window.map
                .queryRenderedFeatures({ layers: ['pref-roads'] })
                .map((f) => f.properties.refs),
              national: window.map.queryRenderedFeatures({ layers: ['roads'] })
                .length,
              url: location.search,
              open: !document.querySelector('#detail').hidden,
              on: !!document.querySelector('.detail-cont.on'),
              pressed: document
                .querySelector('.cont-row .detail-only')
                ?.getAttribute('aria-pressed'),
            }));
          await page.click('.cont-row .detail-only');
          await settle();

          /* 群の眺めへ寄る。押した場所のままでは群の全員は見えない。押すのは
           * 1 本のアークの上(z14)で、そこから遠い相手は視野の外に居る。実測では
           * 佐野古河線の 4 県のうち茨城県ぶん(1.5 km)が 0 本になる:
           *
           *   z14 押したアークの上   gunma 5 / ibaraki 0 / saitama 3 / tochigi 4
           *   群の外接矩形(z11.9)    gunma 3 / ibaraki 2 / saitama 11 / tochigi 43
           *
           * だから「全員が描かれた」は、全員が入る眺めでしか言えない。矩形は
           * 県別 meta の組み合わせ表が持つ物を合わせて作る。 */
          let box = [Infinity, Infinity, -Infinity, -Infinity];
          for (const k of pick.refs) {
            const b = boxOf.get(k);
            if (!b) continue;
            box = [
              Math.min(box[0], b[0]),
              Math.min(box[1], b[1]),
              Math.max(box[2], b[2]),
              Math.max(box[3], b[3]),
            ];
          }
          await page.evaluate(
            (b) =>
              window.map.fitBounds(
                [
                  [b[0], b[1]],
                  [b[2], b[3]],
                ],
                { padding: 40, duration: 0 },
              ),
            box,
          );
          await settle();

          const after = await drawn();
          const stray = after.pref.filter(
            (refs) => !pick.refs.some((k) => refs.includes(`,${k},`)),
          );
          const missing = pick.refs.filter(
            (k) => !after.pref.some((refs) => refs.includes(`,${k},`)),
          );
          ok(
            after.pref.length > 0 && stray.length === 0 && missing.length === 0,
            `the section's funnel leaves the whole group on the map and ` +
              `nothing else (${after.pref.length} arcs, ${stray.length} stray, ` +
              `${missing.length ? `missing ${missing.join(', ')}` : 'none missing'})`,
          );
          ok(
            after.national === 0,
            `and takes the national routes off, the way 「だけ」 does ` +
              `(${after.national} arcs)`,
          );
          ok(
            pick.refs.every((k) =>
              decodeURIComponent(after.url).includes(k.replace('-', ':')),
            ),
            `and the whole group rides the shared link ("${decodeURIComponent(after.url)}")`,
          );
          ok(
            after.open && after.on && after.pressed === 'true',
            `and the box stays open saying so ` +
              `(open ${after.open}, framed ${after.on}, pressed ${after.pressed})`,
          );

          // 解くと、同じ眺めに他の県道が戻る。眺めを動かさずに数えるので、
          // 増えたことがそのまま「群だけではなくなった」ことである。
          await page.click('.cont-row .detail-only');
          await settle();
          const released = await drawn();
          ok(
            released.pref.length > after.pref.length &&
              released.url === '' &&
              released.on === false,
            `pressing it again releases the group ` +
              `(${after.pref.length} → ${released.pref.length} arcs, ` +
              `"${released.url}")`,
          );
        }
        await page.click('#detail-close');
        await settle();
      }
    }
  }
}

// --- どの地域のデータも実際に地図に載っていること --------------------------
// 1 地域がアーカイブに入り損ねても、操作パネルから見た姿はほとんど変わらない。
// だから県を全部訪ね、その道を数える。
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
