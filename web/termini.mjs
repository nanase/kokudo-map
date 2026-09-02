/* 起点・終点を GeoJSON にする。数千点しかなく操作面にも出ているので、タイルに
 * 混ぜず素の GeoJSON で置く。ビルドが渡す二つの一覧(1 路線の起終点と、複数の
 * 路線が一緒に始まる・終わる地点)を一つのソースから描き、`shared` フラグで
 * 見分ける。`refs` はアークと同じ区切り文字で書くので、1 路線に絞る式がそのまま
 * 効く。
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
