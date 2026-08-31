/* 地域ごとの生成物を、閲覧側が実際に取る 2 ファイルにする。
 *
 * 全国のアークは GeoJSON にすると数十 MB になり、1 ファイルでは配れず、47 個に
 * 分けても読み込めない。だから閲覧側は特徴量を持つこと自体をやめる。
 *
 *   national-routes.pmtiles  ベクタタイル。画面に出ている物しか手元に載らない
 *   national.meta.json       画面が出す合計。代わりにここで計算する
 *
 * 2 つ目が 1 つ目を成り立たせている。app.js はかつて、路線の一覧も重用ランキング
 * も選択の合計も、特徴量を全部辿って求めていた。タイルでは全体が手元に無いので、
 * その合計は重複排除したアークに対してここで一度だけ計算し、データとして配る。
 *
 * 集計は rollup.mjs、タイルは tiles.mjs が持つ。どちらも都道府県道の側
 * (pack_web_pref.mjs)が同じ物を呼ぶ。ここに残るのは「一般国道に固有のこと」
 * ——地域の結合、政令の台帳、地域をまたぐ起終点——だけである。
 *
 * 使い方:  node pipeline/pack_web.mjs [--maxzoom 14]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DATA, DECREE, REGIONS, ROOT } from './_paths.mjs';
import { combinationsOf, crossingsOf } from './rollup.mjs';
import { bboxOf, unionBbox, writeTiles } from './tiles.mjs';

const TILEDIR = join(ROOT, 'build', 'tiles');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : Number(process.argv[i + 1]);
};
// 切る最も深いズーム。これより深く(z がこれより大きく)寄ると MapLibre はこの
// ズームの形を引き伸ばすので、詳しさが増えるのはここまでである。これを述べる
// 場所は他に無い。アーカイブが持ち、スタイルはアーカイブに訊く。
const MAXZOOM = arg('--maxzoom', 14);
// このズームより深いぶんは、全国をタイルごとの独立したピラミッドに分けて切る。
// geojson-vt が深いピラミッド全体を一度に抱えずに済む。
const SPLIT = 8;

/* ----------------------------------------------------------------- merge --- */
const index = JSON.parse(readFileSync(join(REGIONS, 'regions.json'), 'utf8'));
if (!index.length) throw new Error('build/regions/regions.json is empty');

const byId = new Map();
const metas = [];
for (const r of index) {
  metas.push(
    JSON.parse(readFileSync(join(REGIONS, `${r.region}.meta.json`), 'utf8')),
  );
  const geo = JSON.parse(
    readFileSync(join(REGIONS, `${r.region}.geojson`), 'utf8'),
  );
  for (const f of geo.features) {
    // bbox は矩形なので、継ぎ目では同じ道が二度返ってくる。同一性を決めるのは
    // OSM の way id で、形を比べる必要は無い。
    if (byId.has(f.properties.id)) continue;
    byId.set(f.properties.id, f);
  }
}
const features = [...byId.values()];
console.log(
  `${index.length} regions -> ${features.length.toLocaleString()} arcs after dedupe`,
);

/* タイルが持つ属性。`refs_list` は落とす。MVT に配列の型は無く、その一覧は
 * 絞り込みが既に使っている、区切り文字で囲んだ値から復元できる。`label` を
 * ここで作っておくのは、symbol の層が素の属性を必要とするためである。 */
for (const f of features) {
  const p = f.properties;
  const list = p.refs_list;
  f.properties = {
    id: p.id,
    refs: p.refs,
    label: list.join('・'),
    n: p.n,
    kind: p.kind,
    src: p.src,
    former: p.former,
    // `revoked` が出来る前に生成した地域はこの欄を持たない(#51 で入った欄で、
    // build/regions の大半はそれより古い)。0 は誰も確認していないという意味
    // ——未確認であって現役ではない——なので、正直な代用であり、しかも MVT が
    // 運べる唯一の値でもある。
    revoked: p.revoked || 0,
    name: p.name || '',
    updated: p.updated,
    km: p.km,
  };
  f.bbox = bboxOf(f.geometry.coordinates);
  f.refs_list = list;
}

/* MVT に null は無い。欠けた属性を vt-pbf は「どの field も立っていない値」と
 * して書き、MapLibre は "unknown feature value" と答えてタイルを丸ごと捨てる
 * ——アーク 1 本の欄が 1 つ欠けるだけで、そのタイルの道が全部消える。しかも
 * それが起きるのはブラウザの中、ビルドが完了を告げたずっと後である。13 万件を
 * 一巡してでも、ここで言う値打ちがあるのはそのためである。 */
for (const f of features) {
  for (const [k, v] of Object.entries(f.properties)) {
    if (v === null || v === undefined) {
      throw new Error(
        `arc ${f.properties.id}: property "${k}" is ${v}. MVT cannot carry ` +
          'it, and MapLibre drops every tile that contains it.',
      );
    }
  }
}

const dataBbox = features.reduce((a, f) => unionBbox(a, f.bbox), [
  Infinity,
  Infinity,
  -Infinity,
  -Infinity,
]);

/* ---------------------------------------------------------------- 集計 --- */
/** 地域をまたいで結合した起終点。重なりの内側にある点は二度報告されるので、
 *  位置を鍵にして、そこで出会う路線番号を合わせる。 */
function mergeTermini(ms) {
  const at = (t) => `${t.lat.toFixed(5)},${t.lon.toFixed(5)}`;
  const single = new Map();
  const shared = new Map();
  for (const m of ms) {
    for (const t of m.termini) single.set(`${at(t)}/${t.ref}`, t);
    for (const t of m.shared_termini) {
      const cur = shared.get(at(t));
      if (cur) {
        cur.refs = [...new Set([...cur.refs, ...t.refs])].sort((a, b) => a - b);
      } else {
        shared.set(at(t), { lat: t.lat, lon: t.lon, refs: [...t.refs] });
      }
    }
  }
  return {
    termini: [...single.values()],
    shared_termini: [...shared.values()].sort(
      (a, b) => b.refs.length - a.refs.length,
    ),
  };
}

/* 政令自身の起点・終点・重要な経過地。pipeline/decree.py がここへ置く。
 * これは端点の置き換えではなく、隣に並ぶ別の欄である。端点は路線のアークが
 * どこで終わるかを述べ、こちらは路線が法令上どこから始まるかを述べる。座標が
 * 当たらなかった路線は地名だけを持ち、その理由を述べる。 */
const decree = JSON.parse(readFileSync(join(DECREE, 'decree.json'), 'utf8'));
if (decree.routes.length !== 459)
  throw new Error(
    `build/decree/decree.json has ${decree.routes.length} routes, not 459`,
  );

/** 日付文字列(ISO 8601、ゼロ埋め)のうち最も古いもの。この形式は文字列の
 *  辞書順がそのまま時系列順になるため、Date に変換せず文字列のまま比べる。 */
const min = (v) => v.filter(Boolean).sort()[0] || null;
/** `min` と同じ理由で、文字列の辞書順のまま最も新しいものを返す。 */
const max = (v) => v.filter(Boolean).sort().slice(-1)[0] || null;

const combos = combinationsOf(features);
// 国道の路線の同一性は番号そのもので、全国で一意である。
const crossings = crossingsOf(features, (a, b) => a - b);
const termini = mergeTermini(metas);
const meta = {
  // 新しさは最も悪い側で報告する。地図の新しさは最も古い地域の新しさでしかなく、
  // それ以外の言い方はすべて過大である。
  osm_timestamp: min(metas.map((m) => m.osm_timestamp)),
  oldest_edit: min(metas.map((m) => m.oldest_edit)),
  newest_edit: max(metas.map((m) => m.newest_edit)),
  endpoints: [...new Set(metas.map((m) => new URL(m.endpoint).host))],
  arc_count: features.length,
  total_km:
    Math.round(features.reduce((s, f) => s + f.properties.km, 0) * 10) / 10,
  bbox: dataBbox.map((v) => Math.round(v * 1e5) / 1e5),
  source: {
    type: 'vector',
    tiles: 'https://data.nanase.cc/national-routes.pmtiles',
    maxzoom: MAXZOOM,
  },
  combinations: combos,
  // 路線どうしの関わりのうち、組み合わせ表にも起終点にも出ないもの。詳細パネル
  // が、いま見ている路線と交わる路線を並べるのに読む。
  crossings,
  ...termini,
  decree,
};

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'national.meta.json'), JSON.stringify(meta));
writeFileSync(join(DATA, 'regions.json'), JSON.stringify(index));

const routes = new Set(combos.flatMap((c) => c.refs));
console.log(
  `combinations: ${combos.length.toLocaleString()} | routes: ${routes.size} | ` +
    `termini: ${termini.termini.length.toLocaleString()} ` +
    `(shared ${termini.shared_termini.length.toLocaleString()}) | ` +
    `crossings: ${crossings.length.toLocaleString()}`,
);
const located = decree.routes.filter(
  (r) => r.start.lat !== undefined && r.end.lat !== undefined,
).length;
console.log(
  `decree: ${decree.routes.length} routes, both termini located for ${located}`,
);

/* ----------------------------------------------------------------- tiles --- */
/* 切り方は pipeline/tiles.mjs が持つ。都道府県道の側(pack_web_pref.mjs)と同じ
 * 仕事なので、ここには置かない。
 *
 * `lowMaxZoom` は既定の `SPLIT - 1` のままにする。geojson-vt は索引の maxZoom に
 * 当たるズームを閾値 0 で書き出すので、国道の z7 は簡略化されない——それが今の
 * 55.9 MB のアーカイブが描いている絵である。値を動かすと z7 の線が変わる。国道の
 * アーカイブを作り直さないのは #100 で決めたことなので、ここは動かさない。 */
writeTiles({
  dir: TILEDIR,
  layer: 'routes',
  features,
  bbox: meta.bbox,
  maxzoom: MAXZOOM,
  split: SPLIT,
  tolerance: 3,
});
console.log(`meta: ${(JSON.stringify(meta).length / 1e6).toFixed(2)} MB`);
