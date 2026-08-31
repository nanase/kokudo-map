/* 国道番号標識——日本の一般国道がそれで知られている標識——を一度だけ描き、
 * 地図が路線を名指しするところすべてで使う。操作面の一覧、ポップアップの
 * 見出し、そしてこのサイト自身のアイコンである。
 *
 * 輪郭は実物の標識の比率を写した(Japanese_National_Route_Sign_Blank.svg、
 * Wikimedia Commons、パブリックドメイン)。数字そのものはここに含めない。
 * 字を写すと元の書体のライセンスが付いてくるためである。
 *
 * 独立したモジュールにしてあるのは、scripts/make_brand.mjs が favicon と
 * 共有画像を同じパスから描くためである。輪郭の写しをもう 1 つ持つことは、
 * 標識の形に二つ目の答えを持つことであり、片方だけずれていく。
 */

/** 標識自身の座標系。使う側はどれもこの枠の中に描く。 */
export const SHIELD_VIEWBOX = '0 0 455 435';

/**
 * 標識の輪郭。一度だけ描く。
 *
 * viewBox の縁までの余白は四方とも約 10 単位ある。下の白い縁が外へ滲んでも
 * 切られずに済むのはそのためである。
 */
export const SHIELD_PATH =
  'M227,423.604c25.117,0 47.688,-9.475 65.617,-25.328c66.496,-68.349 116.87,' +
  '-154.307 145.575,-247.409c2.739,-8.232 5.809,-18.583 5.809,-29.347c0,' +
  '-44.492 -30.696,-81.936 -74.02,-93.054c-46.038,-11.231 -92.261,-16.938 ' +
  '-142.979,-16.938c-50.718,-0 -96.941,5.707 -142.979,16.938c-43.325,' +
  '11.118 -74.02,48.561 -74.02,93.054c-0,10.765 3.62,21.779 6.359,30.01c' +
  '26.315,93.7 76.124,174.919 144.898,246.221c17.928,15.853 40.627,25.853 ' +
  '65.743,25.853Z';

/**
 * 縁の太さ。単位は `SHIELD_PATH` と同じで、favicon を除くすべての標識——下の
 * `shield()`(操作面の行、ポップアップ)と、scripts/make_brand.mjs が og.png へ
 * 描く共有カード——が使う。
 *
 * 場面ごとに違うのは、そのうちどれだけが見えるかである。make_brand.mjs は
 * `paint-order="stroke"` で描くので、面は縮まず、後ろに溶け込む相手も無い。
 * `shield()` はそうしない。背景が必ず操作面かポップアップであり、縁がその地に
 * 溶けることこそ狙いだからである(`.shield` の上の CSS のコメントを参照)。
 */
export const SHIELD_STROKE_WIDTH = 15.94;

/**
 * favicon と、操作面の見出しアイコンが使う縁の太さ。どちらも
 * scripts/make_brand.mjs が描く `web/favicon.svg` を共有する。
 *
 * この印は番号を持たないので、`SHIELD_STROKE_WIDTH` と違って太い縁が押し潰す
 * 文字が無く、favicon の大きさでもはっきり読める太さにできる。`SHIELD_VIEWBOX`
 * の約 10 単位の余白はこの太さには足りないので、make_brand.mjs は
 * `SHIELD_ICON_PAD` ぶん viewBox を広げてから描く。共有カードのほうは細い
 * `SHIELD_STROKE_WIDTH` のままにする。カードの白い地では縁がどのみち見えず、
 * 太くしても得るものは無く、余白のぶん印が小さく見えるだけである。
 */
export const SHIELD_ICON_STROKE_WIDTH = 56;

/** `SHIELD_ICON_STROKE_WIDTH` と対で使う viewBox の余白。上を参照。 */
export const SHIELD_ICON_PAD = 20;

/**
 * 番号を中に入れた標識(「おにぎり」)。
 *
 * 配色は実物の国道番号標識に合わせる——標識の青地に白い番号、その外に標識が
 * 持つ白い縁である。操作面の地色に青い文字を置く形にすると、ポップアップの
 * 後ろに出ている地図と見た目を競うことになる。
 *
 * 番号は HTML の span ではなく `textLength` を付けた SVG の text にする。
 * 3 桁の番号は、この高さでは標識より広くなるためである。以前は後ろの操作面へ
 * 食み出しており、白地に白では何も見えない。
 *
 * 位置、桁数ごとの幅、style.css の `.shield text` が持つ `font-size` は、
 * `SHIELD_VIEWBOX` に対して目で三つまとめて合わせてある。viewBox を変える
 * なら、三つとも合わせ直す。
 */
export function shield(ref, small) {
  const digits = String(ref).length;
  const width = digits >= 3 ? 332 : digits === 2 ? 247 : 115;
  return (
    `<span class="shield${small ? ' sm' : ''}">` +
    `<svg viewBox="${SHIELD_VIEWBOX}" role="img" aria-label="国道${ref}号">` +
    `<path d="${SHIELD_PATH}" stroke-width="${SHIELD_STROKE_WIDTH}" ` +
    'stroke-linejoin="round"/>' +
    `<text x="227" y="260" text-anchor="middle" textLength="${width}" ` +
    `lengthAdjust="spacingAndGlyphs">${ref}</text>` +
    '</svg></span>'
  );
}

export const shieldRow = (refs, small) =>
  refs.map((r) => shield(r, small)).join('');

/* 都道府県道番号標識(案内標識 118の2、通称ヘキサ)------------------------------
 *
 * おにぎりと同じ `SHIELD_VIEWBOX`・同じ配色・同じ縁で描く。二つの標識は隣り合って
 * 並ぶ——路線の一覧、ポップアップの見出し——ので、同じ枠に収めておけば CSS の
 * `.shield` 一つが両方の大きさを決められる。枠が違えば、同じ行に並べたときの
 * 高さの揃え方を、もう一箇所で答えることになる。
 *
 * 輪郭は実物の比率を目で写した六角形で、上下に頂点、左右に垂直な辺を持ち、角は
 * 丸い。おにぎりとの見分けは形が付ける——実物の配色はどちらも標識の青に白い
 * 番号で、色は違いを述べていない。
 */

/**
 * ヘキサの輪郭。角は半径 20 単位で丸めてある——実物の標識も角が丸い。
 *
 * 元の六つの頂点は、上から時計回りに (227.5,14) (415,88) (415,347)
 * (227.5,421) (40,347) (40,88) である。垂直な辺は y=88 から y=347 までの
 * 259 単位、上下の頂点はそこから 74 単位ぶん尖る。横幅 375 に対して縦 407 で、
 * おにぎり(455 × 435)より縦長になる。これも実物に倣う。
 *
 * 丸めた角は二次ベジエで、頂点そのものが制御点になる。数はここで直に書く
 * ——形は変わらないので、毎回同じ答えを出す計算を閲覧側に持たせる理由が無い。
 */
export const HEX_PATH =
  'M208.9,21.3Q227.5,14 246.1,21.3L396.4,80.7Q415,88 415,108L415,327' +
  'Q415,347 396.4,354.3L246.1,413.7Q227.5,421 208.9,413.7L58.6,354.3' +
  'Q40,347 40,327L40,108Q40,88 58.6,80.7Z';

/**
 * 路線の呼び名。「長野県道63号」「東京都道7号」「北海道道106号」の形である。
 *
 * 「県道」「都道」「府道」「道道」の呼び分けは、県の名前の末尾が既に持っている。
 * 名前に「道」を継ぐだけで四つとも正しく出るので、呼び分けの表は要らない。
 * Wikipedia の記事名もこの形である(#101)。
 */
export const prefRouteName = (prefLabel, ref) => `${prefLabel}道${ref}号`;

/**
 * 番号を中に入れたヘキサ。
 *
 * 実物の標識は上に「県道」、下に県名を載せる。ここは番号だけにする——操作面での
 * 実寸は高さ 30 px で、その大きさでは上下の段の字は形にならない。読めない字を
 * 描いても、番号を細らせるだけである。どの県かは、標識を出す側が文字で述べる。
 *
 * 県は消えていない。`prefLabel` は読み上げの名前になり、支援技術には
 * 「長野県道63号」と届く。
 *
 * 桁ごとの幅は、六角形の一番広いところ——垂直な辺のあいだ——に収まる値である。
 * 位置と幅、style.css の `.shield text` が持つ `font-size` は、`SHIELD_VIEWBOX`
 * に対して目で三つまとめて合わせてある。
 */
export function hexShield(prefLabel, ref, small) {
  const digits = String(ref).length;
  const width =
    digits >= 4 ? 320 : digits === 3 ? 290 : digits === 2 ? 220 : 100;
  return (
    `<span class="shield hex${small ? ' sm' : ''}">` +
    `<svg viewBox="${SHIELD_VIEWBOX}" role="img" ` +
    `aria-label="${prefRouteName(prefLabel, ref)}">` +
    `<path d="${HEX_PATH}" stroke-width="${SHIELD_STROKE_WIDTH}" ` +
    'stroke-linejoin="round"/>' +
    `<text x="227.5" y="290" text-anchor="middle" textLength="${width}" ` +
    `lengthAdjust="spacingAndGlyphs">${ref}</text>` +
    '</svg></span>'
  );
}
