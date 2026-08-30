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
