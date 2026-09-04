/* 都道府県道の生成物を、閲覧側が実際に取る形にする。
 *
 *   prefectural-routes.pmtiles   ベクタタイル。国道とは別のアーカイブ
 *   pref/{region}.meta.json      県ごとの集計。県を選んだときに 1 つだけ取る
 *   pref/index.json              全国の県と番号だけの索引。選択パネルが読む
 *   pref/summary.json            全国の対象アーク・延長・重用アーク・路線数。
 *                                 「この地図について」を開いたときに 1 度だけ
 *                                 取る(web/app.js の loadPrefSummary)
 *
 * 国道(pack_web.mjs)と分ける理由は三つある。国道の 55.9 MB を県道を直すたびに
 * 上げ直さずに済み、タイル化のメモリが 2 回に分かれ、県道側が壊れても国道の
 * 地図は出る。切り方は tiles.mjs、集計は rollup.mjs が持つので、ここが持つのは
 * 都道府県道に固有のことだけである。
 *
 * meta を全国 1 枚にしないのは、初期表示で読む量を増やさないためである。国道の
 * national.meta.json は 0.61 MB を画面が丸ごと先読みする。路線が 459 から
 * 13,234 になると、いちばん激しく増えるのは交差の組である。県ごとに分ければ、
 * 画面が最初に読む JSON は国道のぶんだけで、県のぶんは県を選んだときに取る。
 *
 * 使い方:  node pipeline/pack_web_pref.mjs [--maxzoom 14]
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { statsFor } from '../web/aggregate.mjs';
import { encodeRoutes } from '../web/urlstate.mjs';
import { DATA, PREFECTURAL, ROOT, SURVEY } from './_paths.mjs';
import {
  addEndpoints,
  borderPairs,
  combinationsOf,
  crossingsOf,
  groupsOf,
  pickName,
  relationRouteName,
  sharedRouteName,
} from './rollup.mjs';
import { bboxOf, unionBbox, writeTiles } from './tiles.mjs';

const TILEDIR = join(ROOT, 'build', 'tiles-prefectural');
const METADIR = join(DATA, 'pref');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : Number(process.argv[i + 1]);
};
// 切る最も深いズーム。国道と同じ値である。アーカイブが持ち、スタイルは
// アーカイブに訊くので、これを書く場所は他に無い。
const MAXZOOM = arg('--maxzoom', 14);
// このズームより深いぶんは、全国をタイルごとの独立したピラミッドに分けて切る。
const SPLIT = 8;

/* ズーム下限は置かない。都道府県道も国道と同じく縮尺で番号を省略しない(#95)。
 * 代わりに、低ズームでは載せる属性を減らす。
 *
 * z0-7 で線を描くのに必要なのはここに挙げた七つだけである。番号のラベルは z8
 * から出るので(web/mapspec.mjs の route-labels は minzoom 8)`label` は
 * 読まれず、`id`・`name`・`km`・`src` を読むのはポップアップだけである。
 * 実測では、この七つに絞ると z0-7 の最大タイルが 2,322 kB から 1,258 kB
 * になる。国道の低ズーム最大 2,232 kB に対して 56% で、簡略化の閾値は国道と同じ
 * 3 のまま、線の形を変えずに半分にしている(docs/results.md)。
 *
 * 引き換えに、z8 未満では県道のポップアップが出せない。z7 は 1 画素が約 1.2 km
 * で、県道の網はその縮尺では網目になる。どの線を掴んだかが読み手にも
 * 決められない所で、どれか 1 本の名前を出しても情報にならない。画面側の扱いは
 * #101 が決める。 */
const LOW_ZOOM_FIELDS = [
  'pref',
  'refs',
  'n',
  'kind',
  'rank',
  'former',
  'revoked',
];

const lowProperties = (p) => {
  const out = {};
  for (const k of LOW_ZOOM_FIELDS) out[k] = p[k];
  return out;
};

/** 路線の並べ方。番号は県の中でしか一意でないのでキーは `nagano-18` の形だが、
 *  並べるときに意味があるのは番号である。県が同じ物どうしを比べるので、県名は
 *  同点のときの区切りにしか効かない。 */
const num = (key) => Number(key.slice(key.lastIndexOf('-') + 1));
const prefOf = (key) => key.slice(0, key.lastIndexOf('-'));
const byRef = (a, b) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ 県ごと --- */
const regions = readdirSync(PREFECTURAL)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => f.slice(0, -'.meta.json'.length))
  .sort();
if (!regions.length)
  throw new Error(
    'build/prefectural/ が空である。先に `mise run survey-pref` と ' +
      '`mise run build-pref` を実行する。',
  );

mkdirSync(METADIR, { recursive: true });

const features = [];
let dataBbox = [Infinity, Infinity, -Infinity, -Infinity];
let totalArcs = 0;
let totalCombos = 0;
let totalCrossings = 0;
/* pref/summary.json が配る全国集計。web/aggregate.mjs の statsFor と同じ数え方
 * を都道府県道の県別 combos に当てる。web/panel.mjs の statsHTML(国道側)が
 * 同じ関数を同じ形で読んでいるので、答え方を二箇所に分けない。県ごとの combos
 * はその県のアークだけを持つので、県をまたぐ二重計上は起きない。 */
let summaryArcs = 0;
let summaryKm = 0;
let summaryConc = 0;
/* 県別 meta は県ごとのループの中では書けない。群は全県を見終わらないと決まらず、
 * その群は 2〜4 県の meta に載るからである。47 県ぶんを抱えたまま、ループの外で
 * 書く。合わせて 3.5 MB で、この段が既に抱えている全国のアークに比べれば小さい。 */
const metas = [];
/* アークの端点。県境で番号が続く路線を拾うのに読む。県ごとのループの中で貯める。 */
const endpoints = new Map();
/* 路線ごとの延長と、way が名乗った名前。どちらも組み合わせ表から足す。群の
 * 合算延長と路線名がここから出る。 */
const kmOf = new Map();
const namesOf = new Map();
/* 全国の番号だけの索引。県別 meta は路線の集計が丸ごと入って 47 本で 3.54 MB
 * あり、「番号で絞り込む」ためだけに読ませる量ではない。ここが番号だけを抜いて
 * 1 枚にする。 */
const index = {};

for (const region of regions) {
  const built = JSON.parse(
    readFileSync(join(PREFECTURAL, `${region}.meta.json`), 'utf8'),
  );
  const geo = JSON.parse(
    readFileSync(join(PREFECTURAL, `${region}.geojson`), 'utf8'),
  );

  /* この県のアーク。タイルが持つ属性はここで決まる。`refs_list` はタイルに
   * 載せない。MVT に配列の型は無く、区切り文字で囲んだ `refs` から復元できる。
   * 集計はこの場で済ませるので、`refs_list` と `bbox` は特徴量の側に置く。 */
  const mine = [];
  for (const f of geo.features) {
    const p = f.properties;
    const list = p.refs_list;
    const feat = {
      properties: {
        id: p.id,
        pref: p.pref,
        refs: p.refs,
        // ラベルに出す文字。県は `pref` が持つので番号だけである。1 本の
        // アークが持つ番号は必ず同じ県の物なので(build_prefectural.py の
        // refs_key)、県を番号ごとに繰り返す必要が無い。
        label: list.map(num).join('・'),
        n: p.n,
        kind: p.kind,
        // 主要地方道か一般都道府県道か。境目の番号を持っているのは判定なので、
        // ここで番号から決め直すことはしない。
        rank: p.rank,
        src: p.src,
        former: p.former,
        revoked: p.revoked,
        name: p.name || '',
        km: p.km,
      },
      geometry: f.geometry,
      refs_list: list,
      bbox: bboxOf(f.geometry.coordinates),
    };
    mine.push(feat);
  }

  /* MVT に null は無い。欠けた属性を vt-pbf は「どの field も立っていない値」
   * として書き、MapLibre は "unknown feature value" と答えてタイルを丸ごと
   * 捨てる。アーク 1 本の欄が 1 つ欠けるだけでそのタイルの道が全部消え、それが
   * 起きるのはブラウザの中、ビルドが完了を告げた後である。 */
  for (const f of mine) {
    for (const [k, v] of Object.entries(f.properties)) {
      if (v === null || v === undefined) {
        throw new Error(
          `${region} のアーク ${f.properties.id}: 属性 "${k}" が ${v} である。` +
            'MVT はこれを運べず、MapLibre はこれを含むタイルを丸ごと捨てる。',
        );
      }
    }
  }

  const combos = combinationsOf(mine, (f) => ({ rank: f.properties.rank }));
  const crossings = crossingsOf(mine, byRef);
  // その県に在る番号。組み合わせ表のキーから番号だけを取り、重複を落とす。
  index[region] = new Set(combos.flatMap((c) => c.refs.map(num)));

  // pref/summary.json ぶんの積み上げ。選択が空の statsFor はその県の全アークの
  // 和になる。
  const stats = statsFor(combos, new Set());
  summaryArcs += stats.arcs;
  summaryKm += stats.km;
  summaryConc += stats.conc;
  const bbox = mine.reduce(
    (a, f) => unionBbox(a, f.bbox),
    [Infinity, Infinity, -Infinity, -Infinity],
  );

  const meta = {
    region,
    label: built.label,
    // 新しさの言い方は国道の meta と同じである。`osm_timestamp` は OSM の
    // データ基準、`surveyed_at` は build/survey を作った時刻である。
    osm_timestamp: built.osm_timestamp,
    surveyed_at: built.surveyed_at,
    n03_vintage: built.n03_vintage,
    arc_count: built.arc_count,
    // 重複排除の延長。同じ道を何本の県道が指定していても 1 度しか数えない。
    // 国道の meta が `total_km` と呼ぶのと同じ量である。
    total_km: built.arc_km,
    // 指定延長。重用区間を指定した路線の数だけ数えた物で、年報の 総延長 に
    // 当たる。
    designated_km: built.designated_km,
    bbox: bbox.map((v) => Math.round(v * 1e5) / 1e5),
    combinations: combos,
    // 路線どうしの関わりのうち、組み合わせ表に出ない物。国道との交差は出ない。
    // この集合に国道のアークが入っていないためである。
    crossings,
  };
  metas.push(meta);

  addEndpoints(mine, endpoints);
  for (const c of combos)
    for (const key of c.refs) {
      // 組み合わせはアークを重複なく分けるので、路線の延長はその路線を含む行の
      // 単純な和である。web/aggregate.mjs の routesOf と同じ数え方である。
      kmOf.set(key, (kmOf.get(key) ?? 0) + c.km);
      let names = namesOf.get(key);
      if (!names) {
        names = new Map();
        namesOf.set(key, names);
      }
      for (const n of c.names) names.set(n, (names.get(n) ?? 0) + 1);
    }

  totalArcs += mine.length;
  totalCombos += combos.length;
  totalCrossings += crossings.length;
  dataBbox = unionBbox(dataBbox, bbox);
  for (const f of mine) features.push(f);
}

console.log(
  `${regions.length} regions -> ${totalArcs.toLocaleString()} arcs | ` +
    `combinations: ${totalCombos.toLocaleString()} | ` +
    `crossings: ${totalCrossings.toLocaleString()}`,
);

/* ------------------------------------------------------- 複数県にわたる路線 --- */
/* 県境で番号が変わらずに続く路線を束ねる。長野県道1号・愛知県道1号・静岡県道1号
 * は 飯田富山佐久間線 として直接つながっているが、県ごとの meta はそれを述べない。
 *
 * 束ねるだけで、同一性は変えない。路線は (県, 番号) のままで、タイルの属性も
 * 変わらない。関係する都道府県がそれぞれ認定した別々の路線であり、年報も県ごとに
 * 数えている。3 つの認定を 1 つに畳むのは、この地図が重用区間でしないと決めた
 * 「番号を丸める」操作そのものである(issue #155)。
 *
 * 信号は二つあり、互いを補うので両方を採る。リレーションが保証するのは
 * (県, 番号) 13,234 組のうち半分ほどなので、リレーションだけでは無い路線が
 * 落ちる。県境で線が繋がっていない路線は幾何だけでは拾えない。実データでは
 * 373 と 519 で、350 が同じ顔ぶれを出す。
 *
 * 和にしてあるので、片方が 1 本取りこぼしても、もう片方が繋いでいればその群は
 * 残る。どちらか一方だけを直せば済む形にはしない。 */
const relPath = join(SURVEY, 'relations.json');
if (!existsSync(relPath))
  throw new Error(
    `${relPath} が無い。県をまたぐルートリレーションの表は ` +
      '`mise run survey-pref` が書く。',
  );
const relDoc = JSON.parse(readFileSync(relPath, 'utf8'));
const edges = borderPairs(endpoints, (key) => [prefOf(key), num(key)]).map(
  ([a, b]) => [a, b, 'geometry'],
);
for (const r of relDoc.relations) {
  const keys = r.regions.map((g) => `${g}-${r.ref}`);
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++)
      edges.push([keys[i], keys[j], 'relation']);
}
const groups = groupsOf(edges, byRef);
const byRoute = new Map();
groups.forEach((g, i) => {
  for (const key of g.refs) byRoute.set(key, i);
});

/* リレーション名を群ごとに集める。1 つの群を何本ものリレーションが別の名前で
 * 覆うことがあるので、どれを採るかは pickName が順序に依らない規則で決める。 */
const relNameOf = new Map();
for (const r of relDoc.relations) {
  const name = relationRouteName(r.name);
  if (name === null) continue;
  const i = byRoute.get(`${r.regions[0]}-${r.ref}`);
  if (i === undefined) continue;
  let by = relNameOf.get(i);
  if (!by) {
    by = new Map();
    relNameOf.set(i, by);
  }
  by.set(name, (by.get(name) ?? 0) + 1);
}

const continuations = groups.map((g, i) => {
  const by = relNameOf.get(i);
  const relName = by ? pickName(by) : null;
  // リレーション名を優先し、無ければ way 名に落とす。両方を持つ 296 群のうち
  // 293 群で一致する。どちらも無い 27 群では欄そのものを出さない。名前が無い
  // ことを理由に群を落とすことはしない。
  const name = relName ?? sharedRouteName(g.refs, namesOf);
  return {
    refs: g.refs,
    ...(name ? { name } : {}),
    // 群の全員の和。県をまたぐ重複は無いので単純な和でよい。
    km:
      Math.round(g.refs.reduce((s, k) => s + (kmOf.get(k) ?? 0), 0) * 10) / 10,
    src: g.src,
  };
});

const bySrc = new Map();
for (const c of continuations) bySrc.set(c.src, (bySrc.get(c.src) ?? 0) + 1);
console.log(
  `continuations: ${continuations.length} groups, ` +
    `${continuations.reduce((a, c) => a + c.refs.length, 0)} routes, ` +
    `${continuations.filter((c) => c.name).length} named | ` +
    `${[...bySrc.entries()]
      .sort()
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
);
endpoints.clear();

/* --------------------------------------------------------------- meta --- */
/* 同じ群が 2〜4 県の meta に重複して載る。作るのがここ 1 箇所なので、片方が
 * 暗黙のうちに古くなることはない。県別 meta は県を開いたときに 1 つだけ取る物
 * なので、その県で要る群がその中に揃っている方が、読むときと取るときが一致する。 */
let metaBytes = 0;
let biggest = { region: null, bytes: 0 };
for (const meta of metas) {
  const mine = continuations.filter((c) =>
    c.refs.some((k) => prefOf(k) === meta.region),
  );
  if (mine.length) meta.continuations = mine;
  const text = JSON.stringify(meta);
  const bytes = Buffer.byteLength(text, 'utf8');
  writeFileSync(join(METADIR, `${meta.region}.meta.json`), text);
  metaBytes += bytes;
  if (bytes > biggest.bytes) biggest = { region: meta.region, bytes };
}
metas.length = 0;
console.log(
  `meta: ${regions.length} files, ${(metaBytes / 1e6).toFixed(2)} MB total, ` +
    `biggest ${biggest.region} ${(biggest.bytes / 1e3).toFixed(0)} kB`,
);

/* ----------------------------------------------------------------- 索引 --- */
/* 番号は範囲表記に畳む。県の中の番号は塊で存在する(1-2,4,6-27,…)ので、羅列より
 * 短い。畳み方は web/urlstate.mjs の encodeRoutes を借りる。閲覧側は
 * 同じファイルの decodeRoutes で開くので、畳み方の答えが二箇所に分かれない。 */
const indexText = JSON.stringify(
  Object.fromEntries(
    Object.entries(index).map(([region, refs]) => [region, encodeRoutes(refs)]),
  ),
);
writeFileSync(join(METADIR, 'index.json'), indexText);
const totalRoutes = Object.values(index).reduce((a, s) => a + s.size, 0);
console.log(
  `index: ${totalRoutes.toLocaleString()} ` +
    `routes in ${(Buffer.byteLength(indexText, 'utf8') / 1e3).toFixed(1)} kB`,
);

/* ----------------------------------------------------------------- 集計 --- */
/* 「この地図について」が都道府県道側に出す全国集計。web/aggregate.mjs の
 * statsFor と同じ形(arcs・km・conc)にし、路線数を添える。国道の
 * national.meta.json 自体は積まない。閲覧側は起動時にこれを読まず、「この地図
 * について」を開いたときに 1 度だけ取る(web/app.js の loadPrefSummary)。 */
const summaryText = JSON.stringify({
  routes: totalRoutes,
  arcs: summaryArcs,
  km: Math.round(summaryKm * 10) / 10,
  conc: summaryConc,
});
writeFileSync(join(METADIR, 'summary.json'), summaryText);
console.log(
  `summary: arcs ${summaryArcs.toLocaleString()} | km ${summaryKm.toFixed(1)} | ` +
    `conc ${summaryConc.toLocaleString()} | routes ${totalRoutes.toLocaleString()}`,
);

/* ----------------------------------------------------------------- tiles --- */
/* 低ズーム側の索引の maxZoom を SPLIT にする。既定の `SPLIT - 1` では z7 だけが
 * 簡略化されずに出る。国道の z7 がその下の z8 より大きいのはそのためである
 * (docs/architecture.md「索引の一番深いズームは簡略化されない」)。 */
writeTiles({
  dir: TILEDIR,
  layer: 'routes',
  features,
  bbox: dataBbox.map((v) => Math.round(v * 1e5) / 1e5),
  maxzoom: MAXZOOM,
  split: SPLIT,
  lowMaxZoom: SPLIT,
  tolerance: 3,
  lowProperties,
});
