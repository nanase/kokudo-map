/* The 国道番号標識 — the inverted-triangle sign a Japanese national route is
 * known by — drawn once and used everywhere the map names a route: in the
 * panel, in a popup header, and as the site's own icon.
 *
 * Its own module because scripts/make_brand.mjs draws the favicon and the
 * share image from the same path. A second copy of the outline would be a
 * second answer to what the sign looks like, free to drift from the first.
 */

/**
 * A convex polygon with its corners rounded off to radius `r`.
 *
 * Each corner backs off along both of its edges by however far the radius needs
 * — further at a sharp corner than at a blunt one — and joins the two points
 * with an arc. Listing the vertices clockwise on screen (y downwards) is what
 * makes every arc's sweep flag 1.
 *
 * Written as a construction rather than as a path string because the tangent
 * points a radius implies are not numbers anyone should have to check by hand.
 */
export function roundedPolygon(pts, r) {
  const n = pts.length;
  const round2 = (v) => Math.round(v * 100) / 100;

  const corners = pts.map(([x, y], i) => {
    // Unit vector from this vertex towards the one `step` places along.
    const towards = (step) => {
      const [px, py] = pts[(i + step + n) % n];
      const [dx, dy] = [px - x, py - y];
      const len = Math.hypot(dx, dy);
      return [dx / len, dy / len];
    };
    const [ux, uy] = towards(-1);
    const [wx, wy] = towards(1);
    const cos = Math.min(1, Math.max(-1, ux * wx + uy * wy));
    const back = r / Math.tan(Math.acos(cos) / 2);
    const at = (vx, vy) => `${round2(x + vx * back)} ${round2(y + vy * back)}`;
    return [at(ux, uy), at(wx, wy)];
  });

  let d = `M${corners[0][1]}`;
  for (let i = 1; i <= n; i++) {
    const [enter, leave] = corners[i % n];
    d += ` L${enter} A${r} ${r} 0 0 1 ${leave}`;
  }
  return `${d} Z`;
}

/**
 * The outline of the sign, drawn once.
 *
 * The real 国道番号標識 is an inverted triangle with visibly rounded corners,
 * and the marker used to be a bare triangle. `stroke-linejoin: round` was not
 * enough on its own: it rounds the white edge while the blue face underneath
 * still comes to three points, so the sign read as sharper than the thing it
 * stands for. The radius is set from the shape, not from a wish for softness —
 * about a tenth of the width, as on the sign.
 */
export const SHIELD_PATH = roundedPolygon(
  [
    [3, 4],
    [45, 4],
    [24, 39],
  ],
  4,
);

/**
 * An inverted-triangle route marker ("おにぎり") with the number inside.
 *
 * Coloured like the real 国道番号標識 — a white number on the sign blue, inside
 * the white border the sign carries — rather than as blue text on the panel
 * colour, which left it competing with whatever the map showed behind a popup.
 *
 * The number is SVG text with `textLength` rather than an HTML span, because a
 * three-digit number is wider than the triangle at the height it sits: it used
 * to spill onto the panel behind, and white on white would be nothing at all.
 */
export function shield(ref, small) {
  const digits = String(ref).length;
  const width = digits >= 3 ? 23 : digits === 2 ? 16 : 8;
  return (
    `<span class="shield${small ? ' sm' : ''}">` +
    `<svg viewBox="0 0 48 42" role="img" aria-label="国道${ref}号">` +
    `<path d="${SHIELD_PATH}" stroke-width="3" stroke-linejoin="round"/>` +
    `<text x="24" y="16.5" text-anchor="middle" textLength="${width}" ` +
    `lengthAdjust="spacingAndGlyphs">${ref}</text>` +
    '</svg></span>'
  );
}

export const shieldRow = (refs, small) =>
  refs.map((r) => shield(r, small)).join('');
