/* ブラウザ用ライブラリと書体を node_modules から web/vendor/ へ複製する。
 *
 * かつてこのページは MapLibre と PMTiles を、メジャー版だけ固定した形で unpkg
 * から読んでいた。ここにいる誰も作っていないリリースが公開済みの地図の動きを
 * 変えうること、unpkg が落ちれば地図も落ちることの二つを同時に抱える。静的
 * ファイルだけのサイトにどちらも許されない。Google Fonts から書体を読まないのも
 * 同じ理屈である。
 *
 * だから全部を地図と同じオリジンから配る。版は package.json が一度だけ述べ、
 * それが何に解決したかは bun.lock が記録する。web/vendor/ はその解決の
 * 写しなので追跡しない。追跡すれば版を述べる二つ目の場所になり、一つ目と
 * 食い違える。
 *
 * バンドラは使わない。ページは今までどおり、`maplibregl` と `pmtiles` を
 * グローバルに定義する素の <script> 二つ、スタイルシート二つ、@font-face の src
 * 一つを読む。変わったのは URL だけである。
 *
 * 使い方:  node scripts/vendor_web.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULES = join(ROOT, 'node_modules');
const VENDOR = join(ROOT, 'web', 'vendor');

/* `.map` は意図して置いていく。1 つ数 MB あり、公開したサイトに対して誰も
 * 走らせないデバッガのための物である。
 *
 * 書体が二つ混じっている。Roboto は標識の番号、EB Garamond は Wikipedia の W
 * である。どちらも「端末が持っている書体では字形が違って見える」という同じ
 * 理由で自前で配る。EB Garamond はラテン文字ぶん 24 kB を W 一文字のために
 * 運ぶが、降りてくるのは詳細パネルを開いた人だけである。 */
const FILES = [
  ['maplibre-gl', 'dist/maplibre-gl.js'],
  ['maplibre-gl', 'dist/maplibre-gl.css'],
  ['pmtiles', 'dist/pmtiles.js'],
  ['@fontsource/roboto', 'files/roboto-latin-700-normal.woff2'],
  ['@fontsource/eb-garamond', 'files/eb-garamond-latin-500-normal.woff2'],
];

/* 操作パネルの書体。日本語 1 書体は約 7000 字あり、ラテン文字だけの Roboto
 * のように 1 ファイルでは配れない。だから Fontsource が約 120 片に分け、どれを
 * 取るかは `unicode-range` に決めさせる。地図のラベルは web/glyphs/ から
 * 描くので、ここで必要なのは操作パネルだけである。ただし操作パネルはデータ
 * 由来の地名を述べ、どんな漢字も入りうるので、ソースにある文字列へ
 * 絞り込めない。片は完全なまま置く。
 *
 * 複製するのはスタイルシートが求める weight だけである。800 はその中に無く、
 * 800 を求める二つの規則は CSS のふつうの対応づけで 700(LINE Seed JP の Bold)へ
 * 落ちる。`.woff` は置いていく。MapLibre が動くブラウザはどれも `.woff2` を
 * 読む。 */
const FONT_CSS = ['400.css', '700.css'];
const FONT_PKG = '@fontsource/line-seed-jp';
const FONT_OUT = 'line-seed-jp.css';

function pkg(name) {
  const path = join(MODULES, name, 'package.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(
      `${name} が node_modules に無い。先に \`bun install\` を実行する。`,
    );
  }
}

mkdirSync(VENDOR, { recursive: true });

const used = new Map();
for (const [name, rel] of FILES) {
  const meta = pkg(name);
  used.set(name, meta);
  const to = join(VENDOR, rel.split('/').pop());
  copyFileSync(join(MODULES, name, rel), to);
  console.log(`  ${name}@${meta.version}  ${rel.split('/').pop()}`);
}

/* Fontsource のスタイルシートは `./files/…` を指す。web/vendor/ は平らなので、
 * シートを 1 つに繋ぎながら `src` を書き換える。複製するファイルの集合も同じ
 * `src` から読む。手で持つ一覧は、どの片が在るかを述べる二つ目の場所になり、
 * 一つ目と食い違える。 */
{
  const meta = pkg(FONT_PKG);
  used.set(FONT_PKG, meta);
  const woff2 = new Set();
  const sheets = FONT_CSS.map((file) =>
    readFileSync(join(MODULES, FONT_PKG, file), 'utf8')
      .replace(
        /url\(\.\/files\/([\w.-]+\.woff2)\) format\('woff2'\), url\([^)]+\) format\('woff'\)/g,
        (_, name) => {
          woff2.add(name);
          return `url(${name}) format('woff2')`;
        },
      )
      .trim(),
  );
  for (const name of woff2) {
    copyFileSync(join(MODULES, FONT_PKG, 'files', name), join(VENDOR, name));
  }
  writeFileSync(join(VENDOR, FONT_OUT), `${sheets.join('\n\n')}\n`, 'utf8');
  console.log(
    `  ${FONT_PKG}@${meta.version}  ${FONT_OUT} + ${woff2.size} woff2`,
  );
}

/* 他人のコードを再配布するなら、その条件も一緒に運ぶ。 */
const notice = [
  'web/vendor/ は node_modules から複製した物である。',
  'scripts/vendor_web.mjs が作る。手で編集しない。',
  '',
  ...[...used.values()].map((m) =>
    `${m.name} ${m.version} — ${m.license} — ${m.homepage || ''}`.trim(),
  ),
  '',
];
for (const name of used.keys()) {
  for (const file of ['LICENSE', 'LICENSE.txt']) {
    try {
      notice.push(
        `--- ${name} ${file} ---`,
        readFileSync(join(MODULES, name, file), 'utf8'),
      );
      break;
    } catch {
      /* 版やパッケージによっては同梱されない。次の候補か次のパッケージへ。 */
    }
  }
}
writeFileSync(join(VENDOR, 'LICENSES.txt'), notice.join('\n'), 'utf8');
console.log(`  → ${VENDOR}`);
