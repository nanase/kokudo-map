/* 「地図」パネルが下地図の種類を選ばせる、3 枚の見本の絵を作る。
 *
 * 見本は開いている場所の地図ではなく、決まった 1 か所の固定の絵である。開く
 * たびにタイルを 3 種類読ませる理由が無く、場所によっては海しか写らない。
 * 場所は東京駅を真ん中にした z15 で、水・線路・街区が 3 枚とも写る。z14 では
 * 標準地図の駅舎が黒い塊に潰れて、何の絵か読めなかった。
 *
 * タイルの URL は mapspec.mjs の GSI_BASEMAPS から読む。ここに写すと、地図が
 * 読むタイルと見本の絵が別の物を指しうる。
 *
 * 画面に出す寸法(panel.mjs の BASEMAP_THUMB_SIZE)の 3 倍で焼き、高精細な画面
 * でも滲ませない。タイルを並べて撮るのは既にある Chromium である。canvas に
 * 描いて書き出す形は、地理院のタイルが別オリジンなので読み出せない。写真だけ
 * JPEG にする。PNG の 5 分の 1 で済む。
 *
 * 追跡する。3 枚で 110 kB ほどで、場所か下地図の種類を変えたときしか動かない。
 * 地理院のタイルが更新されれば、走らせ直すと絵も変わる。
 *
 * 使い方:  node scripts/make_basemap_thumbs.mjs
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { GSI_BASEMAP_ORDER, GSI_BASEMAPS } from '../web/mapspec.mjs';
import { BASEMAP_THUMB_SIZE } from '../web/panel.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');

const CENTER = { lat: 35.6808, lng: 139.765 };
const ZOOM = 15;
const SCALE = 3;
const W = BASEMAP_THUMB_SIZE.width * SCALE;
const H = BASEMAP_THUMB_SIZE.height * SCALE;
const TILE = 256;

/* 中心の世界座標(ズーム ZOOM のピクセル)。 */
const n = 2 ** ZOOM;
const lat = (CENTER.lat * Math.PI) / 180;
const px = ((CENTER.lng + 180) / 360) * n * TILE;
const py =
  ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n * TILE;
const x0 = Math.round(px - W / 2);
const y0 = Math.round(py - H / 2);

/** 切り出す枠に掛かるタイルを、枠の左上からの位置つきで並べる。 */
function tilesHTML(template) {
  const imgs = [];
  for (let tx = Math.floor(x0 / TILE); tx * TILE < x0 + W; tx++) {
    for (let ty = Math.floor(y0 / TILE); ty * TILE < y0 + H; ty++) {
      const src = template
        .replace('{z}', ZOOM)
        .replace('{x}', tx)
        .replace('{y}', ty);
      imgs.push(
        `<img src="${src}" style="position:absolute;` +
          `left:${tx * TILE - x0}px;top:${ty * TILE - y0}px;` +
          `width:${TILE}px;height:${TILE}px">`,
      );
    }
  }
  return imgs.join('');
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});
for (const id of GSI_BASEMAP_ORDER) {
  await page.setContent(
    '<body style="margin:0;overflow:hidden">' +
      `<div style="position:relative;width:${W}px;height:${H}px">` +
      `${tilesHTML(GSI_BASEMAPS[id].tiles)}</div></body>`,
  );
  const failed = await page.evaluate(() =>
    Promise.all(
      [...document.images].map((img) =>
        img.decode().then(
          () => null,
          () => img.src,
        ),
      ),
    ).then((r) => r.filter(Boolean)),
  );
  if (failed.length) throw new Error(`タイルを読めない: ${failed.join(', ')}`);

  const { thumb } = GSI_BASEMAPS[id];
  const path = join(WEB, thumb);
  mkdirSync(dirname(path), { recursive: true });
  const jpeg = path.endsWith('.jpg');
  await page.screenshot({
    path,
    type: jpeg ? 'jpeg' : 'png',
    ...(jpeg ? { quality: 85 } : {}),
  });
  console.log(
    `  ${thumb}  ${W}x${H}  ${(statSync(path).size / 1024).toFixed(1)} kB`,
  );
}
await browser.close();
