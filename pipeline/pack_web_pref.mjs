/* 都道府県道の生成物を、閲覧側が実際に取る形にする。
 *
 * prefectural-routes.pmtiles ベクタタイル。国道とは別のアーカイブ
 * pref/{region}.meta.json 県ごとの集計。県を選んだときに 1 つだけ取る
 * pref/index.json 全国の県と番号だけの索引。選択パネルが読む
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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { encodeRoutes } from '../web/urlstate.mjs';
import { DATA, PREFECTURAL, ROOT } from './_paths.mjs';
import { combinationsOf, crossingsOf } from './rollup.mjs';
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
let metaBytes = 0;
let biggest = { region: null, bytes: 0 };
/* 全国の番号だけの索引。県別 meta は路線の集計が丸ごと入って 47 本で 3.29 MB
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
  const text = JSON.stringify(meta);
  const bytes = Buffer.byteLength(text, 'utf8');
  writeFileSync(join(METADIR, `${region}.meta.json`), text);

  totalArcs += mine.length;
  totalCombos += combos.length;
  totalCrossings += crossings.length;
  metaBytes += bytes;
  if (bytes > biggest.bytes) biggest = { region, bytes };
  dataBbox = unionBbox(dataBbox, bbox);
  for (const f of mine) features.push(f);
}

console.log(
  `${regions.length} regions -> ${totalArcs.toLocaleString()} arcs | ` +
    `combinations: ${totalCombos.toLocaleString()} | ` +
    `crossings: ${totalCrossings.toLocaleString()}`,
);
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
console.log(
  `index: ${Object.values(index)
    .reduce((a, s) => a + s.size, 0)
    .toLocaleString()} ` +
    `routes in ${(Buffer.byteLength(indexText, 'utf8') / 1e3).toFixed(1)} kB`,
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
