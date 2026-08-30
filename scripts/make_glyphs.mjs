/* 地図のラベルに必要な SDF グリフを作る。他人に配ってもらわずに済ませるためで
 * ある。
 *
 * スタイルの `glyphs` は、かつて国土地理院のデモ用の配布元を指していた。他人の
 * GitHub Pages のサイトが実演として出している物で、答え続ける義務は無い——
 * 止まった日に、この地図のラベルは全部消える。他が静的ファイルだけでできて
 * いる地図が、そんな物に依存する理由は無い。
 * it.
 *
 * 日本語の書体を自前で配るとなれば、ふつうは何十 MB ものグリフ範囲になる。
 * ここではそうならない。ラベルが実際に述べる内容のためである。路線のラベルは
 * `refs.join('・')` で、起終点のラベルも同じなので、この地図が描きうる字は
 * 数字十個と区切り一つで全部である。11 字が、MapLibre の求める 256 符号位置
 * ずつの範囲のうち 2 つに入る。
 *
 * グリフは TinySDF で描き出す——MapLibre 自身が CJK を端末側で描くのに使うのと
 * 同じコードである——実描画の確認のために既にここにある Chromium の中で走らせる。
 * 定番の道具は fontnik だが、win32-x64 向けの実行ファイルを配っておらず、この
 * プロジェクトは同じ理由で tippecanoe も見送っている。
 *
 * 結果は追跡する。約 10 kB しかなく、ラベルが新しい字を覚えたときにしか変わら
 * ない。リポジトリの外に置けば、動きもしない物を作り直すために、配信のたび
 * ブラウザを落としてくることになる。
 *
 * 使い方:  node scripts/make_glyphs.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PbfWriter } from 'pbf';
import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'web', 'glyphs');

/* web/mapspec.mjs の FONT と一致していなければならない。MapLibre は
 * `{fontstack}/{range}` を要求し、その fontstack はあちらに書いてある名前で
 * ある。 */
const STACK = 'NotoSansJP-Regular';
const FAMILY = 'Noto Sans JP';

/* ラベルに入りうる字の全部。路線番号は数字で、`・` は重用区間の指定どうしを
 * 繋ぐ。信用せず、下で生成済みのデータに対して確かめる。 */
const CHARS = [...'0123456789・'];

/* グリフサーバの約束事。em は 24 px、字の枠の周りに 3 px の余白、距離場は縁の
 * 両側 8 px ぶんである。 */
const SDF = { fontSize: 24, buffer: 3, radius: 8, cutoff: 0.25 };

/* MapLibre はグリフの `top` を em の枠より上にある原点から述べるが、TinySDF は
 * アルファベットのベースラインから述べる。この定数は、MapLibre 自身が端末で
 * 描いたグリフをサーバ由来のグリフに混ぜて置くときに当てている値である
 * (glyph_manager の _drawGlyph を参照)。 */
const TOP_ADJUSTMENT = 27.5;
const LEFT_ADJUSTMENT = 0.5;

const RANGE_SIZE = 256;

/* ------------------------------------------------------ データが述べる字 --- */
/**
 * 地図が使い切ってしまうようなグリフの組は作らずに断る。
 *
 * 上の字の集合はデータについての主張なので、データに対して確かめる。閲覧側が
 * 描きうるラベルはどれも路線番号を繋いだ物であり、その指定はビルドが既に書いた
 * 集計表の中にある。
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

/* ---------------------------------------------------------------- 描き出す --- */
async function rasterise() {
  const tinySdfSrc = readFileSync(
    join(ROOT, 'node_modules', '@mapbox', 'tiny-sdf', 'index.js'),
    'utf8',
  ).replace('export default class TinySDF', 'class TinySDF');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  // `text=` を付けると、Google Fonts はこの字だけを載せた書体を 1 つ返す。
  // これから描かない物は何も落ちてこない。
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
      // 書体が届かなかった場合、canvas は何も言わずに端末の書体へ落ちる。
      // グリフは別人の字形になってしまう。
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

/* -------------------------------------------------------------- 符号化する --- */
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

// MapLibre はグリフを 256 符号位置ずつ取り、その範囲でファイルに名前を付ける
// ので、こちらも同じ単位でまとめる。
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

/* Noto Sans JP は SIL Open Font License 1.1 で、このグリフはそこから作った物
 * なので、条件も一緒に運ぶ。 */
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
