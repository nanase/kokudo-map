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
 *
 * 終わりの六つ(`addEndpoints` から `pickName` まで)を読むのは都道府県道
 * だけである。県境で番号が変わらずに続く路線を束ねるための物で、国道の番号は
 * 全国で一意なので県境で切れていない。ここに置くのは、これも路線どうしの関わり
 * を数える仕事で、`crossingsOf` の隣にあるのが自然だからである。
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

/** アークの両端を索引に貯める。県ごとのループから何度でも呼べる。
 *
 * `crossingsOf` は節点を全部見るが、こちらは端だけを見る。探しているのが、道が
 * 交わる所ではなく、道が終わって隣が始まる所だからである。県境で二本の県道が
 * 出会うとき、双方の way はそこで必ず切れている。所属県が way の属性である以上、
 * 一本の way が県境を跨いだまま両県に属することはない。
 *
 * 置き方は `crossingsOf` と同じで、最初の一本は `refs_list` をそのまま置き、
 * 二本目が来て初めて Set に起こす。端点は全国で 29 万あり、大半は一本しか
 * 踏まない。
 */
export function addEndpoints(feats, at = new Map()) {
  for (const f of feats) {
    const refs = f.refs_list;
    const c = f.geometry.coordinates;
    for (const pt of [c[0], c[c.length - 1]]) {
      const k = `${pt[0]},${pt[1]}`;
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
  return at;
}

/** 端点を共有し、番号が同じで、所属県が違う路線の組。
 *
 * 番号が違う隣接は採らない。全国で 133 組あるが、県境の交差点で複数の路線が
 * 出会うだけの組と、番号が変わって続く組を、幾何だけでは分けられない。混ぜると
 * 連結成分が膨らみ、埼玉と東京の 24・25・36・234 号が 8 路線の塊になる。番号が
 * 変わる県境越えは実在するので、これは採らないと決めたのであって、無いと言って
 * いるのではない(issue #155)。
 *
 * `partsOf` は路線のキーを (所属県, 番号) に開く。キーの綴り方を知っているのは
 * 判定(build_prefectural.py の refs_key)なので、ここでは知らないままにする。
 */
export function borderPairs(at, partsOf) {
  const pairs = new Map();
  for (const v of at.values()) {
    if (Array.isArray(v) || v.size < 2) continue;
    const rs = [...v];
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const [pa, na] = partsOf(rs[i]);
        const [pb, nb] = partsOf(rs[j]);
        if (pa === pb || na !== nb) continue;
        const [a, b] = rs[i] < rs[j] ? [rs[i], rs[j]] : [rs[j], rs[i]];
        pairs.set(`${a},${b}`, [a, b]);
      }
  }
  return [...pairs.values()];
}

/** 組を連結成分に畳んだ群。
 *
 * 辺は `[路線, 路線, 出どころ]` の三つ組である。出どころを辺ごとに持たせるのは、
 * 群がどの信号から出たのかを群になってから言うためで、二つの信号が同じ群を
 * 出したのか、片方しか出さなかったのかは、畳んだ後では辺を見ないと分からない。
 * 一つの群に二種類の辺が入れば `both` になる。
 *
 * 連結成分にするので、A-B と B-C は A-B-C の 1 群になる。実データでは 2 県が
 * 525、3 県が 12、4 県が 1 で、塊にはならない。
 */
export function groupsOf(edges, compare) {
  const adj = new Map();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }

  const home = new Map();
  const groups = [];
  for (const start of adj.keys()) {
    if (home.has(start)) continue;
    const i = groups.length;
    const stack = [start];
    const g = [];
    home.set(start, i);
    while (stack.length) {
      const k = stack.pop();
      g.push(k);
      for (const n of adj.get(k))
        if (!home.has(n)) {
          home.set(n, i);
          stack.push(n);
        }
    }
    groups.push(g.sort(compare));
  }

  const srcs = groups.map(() => new Set());
  for (const [a, , src] of edges) srcs[home.get(a)].add(src);

  return groups
    .map((refs, i) => ({
      refs,
      src: srcs[i].size > 1 ? 'both' : [...srcs[i]][0],
    }))
    .sort((x, y) => {
      const n = Math.min(x.refs.length, y.refs.length);
      for (let i = 0; i < n; i++) {
        const d = compare(x.refs[i], y.refs[i]);
        if (d) return d;
      }
      return x.refs.length - y.refs.length;
    });
}

/* ルートリレーションの `name` に付く前置き。`岐阜県道・三重県道23号　北方多度線`
 * の `北方多度線` より前を食う。県の数は 1 つとはかぎらず、番号との間や番号の
 * 後ろには全角の空白が入ることがある。 */
const RELATION_PREFIX = /^(?:[^\s・]+道・)*[^\s・]+道\s*\d+\s*号\s*/;

/* 種別の前置き。`主要地方道沼田檜枝岐線` の `主要地方道` を食う。種別は meta の
 * `rank` が既に述べているので、路線名に重ねて持たない。県をまたぐ 378 本の中に
 * 在るのは `主要地方道` の 2 本だけだが、`一般県道` も
 * `一般県道中瀬牧西線`(群馬県道258号・埼玉県道258号)のように実在する。 */
const RANK_PREFIX = /^(?:主要地方道|一般県道)/;

/** ルートリレーションの `name` が述べる路線名。
 *
 * 書き方は揃っていない。県をまたぐ 378 本では、路線名だけが 73、`県道N号` を
 * 含む物が 262、番号までで路線名の無い物が 40、`name` そのものが無い物が 3 で
 * ある。前置きを外して `線` で終われば路線名として採り、残らなければ何も
 * 返さない。
 */
export function relationRouteName(name) {
  const s = (name ?? '')
    .replace(RELATION_PREFIX, '')
    .replace(RANK_PREFIX, '')
    .trim();
  return s.endsWith('線') ? s : null;
}

/** 群の全員が持つ路線名。way の名前から採る。
 *
 * `namesOf` は路線のキーごとの `名前 -> 何本の組み合わせが載せたか` である。
 * `combinations[].names` を県ごとに足した物を渡す。
 *
 * way の `name` が路線名の根拠にならないのは「その (県, 番号) が何号か」を
 * 決めるときの話である(PREFECTURAL.md)。ここでは番号は既に決まっており、県境の
 * 向こうの路線まで同じ名前を持つことが裏取りになっている。`線` で終わり `号` を
 * 含まない物だけを採るのは、`環状1号線` や `1条通` のような場所の呼び名を
 * 路線名と取り違えないためである。
 */
export function sharedRouteName(keys, namesOf) {
  const first = namesOf.get(keys[0]);
  if (!first) return null;
  const shared = new Map();
  for (const n of first.keys()) {
    if (!n.endsWith('線') || n.includes('号')) continue;
    if (!keys.every((k) => namesOf.get(k)?.has(n))) continue;
    shared.set(
      n,
      keys.reduce((s, k) => s + (namesOf.get(k)?.get(n) ?? 0), 0),
    );
  }
  return pickName(shared);
}

/** 何通りか出た名前から 1 つ選ぶ。
 *
 * 多い方、同数なら短い方、それも同じなら綴り順である。**入力の並びで決めては
 * ならない。** 群を覆うリレーションは 1 本とはかぎらず、県を読む順もファイル名
 * 順でしかない。並びで決めると、県が 1 つ増えた日に無関係な群の名前が変わる。
 *
 * 何を数えた値かは呼ぶ側が決める。リレーション名なら「そう名乗ったリレーション
 * の本数」、way 名なら「その名前を載せた組み合わせの数」である。
 */
export function pickName(counts) {
  const sorted = [...counts.entries()].sort(
    (a, b) =>
      b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1),
  );
  return sorted.length ? sorted[0][0] : null;
}
