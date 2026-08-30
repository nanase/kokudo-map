/* ブラウザ用ライブラリと書体を node_modules から web/vendor/ へ複製する。
 *
 * かつてこのページは MapLibre と PMTiles を、メジャー版だけ固定した形で unpkg
 * から読んでいた。それは二つの問題を同時に抱える。ここにいる誰も作っていない
 * リリースが、公開済みの地図の動きを変えうること。そして unpkg が落ちれば地図も
 * 一緒に落ちることである。静的ファイルだけでできているサイトに、どちらも許され
 * ない。Google Fonts から書体を読まないのも同じ理屈である。
 *
 * だから全部を地図と同じオリジンから配る。版は package.json が一度だけ、正確に
 * 述べる。それが何に解決したかは bun.lock が記録する。web/vendor/ はその解決の
 * 写しなので追跡しない——追跡すれば版を述べる二つ目の場所になり、一つ目と食い
 * 違えるようになる。
 *
 * バンドラは使わない。ページは今までどおり読む。`maplibregl` と `pmtiles` を
 * グローバルに定義する素の <script> が二つ、スタイルシートが二つ、@font-face の
 * src が一つである。変わったのは URL だけである。
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
 * 走らせないデバッガのための物である。 */
const FILES = [
  ['maplibre-gl', 'dist/maplibre-gl.js'],
  ['maplibre-gl', 'dist/maplibre-gl.css'],
  ['pmtiles', 'dist/pmtiles.js'],
  ['@fontsource/roboto', 'files/roboto-latin-700-normal.woff2'],
];

/* 操作面の書体。日本語 1 書体は約 7000 字あり、ラテン文字だけの Roboto のよう
 * に 1 ファイルでは配れない。だから Fontsource が約 120 片に分け、どれを実際に
 * 取るかは `unicode-range` に決めさせる。地図のラベルは web/glyphs/ から描く
 * ので、ここで必要になるのは操作面だけである——ただし操作面はデータ由来の地名を
 * 述べ、そこにはどんな漢字も入りうる。ソースにある文字列へ絞り込むことは、
 * それでできない。片は完全なまま置く。
 *
 * 複製するのはスタイルシートが求める weight だけである。800 はその中に無い。
 * 800 を求める二つの規則は、CSS のふつうの weight の対応づけで 700 へ落ちる。
 * それが LINE Seed JP の Bold である。
 *
 * `.woff` は置いていく。MapLibre が動くブラウザはどれも `.woff2` を読む。 */
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
 * シートを 1 つに繋ぎながら `src` を書き換える。複製するファイルの集合もその
 * 同じ `src` から読む——手で持つ一覧は、どの片が在るかを述べる二つ目の場所に
 * なり、一つ目と食い違える。 */
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
