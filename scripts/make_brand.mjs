/* Draw the site's own two images: the tab icon and the card link previews show.
 *
 * Both are the 国道番号標識, because that is what the map is about — and both
 * are drawn from `SHIELD_PATH` in web/shield.mjs, the same outline the panel
 * and the popups use. Tracing the triangle a second time here would be a
 * second answer to what the sign looks like.
 *
 * The favicon is SVG: one file, no sizes to keep in step, and the sign is a
 * flat shape that loses nothing by being drawn rather than sampled. It carries
 * no number — at 16 px a number is a smudge, and the map is about all of them.
 *
 * The card is a PNG because that is what link scrapers accept, rendered at the
 * 1200x630 they expect. It is drawn in the Chromium already here for the
 * render check rather than by a drawing library.
 *
 * Both are committed: a few tens of kB that change only when the sign or the
 * wording does.
 *
 * Usage:  node scripts/make_brand.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');

const {
  SHIELD_PATH,
  SHIELD_VIEWBOX,
  SHIELD_STROKE_WIDTH,
  SHIELD_ICON_STROKE_WIDTH,
  SHIELD_ICON_PAD,
} = await import(new URL('../web/shield.mjs', import.meta.url).href);

/* favicon は他のどこよりも小さく描かれるので、白い縁をここだけ太くする
 * (SHIELD_ICON_STROKE_WIDTH)。SHIELD_VIEWBOX の余白は約 10 単位しかなく
 * その太さの縁を描くには足りないので、SHIELD_ICON_PAD ぶん足す。 */
const [vx, vy, vw, vh] = SHIELD_VIEWBOX.split(' ').map(Number);
const ICON_VIEWBOX =
  `${vx - SHIELD_ICON_PAD} ${vy - SHIELD_ICON_PAD} ` +
  `${vw + 2 * SHIELD_ICON_PAD} ${vh + 2 * SHIELD_ICON_PAD}`;

/* 標識の配色。style.css の --shield-face / --shield-edge と同じ値である。 */
const FACE = '#00449E';
const EDGE = '#FFFFFF';
/* 重用の深さを表す 4 色。mapspec.mjs の N_COLORS と同じ値である。 */
const N_COLORS = ['#1B62C4', '#D98324', '#C2352B', '#7B3E9D'];

const TITLE = '国道マップ';
const TAGLINE = '重用区間で番号を丸めない。縮尺で番号を省略しない。';
const SUB = '全国 47 都道府県・一般国道 459 路線';

/* ---------------------------------------------------------------- favicon --- */
/* The sign sits on its own; there is no page behind it to blend into, so
 * `paint-order="stroke"` paints the fill over the stroke's inward half.
 * Without it the default paint order (stroke over fill) eats the border's
 * full width into the face, and the face reads as visibly smaller. */
const favicon = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ICON_VIEWBOX}">`,
  `<path d="${SHIELD_PATH}" fill="${FACE}" stroke="${EDGE}"`,
  ` stroke-width="${SHIELD_ICON_STROKE_WIDTH}" stroke-linejoin="round"`,
  ' paint-order="stroke"/>',
  '</svg>',
].join('');
writeFileSync(join(WEB, 'favicon.svg'), `${favicon}\n`, 'utf8');
console.log(`  favicon.svg  ${favicon.length} B`);

/* ------------------------------------------------------------------- card --- */
const card = `<!doctype html><meta charset="utf-8">
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; display: flex; flex-direction: column;
    justify-content: center; gap: 34px; padding: 0 96px;
    background: #FFFFFF; color: #121A24;
    font-family: "Noto Sans JP", "Yu Gothic UI", sans-serif;
  }
  /* 重用区間そのもの。4 色が同じ道の上で重なる、この地図の主題である。 */
  .stack { position: absolute; inset: 0 0 auto 0; height: 14px; display: flex; }
  .stack i { flex: 1; }
  h1 { font-size: 82px; font-weight: 700; letter-spacing: 0.02em; }
  .row { display: flex; align-items: center; gap: 30px; }
  svg { height: 103px; width: auto; flex: 0 0 auto; }
  p { font-size: 33px; line-height: 1.5; color: #46566A; }
  .sub { font-size: 26px; color: #6C7E93; }
</style>
<div class="stack">${N_COLORS.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
<div class="row">
  <svg viewBox="${SHIELD_VIEWBOX}">
    <path d="${SHIELD_PATH}" fill="${FACE}" stroke="${EDGE}"
          stroke-width="${SHIELD_STROKE_WIDTH}" stroke-linejoin="round"
          paint-order="stroke"/>
  </svg>
  <h1>${TITLE}</h1>
</div>
<p>${TAGLINE}</p>
<p class="sub">${SUB}</p>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await page.setContent(card);
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: 'png' });
await browser.close();

writeFileSync(join(WEB, 'og.png'), png);
console.log(`  og.png  1200x630  ${(png.length / 1024).toFixed(1)} kB`);
