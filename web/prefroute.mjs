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

/** 県と番号から鍵を作る。上の二つの逆で、組み立て方もここに一度だけ書く。 */
export const prefKeyOf = (region, ref) => `${region}-${ref}`;

/**
 * 鍵の並べ方。
 *
 * 並びで意味を持つのは番号のほうである。同じ県の物どうしを比べる場面しか無い
 * ので、県名は同点のときの区切りにしか効かない——それでも入れてあるのは、
 * 並びが入力の順に左右されないようにするためである。
 */
export const comparePrefKeys = (a, b) =>
  prefRefOf(a) - prefRefOf(b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * 打たれた番号で都道府県道を探す。
 *
 * `index` は県 → その県に在る番号の配列(`web/data/pref/index.json` を開いた
 * 物)。当て方は国道の一覧と同じ前方一致である——「18」と打てば 18・180・181…
 * が残る。同じ欄が両方の系統に当たるので、当て方も二つに分かれてはならない。
 *
 * 並びは番号が先、同じ番号の中は県の順である。県道 18 号は 47 本あるので、
 * 番号で並べれば同じ番号のものが固まり、県で目を走らせられる。県の順は
 * `index` の並び順をそのまま使う——regions.json の順である。
 *
 * `limit` で切る。「1」の一致は数千件になり、それを全部 DOM にするのは、
 * 打っている途中の 1 文字ごとに起きる。切った後の総数も返すので、呼ぶ側は
 * 「上位 N 件」と述べられる。
 */
export function matchPrefRoutes(index, query, limit) {
  const q = String(query);
  const hits = [];
  for (const [region, refs] of index) {
    for (const ref of refs) {
      if (String(ref).startsWith(q)) hits.push({ region, ref });
    }
  }
  hits.sort((a, b) => a.ref - b.ref);
  return {
    matches: hits.slice(0, limit).map((h) => ({
      ...h,
      key: prefKeyOf(h.region, h.ref),
    })),
    total: hits.length,
  };
}
