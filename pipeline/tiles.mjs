/* 特徴量の並びを、タイルの blob と索引にする。
 *
 * 国道(pack_web.mjs)と都道府県道(pack_web_pref.mjs)が同じ切り方を使う。切り方は
 * 属性でも集計でもなく、経緯度とズームだけで決まる仕事なので、二つの入口の
 * どちらにも属さない。書き写した複製を二つ持つと、片方が暗黙のうちに古くなる。
 *
 * 出す物は 1 つの blob と 1 つの索引である。ばらばらの .pbf を 10 万個作るより、
 * Windows では速い——pack_pmtiles.py はその 2 つを受け取る。
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

/** MVT のタイル内座標の分解能。閲覧側と切る側で同じ値でなければならない。 */
export const EXTENT = 4096;

/** 折れ線の外接矩形。 */
export function bboxOf(coords) {
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

/** 二つの矩形が重なるか。 */
export const overlaps = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** 矩形どうしの和。 */
export const unionBbox = (a, b) => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

const lonX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};

/** あるズームで、データが覆うタイルの範囲。 */
export function tileRange(bbox, z) {
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

const fc = (feats, project) => ({
  type: 'FeatureCollection',
  features: feats.map((f) => ({
    type: 'Feature',
    properties: project ? project(f.properties) : f.properties,
    geometry: f.geometry,
  })),
});

/* writeSync は部分書き込みを返しうる。返り値を捨てると、その 1 タイルだけが
 * 短いまま索引には全長が載り、archive が静かに壊れる。書き切るまで回す。 */
function writeAll(fd, buf) {
  let at = 0;
  while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
}

/**
 * 特徴量を切って `dir` へ tiles.bin と tiles.json を書く。
 *
 * @param {object} o
 * @param {string} o.dir           書き出す先
 * @param {string} o.layer         MVT の層の名前
 * @param {Array}  o.features      `{properties, geometry, bbox}` の並び
 * @param {number[]} o.bbox        データ全体の外接矩形
 * @param {number} o.maxzoom       切る最も深いズーム
 * @param {number} o.split         ここより深いぶんはタイルごとに分けて切る
 * @param {number} o.tolerance     簡略化の閾値(geojson-vt)
 * @param {number} [o.lowMaxZoom]  低ズーム側の索引の maxZoom。既定は `split - 1`
 * @param {Function} [o.lowProperties]  低ズームで載せる属性を選ぶ写像
 * @returns {{total: number, bytes: number}}
 */
export function writeTiles(o) {
  const {
    dir,
    layer,
    features,
    bbox,
    maxzoom,
    split,
    tolerance,
    lowMaxZoom = split - 1,
    lowProperties = null,
  } = o;

  /* タイルは切ったそばから書き出す。
   *
   * 全部を配列に溜めてから Buffer.concat で 1 本にしていた。国道の tiles.bin は
   * 98.8 MB なので、繋ぐ瞬間だけ同じ物が 2 つ、約 200 MB 生きる。47 県ぶんの
   * GeoJSON と結合済みの弧も同時に載っているところで、これがヒープの上限を
   * 押し上げていた一因だった。今どれだけ渡しているかは docs/results.md
   * 「タイル化に必要なメモリ」にある。
   *
   * 索引は書いた順・書いた位置をそのまま並べるので、溜めてから数えるのと
   * 同じ物になる。つまり出来上がる 2 ファイルは 1 バイトも変わらない。
   *
   * 書く先は仮の名前にする。tiles.bin と tiles.json は対でなければ意味が無い
   * ——pack_pmtiles.py は索引の言う位置で blob を切るだけなので、短い bin と
   * 前回の json が残ると、範囲外の切り出しが空を返し、静かに壊れた PMTiles が
   * できる。本物を頭で truncate してしまうと、途中で落ちた回にその状態が残る。
   * 仮に書いておけば、落ちた回は前回の対がそのまま残る。 */
  mkdirSync(dir, { recursive: true });
  const BIN = join(dir, 'tiles.bin');
  const IDX = join(dir, 'tiles.json');
  const BIN_PART = `${BIN}.part`;
  const binFd = openSync(BIN_PART, 'w');
  const idxRows = [];
  let total = 0;
  let bytes = 0;

  function emit(z, x, y, tile) {
    if (!tile?.features.length) return;
    const buf = vtpbf.fromGeojsonVt(
      { [layer]: tile },
      { version: 2, extent: EXTENT },
    );
    idxRows.push([z, x, y, bytes, buf.length]);
    writeAll(binFd, buf);
    total++;
    bytes += buf.length;
  }

  /* ズーム 0 から split-1 までは、全体を 1 つの索引から作る。
   *
   * この索引の maxZoom がそのまま簡略化の効き方を決める。geojson-vt は
   * `z === options.maxZoom` のズームを閾値 0 で書き出すので、既定の `split - 1`
   * は、いちばん深い低ズームを素のまま出すということである(docs/architecture.md
   * 「索引の一番深いズームは簡略化されない」)。
   *
   * 索引は 1 段ずつ作らせ、書き終えた段から捨てる。indexMaxZoom を maxZoom と
   * 揃えると、getTile を呼ぶ前に z0 から split-1 までが全部できあがる。しかも
   * getTile が返したタイルは、transform が geometry をその場で入れ子配列へ
   * 膨らませ、捨てないかぎり居座る。国道でも都道府県道でも、ヒープの山はこの
   * 1 か所だった。
   *
   * indexMaxZoom を 0 にすると、最初にできるのは z0 だけになり、以降は getTile
   * が必ず 1 段ずつ掘る。だから 1 段書き終えるたび、その 1 段上を落としてよい
   * ——次に掘る先の親は、いま書き終えたばかりの段だからである。
   *
   * 「emit した直後にそのタイルを落とす」ではいけない。splitTile は
   * `z === indexMaxZoom || tile.numPoints <= indexMaxPoints` で止まり、
   * indexMaxPoints の既定は 100,000 である。まばらな場所では indexMaxZoom に
   * 届く前に止まり、そのタイルが source を抱えたまま残る。深いタイルは後から
   * そこを掘って作るので、親を先に消すと getTile が null を返し、エラーも
   * 出さずにタイルが減る(実測で国道の z0-7 が 53 枚から 38 枚になった)。
   *
   * これは geojson-vt 4.0.3 の中身に依っている。package.json の指定は `^4.0.3`
   * である。src/tile.js の createTile は簡略化の閾値を `options.maxZoom` だけ
   * から決めるので、indexMaxZoom を変えてもタイルの中身は変わらない。tiles は
   * ソースが "part of the public API" と述べているが、鍵を作る toID は内部で、
   * 下に写しを持つ。 */
  let low = geojsonvt(fc(features, lowProperties), {
    maxZoom: lowMaxZoom,
    indexMaxZoom: 0,
    tolerance,
    extent: EXTENT,
    buffer: 64,
  });

  /** 索引がタイルの鍵に使う id。geojson-vt の src/index.js と同じ式である。 */
  const toID = (z, x, y) => ((1 << z) * y + x) * 32 + z;

  let prev = [];
  let gone = new Set();
  for (let z = 0; z < split; z++) {
    const r = tileRange(bbox, z);
    const ids = [];
    const absent = new Set();
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        emit(z, x, y, low.getTile(z, x, y));
        const id = toID(z, x, y);
        if (low.tiles[id]) {
          ids.push(id);
          continue;
        }
        /* 索引に無いタイルがある。親に弧が 1 本も無ければ、その下に作る物も
         * 無いので、これは正しい。親ごと無いのも、その親が同じ理由で無かった
         * ——`gone` に居る——なら正しい。それ以外、つまり親が弧を持って生きて
         * いるか、理由なく親が消えているなら、掘る前に親を消している。枚数の
         * 足りないアーカイブを配るくらいなら、ここで落ちるほうがよい。 */
        if (z > 0) {
          const up = toID(z - 1, x >> 1, y >> 1);
          const parent = low.tiles[up];
          if (!gone.has(up) && (!parent || parent.numFeatures)) {
            throw new Error(`low index: z${z}/${x}/${y} lost its parent`);
          }
        }
        absent.add(id);
      }
    }
    for (const id of prev) delete low.tiles[id];
    prev = ids;
    gone = absent;
  }
  /* 最後の段は、索引ごと落とす。この後は深いセルを 1 つずつ切るだけで、
   * 低ズーム側はもう読まない。 */
  low = null;
  console.log(`  z0-${split - 1}: ${total} tiles`);

  /* それより下は、split のタイルごとに 1 つのピラミッドを作る。特徴量は bbox で
   * 選ぶだけで、切らない。切り取りは geojson-vt 自身が行うので、先に切ると、
   * あちらでは繕えない継ぎ目が残る。 */
  const rs = tileRange(bbox, split);
  const cells = [];
  for (let x = rs.x0; x <= rs.x1; x++) {
    for (let y = rs.y0; y <= rs.y1; y++) cells.push([x, y]);
  }

  /** セルが取り込む範囲。中身を切らないための余白ぶん、セルより広い。 */
  const cellBox = (x, y) => {
    const b = tileBounds(split, x, y);
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
  const cellSpan = 360 / 2 ** split;
  const margin = cellSpan * 0.05;
  for (const f of features) {
    const grown = [
      f.bbox[0] - margin,
      f.bbox[1] - margin,
      f.bbox[2] + margin,
      f.bbox[3] + margin,
    ];
    const r = tileRange(grown, split);
    for (let x = Math.max(rs.x0, r.x0 - 1); x <= Math.min(rs.x1, r.x1); x++) {
      for (let y = Math.max(rs.y0, r.y0 - 1); y <= Math.min(rs.y1, r.y1); y++) {
        if (!overlaps(f.bbox, cellBox(x, y))) continue;
        const key = `${x},${y}`;
        const list = bucket.get(key);
        if (list) list.push(f);
        else bucket.set(key, [f]);
      }
    }
  }
  console.log(
    `  z${split}-${maxzoom}: ${cells.length} cells (${bucket.size} with arcs)`,
  );

  let done = 0;
  for (const [cx, cy] of cells) {
    const sub = bucket.get(`${cx},${cy}`) ?? [];
    done++;
    if (!sub.length) continue;
    const idx = geojsonvt(fc(sub), {
      maxZoom: maxzoom,
      indexMaxZoom: split,
      tolerance,
      extent: EXTENT,
      buffer: 64,
    });
    for (let z = split; z <= maxzoom; z++) {
      const s = 2 ** (z - split);
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

  /* 古い索引を先に落としてから、blob を本物の名前へ移し、最後に索引を書く。
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
      maxzoom,
      extent: EXTENT,
      bbox,
      layer,
      tiles: idxRows,
    }),
  );
  console.log(
    `wrote ${total.toLocaleString()} tiles, ${(bytes / 1e6).toFixed(1)} MB uncompressed`,
  );
  return { total, bytes };
}
