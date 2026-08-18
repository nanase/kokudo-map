/* Putting untrusted text into HTML safely.
 *
 * The panel and the popups are assembled as strings, and some of what goes
 * into them was written by whoever last edited the road in OpenStreetMap:
 * `name` above all, but also `kind` and `src` where the lookup falls through
 * to the raw tag value. Anyone can edit OSM, so a name is untrusted input that
 * arrives by way of the build, and pasting it into `innerHTML` unescaped is
 * script injection with a mapper as the author.
 *
 * Numbers computed here — arc counts, lengths, designations that have been
 * through `Number()` — cannot carry markup and are left alone. Everything that
 * reached the viewer as a string goes through this.
 */

const REPLACEMENTS = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a value for interpolation into HTML. Nullish becomes empty. */
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => REPLACEMENTS[c]);
