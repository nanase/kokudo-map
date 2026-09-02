/* 信用できない文字列を安全に HTML へ入れる。操作面もポップアップも文字列で
 * 組み立てており、`name` や、対応表から外れて生のタグ値に落ちる `kind`・`src`
 * は OSM の投稿者が書いたものである。エスケープせずに `innerHTML` へ貼ると
 * スクリプト混入になる。ここで計算した数(アーク数、延長、`Number()` を通した
 * 指定)は markup を持ちえないのでそのまま置く。
 */

const REPLACEMENTS = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML へ差し込む値をエスケープする。null と undefined は空文字になる。 */
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => REPLACEMENTS[c]);
