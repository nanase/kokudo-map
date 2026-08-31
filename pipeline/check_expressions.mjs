/* 閲覧側が実際に組むスタイルそのものを検査し、続けてその絞り込み式を生成済みの
 * データで評価する。
 *
 * 式を書き写さず web/mapspec.mjs を import する。書き写した複製が、一度この検査
 * を欺いたためである。複製は問題なく通り、本物の層は MapLibre に拒否されていた。
 * `zoom` の補間を算術式で包んでいたことと、`line-dasharray` をデータ駆動にして
 * いたことが理由である。
 *
 * 使い方:  node pipeline/check_expressions.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REGIONS, ROOT } from './_paths.mjs';

// 相対の深さを決め打ちせずパスで import する。このスクリプト群はスキルに属して
// おり、プロジェクトからどれだけ下にあるかは決まっていない。
const {
  baseStyle,
  routeLayers,
  routeSources,
  PMTILES_URL,
  PREF_PMTILES_URL,
  PREF_SOURCE,
  prefLabelLayer,
  prefLineLayers,
  prefLayers,
  buildFilter,
  withKind,
  hasRef,
  FILTERED_LAYERS,
  SPECIAL_KINDS,
} = await import(pathToFileURL(join(ROOT, 'web', 'mapspec.mjs')).href);

const require = createRequire(join(ROOT, 'package.json'));
const spec = require('@maplibre/maplibre-gl-style-spec');

/* この検査は二つに分かれ、生成物が必要なのは片方だけである。
 *
 * 1 節は、スタイルと絞り込み式が MapLibre の仕様に適合するかを訊く——コードに
 * ついての問いで、どこでも答えられる。CI がデータの無い clone で走らせられるのは
 * このためである。2 節から 5 節は、その同じ式を実データのアークで評価し、素の
 * JavaScript と突き合わせる。こちらは地域が生成済みであることを要求する。
 *
 * `--spec-only` は前半だけを求める。付けないときのデータ不足はエラーであって、
 * 検査を減らして済ませることではない。生成済みの木で自分の作業を確かめている
 * 人は、それを知らされるべきで、突き合わせを飛ばした合格を渡されるべきでは
 * ない。
 */
const args = process.argv.slice(2);
const SPEC_ONLY = args.includes('--spec-only');
const REGION = args.find((a) => !a.startsWith('--')) || 'nagano';

let geo = null;
let meta = null;
if (SPEC_ONLY) {
  console.log('--spec-only: 仕様の検査だけを行う(データを読まない)');
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

/* ---- 1. スタイル全体が仕様を満たす --------------------------------------- */
function styleWith(filters) {
  const style = baseStyle();
  // 代用ではなく、閲覧側自身のソース定義を使う。層の `source-layer` はベクタ
  // ソースに対してしか妥当にならないので、でっち上げた GeoJSON のソースで層を
  // 検査すると、本物の地図が落ちるのに検査は通る。
  Object.assign(style.sources, routeSources(PMTILES_URL, PREF_PMTILES_URL));
  const layers = routeLayers();
  if (filters) {
    for (const l of layers)
      if (filters[l.id] !== undefined) l.filter = filters[l.id];
  }
  // 閲覧側が addLayer する順(app.js の boot)をそのまま組む。県道の線は国道の
  // すべての層の下、県道の札は国道の札のすぐ下である。層の順は描く順と札の
  // 場所争いの両方を決めるので、検査するスタイルの並びが本物と違えば、検査した
  // 物は本物ではない。
  const at = layers.findIndex((l) => l.id === 'route-labels');
  style.layers = [
    ...style.layers,
    ...prefLineLayers(),
    ...layers.slice(0, at),
    prefLabelLayer(),
    ...layers.slice(at),
  ];
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

// どのズームを持っているかはアーカイブが述べ、protocol がそれを伝える。スタイル
// に書き写したズームの範囲は、同じ問いへの二つ目の、しかも何も言わない答えで
// ある。z12 までのアーカイブに maxzoom:14 を書いたときは、スタイルの検査は通る
// のに z12 より下がどの層も真っ白になった。
const sources = routeSources(PMTILES_URL, PREF_PMTILES_URL);
for (const id of ['routes', PREF_SOURCE]) {
  const src = sources[id];
  ok(
    src.minzoom === undefined && src.maxzoom === undefined,
    `the ${id} vector source does not restate the archive's zoom range ` +
      `(${JSON.stringify(src)})`,
  );
}
ok(
  [...routeLayers(), ...prefLayers()]
    .filter((l) => l.source === 'routes' || l.source === PREF_SOURCE)
    .every((l) => l['source-layer'] === 'routes'),
  'every layer on a vector source names its source-layer',
);
// 都道府県道のアーカイブは z0-7 で `label` を落としている(#100)。それを読むのは
// 札の層だけで、その層は z8 から出る。ここが崩れると、引いた縮尺でだけ札が
// 消える——描かれない理由がタイルの中にあるので、画面を見ても分からない。
const labelReaders = prefLayers().filter((l) =>
  JSON.stringify(l).includes('"label"'),
);
ok(
  labelReaders.length > 0 && labelReaders.every((l) => l.minzoom >= 8),
  `every prefectural layer reading \`label\` starts at z8 ` +
    `(${labelReaders.map((l) => `${l.id}@${l.minzoom}`).join(', ')})`,
);

// 画面が作りうる絞り込みの組み合わせも、その場で妥当でなければならない。場面は
// 地域自身のデータから作るので、どこで走らせても同じ検査になる。最も深い重用が
// 最も厳しい場合である。重用が 1 つも無い県でも妥当なスタイルにはなるはずなので、
// 場面は例外を投げず、その県で最も長い路線へ落とす。--spec-only では読み取る
// 地域が無いので代用を使う。この節が訊くのは絞り込みが MapLibre の仕様に適合
// するかであり、適合するかどうかは中の番号によらない。18・117・406 は、この
// プロジェクトが通して例に使ってきた重用である。
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
${pass} passed, ${fails.length} failed(仕様のみ)`);
  process.exit(fails.length ? 1 : 0);
}

/* ---- 2. 絞り込みは素の JavaScript と同じアークを選ぶか ------------------- */
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

/* ---- 3. 区分の分割はアークを重複も脱落も無く分ける ---------------------- */
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

/* ---- 4. 部分文字列の罠 --------------------------------------------------- */
// ここに無い路線番号のうち、在る番号の中に数字として現れる物を選ぶ——2 は 20
// に、1 は 17 に隠れている。1 件でも当たれば、区切り文字による防ぎが破れた証拠
// になる。
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

// この地域で最も長い四つの路線は、二つの経路で同じ結果にならなければならない。
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

/* ---- 5. 最も深い重用を抜き取りで確かめる -------------------------------- */
// 最も深い重なりがどれだけ深いかは全国についての事実であって、県ごとの事実では
// ない——六重用は verify_national.py が結合後のデータで断定する。ここでは、
// それが在ってランキングの先頭に来ることだけを見る。
const top = meta.concurrency_ranking[0];
ok(
  top?.n >= 2,
  `deepest concurrency in ${meta.label} is ${top?.n}x ${JSON.stringify(top?.refs)}`,
);
// 最も深い組み合わせのどの番号も、同じアークに当たらなければならない——それが
// この地図の見せたい物である——うえで、絞り込みの素片と、保存されている一覧が、
// どのアークかについて一致しなければならない。重用が 1 つも無い県では、ここで
// 比べる物が無い。
if (!top) {
  console.log('NOTE  この地域に重用区間は無いので、この検査は行わない');
} else {
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
}

console.log(fails.length ? `\n${fails.join('\n')}` : '');
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
