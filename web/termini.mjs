/* 起点・終点 as a GeoJSON source.
 *
 * These are a few thousand points and every one of them is already in the
 * panel, so they stay plain GeoJSON rather than joining the arcs in the tile
 * archive. The build hands over two lists — termini that belong to one route,
 * and places where several routes begin or end together — and the map draws
 * them from one source, telling them apart by a `shared` flag.
 *
 * `refs` is written with the same delimiters the arcs use, so the one filter
 * that narrows the map to a route narrows these too.
 */

const feature = (refs, shared, lon, lat) => ({
  type: 'Feature',
  properties: {
    refs: `,${refs.join(',')},`,
    label: refs.join('・'),
    shared,
    count: refs.length,
  },
  geometry: { type: 'Point', coordinates: [lon, lat] },
});

/** The whole termini layer, shared points first. */
export function terminiFeatures(meta) {
  return {
    type: 'FeatureCollection',
    features: [
      ...meta.shared_termini.map((t) => feature(t.refs, 1, t.lon, t.lat)),
      ...meta.termini.map((t) => feature([t.ref], 0, t.lon, t.lat)),
    ],
  };
}
