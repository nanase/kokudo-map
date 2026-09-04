/* リポジトリの場所を決める。pipeline/ はルートの直下にあるので、深さは決まって
 * いる。 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* 地域ごとの GeoJSON と meta。中間成果であって配信物ではない。閲覧側が取るのは
 * pack_web.mjs が web/data へ詰めた物である。 */
export const REGIONS = join(ROOT, 'build', 'regions');

/* 都道府県道の判定の生成物。国道と同じ形の GeoJSON と meta である。
 * 木を分ける理由は pipeline/_paths.py にある。 */
export const PREFECTURAL = join(ROOT, 'build', 'prefectural');

/* 都道府県道になりうる way を全国から測った結果。判定の入力である。JS から
 * 読むのは、県をまたぐルートリレーションの表(relations.json)だけである。 */
export const SURVEY = join(ROOT, 'build', 'survey');

/* 政令の別表をデータにした物。pipeline/decree.py が書く。 */
export const DECREE = join(ROOT, 'build', 'decree');
export const DATA = join(ROOT, 'web', 'data');
