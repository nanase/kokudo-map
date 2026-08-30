/* 起点・終点を GeoJSON にする。
 *
 * 数千点しかなく、どれも操作面に既に出ているので、タイルのアークに混ぜず素の
 * GeoJSON のまま置く。ビルドが渡すのは二つの一覧——1 路線に属する起終点と、
 * 複数の路線が一緒に始まる・終わる地点——で、地図は一つのソースから両方を描き、
 * `shared` フラグで見分ける。
 *
 * `refs` はアークと同じ区切り文字で書く。地図を 1 路線に絞る式が、そのまま
 * ここにも効く。
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

/** 起終点の層まるごと。共有する地点を先に置く。 */
export function terminiFeatures(meta) {
  return {
    type: 'FeatureCollection',
    features: [
      ...meta.shared_termini.map((t) => feature(t.refs, 1, t.lon, t.lat)),
      ...meta.termini.map((t) => feature([t.ref], 0, t.lon, t.lat)),
    ],
  };
}
