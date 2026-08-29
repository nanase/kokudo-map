/* Copy the browser libraries and web fonts out of node_modules into web/vendor/.
 *
 * The page used to load MapLibre and PMTiles from unpkg at a floating major
 * version. That is two problems at once: a release nobody here made could
 * change what a published map runs, and an outage at unpkg takes the map down
 * with it. Neither is acceptable for a site that otherwise consists of static
 * files and nothing else. The same reasoning rules out loading a typeface from
 * Google Fonts.
 *
 * So everything is served from the same origin as the map. The version is
 * stated once, in package.json, and pinned exactly; bun.lock records what that
 * resolved to. web/vendor/ is a copy of that resolution and is not tracked —
 * a tracked copy would be a second statement of the version, free to disagree
 * with the first.
 *
 * There is no bundler. The page loads these as it always did: two plain
 * <script> tags that define `maplibregl` and `pmtiles` as globals, plus two
 * stylesheets, plus one @font-face src. Only the URLs changed.
 *
 * Usage:  node scripts/vendor_web.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULES = join(ROOT, 'node_modules');
const VENDOR = join(ROOT, 'web', 'vendor');

/* The `.map` files are deliberately left behind: they are several megabytes
 * apiece and serve a debugger nobody runs against the published site. */
const FILES = [
  ['maplibre-gl', 'dist/maplibre-gl.js'],
  ['maplibre-gl', 'dist/maplibre-gl.css'],
  ['pmtiles', 'dist/pmtiles.js'],
  ['@fontsource/roboto', 'files/roboto-latin-700-normal.woff2'],
];

/* The UI typeface. A Japanese face covers ~7000 glyphs and cannot be shipped
 * as one file the way the Latin-only Roboto is, so Fontsource splits it into
 * ~120 pieces and lets `unicode-range` decide which ones a page actually
 * fetches. The map draws its own labels from web/glyphs/, so this is the
 * chrome only — but the chrome states place names that come from the data,
 * and those can hold any kanji. That rules out subsetting to the strings in
 * the source: the pieces have to stay complete.
 *
 * Only the weights the stylesheet asks for are copied. 800 is not among them;
 * the two rules that ask for it fall back to 700 by the normal CSS weight
 * matching, which is what LINE Seed JP's Bold is.
 *
 * `.woff` is left behind. Every browser that runs MapLibre reads `.woff2`. */
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

/* Fontsource's stylesheets point at `./files/…`; web/vendor/ is flat, so the
 * `src` is rewritten as the sheets are joined into one. The set of files to
 * copy is read out of that same `src` — a hand-kept list would be a second
 * statement of which pieces exist, free to disagree with the first. */
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

/* Redistributing someone else's code means carrying its terms with it. */
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
