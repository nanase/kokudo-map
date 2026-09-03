/* 画面が出す合計を、アークの並びから一度だけ計算する。
 *
 * 閲覧側は特徴量を持たない。タイルには画面に出ている物しか載らないので、路線の
 * 一覧も重用のランキングも選択の合計もあちらでは足せない。ここで足して meta と
 * して配る。
 *
 * 国道(pack_web.mjs)と都道府県道(pack_web_pref.mjs)の両方が使う。数え方は路線の
 * 格に依らないので、二つの入口のどちらにも属さない。違うのは路線の同一性を何で
 * 表すかだけで(国道は番号 `18`、都道府県道は県を貼り付けた `nagano-18`)、それは
 * 並べ替えの比較関数として受け取る。
 *
 * 受け取るアークは `{properties: {refs, n, km, kind, former, name}, refs_list,
 * bbox, geometry}` の形である。`refs` は区切り文字で囲んだキー、`refs_list` は
 * その中身の並びである。
 */

const km2 = (v) => Math.round(v * 100) / 100;

/** 指定の集合ごとに 1 行。画面が出す物はどれもこの行の部分和である。
 *
 * 路線別の表では足りない。重用区間のアークは複数の路線に属するので、路線の行を
 * 足すと共有部分を二重に数える(18 号と 117 号を持つアークは両方に属する)。
 * それはこの地図が隠すのをやめさせたい数そのものである。
 *
 * 行はその延長が何でできているかも持つ。合計だけでは「国道152号のうち実際に
 * 走れるのはどれだけか」に答えられない。`kinds` は延長をタイルと同じ `kind` で
 * 分け、`former_km` はそのうち旧道がどれだけかを示す。別の欄にしてあるのは別の
 * 軸だからで、旧道は「どれかの区分の道であって現道ではなくなった物」なので、
 * `kinds` に畳むと自動車専用道路の旧道も徒歩道の旧道も見えなくなる(#26)。
 *
 * どちらも 0 は書かずに欠落で表す。行は国道で約 1,200、区分は七つあり、1 行が
 * 名指しするのは 1 つか 2 つである。0 を書き並べれば何も述べないまま表が
 * 三倍になる。
 *
 * `extra` は、その路線の格に固有の欄を 1 行ごとに足す。都道府県道は
 * 主要地方道かどうかをここで持つ。境目の値を持つのは判定(build_prefectural.py)
 * なので、JS 側が番号から決め直すと同じ問いに二箇所で答えることになる。
 */
export function combinationsOf(feats, extra = null) {
  const by = new Map();
  for (const f of feats) {
    const p = f.properties;
    let e = by.get(p.refs);
    if (!e) {
      e = {
        refs: f.refs_list,
        n: p.n,
        km: 0,
        arcs: 0,
        kinds: new Map(),
        former: 0,
        names: new Map(),
        bbox: [Infinity, Infinity, -Infinity, -Infinity],
        extra: extra ? extra(f) : null,
      };
      by.set(p.refs, e);
    }
    e.km += p.km;
    e.arcs++;
    e.kinds.set(p.kind, (e.kinds.get(p.kind) || 0) + p.km);
    if (p.former) e.former += p.km;
    if (p.name) e.names.set(p.name, (e.names.get(p.name) || 0) + 1);
    e.bbox = [
      Math.min(e.bbox[0], f.bbox[0]),
      Math.min(e.bbox[1], f.bbox[1]),
      Math.max(e.bbox[2], f.bbox[2]),
      Math.max(e.bbox[3], f.bbox[3]),
    ];
  }
  return [...by.values()]
    .map((e) => {
      // 先に丸めてから落とす。丸めて消える区分は 5 m 未満で、述べることが無い。
      // 名前はビルドがアークを分類したときの物で、ここが独自の語彙を作ることは
      // しない。
      const kinds = [...e.kinds.entries()]
        .map(([k, v]) => [k, km2(v)])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const former = km2(e.former);
      return {
        refs: e.refs,
        n: e.n,
        km: km2(e.km),
        arcs: e.arcs,
        kinds: Object.fromEntries(kinds),
        ...(former > 0 ? { former_km: former } : {}),
        names: [...e.names.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([n]) => n),
        bbox: e.bbox.map((v) => Math.round(v * 1e5) / 1e5),
        ...(e.extra ?? {}),
      };
    })
    .sort((a, b) => b.n - a.n || b.km - a.km);
}

/** 平面で交わる路線の組。
 *
 * 重用は「一本の道が複数の番号を持つ」ことで、組み合わせ表が既に持つ。ここが
 * 示すのはその逆、別々の道が一点で出会うことで、表のどこにも無い。交差点は
 * アークの端とはかぎらない。OSM の way は交差のたびに切れているとはかぎらず、
 * 一方の途中の節点をもう一方の端が踏むことがあるので、端だけを見ると出会う組の
 * 2% を取り落とす。だから節点を全部見る。
 *
 * 節点は座標そのもので同定する。同じ OSM 節点から出た座標は判定が同じ桁(小数
 * 第 6 位、約 10 cm)で丸めているので、文字列として一致する。立体交差は節点を
 * 共有しないのでここには出ない。曲がれない交差は交差ではない。
 *
 * 最初にその節点を踏んだアークの refs_list は複製せずそのまま置き、二本目が来て
 * 初めて Set に起こす。全国の節点は 160 万あり、大半は一本しか踏まないので、
 * 置き場のほとんどが参照だけで済む。一本しか踏まない節点が組を作らないことも、
 * この形そのものから従う。
 *
 * 重用したことのある組は落とす。重用は重用として述べる場所があり、同じことを
 * 二箇所で言わない。落とす相手は「同じアークに載ったことがある組」なので、一本
 * のアークが自分の節点に落とす影も一緒に消える。
 *
 * `compare` は路線の並べ方である。組の中も出来上がった並びもこれで揃える。
 */
export function crossingsOf(feats, compare) {
  const concurrent = new Set();
  for (const f of feats) {
    const refs = f.refs_list;
    for (let i = 0; i < refs.length; i++)
      for (let j = i + 1; j < refs.length; j++)
        concurrent.add(`${refs[i]},${refs[j]}`);
  }

  const at = new Map();
  for (const f of feats) {
    const refs = f.refs_list;
    for (const c of f.geometry.coordinates) {
      const k = `${c[0]},${c[1]}`;
      const cur = at.get(k);
      if (cur === undefined) at.set(k, refs);
      else if (Array.isArray(cur)) {
        const s = new Set(cur);
        for (const r of refs) s.add(r);
        at.set(k, s);
      } else {
        for (const r of refs) cur.add(r);
      }
    }
  }

  const pairs = new Map();
  for (const v of at.values()) {
    if (Array.isArray(v) || v.size < 2) continue;
    const rs = [...v].sort(compare);
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const k = `${rs[i]},${rs[j]}`;
        if (!concurrent.has(k)) pairs.set(k, [rs[i], rs[j]]);
      }
  }
  return [...pairs.values()].sort(
    (a, b) => compare(a[0], b[0]) || compare(a[1], b[1]),
  );
}
