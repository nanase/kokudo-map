/* 国道番号標識を一度だけ描き、地図が路線を名指しするところすべてで使う。
 * 操作面の一覧、ポップアップの見出し、このサイト自身のアイコンである。
 *
 * 輪郭は実物の標識の比率を写した(Japanese_National_Route_Sign_Blank.svg、
 * Wikimedia Commons、パブリックドメイン)。数字は含めない。字を写すと元の書体の
 * ライセンスが付いてくる。独立したモジュールにしてあるのは、scripts/make_brand.
 * mjs が favicon と共有画像を同じパスから描くためである。輪郭の写しを二つ持つと
 * 片方だけずれていく。
 */

/** 標識自身の座標系。使う側はどれもこの枠の中に描く。 */
export const SHIELD_VIEWBOX = '0 0 455 435';

/**
 * 標識の輪郭。viewBox の縁までの余白は四方とも約 10 単位あり、白い縁が外へ
 * 滲んでも切られない。
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
 * 縁の太さ。単位は `SHIELD_PATH` と同じで、favicon を除くすべての標識(下の
 * `shield()` と、scripts/make_brand.mjs が og.png へ描く共有カード)が使う。
 * make_brand.mjs は `paint-order="stroke"` で描くので面は縮まない。`shield()`
 * はそうせず、縁が操作面やポップアップの地に溶けることを狙う(`.shield` の CSS
 * を参照)。
 */
export const SHIELD_STROKE_WIDTH = 15.94;

/**
 * favicon と、操作面の見出しアイコンが使う縁の太さ。どちらも
 * scripts/make_brand.mjs が描く `web/favicon.svg` を共有する。番号を
 * 持たないので、太い縁が押し潰す文字が無く、favicon の大きさでも読める
 * 太さにできる。`SHIELD_VIEWBOX` の余白では足りないので、make_brand.mjs は
 * `SHIELD_ICON_PAD` ぶん viewBox を広げてから描く。共有カードは細い
 * `SHIELD_STROKE_WIDTH` のままにする。白い地では縁が見えず、太くしても印が
 * 小さく見えるだけである。
 */
export const SHIELD_ICON_STROKE_WIDTH = 56;

/** `SHIELD_ICON_STROKE_WIDTH` と対で使う viewBox の余白。上を参照。 */
export const SHIELD_ICON_PAD = 20;

/**
 * 番号を中に入れた標識(「おにぎり」)。配色は実物に合わせる(青地に白い番号、その
 * 外に白い縁)。操作面の地色に青い文字を置くと、後ろの地図と見た目を競う。番号は
 * `textLength` を付けた SVG の text にする。3 桁の番号はこの高さでは標識より
 * 広くなり、以前は後ろの操作面へ食み出していた。位置、桁数ごとの幅、style.css
 * の `.shield text` の `font-size` は `SHIELD_VIEWBOX` に対して目で三つまとめて
 * 合わせてある。viewBox を変えるなら三つとも合わせ直す。
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
 * 輪郭は実物の標識を写した(Some_Pref_Route_Sign_Template.svg、Wikimedia
 * Commons、パブリックドメイン)。素材の `plate` の path に一様な拡大と平行移動を
 * 掛けただけで、頂点は打ち直していない。配色も縁の描き方もおにぎりと同じで、
 * 違うのは形だけである。
 */

/**
 * ヘキサ自身の座標系。`SHIELD_VIEWBOX` と高さだけを揃え、幅が違う。実物の
 * ヘキサは横に長く(素材で 395 × 348、おにぎりは 434 × 412)、おにぎりの枠へ
 * 入れると背が 7% 低くなって同じ行の高さが揃わない。高さは CSS の `.shield`
 * 一つが決め、svg は width を auto にする。
 */
export const HEX_VIEWBOX = '0 0 489 435';

/**
 * ヘキサの輪郭。上下が水平な辺、左右が頂点の六角形で、角は丸い。素材のパスを 1.
 * 1961 倍し、`HEX_VIEWBOX` の中央へ寄せた。倍率は縁を含めた外径の
 * 高さがおにぎりと 428.02 で一致するように決めた。四方の余白は左右 8、上下 9.
 * 5 あり、縁が外へ滲んでも切られない。素材の六角形は上の辺が下の辺より 1.
 * 6 単位長い非対称だが、直さずに写す。0.4% は高さ 30 px で 0.1 px に足りない。
 */
export const HEX_PATH =
  'M473.18,197.78C480.62,209.87 480.62,225.13 473.18,237.22L375.71,406.28' +
  'C368.79,418.31 355.82,425.53 341.97,425.06L147.03,425.06C133.18,425.53 ' +
  '120.21,418.31 113.29,406.28L15.82,237.22C8.38,225.13 8.38,209.87 ' +
  '15.82,197.78L111.42,28.72C118.33,16.69 131.31,9.47 145.15,9.94L341.97,9.94' +
  'C355.82,9.47 368.79,16.69 375.71,28.72L473.18,197.78Z';

/**
 * ヘキサの縁の太さ。素材の 10 を輪郭と同じ 1.1961 倍にした値で、おにぎりの
 * `SHIELD_STROKE_WIDTH`(15.94)より細い。縁の太さもヘキサがヘキサに見える理由の
 * 一つなので、素材のままにした。
 */
export const HEX_STROKE_WIDTH = 11.96;

/**
 * 路線の呼び名。「長野県道63号」「東京都道7号」「北海道道106号」の形である。
 * 「県道」「都道」「府道」「道道」の呼び分けは県の名前の末尾が持つので、「道」
 * を継ぐだけで四つとも正しく出る。Wikipedia の記事名もこの形である(#101)。
 */
export const prefRouteName = (prefLabel, ref) => `${prefLabel}道${ref}号`;

/**
 * 番号を中に入れたヘキサ。実物は上に「県道」、下に県名を載せるが、ここは
 * 番号だけにする。操作面での実寸は高さ 30 px で、上下の段の字は形にならない。
 * どの県かは標識を出す側が文字で示し、`prefLabel` は読み上げの名前になる。
 *
 * 番号はおにぎりより大きい。ヘキサは胴が広く上下の段を載せないので、style.css
 * の `.shield.hex text` が `font-size` を 240 に上げている(おにぎりは 212.5)。
 * 高さ 22 px の行(関連路線の一覧)でも 3 桁が読める。桁ごとの幅はその字の高さで
 * 斜辺のあいだに残る幅から取り、3 桁と 4 桁は同じ値になる。位置と幅と
 * `font-size` は `HEX_VIEWBOX` に対して目で三つまとめて合わせてある。
 */
export function hexShield(prefLabel, ref, small) {
  const digits = String(ref).length;
  const width = digits >= 3 ? 326 : digits === 2 ? 267 : 134;
  return (
    `<span class="shield hex${small ? ' sm' : ''}">` +
    `<svg viewBox="${HEX_VIEWBOX}" role="img" ` +
    `aria-label="${prefRouteName(prefLabel, ref)}">` +
    `<path d="${HEX_PATH}" stroke-width="${HEX_STROKE_WIDTH}" ` +
    'stroke-linejoin="round"/>' +
    `<text x="244.5" y="303" text-anchor="middle" textLength="${width}" ` +
    `lengthAdjust="spacingAndGlyphs">${ref}</text>` +
    '</svg></span>'
  );
}
