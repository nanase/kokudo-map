/* Copy the browser libraries out of node_modules into web/vendor/.
 *
 * The page used to load MapLibre and PMTiles from unpkg at a floating major
 * version. That is two problems at once: a release nobody here made could
 * change what a published map runs, and an outage at unpkg takes the map down
 * with it. Neither is acceptable for a site that otherwise consists of static
 * files and nothing else.
 *
 * So the libraries are served from the same origin as the map. The version is
 * stated once, in package.json, and pinned exactly; bun.lock records what that
 * resolved to. web/vendor/ is a copy of that resolution and is not tracked —
 * a tracked copy would be a second statement of the version, free to disagree
 * with the first.
 *
 * There is no bundler. The page loads these as it always did: two plain
 * <script> tags that define `maplibregl` and `pmtiles` as globals, plus one
 * stylesheet. Only the URLs changed.
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
];

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

/* Redistributing someone else's code means carrying its terms with it. Both
 * are BSD-3-Clause; only MapLibre ships the text, so the rest is stated. */
const notice = [
  'web/vendor/ は node_modules から複製した物である。',
  'scripts/vendor_web.mjs が作る。手で編集しない。',
  '',
  ...[...used.values()].map((m) =>
    `${m.name} ${m.version} — ${m.license} — ${m.homepage || ''}`.trim(),
  ),
  '',
];
try {
  notice.push(
    '--- maplibre-gl LICENSE.txt ---',
    readFileSync(join(MODULES, 'maplibre-gl', 'LICENSE.txt'), 'utf8'),
  );
} catch {
  /* 版によっては同梱されない。上の行が条件を述べている。 */
}
writeFileSync(join(VENDOR, 'LICENSES.txt'), notice.join('\n'), 'utf8');
console.log(`  → ${VENDOR}`);
