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
 * 集計は 1 枚の表である。指定の組み合わせごとに 1 行で、延長・アーク数・広がりと、
 * その延長が何でできているか——`kind` 別と旧道別——を持つ。路線の合計もランキング
 * も選択の集計も、その行の部分和である。だから数の出どころは三つではなく一つで、
 * 食い違いようがない。路線別の表では足りないのは重用のためである。18 号と 117 号
 * を持つアークは両方に属するので、二つの路線の行を足すと二重に数える。
 *
 * タイルは geojson-vt で切る——MapLibre が GeoJSON ソースに使うのと同じコード
 * なので、ブラウザが描く形の求め方は今までと変わらない。tippecanoe に Windows
 * 版は無く、これには不要である。
 *
 * 使い方:  node pipeline/pack_web.mjs [--maxzoom 14]
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

import { DATA, DECREE, REGIONS, ROOT } from './_paths.mjs';

const TILEDIR = join(ROOT, 'build', 'tiles');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : Number(process.argv[i + 1]);
};
// 切る最も深いズーム。それより下では MapLibre がこのズームの形を引き伸ばすので、
// 詳しさが増えるのはここまでである。これを述べる場所は他に無い。アーカイブが
// 持ち、スタイルはアーカイブに訊く。
const MAXZOOM = arg('--maxzoom', 14);
// このズームより下では、全国をタイルごとの独立したピラミッドに分けて切る。
// geojson-vt が深いピラミッド全体を一度に抱えずに済む。
const SPLIT = 8;
const EXTENT = 4096;

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

function bboxOf(coords) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

const dataBbox = features.reduce(
  (a, f) => [
    Math.min(a[0], f.bbox[0]),
    Math.min(a[1], f.bbox[1]),
    Math.max(a[2], f.bbox[2]),
    Math.max(a[3], f.bbox[3]),
  ],
  [Infinity, Infinity, -Infinity, -Infinity],
);

/* ---------------------------------------------------------------- 集計 --- */
const km2 = (v) => Math.round(v * 100) / 100;

/** 指定の集合ごとに 1 行。画面が出す物はどれも、この行の部分和である。
 *
 *  行はその延長が何でできているかも持つ。合計だけでは「国道152号のうち実際に
 *  走れるのはどれだけか」に答えられないためである。`kinds` は延長をタイルが
 *  持つのと同じ `kind` で分け、`former_km` はそのうち旧道がどれだけかを述べる。
 *  二つを別の欄にしてあるのは、別の軸だからである。旧道は「どれかの区分の道で
 *  あって、現道ではなくなった物」なので、`kinds` に畳むと自動車専用道路の旧道も
 *  徒歩道の旧道も見えなくなる(#26)。
 *
 *  どちらも 0 は書かずに欠落で表す。行は約 1,200、区分は七つあり、1 行が名指し
 *  するのは 1 つか 2 つである。0 の五つを書き並べれば、何も述べないまま表が
 *  三倍になる。 */
function combinationsOf(feats) {
  const by = new Map();
  for (const f of feats) {
    const p = f.properties;
    let e = by.get(p.refs);
    if (!e) {
      e = {
        refs: f.refs_list,
        n: p.n,
        km: 0,
        arcs: 0,
        kinds: new Map(),
        former: 0,
        names: new Map(),
        bbox: [Infinity, Infinity, -Infinity, -Infinity],
      };
      by.set(p.refs, e);
    }
    e.km += p.km;
    e.arcs++;
    e.kinds.set(p.kind, (e.kinds.get(p.kind) || 0) + p.km);
    if (p.former) e.former += p.km;
    if (p.name) e.names.set(p.name, (e.names.get(p.name) || 0) + 1);
    e.bbox = [
      Math.min(e.bbox[0], f.bbox[0]),
      Math.min(e.bbox[1], f.bbox[1]),
      Math.max(e.bbox[2], f.bbox[2]),
      Math.max(e.bbox[3], f.bbox[3]),
    ];
  }
  return [...by.values()]
    .map((e) => {
      // 先に丸めてから落とす。丸めて消える区分は 5 m 未満で、述べることが無い。
      // 名前はビルドがアークを分類したときの物で、ここが独自の語彙を作ることは
      // しない。
      const kinds = [...e.kinds.entries()]
        .map(([k, v]) => [k, km2(v)])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const former = km2(e.former);
      return {
        refs: e.refs,
        n: e.n,
        km: km2(e.km),
        arcs: e.arcs,
        kinds: Object.fromEntries(kinds),
        ...(former > 0 ? { former_km: former } : {}),
        names: [...e.names.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([n]) => n),
        bbox: e.bbox.map((v) => Math.round(v * 1e5) / 1e5),
      };
    })
    .sort((a, b) => b.n - a.n || b.km - a.km);
}

/** 平面で交わる路線の組。
 *
 * 重用は「一本の道が複数の番号を持つ」ことなので、組み合わせ表がすでに述べて
 * いる。ここが述べるのはその逆——別々の道が一点で出会うこと——で、表のどこにも
 * 無い。交差点はアークの端とはかぎらない。OSM の way は交差のたびに切れている
 * とはかぎらず、一方の途中の節点をもう一方の端が踏むことがあるので、端だけを
 * 見ると出会う組の 2% を取り落とす。だから節点を全部見る。
 *
 * 節点は座標そのもので同定する。同じ OSM 節点から出た座標は build_routes.py が
 * 同じ桁(小数第 6 位、約 10 cm)で丸めているので、文字列として一致する。立体交差
 * は節点を共有しないので、ここには出ない——曲がれない交差は交差ではない。
 *
 * 最初にその節点を踏んだアークの refs_list は、複製せずそのまま置く。二本目が
 * 来て初めて Set に起こす。全国の節点は 160 万あり、その大半は一本しか踏まない
 * ので、この一手で置き場のほとんどが参照だけで済む。同時に、一本しか踏まない
 * 節点(交差点ではない)が組を作らないことが、この形そのものから従う。
 *
 * 重用したことのある組は落とす。重用は重用として述べる場所があり、同じことを
 * 二箇所で言わないためである。落とす相手は「同じアークに載ったことがある組」
 * なので、一本のアークが自分の節点に落とす影も一緒に消える。
 */
function crossingsOf(feats) {
  const concurrent = new Set();
  for (const f of feats) {
    const refs = f.refs_list;
    for (let i = 0; i < refs.length; i++)
      for (let j = i + 1; j < refs.length; j++)
        concurrent.add(`${refs[i]},${refs[j]}`);
  }

  const at = new Map();
  for (const f of feats) {
    const refs = f.refs_list;
    for (const c of f.geometry.coordinates) {
      const k = `${c[0]},${c[1]}`;
      const cur = at.get(k);
      if (cur === undefined) at.set(k, refs);
      else if (Array.isArray(cur)) {
        const s = new Set(cur);
        for (const r of refs) s.add(r);
        at.set(k, s);
      } else {
        for (const r of refs) cur.add(r);
      }
    }
  }

  const pairs = new Set();
  for (const v of at.values()) {
    if (Array.isArray(v) || v.size < 2) continue;
    const rs = [...v].sort((a, b) => a - b);
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const k = `${rs[i]},${rs[j]}`;
        if (!concurrent.has(k)) pairs.add(k);
      }
  }
  return [...pairs]
    .map((k) => k.split(',').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

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

const min = (v) => v.filter(Boolean).sort()[0] || null;
const max = (v) => v.filter(Boolean).sort().slice(-1)[0] || null;

const combos = combinationsOf(features);
const crossings = crossingsOf(features);
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
const lonX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};

/** あるズームで、データが覆うタイルの範囲。 */
function tileRange(bbox, z) {
  const n = 2 ** z;
  const clamp = (v) => Math.max(0, Math.min(n - 1, Math.floor(v)));
  return {
    x0: clamp(lonX(bbox[0], z)),
    x1: clamp(lonX(bbox[2], z)),
    y0: clamp(latY(bbox[3], z)),
    y1: clamp(latY(bbox[1], z)),
  };
}

const tileBounds = (z, x, y) => {
  const n = 2 ** z;
  const lon = (v) => (v / n) * 360 - 180;
  const lat = (v) => {
    const m = Math.PI * (1 - (2 * v) / n);
    return (180 / Math.PI) * Math.atan(Math.sinh(m));
  };
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
};

const overlaps = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const fc = (feats) => ({
  type: 'FeatureCollection',
  features: feats.map((f) => ({
    type: 'Feature',
    properties: f.properties,
    geometry: f.geometry,
  })),
});

/* タイルは切ったそばから書き出す。
 *
 * 全部を配列に溜めてから Buffer.concat で 1 本にしていた。tiles.bin は
 * 98.8 MB なので、繋ぐ瞬間だけ同じ物が 2 つ、約 200 MB 生きる。47 県ぶんの
 * GeoJSON と結合済みの弧も同時に載っているところで、これが
 * `node --max-old-space-size=6144` を要求している一因だった。
 *
 * 索引は書いた順・書いた位置をそのまま並べるので、溜めてから数えるのと
 * 同じ物になる。つまり出来上がる 2 ファイルは 1 バイトも変わらない。
 *
 * 書く先は仮の名前にする。tiles.bin と tiles.json は対でなければ意味が無い
 * ——pack_pmtiles.py は索引の言う位置で blob を切るだけなので、短い bin と
 * 前回の json が残ると、範囲外の切り出しが空を返し、静かに壊れた PMTiles が
 * できる。本物を頭で truncate してしまうと、途中で落ちた回にその状態が残る。
 * 仮に書いておけば、落ちた回は前回の対がそのまま残る。 */
mkdirSync(TILEDIR, { recursive: true });
const BIN = join(TILEDIR, 'tiles.bin');
const IDX = join(TILEDIR, 'tiles.json');
const BIN_PART = `${BIN}.part`;
const binFd = openSync(BIN_PART, 'w');
const idxRows = [];
let total = 0;
let bytes = 0;

/* writeSync は部分書き込みを返しうる。返り値を捨てると、その 1 タイルだけが
 * 短いまま索引には全長が載り、archive が静かに壊れる。書き切るまで回す。 */
function writeAll(fd, buf) {
  let at = 0;
  while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
}

function emit(z, x, y, tile) {
  if (!tile?.features.length) return;
  const buf = vtpbf.fromGeojsonVt(
    { routes: tile },
    { version: 2, extent: EXTENT },
  );
  idxRows.push([z, x, y, bytes, buf.length]);
  writeAll(binFd, buf);
  total++;
  bytes += buf.length;
}

/* ズーム 0 から SPLIT-1 までは、全体を 1 つの索引から作る。タイルの数が少なく、
 * どれも十分に簡略化されているので、全部抱えても何ということはない。 */
console.log(`tiling z0-${SPLIT - 1} (whole country)`);
const low = geojsonvt(fc(features), {
  maxZoom: SPLIT - 1,
  indexMaxZoom: SPLIT - 1,
  tolerance: 3,
  extent: EXTENT,
  buffer: 64,
});
for (let z = 0; z < SPLIT; z++) {
  const r = tileRange(dataBbox, z);
  for (let x = r.x0; x <= r.x1; x++) {
    for (let y = r.y0; y <= r.y1; y++) emit(z, x, y, low.getTile(z, x, y));
  }
}
console.log(`  ${total} tiles`);

/* それより下は、SPLIT のタイルごとに 1 つのピラミッドを作る。特徴量は bbox で
 * 選ぶだけで、切らない。切り取りは geojson-vt 自身が行うので、先に切ると、
 * あちらでは繕えない継ぎ目が残る。 */
const r8 = tileRange(dataBbox, SPLIT);
const cells = [];
for (let x = r8.x0; x <= r8.x1; x++) {
  for (let y = r8.y0; y <= r8.y1; y++) cells.push([x, y]);
}

/** セルが取り込む範囲。中身を切らないための余白ぶん、セルより広い。 */
const cellBox = (x, y) => {
  const b = tileBounds(SPLIT, x, y);
  const margin = (b[2] - b[0]) * 0.05;
  return [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin];
};

/* どのセルにどの弧が必要かを、先に一度だけ振り分ける。
 *
 * セルごとに features を端から見ていた。日本は z8 で 16×20 の 320 セルに
 * 収まり、うち弧があるのは 70 だけである。つまり 130,000 件の走査を 320 回、
 * 4,160 万回の判定をして、その 8 割は 1 件も拾わないセルのために回っていた。
 *
 * 弧の側から見れば、1 本が跨ぐセルは普通 1 つ、多くて数個である。弧の
 * bbox を余白ぶん広げて z8 の索引に落とせば、当たりうるセルはその周りだけに
 * 絞れる。絞ったうえで、判定そのものは元と同じ overlaps を使う——低い側の
 * 端がちょうどセルの境に乗る場合まで含めて同じ答えにするため、候補は
 * 1 セルぶん広く取ってから本当の判定にかける。 */
const bucket = new Map();
const CELL_SPAN = 360 / 2 ** SPLIT;
const MARGIN = CELL_SPAN * 0.05;
for (const f of features) {
  const grown = [
    f.bbox[0] - MARGIN,
    f.bbox[1] - MARGIN,
    f.bbox[2] + MARGIN,
    f.bbox[3] + MARGIN,
  ];
  const r = tileRange(grown, SPLIT);
  for (let x = Math.max(r8.x0, r.x0 - 1); x <= Math.min(r8.x1, r.x1); x++) {
    for (let y = Math.max(r8.y0, r.y0 - 1); y <= Math.min(r8.y1, r.y1); y++) {
      if (!overlaps(f.bbox, cellBox(x, y))) continue;
      const key = `${x},${y}`;
      const list = bucket.get(key);
      if (list) list.push(f);
      else bucket.set(key, [f]);
    }
  }
}
console.log(
  `tiling z${SPLIT}-${MAXZOOM} in ${cells.length} cells (${bucket.size} with arcs)`,
);

let done = 0;
for (const [cx, cy] of cells) {
  const sub = bucket.get(`${cx},${cy}`) ?? [];
  done++;
  if (!sub.length) continue;
  const idx = geojsonvt(fc(sub), {
    maxZoom: MAXZOOM,
    indexMaxZoom: SPLIT,
    tolerance: 3,
    extent: EXTENT,
    buffer: 64,
  });
  for (let z = SPLIT; z <= MAXZOOM; z++) {
    const s = 2 ** (z - SPLIT);
    for (let x = cx * s; x < (cx + 1) * s; x++) {
      for (let y = cy * s; y < (cy + 1) * s; y++)
        emit(z, x, y, idx.getTile(z, x, y));
    }
  }
  process.stdout.write(
    `\r  cell ${done}/${cells.length}  ${sub.length} arcs  ` +
      `${total.toLocaleString()} tiles  ${(bytes / 1e6).toFixed(1)} MB   `,
  );
}
process.stdout.write('\n');

/* PMTiles にまとめる側は、10 万個の小さなファイルではなく 1 つの blob と 1 つの
 * 索引を受け取る。Windows では、そのファイルを作る時間のほうがタイルを切る時間
 * より長くなる。blob は既にディスクにある(emit を参照)。残るのは索引だけである。
 *
 * 古い索引を先に落としてから、blob を本物の名前へ移し、最後に索引を書く。
 * この順なら、どこで落ちても残るのは「前回の対」か「索引の無い blob」の
 * どちらかで、食い違う対にはならない。索引が無ければ pack_pmtiles.py は
 * 読めずに落ちる——静かに壊れた PMTiles よりそちらがよい。 */
closeSync(binFd);
rmSync(IDX, { force: true });
renameSync(BIN_PART, BIN);
writeFileSync(
  IDX,
  JSON.stringify({
    minzoom: 0,
    maxzoom: MAXZOOM,
    extent: EXTENT,
    bbox: meta.bbox,
    layer: 'routes',
    tiles: idxRows,
  }),
);
console.log(
  `wrote ${total.toLocaleString()} tiles, ${(bytes / 1e6).toFixed(1)} MB uncompressed`,
);
console.log(`meta: ${(JSON.stringify(meta).length / 1e6).toFixed(2)} MB`);
