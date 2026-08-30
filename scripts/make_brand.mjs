/* このサイト自身の絵を描く。タブのアイコン、manifest.webmanifest が指すホーム
 * 画面のアイコン、そしてリンクの共有カードである。
 *
 * 三つとも国道番号標識である。この地図が扱っているのがそれだからで、どれも
 * web/shield.mjs の `SHIELD_PATH`——操作面とポップアップが使うのと同じ輪郭——
 * から描く。ここで三角形をもう一度写せば、標識の形に二つ目の答えを持つことに
 * なる。
 *
 * favicon は SVG である。1 ファイルで済み、揃えるべき寸法も無く、標識は平らな
 * 形なので、標本化せず描いて失う物が無い。番号は載せない——16 px では番号は
 * 滲みでしかなく、この地図が扱うのは番号の全部である。
 *
 * ホーム画面のアイコンと共有カードは PNG で、どちらも作図ライブラリではなく、
 * 既にここにある Chromium で描く。アイコンは、カードが横長で述べる場面を正方形に
 * 切り出した物である。三枚の標識が道の上に立ち、路線が合流するほど道の色が
 * 深くなる。本物の `shield()` をそのまま使う——手で描いた番号ではない——ので、
 * 番号入りの標識の見た目に二つの答えが生まれることはない。
 *
 * どれも追跡する。数十 kB しかなく、標識か文言が変わったときにしか動かない。
 * 下の街路を、その場の乱数ではなく種を渡した生成器で引いているのはそのため
 * である。二度走らせて同じバイト列にならなければ、走らせるたびに差分になる。
 *
 * 使い方:  node scripts/make_brand.mjs
 *          node scripts/make_brand.mjs --card 1280x640 --out build/social.png
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');

/* --card WxH --out PATH で、共有カードだけをその寸法で書き出す。GitHub の
 * social preview は 1280x640 を求め、SNS が出すカードが期待する 1200x630 と
 * 合わない。二つ揃って初めて効く——片方だけだと web/og.png を違う寸法で
 * 潰しかねない。 */
const { values: opt } = parseArgs({
  options: { card: { type: 'string' }, out: { type: 'string' } },
});
if (
  (opt.card !== undefined || opt.out !== undefined) &&
  !(opt.card && opt.out)
) {
  throw new Error(
    '--card と --out は揃えて渡す: --card 1280x640 --out build/social.png',
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
/* 地の色。ホーム画面アイコンと共有カードの両方が使う——地図の画面自体は
 * 明暗を切り替えるが、これらは常にこの一色である。 */
const GROUND = '#0B1826';

const TITLE = '国道マップ';
/* カードが載せる一文。README の冒頭でも共有カードでも、絵の周りに説明文は
 * 無く、地図が何のためにあるかを述べるのはここだけになる。 */
const TAGLINE = ['重用区間で番号を丸めない', '日本の国道地図'];

/* 地図(アイコン・カード共通)だけを少し倒す。街も国道も同じだけ倒れるので、
 * 交わりは直角のまま右肩上がりに見える。標識と文字は倒さない——地図の注記は
 * 水平に置く。 */
const TILT = -4;

/* (cx,cy) を中心に deg 度だけ回した (x,y) を返す関数を作る。アイコン・
 * カードは大きさが違う別々のキャンバスなので、中心もそれぞれ持つ——同じ式を
 * 中心だけ変えて使い回す。 */
function makeRot(cx, cy, deg) {
  const rad = (deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  return (x, y) => {
    const [dx, dy] = [x - cx, y - cy];
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
}

/* 国道の線・街路。区間ごとに 1 本、縦か横だけ——交わりは直角だけである。 */
const line = (x1, y1, x2, y2, color, w) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"` +
  ` stroke="${color}" stroke-width="${w}" stroke-linecap="butt"/>`;

/* Roboto は番号だけに使う。style.css と同じ vendor の woff2 を埋め込むので、
 * この機械に何が入っているかに関わらず、番号は画面の標識と同じ字形になる。
 * アイコンとカードの両方に必要なので、どちらより先に読む。 */
const ROBOTO = join(WEB, 'vendor', 'roboto-latin-700-normal.woff2');
const roboto = readFileSync(ROBOTO).toString('base64');
const fontFace =
  '@font-face { font-family: Roboto; font-weight: 700; font-style: normal;' +
  ` src: url(data:font/woff2;base64,${roboto}) format('woff2'); }`;

/* favicon・ホーム画面アイコン・カードは PNG に焼く必要があるので、まとめて
 * ブラウザを起こす。起動・終了を繰り返す理由が無い。 */
const browser = await chromium.launch();

/* --------------------------------------------------------------- favicon --- */
/* --card はカードだけを求めている。favicon・アイコンは寸法を持たないので、
 * 書き直して何かが変わる場面が無い。 */
if (!opt.card) {
  /* 標識は単独で置かれ、後ろに溶け込む相手のページが無い。だから
   * `paint-order="stroke"` で、縁の内側半分の上に面を塗る。これが無いと既定の
   * 塗り順(面の上に縁)になり、縁の幅ぶんが面を食って、面が目に見えて小さく
   * 読める。 */
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

/* ---------------------------------------------------------- home icon --- *
 *
 * ホーム画面に追加したときのアイコン(manifest.webmanifest が参照する)。
 * favicon (標識 1 枚だけ) ではなく、共有カードの一番深い区間——単独指定→
 * 二重用→三重用——を正方形に切り出した絵にする。標識 1 枚だけでは一般的な
 * 道路標識アプリに見え、重用区間という着想が伝わらない。
 *
 * 視点は左から右へ動くので、若い番号(73)を左・手前・大きく、大きい番号
 * (215)を右・奥・小さく置く。道の色も揃える——若い番号だけの区間が青、
 * 合流するたびに濃くなって右端が赤になる。
 *
 * 標識は shield() をそのまま使う。番号入りの標識をどう描くかの答えは
 * shield.mjs 側に既にあり、太さ違いの縁をここで新たに作ると、番号付き標識の
 * 見た目に二つ目の答えを持つことになる。 */
if (!opt.card) {
  const ICON = 512;
  const iconRot = makeRot(ICON / 2, ICON / 2, TILT);

  /* 標識の並び。底辺(ICON_BASE)を揃えて道の上に立たせ、大きさで奥行きを
   * 出す。z は描く順——奥(215)を先に、手前(73)を最後に描いて一番上に乗せる。 */
  const ICON_BASE = 350;
  const SIGNS = [
    { ref: 73, x: 195, h: 252, z: 3 },
    { ref: 110, x: 315, h: 196, z: 2 },
    { ref: 215, x: 415, h: 150, z: 1 },
  ];
  const ROAD = { y0: 328, y1: 368, b1: 265, b2: 385 };
  const GRID_LINES = [
    [-60, 118, 600, 118],
    [-60, 300, 600, 300],
    [140, -60, 140, 600],
    [380, -60, 380, 600],
  ];

  const mapSvg =
    `<svg viewBox="0 0 ${ICON} ${ICON}" width="${ICON}" height="${ICON}">` +
    `<rect width="100%" height="100%" fill="${GROUND}"/>` +
    `<g transform="rotate(${TILT} ${ICON / 2} ${ICON / 2})">` +
    `<g stroke="#22374E" stroke-width="4" opacity=".85" fill="none">` +
    GRID_LINES.map(
      ([x1, y1, x2, y2]) =>
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`,
    ).join('') +
    '</g>' +
    [
      [-100, ROAD.b1, N_COLORS[0]],
      [ROAD.b1, ROAD.b2, N_COLORS[1]],
      [ROAD.b2, ICON + 100, N_COLORS[2]],
    ]
      .map(
        ([x0, x1, c]) =>
          `<rect x="${x0}" y="${ROAD.y0}" width="${x1 - x0}" height="${ROAD.y1 - ROAD.y0}" fill="${c}"/>`,
      )
      .join('') +
    '</g>' +
    '<rect width="100%" height="100%" fill="url(#iv)"/>' +
    '<defs><radialGradient id="iv" cx=".5" cy=".5" r=".82">' +
    `<stop offset=".3" stop-color="${GROUND}" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="${GROUND}" stop-opacity=".55"/>` +
    '</radialGradient></defs>' +
    '</svg>';

  const pins = SIGNS.map((s) => {
    const [x, y] = iconRot(s.x, ICON_BASE - s.h / 2);
    return (
      `<span class="pin" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px` +
      `;height:${s.h}px;z-index:${s.z}">${shield(s.ref)}</span>`
    );
  }).join('');

  /* 実際に書き出す大きさ(outSize)へは、512 単位で組んだ絵を CSS の scale
   * で縮める——カードが CARD の組みを OUT の枠へ拡大縮小するのと同じやり方。
   * safeZoneScale は maskable 専用の追加縮小(下記)。 */
  const iconHtml = (
    outSize,
    safeZoneScale = 1,
  ) => `<!doctype html><meta charset="utf-8">
<style>
  ${fontFace}
  * { margin: 0; box-sizing: border-box; }
  body { width: ${outSize}px; height: ${outSize}px; overflow: hidden; background: ${GROUND}; }
  .icon {
    position: absolute; left: 50%; top: 50%; width: ${ICON}px; height: ${ICON}px;
    transform: translate(-50%, -50%) scale(${((outSize / ICON) * safeZoneScale).toFixed(6)});
  }
  .map { position: absolute; inset: 0; }
  .map svg { display: block; }
  .pin { position: absolute; transform: translate(-50%, -50%);
    filter: drop-shadow(0 5px 10px rgba(0, 0, 0, .6)); }
  .shield { display: block; height: 100%; }
  .shield svg { display: block; height: 100%; width: auto; }
  .shield path { fill: ${FACE}; stroke: ${EDGE}; paint-order: stroke; }
  .shield text { fill: ${EDGE}; font-family: Roboto; font-weight: 700; font-size: ${NUM_SIZE}px; }
</style>
<div class="icon"><div class="map">${mapSvg}</div>${pins}</div>`;

  const iconDir = join(WEB, 'icons');
  mkdirSync(iconDir, { recursive: true });

  const renderIconPng = async (html, outSize) => {
    const page = await browser.newPage({
      viewport: { width: outSize, height: outSize },
      deviceScaleFactor: 1,
    });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ type: 'png' });
    await page.close();
    return png;
  };

  for (const outSize of [192, 512]) {
    const png = await renderIconPng(iconHtml(outSize), outSize);
    const name = `icon-${outSize}.png`;
    writeFileSync(join(iconDir, name), png);
    console.log(
      `  icons/${name}  ${outSize}x${outSize}  ${(png.length / 1024).toFixed(1)} kB`,
    );
  }

  /* maskable: OS 側が任意の輪郭(丸・角丸四角など)でくり抜く前提の版。
   * 安全域(直径 80% の中心円)に収まるよう、絵全体をさらに 0.8 倍へ縮めて
   * 中央へ置く。地(GROUND)が全面を覆っているので、縮めた分の余白は
   * 継ぎ目なく地に溶ける。 */
  const maskable = await renderIconPng(iconHtml(512, 0.8), 512);
  writeFileSync(join(iconDir, 'icon-512-maskable.png'), maskable);
  console.log(
    `  icons/icon-512-maskable.png  512x512  ${(maskable.length / 1024).toFixed(1)} kB`,
  );

  /* iOS の「ホーム画面に追加」は manifest.webmanifest をほぼ見ず、この
   * ファイルだけを見る。角を自動で丸めるだけで任意形にはくり抜かないので、
   * maskable の安全域は不要である——他の 2 枚と同じ絵をそのまま縮小する。 */
  const apple = await renderIconPng(iconHtml(180), 180);
  writeFileSync(join(iconDir, 'apple-touch-icon.png'), apple);
  console.log(
    `  icons/apple-touch-icon.png  180x180  ${(apple.length / 1024).toFixed(1)} kB`,
  );
}

/* ------------------------------------------------------------------- card ---
 *
 * カードは、この地図が存在する理由そのものを出す。複数の路線番号を持つひと続き
 * の道である。二本の国道が本線に丁字路で入り、線は単独指定 → 二重用 → 三重用
 * と深くなる。深さは三つの言い方で同時に述べる——線の色、その上に載る標識の数、
 * そして標識の大きさである。最も深い区間を最も大きく描く。見る値打ちがあるのは
 * そこだからである。
 *
 * 番号は 73・110・215 である。三つとも一般国道に無い番号なので
 * (pipeline/build_routes.py の `VALID`。1〜58 と 101〜507 から、廃止された 6 つの
 * 番号を除いた集合である)、
 * この絵を実在の重用についての主張として読むことはできない。だから絵は測量では
 * なく、構図として自由に組める。
 */
const CARD = { w: 1200, h: 630 };

/* 別の寸法を求められても絵は組み直さない。CARD の組みのまま、求められた枠を
 * 覆うところまで拡大して、はみ出したぶんを切る。縁は地の色へ沈めてあり、
 * 見る物は中ほどに寄せてあるので、数十 px を切っても絵は欠けない。組みを
 * 寸法ごとに持つと、直した側と直し忘れた側ができる。 */
const size = opt.card ? /^([1-9]\d*)x([1-9]\d*)$/.exec(opt.card) : null;
if (opt.card && !size) {
  throw new Error(`--card は WxH で渡す (例: 1280x640): ${opt.card}`);
}
const OUT = size
  ? { w: Number(size[1]), h: Number(size[2]) }
  : { w: CARD.w, h: CARD.h };
const SCALE = Math.max(OUT.w / CARD.w, OUT.h / CARD.h);

/* 切り落としの上限は、絵の中で最も外に出る物との隙間から決める。組みが
 * 決まった後でしか測れないので、検査は下の「切り落とし」節にある。 */
const crop = {
  w: 1 - OUT.w / (CARD.w * SCALE),
  h: 1 - OUT.h / (CARD.h * SCALE),
};
const INK_2 = '#9CB8DC';
/* 街路。地の色との差はここだけで決まる。 */
const STREET = '#22374E';
const STREET_MAJOR = '#31506F';

const rot = makeRot(CARD.w / 2, CARD.h / 2, TILT);

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

/**
 * 標識の一枚一枚が、地図を倒した後どこに載るか。描く側も、切り落としの
 * 上限を測る側も、ここだけを読む。位置の式を二度書くと、片方だけ動かせて
 * しまう——検査が読むのが写しなら、それは検査ではない。
 */
function placements(refs, x0, h) {
  const step = Math.round(SIGN_W(h) * 0.83);
  return refs.map((ref, i) => {
    const [x, y] = rot(x0 + i * step, ROAD_Y - h * 0.42);
    return { ref, x, y, w: SIGN_W(h), h, z: refs.length - i };
  });
}

function signs(refs, x0, h) {
  return placements(refs, x0, h)
    .map(
      (s) =>
        `<span class="pin" style="left:${s.x.toFixed(1)}px;top:${s.y.toFixed(1)}px` +
        `;height:${s.h}px;z-index:${s.z}">${shield(s.ref)}</span>`,
    )
    .join('');
}

/* 標識の三つの組。単独 → 二重用 → 三重用。深いほど大きく、右へ寄る。 */
const GROUPS = [
  { refs: [73], x0: 232, h: 86 },
  { refs: [73, 110], x0: 430, h: 118 },
  { refs: [73, 110, 215], x0: 790, h: 158 },
];

/* 題字の左上。style.css ではなくここが述べる——下の隙間の計算が読む。 */
const TEXT_INSET = { top: 66, left: 92 };

/* ------------------------------------------------------------ 切り落とし ---
 *
 * 求められた枠を覆うまで拡大して、はみ出したぶんを切る作りなので、縦横比が
 * 1200:630 から離れるほど切る量が増える。どこかで題字か標識が欠ける。
 * 1080x1080 を渡すと横を 48% 切り、題字は「道マップ」になる——それでも
 * 終了コードは 0 になってしまう。
 *
 * 切ってよい量は、絵の中で最も外に出る物との隙間で決まる。横で最も外に出る
 * のは右端の標識で、地図ごと 4 度倒してあるぶん、倒す前より外へ出ている。
 * 手で 4.5% と書いていたのは倒す前の値で、実際の隙間はそれより狭い。
 * placements() に載る場所を訊いて測る。
 */
const placed = GROUPS.flatMap(({ refs, x0, h }) => placements(refs, x0, h));
const rightmost = Math.max(...placed.map((s) => s.x + s.w / 2));
const lowest = Math.max(...placed.map((s) => s.y + s.h / 2));
/* 両端で切るので、隙間の 2 倍まで許せる。縦も標識の実際の下端から測る——
 * 本線の高さ (ROAD_Y) は標識が載る前の値で、下端はそこより上にある。 */
const CROP_MAX = {
  w: (2 * Math.min(TEXT_INSET.left, CARD.w - rightmost)) / CARD.w,
  h: (2 * Math.min(TEXT_INSET.top, CARD.h - lowest)) / CARD.h,
};
if (crop.w > CROP_MAX.w || crop.h > CROP_MAX.h) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  throw new Error(
    `--card ${opt.card} は ${CARD.w}:${CARD.h} から離れすぎている: ` +
      `横 ${pct(crop.w)}・縦 ${pct(crop.h)} を切ることになり、` +
      `上限 (横 ${pct(CROP_MAX.w)}・縦 ${pct(CROP_MAX.h)}) を超える。` +
      '題字か標識が欠ける',
  );
}

const card = `<!doctype html><meta charset="utf-8">
<style>
  ${fontFace}
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
    position: absolute; inset: ${TEXT_INSET.top}px auto auto 0;
    padding-left: ${TEXT_INSET.left}px; width: 700px;
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
     ポップアップで、縁がその地に溶けるのが狙いだから——だが、このカードには
     溶ける先が無く、内側へ食い込むと面がひと回り小さく見える
     (web/shield.mjs の SHIELD_STROKE_WIDTH の注記)。 */
  .shield path { fill: ${FACE}; stroke: ${EDGE}; paint-order: stroke; }
  .shield text { fill: ${EDGE}; font-family: Roboto; font-weight: 700; font-size: ${NUM_SIZE}px; }
</style>
<div class="card">
  <div class="map">${map}${GROUPS.map((g) => signs(g.refs, g.x0, g.h)).join('')}</div>
  <div class="text">
    <h1>${TITLE}</h1>
    <p>${TAGLINE.join('<br>')}</p>
  </div>
</div>`;

/* 書き先は Chromium を起動する前に決めて、形だけ確かめる。docs が案内する
 * build/ は .gitignore にあるので clone した直後には無く、`--out build/` の
 * ように既にあるディレクトリを渡されることもある。描き終えてから ENOENT や
 * EISDIR で落ちると、1 秒ぶんの描画がまるごと無駄になる。確かめるほうを
 * mkdir より先に置くのは、断る書き先のために空のディレクトリを残さない
 * ためである。
 *
 * 見るのは形だけで、書けるかどうかは見ない。権限で弾かれる書き先は描き
 * 終えてから落ちる。そこまで確かめるには実際に書いてみるほかなく、
 * 書いてしまえば確かめる意味が無い。 */
/* 末尾の区切りはディレクトリを指す書き方である。resolve がそれを落とすので、
 * `--out build/social.png/` は `build/social.png` という名前のファイルとして
 * 書かれてしまう。落とされる前に断る。 */
if (/[\\/]$/.test(opt.out ?? '')) {
  throw new Error(`--out はファイル名で渡す。ディレクトリである: ${opt.out}`);
}
const dest = opt.out ? resolve(opt.out) : join(WEB, 'og.png');
/* 書き先は .png のファイル名でなければ断る。`--out build` も `--out build/`
 * も、書きたいのはディレクトリの中である。まだ build/ が無いと、resolve は
 * それを `<root>/build` という 1 つのファイル名として返し、PNG がその名前で
 * 生まれて、以後の mkdir が全部転ぶ。書く物は PNG しかないので、拡張子で
 * 見分けるのがいちばん狭い。 */
if (!/\.png$/i.test(dest)) {
  throw new Error(`--out は .png のファイル名で渡す: ${opt.out}`);
}
/* 追跡している 2 枚は 1200x630 でしか作らない。別の寸法でそこへ書くと、
 * 揃えて渡す決まりが防いでいるはずのこと——og.png を違う寸法で潰す——が
 * そのまま起きる。 */
if (
  opt.card &&
  /* Windows のファイル名は大小を区別しない。`web/OG.png` も同じ場所である。 */
  dest.toLowerCase() === join(WEB, 'og.png').toLowerCase()
) {
  throw new Error(
    `web/og.png は --card では書けない。引数なしで走らせる: ${opt.out}`,
  );
}
if (statSync(dest, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`--out はファイル名で渡す。ディレクトリである: ${opt.out}`);
}
mkdirSync(dirname(dest), { recursive: true });

const page = await browser.newPage({
  viewport: { width: OUT.w, height: OUT.h },
  deviceScaleFactor: 1,
});
await page.setContent(card);
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: 'png' });
await browser.close();

writeFileSync(dest, png);
const kb = (png.length / 1024).toFixed(1);
console.log(`  ${basename(dest)}  ${OUT.w}x${OUT.h}  ${kb} kB`);
