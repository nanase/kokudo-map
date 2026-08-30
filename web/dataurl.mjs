/* 配信データの基点を一箇所で述べる。
 *
 * mapspec.mjs と app.js は、配信データの URL をここの dataURL() を通してだけ
 * 組む。手元で mise run serve する分には相対パスのまま、pipeline/serve.py が
 * web/data/ を読む。Pages に配るときだけ、下の定数を Actions が
 * https://data.nanase.cc/ へ書き換える(.github/workflows/pages.yml)。
 *
 * 配信データのファイルが増えても、書き換え対象は常にこの 1 行のままである。
 */
const DATA_BASE_URL = 'data/';

/** 配信データの 1 ファイルの URL。手元では相対パス、Pages では絶対 URL になる。 */
export const dataURL = (name) => `${DATA_BASE_URL}${name}`;
