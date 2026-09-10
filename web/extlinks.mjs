/* 「外部サイトで開く」が渡す 2 本の URL。押した時点の map.getCenter() /
 * map.getZoom() から組む純関数だけをここに置き、地図にも DOM にも触れない。
 * DOM の配線(押したときにこれを呼んで href を書く)は wiring.mjs にある。
 */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** map.getCenter() の lng は地図を周回すると ±180 を超えたまま返る。外へ
 * 出す前に -180 以上 180 未満へ畳む。 */
export function normalizeLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** 小数第 6 位までに丸める。1e-6 度はおよそ 10 cm で、地点を示す URL として
 * それより細かい桁は意味を持たない。 */
export const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** Google マップの縮尺は小数第 2 位まで。3 未満・21 超はその外の URL を
 * Google が受け付けないので丸める。 */
export function googleMapsZoom(zoom) {
  return Math.round(clamp(zoom, 3, 21) * 100) / 100;
}

/** 地理院地図の縮尺は整数の段しか取らない。四捨五入してから 5 未満・18 超を
 * 丸める。 */
export function gsiZoom(zoom) {
  return clamp(Math.round(zoom), 5, 18);
}

/** Google マップの URL。`@lat,lng,zoomz` の形で、その地点・縮尺を開く。 */
export function googleMapsURL({ lat, lng, zoom }) {
  const la = round6(lat);
  const lo = round6(normalizeLng(lng));
  const z = googleMapsZoom(zoom);
  return `https://www.google.com/maps/@${la},${lo},${z}z`;
}

/** 地理院地図の URL。ハッシュに `zoom/lat/lng/` を積む。 */
export function gsiMapURL({ lat, lng, zoom }) {
  const la = round6(lat);
  const lo = round6(normalizeLng(lng));
  const z = gsiZoom(zoom);
  return `https://maps.gsi.go.jp/#${z}/${la}/${lo}/`;
}
