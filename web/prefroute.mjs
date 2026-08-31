/* 都道府県道の路線を名指す鍵。
 *
 * 路線番号は県の中でしか一意でない——県道 18 号は 47 本ある——ので、路線の
 * 同一性は(県, 番号)の組である。判定はその組を `nagano-18` の 1 本の文字列に
 * して配る(pipeline/build_prefectural.py の `refs_key`)。タイルの `refs` も
 * 県別 meta の `combinations[].refs` も、この形の鍵で路線を指している。
 *
 * 閲覧側はその鍵を読む側なので、読み方はここに一度だけ書く。県の名前に `-` を
 * 含む物は無いが、番号は必ず末尾なので、最後の `-` で切る形にしてある。
 */

/** 鍵の県。`nagano-18` なら `nagano` である。 */
export const prefRegionOf = (key) => key.slice(0, key.lastIndexOf('-'));

/** 鍵の番号。`nagano-18` なら 18 である。 */
export const prefRefOf = (key) => Number(key.slice(key.lastIndexOf('-') + 1));

/**
 * 鍵の並べ方。
 *
 * 並びで意味を持つのは番号のほうである。同じ県の物どうしを比べる場面しか無い
 * ので、県名は同点のときの区切りにしか効かない——それでも入れてあるのは、
 * 並びが入力の順に左右されないようにするためである。
 */
export const comparePrefKeys = (a, b) =>
  prefRefOf(a) - prefRefOf(b) || (a < b ? -1 : a > b ? 1 : 0);
