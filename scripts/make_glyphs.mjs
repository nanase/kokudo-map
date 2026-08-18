/* Build the SDF glyphs the map's labels need, so no one else has to serve them.
 *
 * The style pointed `glyphs` at 国土地理院's demo endpoint. That is someone
 * else's GitHub Pages site, offered as a demonstration and under no obligation
 * to keep answering — and every label on this map would vanish the day it
 * stopped. A map that is otherwise static files has no business depending on
 * it.
 *
 * Self-hosting a Japanese font normally means tens of megabytes of glyph
 * ranges. It does not here, because of what the labels actually say: a route
 * label is `refs.join('・')` and a terminus label is the same, so the entire
 * alphabet this map can ever draw is ten digits and one separator. Eleven
 * glyphs, in two of the 256-codepoint ranges MapLibre asks for.
 *
 * The glyphs are rasterised with TinySDF — the same code MapLibre itself uses
 * for locally rendered CJK — inside the Chromium that is already here for the
 * render check. fontnik would be the conventional tool, but it ships no
 * prebuilt binary for win32-x64, and this project already declined tippecanoe
 * for that reason.
 *
 * The result is committed. It is ~10 kB that changes only if the labels learn
 * a new character, and keeping it out of the repository would mean a browser
 * download on every deploy to rebuild something that never moves.
 *
 * Usage:  node scripts/make_glyphs.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PbfWriter } from 'pbf';
import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'web', 'glyphs');

/* Must match FONT in web/mapspec.mjs: MapLibre asks for `{fontstack}/{range}`
 * and the fontstack is the name written there. */
const STACK = 'NotoSansJP-Regular';
const FAMILY = 'Noto Sans JP';

/* Every character a label can contain. Route numbers are digits; `・` joins
 * the designations on a concurrent section. Checked against the built data
 * below rather than trusted. */
const CHARS = [...'0123456789・'];

/* The server convention: 24 px em, 3 px of padding around the glyph box, and a
 * distance field that runs 8 px either side of the edge. */
const SDF = { fontSize: 24, buffer: 3, radius: 8, cutoff: 0.25 };

/* MapLibre states a glyph's `top` against an origin above the em box, while
 * TinySDF states it against the alphabetic baseline. These are the constants
 * MapLibre itself applies when it has to place its own glyphs among
 * server-provided ones (see _drawGlyph in glyph_manager). */
const TOP_ADJUSTMENT = 27.5;
const LEFT_ADJUSTMENT = 0.5;

const RANGE_SIZE = 256;

/* ------------------------------------------------------- what the data says --- */
/**
 * Refuse to build a set of glyphs the map would outgrow.
 *
 * The alphabet above is a claim about the data, so it is checked against the
 * data. Every label the viewer can draw is a join of route numbers, and the
 * designations are in the aggregate table the build already wrote.
 */
function checkAlphabet() {
  const meta = join(ROOT, 'web', 'data', 'national.meta.json');
  let m;
  try {
    m = JSON.parse(readFileSync(meta, 'utf8'));
  } catch {
    console.log('  web/data/national.meta.json が無いので照合は省く');
    return;
  }
  const labels = [
    ...m.combinations.map((c) => c.refs.join('・')),
    ...m.termini.map((t) => String(t.ref)),
    ...m.shared_termini.map((t) => t.refs.join('・')),
  ];
  const seen = new Set(labels.join(''));
  const missing = [...seen].filter((c) => !CHARS.includes(c));
  if (missing.length) {
    throw new Error(
      `ラベルに CHARS の外の字がある: ${missing.map((c) => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase()})`).join(', ')}`,
    );
  }
  console.log(`  ${labels.length} 件のラベルを照合、使う字は ${seen.size} 種`);
}

/* ------------------------------------------------------------ rasterising --- */
async function rasterise() {
  const tinySdfSrc = readFileSync(
    join(ROOT, 'node_modules', '@mapbox', 'tiny-sdf', 'index.js'),
    'utf8',
  ).replace('export default class TinySDF', 'class TinySDF');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  // `text=` makes Google Fonts return one face carrying exactly these glyphs,
  // so nothing is downloaded that is not about to be drawn.
  const css = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(FAMILY).replace(/%20/g, '+')}:wght@400&text=${encodeURIComponent(CHARS.join(''))}`;
  await page.setContent(`<link rel="stylesheet" href="${css}">`);
  await page.addScriptTag({
    content: `${tinySdfSrc}\nwindow.TinySDF = TinySDF;`,
  });

  const glyphs = await page.evaluate(
    async ({ chars, family, sdf }) => {
      const spec = `${sdf.fontSize}px "${family}"`;
      await document.fonts.load(spec, chars.join(''));
      await document.fonts.ready;
      // If the face did not arrive, canvas silently falls back to a system
      // font and the glyphs would be someone else's shapes.
      if (!document.fonts.check(spec))
        throw new Error(`${family} が読めていない`);

      const tiny = new window.TinySDF({ ...sdf, fontFamily: `"${family}"` });
      return chars.map((ch) => {
        const g = tiny.draw(ch);
        return {
          id: ch.codePointAt(0),
          char: ch,
          data: [...g.data],
          bitmapWidth: g.width,
          bitmapHeight: g.height,
          width: g.glyphWidth,
          height: g.glyphHeight,
          left: g.glyphLeft,
          top: g.glyphTop,
          advance: g.glyphAdvance,
        };
      });
    },
    { chars: CHARS, family: FAMILY, sdf: SDF },
  );

  await browser.close();
  return glyphs;
}

/* -------------------------------------------------------------- encoding --- */
function writeGlyph(g, pbf) {
  pbf.writeVarintField(1, g.id);
  pbf.writeBytesField(2, g.bitmap);
  pbf.writeVarintField(3, g.width);
  pbf.writeVarintField(4, g.height);
  pbf.writeSVarintField(5, g.left);
  pbf.writeSVarintField(6, g.top);
  pbf.writeVarintField(7, g.advance);
}

function writeStack(stack, pbf) {
  pbf.writeStringField(1, stack.name);
  pbf.writeStringField(2, stack.range);
  for (const g of stack.glyphs) pbf.writeMessage(3, writeGlyph, g);
}

function encode(range, glyphs) {
  const pbf = new PbfWriter();
  pbf.writeMessage(1, writeStack, { name: STACK, range, glyphs });
  return Buffer.from(pbf.finish());
}

/* ------------------------------------------------------------------ main --- */
console.log('ラベルの字を確かめる');
checkAlphabet();

console.log('Chromium で SDF を焼く');
const drawn = await rasterise();

// MapLibre fetches glyphs 256 codepoints at a time and names the file after
// the block, so the glyphs are grouped the same way.
const byRange = new Map();
for (const g of drawn) {
  const start = Math.floor(g.id / RANGE_SIZE) * RANGE_SIZE;
  const range = `${start}-${start + RANGE_SIZE - 1}`;
  if (!byRange.has(range)) byRange.set(range, []);
  byRange.get(range).push({
    id: g.id,
    bitmap: Buffer.from(g.data),
    width: g.width,
    height: g.height,
    left: Math.round(g.left + LEFT_ADJUSTMENT),
    top: Math.round(g.top - TOP_ADJUSTMENT),
    advance: Math.round(g.advance),
  });
  console.log(
    `  ${g.char}  U+${g.id.toString(16).toUpperCase().padStart(4, '0')}  ` +
      `${g.width}x${g.height}  bitmap ${g.bitmapWidth}x${g.bitmapHeight}  advance ${g.advance.toFixed(2)}`,
  );
}

const dir = join(OUT, STACK);
mkdirSync(dir, { recursive: true });
for (const [range, glyphs] of byRange) {
  const buf = encode(range, glyphs);
  writeFileSync(join(dir, `${range}.pbf`), buf);
  console.log(`  ${STACK}/${range}.pbf  ${glyphs.length} 字  ${buf.length} B`);
}

/* Noto Sans JP is SIL Open Font License 1.1, and these glyphs are derived from
 * it, so its terms travel with them. */
let ofl = '';
try {
  const res = await fetch('https://openfontlicense.org/documents/OFL.txt');
  if (res.ok) ofl = await res.text();
} catch {
  /* 取れないときは所在だけ述べる。 */
}
writeFileSync(
  join(OUT, 'NOTICE.txt'),
  [
    'web/glyphs/ は Noto Sans JP Regular から焼いた SDF グリフである。',
    'scripts/make_glyphs.mjs が作る。手で編集しない。',
    '',
    `字は ${CHARS.join('')} の ${CHARS.length} 種だけである。`,
    'ラベルは路線番号を ・ で繋いだ物しかないので、これで足りる。',
    '',
    'Noto Sans JP — SIL Open Font License 1.1',
    'https://fonts.google.com/noto/specimen/Noto+Sans+JP',
    '',
    ofl || 'ライセンス全文: https://openfontlicense.org/documents/OFL.txt',
    '',
  ].join('\n'),
  'utf8',
);
console.log(`  → ${OUT}`);
