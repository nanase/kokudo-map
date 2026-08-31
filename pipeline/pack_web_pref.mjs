/* 都道府県道の生成物を、閲覧側が実際に取る形にする。
 *
 *   prefectural-routes.pmtiles   ベクタタイル。国道とは別のアーカイブ
 *   pref/{region}.meta.json      県ごとの集計。県を選んだときに 1 つだけ取る
 *
 * 国道(pack_web.mjs)と分ける理由は三つある。国道の 55.9 MB を県道を直すたびに
 * 上げ直さずに済むこと。タイル化のメモリが 2 回に分かれること。県道側が壊れても
 * 国道の地図は出ること。切り方そのものは tiles.mjs、集計は rollup.mjs が持つ
 * ので、ここが持つのは「都道府県道に固有のこと」だけである。
 *
 * meta を全国 1 枚にしないのは、初期表示で読む量を増やさないためである。国道の
 * national.meta.json は 0.61 MB を画面が丸ごと先読みする。路線が 459 から 13,234 に
 * なると、いちばん激しく増えるのは交差の組である。県ごとに分ければ、画面が最初に
 * 読む JSON は今までどおり国道のぶんだけで、県のぶんは県を選んだときに取る。
 *
 * 使い方:  node pipeline/pack_web_pref.mjs [--maxzoom 14]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DATA, PREFECTURAL, ROOT } from './_paths.mjs';
import { combinationsOf, crossingsOf } from './rollup.mjs';
import { bboxOf, unionBbox, writeTiles } from './tiles.mjs';

const TILEDIR = join(ROOT, 'build', 'tiles-prefectural');
const METADIR = join(DATA, 'pref');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : Number(process.argv[i + 1]);
};
// 切る最も深いズーム。国道と同じ値である。これを述べる場所は他に無い——アーカイブ
// が持ち、スタイルはアーカイブに訊く。
const MAXZOOM = arg('--maxzoom', 14);
// このズームより深いぶんは、全国をタイルごとの独立したピラミッドに分けて切る。
const SPLIT = 8;

/* ズーム下限は置かない。都道府県道も国道と同じく、縮尺で番号を省略しない(#95)。
 * 代わりに、低ズームでは載せる属性を減らす。
 *
 * z0-7 で線を描くのに要るのはここに挙げた七つだけである。番号の札は z8 から出る
 * ので(web/mapspec.mjs の route-labels は minzoom 8)、`label` はそもそも読まれない。
 * `id`・`name`・`km`・`src` を読むのはポップアップだけである。
 *
 * 実測では、この七つに絞ると z0-7 の最大タイルが 2,322 kB から 1,258 kB になる。
 * 国道の低ズーム最大 2,233 kB に対して 56% で、簡略化の閾値は国道と同じ 3 のまま
 * ——つまり線の形は変えずに半分にしている。docs/results.md に内訳がある。
 *
 * 引き換えに、z8 未満では県道のポップアップが出せない。z7 は 1 画素が約 1.2 km で、
 * 県道の網はその縮尺では網目になる。どの線を掴んだかが読み手にも決められない
 * ところで、どれか 1 本の名前を出しても情報にならない。画面側の扱いは #101 が
 * 決める。 */
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

/** 路線の並べ方。番号は県の中でしか一意でないので鍵は `nagano-18` の形だが、
 *  並べるときに意味があるのは番号のほうである。県が同じ物どうしを比べるので、
 *  県名は同点のときの区切りにしか効かない。 */
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

for (const region of regions) {
  const built = JSON.parse(
    readFileSync(join(PREFECTURAL, `${region}.meta.json`), 'utf8'),
  );
  const geo = JSON.parse(
    readFileSync(join(PREFECTURAL, `${region}.geojson`), 'utf8'),
  );

  /* この県のアーク。タイルが持つ属性はここで決まる。`refs_list` はタイルには
   * 載せない——MVT に配列の型は無く、その一覧は絞り込みが既に使っている、区切り
   * 文字で囲んだ `refs` から復元できる。集計はこの場で済ませるので、`refs_list`
   * と `bbox` は特徴量の側に置いて MVT の属性には入れない。 */
  const mine = [];
  for (const f of geo.features) {
    const p = f.properties;
    const list = p.refs_list;
    const feat = {
      properties: {
        id: p.id,
        pref: p.pref,
        refs: p.refs,
        // 札に出す文字。県は `pref` が持つので、ここは番号だけである。1 本の
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

  /* MVT に null は無い。欠けた属性を vt-pbf は「どの field も立っていない値」と
   * して書き、MapLibre は "unknown feature value" と答えてタイルを丸ごと捨てる
   * ——アーク 1 本の欄が 1 つ欠けるだけで、そのタイルの道が全部消える。しかも
   * それが起きるのはブラウザの中、ビルドが完了を告げたずっと後である。 */
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
    // 指定延長。重用区間を指定した路線の数だけ数えた物で、年報の 総延長 に当たる。
    designated_km: built.designated_km,
    bbox: bbox.map((v) => Math.round(v * 1e5) / 1e5),
    combinations: combos,
    // 路線どうしの関わりのうち、組み合わせ表に出ないもの。国道との交差はここに
    // 出ない——この集合に国道のアークが入っていないためである。
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

/* ----------------------------------------------------------------- tiles --- */
/* 低ズーム側の索引の maxZoom を SPLIT にする。geojson-vt は索引の maxZoom に
 * 当たるズームを閾値 0 で書き出す——点も落とさず、短い線も捨てない。既定の
 * `SPLIT - 1` では、いちばん深い低ズーム(z7)だけが素のまま出る。国道の z7 が
 * 12.12 MB と、その下の z8 の 5.96 MB より大きいのはそのためである。 */
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
