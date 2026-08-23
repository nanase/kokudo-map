/* The 国道番号標識 — the sign a Japanese national route is known by — drawn
 * once and used everywhere the map names a route: in the panel, in a popup
 * header, and as the site's own icon.
 *
 * The outline is traced from the real sign's proportions (Japanese_National_
 * Route_Sign_Blank.svg, Wikimedia Commons, public domain — the number itself
 * is left out here because a traced digit would carry the source font's
 * licence).
 *
 * Its own module because scripts/make_brand.mjs draws the favicon and the
 * share image from the same path. A second copy of the outline would be a
 * second answer to what the sign looks like, free to drift from the first.
 */

/** The sign's own coordinate system; every consumer draws inside this box. */
export const SHIELD_VIEWBOX = '0 0 455 435';

/**
 * The outline of the sign, drawn once.
 *
 * Margin to the viewBox edge is about 10 units on every side, which is what
 * lets the white border below bleed outward without being clipped.
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
 * Border thickness, in the same units as `SHIELD_PATH`.
 *
 * One value for every size the sign is drawn at, favicon included — the
 * traced sign has one true border proportion. What differs by context is how
 * much of it shows: scripts/make_brand.mjs paints the favicon and card with
 * `paint-order="stroke"` so the face keeps its full size with nothing behind
 * it to blend into; `shield()` below does not, since its background is
 * always the panel or a popup, and the border blending into that edge is the
 * point (see the CSS comment above `.shield`).
 */
export const SHIELD_STROKE_WIDTH = 15.94;

/**
 * Border thickness for the standalone brand mark — favicon, the panel's own
 * title icon, the share card — drawn by scripts/make_brand.mjs.
 *
 * The mark carries no number, so unlike `SHIELD_STROKE_WIDTH` there is no
 * text for a heavier border to crowd, and it can afford to read clearly at
 * favicon size. `SHIELD_VIEWBOX`'s ~10-unit margin is too tight for a border
 * this heavy on its own, so make_brand.mjs pads the viewBox by
 * `SHIELD_ICON_PAD` before drawing it.
 */
export const SHIELD_ICON_STROKE_WIDTH = 56;

/** viewBox padding paired with `SHIELD_ICON_STROKE_WIDTH` — see above. */
export const SHIELD_ICON_PAD = 20;

/**
 * A route marker ("おにぎり") with the number inside.
 *
 * Coloured like the real 国道番号標識 — a white number on the sign blue, inside
 * the white border the sign carries — rather than as blue text on the panel
 * colour, which left it competing with whatever the map showed behind a popup.
 *
 * The number is SVG text with `textLength` rather than an HTML span, because a
 * three-digit number is wider than the sign at the height it sits: it used
 * to spill onto the panel behind, and white on white would be nothing at all.
 *
 * Position, per-digit-count width, and the `font-size` in style.css's
 * `.shield text` rule were all tuned together, by eye, against
 * `SHIELD_VIEWBOX`. Re-tune all three together if the viewBox ever changes.
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
