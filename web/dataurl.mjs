/* 配信データの基点を一箇所で持つ。mapspec.mjs と app.js は配信データの URL
 * をここの dataURL() を通してだけ組む。手元では相対パスのまま pipeline/serve.py
 * が web/data/ を読み、Pages に配るときだけ Actions が下の定数を
 * https://data.nanase.cc/ へ書き換える(.github/workflows/pages.yml)。
 * ファイルが増えても書き換え対象はこの 1 行だけである。
 */
const DATA_BASE_URL = 'data/';

/** 配信データの 1 ファイルの URL。手元では相対パス、Pages では絶対 URL
 * になる。 */
export const dataURL = (name) => `${DATA_BASE_URL}${name}`;
