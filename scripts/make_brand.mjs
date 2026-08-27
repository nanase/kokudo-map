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
 * wording does. That is why the street grid below is drawn from a seeded
 * generator rather than a live random: two runs must produce the same bytes,
 * or every run would show up as a diff.
 *
 * Usage:  node scripts/make_brand.mjs
 *         node scripts/make_brand.mjs --card 1280x640 --out social.png
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');

/* --card WxH --out PATH で、札だけをその寸法で書き出す。GitHub の social
 * preview は 1280x640 を求め、リンクの札が期待する 1200x630 と合わない。
 * 二つ揃って初めて効く——片方だけだと web/og.png を違う寸法で潰しかねない。 */
const { values: opt } = parseArgs({
  options: { card: { type: 'string' }, out: { type: 'string' } },
});
if (Boolean(opt.card) !== Boolean(opt.out)) {
  throw new Error(
    '--card と --out は揃えて渡す: --card 1280x640 --out social.png',
  );
}

const {
  SHIELD_PATH,
  SHIELD_VIEWBOX,
  SHIELD_ICON_STROKE_WIDTH,
  SHIELD_ICON_PAD,
  shield,
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
/* 標識の番号の大きさ。style.css の `.shield text` と同じ値である。 */
const NUM_SIZE = 212.5;

const TITLE = '国道マップ';
/* 札が載せる一文。README の冒頭でも共有の札でも、絵の周りに説明文は無く、
 * 地図が何のためにあるかを述べるのはここだけになる。 */
const TAGLINE = ['重用区間で番号を丸めない', '日本の国道地図'];

/* ---------------------------------------------------------------- favicon --- */
/* --card は札だけを求めている。favicon は寸法を持たないので、書き直して
 * 何かが変わる場面が無い。 */
if (!opt.card) {
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
}

/* ------------------------------------------------------------------- card ---
 *
 * The card shows the one thing the map exists for: a stretch of road carrying
 * more than one route number. Two national routes run into the main line at
 * T-junctions, and the line goes 単独 → 二重用 → 三重用. The depth is said
 * three ways at once — the colour of the line, how many signs sit on it, and
 * how big those signs are. The deepest stretch is the largest, because that
 * is the part worth looking at.
 *
 * The numbers are 73, 110 and 215. All three are numbers no general national
 * route has (`VALID` in pipeline/build_routes.py: 1-58 and 101-507 less the
 * six abolished), so nobody can read the picture as a claim about a real
 * concurrency, and the drawing is free to be composed rather than surveyed.
 */
const CARD = { w: 1200, h: 630 };

/* 別の寸法を求められても絵は組み直さない。CARD の組みのまま、求められた枠を
 * 覆うところまで拡大して、はみ出したぶんを切る。縁は地の色へ沈めてあり、
 * 見る物は中ほどに寄せてあるので、数十 px を切っても絵は欠けない。組みを
 * 寸法ごとに持つと、直した側と直し忘れた側ができる。 */
const size = opt.card ? /^(\d+)x(\d+)$/.exec(opt.card) : null;
if (opt.card && !size) {
  throw new Error(`--card は WxH で渡す (例: 1280x640): ${opt.card}`);
}
const OUT = size
  ? { w: Number(size[1]), h: Number(size[2]) }
  : { w: CARD.w, h: CARD.h };
const SCALE = Math.max(OUT.w / CARD.w, OUT.h / CARD.h);
const GROUND = '#0B1826';
const INK_2 = '#9CB8DC';
/* 街路。地の色との差はここだけで決まる。 */
const STREET = '#22374E';
const STREET_MAJOR = '#31506F';

/* 地図だけを少し倒す。街も国道も同じだけ倒れるので、交わりは直角のまま
 * 右肩上がりに見える。標識と文字は倒さない——地図の注記は水平に置く。 */
const TILT = -4;
const RAD = (TILT * Math.PI) / 180;
const [COS, SIN] = [Math.cos(RAD), Math.sin(RAD)];
const rot = (x, y) => {
  const [dx, dy] = [x - CARD.w / 2, y - CARD.h / 2];
  return [CARD.w / 2 + dx * COS - dy * SIN, CARD.h / 2 + dx * SIN + dy * COS];
};

/* 倒したぶん四隅が空くので、絵の外まで広く敷く。国道の線も同じ範囲まで
 * 引き、枠の内側で始まったり終わったりしないようにする。 */
const BOX = { x0: -230, x1: 1430, y0: -230, y1: 860 };

/* 街路の間隔と長さを不揃いにするためだけの乱数。種を渡すので出力は毎回
 * 同じ——committed な PNG が走らせるたびに差分になっては困る。 */
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 縦と横の二方向だけで組む。交わるのは直角だけである。全通しの街路を
 * 3 割弱に留め、残りは数区画で終わらせる——等間隔の全通しにすると、
 * 街路ではなく方眼紙に見える。 */
function streets(seed) {
  const rnd = mulberry32(seed);
  const axis = (from, to) => {
    const out = [];
    for (let v = from; v < to; v += 42 + Math.floor(rnd() * 56)) {
      out.push(Math.round(v));
    }
    return out;
  };
  const xs = axis(BOX.x0, BOX.x1);
  const ys = axis(BOX.y0, BOX.y1);
  const run = (list) => {
    const a = Math.floor(rnd() * (list.length - 2));
    const b = Math.min(list.length - 1, a + 2 + Math.floor(rnd() * 5));
    return [list[a], list[b]];
  };
  const [thin, thick] = [[], []];
  for (const x of xs) {
    if (rnd() < 0.28) thick.push(`M${x} ${BOX.y0} L${x} ${BOX.y1}`);
    else {
      const [a, b] = run(ys);
      thin.push(`M${x} ${a} L${x} ${b}`);
    }
  }
  for (const y of ys) {
    if (rnd() < 0.28) thick.push(`M${BOX.x0} ${y} L${BOX.x1} ${y}`);
    else {
      const [a, b] = run(xs);
      thin.push(`M${a} ${y} L${b} ${y}`);
    }
  }
  return (
    `<g stroke="${STREET}" stroke-width="2.1" fill="none"><path d="${thin.join(' ')}"/></g>` +
    `<g stroke="${STREET_MAJOR}" stroke-width="3.6" fill="none"><path d="${thick.join(' ')}"/></g>`
  );
}

/* 国道の線。区間ごとに 1 本、縦か横だけ——交わりは直角だけである。 */
const line = (x1, y1, x2, y2, color, w) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"` +
  ` stroke="${color}" stroke-width="${w}" stroke-linecap="butt"/>`;

/* 本線の高さと、二本が突き当たる位置。ここを動かすと標識も一緒に動く。 */
const ROAD_Y = 516;
const JOIN_A = 314; /* 南から。ここから二重用 */
const JOIN_B = 700; /* 北から。ここから三重用 */

const road =
  line(JOIN_A, BOX.y1, JOIN_A, ROAD_Y, N_COLORS[0], 13) +
  line(JOIN_B, BOX.y0, JOIN_B, ROAD_Y, N_COLORS[0], 13) +
  line(BOX.x0, ROAD_Y, JOIN_A, ROAD_Y, N_COLORS[0], 16) +
  line(JOIN_A, ROAD_Y, JOIN_B, ROAD_Y, N_COLORS[1], 20) +
  line(JOIN_B, ROAD_Y, BOX.x1, ROAD_Y, N_COLORS[2], 23);

/* 縁へ向かって地の色へ沈める。道が枠でぶつ切りにならず、絵の外へ続いて
 * いるように見える。文字の側はさらに左から締める。 */
const vignette =
  '<rect width="100%" height="100%" fill="url(#edge)"/>' +
  '<defs><radialGradient id="edge" cx=".5" cy=".5" r=".72">' +
  `<stop offset=".26" stop-color="${GROUND}" stop-opacity="0"/>` +
  `<stop offset=".72" stop-color="${GROUND}" stop-opacity=".40"/>` +
  `<stop offset="1" stop-color="${GROUND}" stop-opacity=".94"/>` +
  '</radialGradient></defs>';
const scrim =
  '<rect width="100%" height="100%" fill="url(#left)"/>' +
  '<defs><linearGradient id="left" x1="0" x2="1">' +
  `<stop offset="0" stop-color="${GROUND}" stop-opacity=".94"/>` +
  `<stop offset=".5" stop-color="${GROUND}" stop-opacity="0"/></linearGradient></defs>`;

const map =
  `<svg viewBox="0 0 ${CARD.w} ${CARD.h}" width="${CARD.w}" height="${CARD.h}">` +
  `<rect width="100%" height="100%" fill="${GROUND}"/>` +
  `<g transform="rotate(${TILT} ${CARD.w / 2} ${CARD.h / 2})">${streets(11)}${road}</g>` +
  `${vignette}${scrim}</svg>`;

/* 標識は本線の上に載る。持ち上げ幅を高さの 42% にしてあるので、大きさが
 * 変わってもどれも同じだけ線に食い込む。重なりは幅の 2 割弱で、左が手前。 */
const SIGN_W = (h) => (h * vw) / vh;
function signs(refs, x0, h) {
  const step = Math.round(SIGN_W(h) * 0.83);
  return refs
    .map((ref, i) => {
      const [x, y] = rot(x0 + i * step, ROAD_Y - h * 0.42);
      return (
        `<span class="pin" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px` +
        `;height:${h}px;z-index:${refs.length - i}">${shield(ref)}</span>`
      );
    })
    .join('');
}

/* Roboto は番号だけに使う。style.css と同じ vendor の woff2 を埋め込むので、
 * この機械に何が入っているかに関わらず、番号は画面の標識と同じ字形になる。 */
const ROBOTO = join(WEB, 'vendor', 'roboto-latin-700-normal.woff2');
const roboto = readFileSync(ROBOTO).toString('base64');

const card = `<!doctype html><meta charset="utf-8">
<style>
  @font-face {
    font-family: Roboto; font-weight: 700; font-style: normal;
    src: url(data:font/woff2;base64,${roboto}) format('woff2');
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: ${OUT.w}px; height: ${OUT.h}px; position: relative; overflow: hidden;
    background: ${GROUND};
  }
  /* 組みは常に CARD の寸法。求められた枠の中央に置き、覆うまで拡大する。 */
  .card {
    position: absolute; left: 50%; top: 50%;
    width: ${CARD.w}px; height: ${CARD.h}px;
    transform: translate(-50%, -50%) scale(${SCALE});
    color: #FFFFFF;
    font-family: "Noto Sans JP", "Yu Gothic UI", sans-serif;
  }
  .map { position: absolute; inset: 0; }
  .map svg { display: block; }
  /* 名前は説明文の 2.5 倍以上に取る。縮めて出されたとき、最後まで残るのは
     ここだけなので。900 は Noto Sans JP が入っている機械でしか出ない。 */
  .text {
    position: absolute; inset: 66px auto auto 0; padding-left: 92px; width: 700px;
    display: flex; flex-direction: column; gap: 26px;
  }
  h1 { font-size: 108px; font-weight: 900; line-height: 1.05; letter-spacing: .02em; }
  p { font-size: 42px; font-weight: 500; line-height: 1.5; color: ${INK_2}; }
  /* 標識は絵の一部なので、地図の上に影を落として浮かせる。 */
  .pin {
    position: absolute; transform: translate(-50%, -50%);
    filter: drop-shadow(0 5px 10px rgba(0, 0, 0, .6));
  }
  .shield { display: block; height: 100%; }
  .shield svg { display: block; height: 100%; width: auto; }
  /* 縁は全幅を外へ出す。shield() は既定の塗り順のまま——載る先がパネルや
     ポップアップで、縁がその地に溶けるのが狙いだから——だが、この札には
     溶ける先が無く、内側へ食い込むと面がひと回り小さく見える
     (web/shield.mjs の SHIELD_STROKE_WIDTH の注記)。 */
  .shield path { fill: ${FACE}; stroke: ${EDGE}; paint-order: stroke; }
  .shield text { fill: ${EDGE}; font-family: Roboto; font-weight: 700; font-size: ${NUM_SIZE}px; }
</style>
<div class="card">
  <div class="map">${map}${signs([73], 232, 86)}${signs([73, 110], 430, 118)}${signs([73, 110, 215], 790, 158)}</div>
  <div class="text">
    <h1>${TITLE}</h1>
    <p>${TAGLINE.join('<br>')}</p>
  </div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: OUT.w, height: OUT.h },
  deviceScaleFactor: 1,
});
await page.setContent(card);
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: 'png' });
await browser.close();

const dest = opt.out ? resolve(opt.out) : join(WEB, 'og.png');
writeFileSync(dest, png);
const kb = (png.length / 1024).toFixed(1);
console.log(`  ${basename(dest)}  ${OUT.w}x${OUT.h}  ${kb} kB`);
