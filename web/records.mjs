/* 国道の記録。「最も短い国道」「海上区間が最も長い国道」のような、全国の国道を
 * 比べて初めて言える事実を national.meta.json から数える。画面の数はどれも
 * この表の部分和で(aggregate.mjs)、記録も同じ表を読む。ビルドを足さずに済むのは
 * そのためである。
 *
 * 値には確かさの差がある。路線の数・位置・政令の文言は確かだが、延長は OSM に
 * 描かれた線から測った値で、台帳と同じ数え方(ランプを除き、上下線を 1 本)に
 * 直してあっても公式の延長とはずれる。順位は確かでも値はずれる(海上区間は OSM の
 * 路線に入っている航路の線しか無く、58 号は公式 609.5 km に対して 559 km である)。
 * 延長を使う記録は `reference` を立て、画面が「参考」の印を付ける。
 *
 * markup は panel.mjs の recordCardHTML が組む。ここは数と文だけを返す。
 * test/records.test.mjs を参照。
 */

/** カードの分類。並びはタブの並びである。 */
export const RECORD_TABS = ['珍しい道', '線形', '交わり', '極点', '番号'];

const [RARE, SHAPE, LINKS, ENDS, NUMBER] = RECORD_TABS.keys();

/* 丸めの尾。行は 10 m 単位で配られるので、引き算の結果がそれ未満なら 0 と読む。
 * 1 行の km と区分はそれぞれ ±5 m まで丸めてあり、引けば 10 m までずれうる。 */
const ROUNDING_KM = 0.01;

const union = (a, b) => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const EMPTY = [Infinity, Infinity, -Infinity, -Infinity];
const unionAll = (boxes) => boxes.reduce(union, EMPTY);

/** 最大の値を持つ物を、同点ごと返す。記録は一人とはかぎらない(交わる国道が
 * 最も多いのは 1 号と 2 号の 2 本である)。 */
function leaders(items, value) {
  let best = -Infinity;
  let out = [];
  for (const it of items) {
    const v = value(it);
    if (v > best) {
      best = v;
      out = [it];
    } else if (v === best) {
      out.push(it);
    }
  }
  return { best, items: out };
}

/** 二点の大円距離(km)。 */
function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** 路線ごとの集まり。組み合わせ表を 1 度だけ辿る。 */
function routeTable(combos) {
  const by = new Map();
  for (const c of combos) {
    for (const ref of c.refs) {
      let e = by.get(ref);
      if (!e) {
        e = { ref, rows: [], km: 0, concKm: 0 };
        by.set(ref, e);
      }
      e.rows.push(c);
      e.km += c.km;
      if (c.n >= 2) e.concKm += c.km;
    }
  }
  return [...by.values()].sort((a, b) => a.ref - b.ref);
}

const kindKm = (route, kind) =>
  route.rows.reduce((s, c) => s + (c.kinds?.[kind] ?? 0), 0);

/**
 * 全国の国道の記録。`meta` は national.meta.json そのものである。
 *
 * 返す 1 件は次の形である。
 *
 * | 欄          | 中身                                                     |
 * | ---         | ---                                                      |
 * | `key`       | 記録の名前。画面の状態と検査が使う                       |
 * | `tab`       | `RECORD_TABS` の添字                                     |
 * | `title`     | 記録の名前(「最も短い国道」)                             |
 * | `refs`      | 答えの路線。同点なら複数                                 |
 * | `value`     | 値。数のまま返し、桁は `digits` が決める                 |
 * | `unit`      | 値の単位                                                 |
 * | `approx`    | 値の前に「約」を付けるか                                 |
 * | `reference` | 延長を使う値か。画面が「参考」の印を付ける               |
 * | `desc`      | 説明の 1 文。政令の起点・終点と、記録ごとの定型文で作る |
 * | `bbox`      | 「この場所を見る」の行き先                               |
 * | `ends`      | 極点の記録だけ。方角ごとの路線・緯度経度・行き先         |
 *
 * 延長を台帳と同じ数え方にする前の古い meta(行が `twin_km` を持たない)では、
 * それを要る記録を出さない。web/data は追跡していないので、古い meta が配信された
 * まま新しいコードが出ることがある。そのとき上下線を 2 本ぶん数えた値を出すよりは、
 * 出さないほうがよい。
 */
export function recordsOf(meta) {
  const combos = meta?.combinations ?? [];
  if (!combos.length) return [];
  const routes = routeTable(combos);
  const byRef = new Map(routes.map((r) => [r.ref, r]));
  const decree = new Map(
    (meta.decree?.routes ?? []).map((d) => [Number(d.ref), d]),
  );
  const hasLedger = combos.some((c) => 'twin_km' in c);

  const startOf = (ref) => decree.get(ref)?.start?.name;
  const endOf = (ref) => decree.get(ref)?.end?.name;
  const span = (ref) =>
    startOf(ref) && endOf(ref) ? `${startOf(ref)}から${endOf(ref)}まで。` : '';
  const boxOf = (refs, keep = () => true) =>
    unionAll(
      refs.flatMap((ref) =>
        byRef
          .get(ref)
          .rows.filter(keep)
          .map((c) => c.bbox),
      ),
    );

  const out = [];

  /* 珍しい道。区分ごとの延長で比べる。 */
  const kindRecord = (key, kind, title, tail) => {
    const { best, items } = leaders(routes, (r) => kindKm(r, kind));
    if (!(best > 0)) return;
    const refs = items.map((r) => r.ref);
    out.push({
      key,
      tab: RARE,
      title,
      refs,
      value: best,
      unit: 'km',
      digits: best >= 100 ? 0 : 1,
      approx: false,
      reference: true,
      desc: `${refs.length === 1 ? span(refs[0]) : ''}${tail}`,
      bbox: boxOf(refs, (c) => (c.kinds?.[kind] ?? 0) > 0),
    });
  };
  kindRecord(
    'ferry',
    'ferry',
    '海上区間が最も長い国道',
    '海の上も国道の一部。',
  );
  kindRecord(
    'foot',
    'foot',
    '徒歩道が最も長い国道',
    '車の通れない区間がある。',
  );
  kindRecord(
    'unopened',
    'unopened',
    '未開通区間が最も長い国道',
    'まだ道の無い区間が残る。',
  );

  // 全線が自動車専用道路。どの行の延長も、自動車専用道路だけでできている。
  // ランプは延長に入っていない(古い meta では入っているので、この記録を出さない)。
  // 行ごとに見るのは、丸めの尾が路線ぶん積もらないようにするためである。
  if (hasLedger) {
    const refs = routes
      .filter(
        (r) =>
          kindKm(r, 'expressway') > 0 &&
          r.rows.every((c) => c.km - (c.kinds?.expressway ?? 0) <= ROUNDING_KM),
      )
      .map((r) => r.ref);
    if (refs.length) {
      out.push({
        key: 'motorway',
        tab: RARE,
        title: '全線が自動車専用道路',
        refs,
        value: refs.length,
        unit: '本',
        digits: 0,
        approx: false,
        reference: true,
        desc: 'ランプを除き、全線を自動車専用道路として描いている。',
        bbox: boxOf(refs),
      });
    }
  }

  /* 線形。 */
  if (hasLedger) {
    const { best, items } = leaders(routes, (r) => -r.km);
    const refs = items.map((r) => r.ref);
    out.push({
      key: 'shortest',
      tab: SHAPE,
      title: '最も短い国道',
      refs,
      value: -best,
      unit: 'km',
      digits: 1,
      approx: true,
      reference: true,
      desc: refs.length === 1 ? span(refs[0]) : '',
      bbox: boxOf(refs),
    });
  }

  const loops = [...decree.values()]
    .filter((d) => d.start?.name && d.start.name === d.end?.name)
    .map((d) => Number(d.ref))
    .filter((ref) => byRef.has(ref))
    .sort((a, b) => a - b);
  if (loops.length) {
    out.push({
      key: 'loop',
      tab: SHAPE,
      title: '起点と終点が同じ国道',
      refs: loops,
      value: loops.length,
      unit: '本',
      digits: 0,
      approx: false,
      reference: false,
      desc: `${loops.map((ref) => `${ref}号は${startOf(ref)}`).join('、')}。`,
      bbox: boxOf(loops),
    });
  }

  const located = [...decree.values()].filter(
    (d) =>
      Number.isFinite(d.start?.lat) &&
      Number.isFinite(d.end?.lat) &&
      byRef.has(Number(d.ref)),
  );
  if (located.length) {
    const { best, items } = leaders(located, (d) => distanceKm(d.start, d.end));
    const refs = items.map((d) => Number(d.ref));
    out.push({
      key: 'farthest',
      tab: SHAPE,
      title: '起点と終点が直線距離で最も離れている国道',
      refs,
      // 起点・終点の座標は市区町村の中の端点で、政令の地点そのものではない。
      // 10 km の桁に丸め、「約」を付ける。
      value: Math.round(best / 10) * 10,
      unit: 'km',
      digits: 0,
      approx: true,
      reference: true,
      desc:
        refs.length === 1
          ? `起点は${startOf(refs[0])}、終点は${endOf(refs[0])}。`
          : '',
      bbox: boxOf(refs),
    });
  }

  /* 交わり。 */
  const crossCount = new Map();
  for (const [a, b] of meta.crossings ?? []) {
    crossCount.set(a, (crossCount.get(a) ?? 0) + 1);
    crossCount.set(b, (crossCount.get(b) ?? 0) + 1);
  }
  if (crossCount.size) {
    const { best, items } = leaders(routes, (r) => crossCount.get(r.ref) ?? 0);
    const refs = items.map((r) => r.ref);
    out.push({
      key: 'crossings',
      tab: LINKS,
      title: '交わる国道が最も多い国道',
      refs,
      value: best,
      unit: '本',
      digits: 0,
      approx: false,
      reference: false,
      desc: '平面で交わるほかの国道の数。',
      bbox: boxOf(refs),
    });
  }

  if (hasLedger) {
    const { best, items } = leaders(
      routes.filter((r) => r.km > 0),
      (r) => Math.round((r.concKm / r.km) * 100),
    );
    const refs = items.map((r) => r.ref);
    // 割合は丸めてあるので、100% でも単独の区間を持ちうる。有無は延長で決める。
    const single =
      best < 100
        ? `単独の区間は ${100 - best}% だけ。`
        : items.every((r) => r.km - r.concKm <= ROUNDING_KM)
          ? '単独の区間は無い。'
          : '単独の区間は 1% に満たない。';
    out.push({
      key: 'concurrency',
      tab: LINKS,
      title: '重用の割合が最も高い国道',
      refs,
      value: best,
      unit: '%',
      digits: 0,
      approx: false,
      reference: true,
      desc: `${refs.length === 1 ? span(refs[0]) : ''}${single}`,
      bbox: boxOf(refs),
    });
  }

  /* 極点。行の広がりの端で比べる。路線の線そのものの端なので確かである。 */
  const extreme = (dir, edge, sign, axis) => {
    let best = null;
    for (const r of routes) {
      for (const c of r.rows) {
        const v = c.bbox[edge] * sign;
        if (!best || v > best.v) best = { v, ref: r.ref, bbox: c.bbox };
      }
    }
    return { dir, ref: best.ref, deg: best.v * sign, axis, bbox: best.bbox };
  };
  const ends = [
    extreme('北', 3, 1, 'N'),
    extreme('東', 2, 1, 'E'),
    extreme('西', 0, -1, 'E'),
    extreme('南', 1, -1, 'N'),
  ];
  const holders = new Map();
  for (const e of ends)
    holders.set(e.ref, [...(holders.get(e.ref) ?? []), e.dir]);
  const twice = [...holders].filter(([, dirs]) => dirs.length > 1);
  out.push({
    key: 'ends',
    tab: ENDS,
    title: '東西南北の端',
    refs: [...holders.keys()],
    value: null,
    unit: '',
    digits: 0,
    approx: false,
    reference: false,
    desc: twice
      .map(([ref, dirs]) => `${ref}号は${dirs.join('と')}の端を一つで持つ。`)
      .join(''),
    bbox: unionAll(ends.map((e) => e.bbox)),
    ends,
  });

  /* 番号。 */
  const top = routes[routes.length - 1].ref;
  out.push({
    key: 'largest',
    tab: NUMBER,
    title: '最も大きい番号',
    refs: [top],
    value: top,
    unit: '号',
    digits: 0,
    approx: false,
    reference: false,
    desc: span(top),
    bbox: boxOf([top]),
  });

  return out;
}
