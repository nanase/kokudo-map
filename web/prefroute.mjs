/* 都道府県道の路線を名指すキー。番号は県の中でしか一意でない(県道 18 号は
 * 47 本ある)ので、路線の同一性は(県, 番号)の組である。判定はその組を
 * `nagano-18` の文字列にして配る(pipeline/build_prefectural.py の `refs_key`)。
 * タイルの `refs` も県別 meta の `combinations[].refs` もこの形である。
 * 読み方はここに一度だけ書く。番号は必ず末尾なので、最後の `-` で切る。
 */

/** キーの県。`nagano-18` なら `nagano` である。 */
export const prefRegionOf = (key) => key.slice(0, key.lastIndexOf('-'));

/** キーの番号。`nagano-18` なら 18 である。 */
export const prefRefOf = (key) => Number(key.slice(key.lastIndexOf('-') + 1));

/** 県と番号からキーを作る。上の二つの逆で、組み立て方もここに一度だけ書く。 */
export const prefKeyOf = (region, ref) => `${region}-${ref}`;

/**
 * キーの並べ方。並びで意味を持つのは番号で、県名は同点のときの区切りにしか
 * 効かない。入れてあるのは、並びが入力の順に左右されないようにするためである。
 */
export const comparePrefKeys = (a, b) =>
  prefRefOf(a) - prefRefOf(b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * 打たれた番号で都道府県道を探す。`index` は県 → その県にある番号の配列
 * (`web/data/pref/index.json`)。当て方は国道の一覧と同じ前方一致で、「18」と
 * 打てば 18・180・181… が残る。並びは番号が先、同じ番号の中は県の順(`index` の
 * 順、つまり regions.json の順)である。
 *
 * `limit` で切る。「1」の一致は数千件になり、打っている途中の 1 文字ごとに
 * 起きる。総数も返すので、呼ぶ側は「上位 N 件」と示せる。
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
