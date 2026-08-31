/* 一つの国道について述べる場所。
 *
 * ポップアップは押したアーク 1 本について述べる。路線そのもの——延長、どれだけ
 * が重用か、台帳の起終点はどこか——を述べる場所は、これまで地図のどこにも無
 * かった。ポップアップの標識を押すと開くのがこのパネルである。
 *
 * panel.mjs・popup.mjs と同じ作法で、中身の組み立てはデータの純関数としてここ
 * に置く。地図が必要な部分——その地点へ飛ぶこと、パネルのぶん地図をずらすこと
 * ——だけが app.js に残る。
 *
 * 数はここでは数えない。すべて aggregate.mjs が national.meta.json の組み合わせ
 * 表から出したものを受け取る。同じ数を二度計算すると、片方が暗黙のうちに古くなる。
 */
import { esc } from './html.mjs';
import { PREF_RANK_LABELS } from './mapspec.mjs';
import { KIND_LABELS, PREF_KIND_LABELS } from './popup.mjs';
import { prefKeyOf, prefRefOf } from './prefroute.mjs';
import { hexShield, prefRouteName, shield } from './shield.mjs';

/** 路線の記事。日本語版 Wikipedia は「国道N号」で立項が揃っている。 */
export const wikipediaURL = (ref) =>
  `https://ja.wikipedia.org/wiki/${encodeURIComponent(`国道${ref}号`)}`;

/**
 * 都道府県道の記事。「長野県道63号」の形で引ける。
 *
 * 路線名は入れない。way の `name` は路線名ではなく、その場所の呼び名だからで
 * ある——「環状1号線」「1条通」「大網街道」「豊永橋」のような通称名・街路名・
 * 橋名が入っている。路線名は OSM から取れないので、入れる形にはできない。
 *
 * 地図が持つ 13,234 組のうち、素の形で引けるのは 11,891 組、89.9% である。
 * 連名指定も素の形で解ける——徳島県道1号 は「徳島県道・香川県道1号徳島引田線」
 * へのリダイレクトである。
 *
 * 引けない 1,343 組(10.1%)は赤リンクになる。記事が `宮崎県道14号佐土原国富線`
 * しか無く、素の形のリダイレクトが無い、という形である。ビルド時に存在を確かめて
 * リンクを出し分けることはしない——古くなった「記事が無い」は赤リンクより悪い。
 * この地図は更新の間隔を約束していないので、記事の不在を断定できる立場にない。
 */
export const prefWikipediaURL = (prefLabel, ref) =>
  `https://ja.wikipedia.org/wiki/${encodeURIComponent(prefRouteName(prefLabel, ref))}`;

/**
 * 台帳(政令)の起点・終点。national.meta.json がその欄を持たなければ空である。
 *
 * 欄は `decree.routes` で、`pipeline/pack_web.mjs` が書く。この関数を書いた
 * 時点では欄がまだ無く、`decree_termini` という名前を見込んでいた。#64 が
 * 実際に載せた名前は違ったので、欄はあるのに何も出ない状態が続いていた。
 * 名前を当てにする側は、当てにした名前を実物と突き合わせないと気づけない。
 * `pipeline/render_check.mjs` が実データで出ることを毎回確かめる。
 *
 * meta を読むのはここ 1 箇所だけにしてある。欄の形が変わっても、直す場所が
 * この関数だけで済むようにするためである。
 *
 * 座標が当たらなかった路線は地名だけを持つ。その場合も欄は出す——飛べない
 * だけで、どこが起終点かは述べられる。
 */
export function decreeTerminiOf(meta, ref) {
  const row = meta?.decree?.routes?.find((t) => Number(t.ref) === Number(ref));
  if (!row) return [];
  return [
    ['起点', row.start],
    ['終点', row.end],
  ]
    .filter(([, t]) => t?.name)
    .map(([label, t]) => ({
      label,
      name: t.name,
      // 座標が片方だけ来ることは無いが、来ても飛び先の無いボタンは出さない。
      at:
        Number.isFinite(t.lon) && Number.isFinite(t.lat)
          ? [t.lon, t.lat]
          : null,
    }));
}

/**
 * いま見ている路線に関わる路線を、関わり方ごとに分けて返す。
 *
 * 三つの関わり方は、それぞれ meta の別の欄が述べている。
 *
 * | 節       | 読む欄           | 意味                             |
 * | ---      | ---              | ---                              |
 * | 重用     | `combinations`   | 同じ道を一緒に走っている         |
 * | 起終点   | `shared_termini` | 路線の端が同じ地点にある         |
 * | 交差     | `crossings`      | 別々の道が平面で交わる           |
 *
 * 同じ番号は一度しか出さない。重用する相手は重用の切れ目で必ず交差もするし、
 * 起終点を共有する相手はその地点で必ず交わるので、そのまま並べると同じ標識が
 * 二度も三度も出る。上の表の順に強い関わりから拾い、先に拾った番号は後の節へ
 * 落とさない——「18 号とは重用している」と言った後に「18 号とは交差する」と
 * 言い足しても、読む人が知ることは増えない。
 *
 * 欄を持たない meta では、その節ごと空になる。`crossings` は後から入った欄な
 * ので、それより前に作った web/data を配ったままでも壊れない。都道府県道の県別
 * meta は `shared_termini` を持たない——都道府県道には全国 1 枚の起終点の台帳が
 * 無い——ので、その節はいつも空になる。
 *
 * `system` はその路線が何と呼ばれる系統かで、節の見出しに入る。`compare` は
 * 路線の並べ方、`normalize` は渡された路線を表の鍵に揃える関数である。国道の
 * 鍵は番号、都道府県道の鍵は `nagano-18` の文字列で、表の中の値と `===` で
 * 突き合わせる以上、揃えるのはここでなければならない。
 */
export function relatedRoutesOf(
  meta,
  ref,
  { system = '国道', compare = (a, b) => a - b, normalize = Number } = {},
) {
  const self = normalize(ref);
  const pick = (refs) => refs.filter((r) => r !== self);

  const conc = new Set();
  for (const c of meta?.combinations ?? []) {
    if (c.n < 2 || !c.refs.includes(self)) continue;
    for (const r of pick(c.refs)) conc.add(r);
  }

  const ends = new Set();
  for (const t of meta?.shared_termini ?? []) {
    if (!t.refs.includes(self)) continue;
    for (const r of pick(t.refs)) if (!conc.has(r)) ends.add(r);
  }

  const cross = new Set();
  for (const pair of meta?.crossings ?? []) {
    if (!pair.includes(self)) continue;
    for (const r of pick(pair)) if (!conc.has(r) && !ends.has(r)) cross.add(r);
  }

  // 番号の順に並べる。並びに意味を持たせるなら重用の長さや交差の回数で並べる
  // 手もあるが、標識には番号しか書いていないので、その順の理由が画面から読め
  // ない。番号順なら、探している番号がどこにあるかを見当だけで決められる。
  const sorted = (s) => [...s].sort(compare);
  return [
    { key: 'conc', label: `重用する${system}`, refs: sorted(conc) },
    { key: 'termini', label: `起終点を共有する${system}`, refs: sorted(ends) },
    { key: 'cross', label: `交差する${system}`, refs: sorted(cross) },
  ].filter((g) => g.refs.length);
}

/* 小数第 1 位まで。組み合わせ表の km がその桁で丸めてある。テストが期待値を
 * 独自に組むと同じ書式を二箇所で持つことになるので、export して本物の定義を
 * そのまま使わせる。 */
export const fmtKm = (km) =>
  km.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

const row = (dt, dd) => `<dt>${dt}</dt><dd>${dd}</dd>`;

/* Wikipedia の記事へ。あちらのロゴはパブリックドメインではないので写さない。
 * 代わりに、記事の見出しが使う系統の書体で W 一文字を出す——字体そのものは
 * 書体が持ち、ここは持たない(書体は style.css の `.detail-wiki text`)。
 *
 * かつてはその書体を端末に頼んでいた。頼める端末は、Office か Adobe の
 * 付属品として Garamond 系を持っている端末だけである。持たない端末では総称
 * の serif に落ち、V の重なりを持たない別の W が出ていた。いまは標識の番号
 * と同じように自前で配っているので、どの端末でも同じ字が出る。
 *
 * 隣の漏斗と同じ svg にしてある。textLength は shield.mjs の番号と同じ用途
 * で、どの書体が当たっても枠から食み出させないためである。21 は EB Garamond
 * の W の送り幅(font-size 22px で 20.97px)に合わせてあり、この書体では
 * 伸び縮みしない——20 だったころは 20/24 に潰れ、細い斜め線がさらに細く
 * なっていた。 */
export const WIKIPEDIA_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<text x="12" y="18.4" text-anchor="middle" textLength="21" ' +
  'lengthAdjust="spacingAndGlyphs">W</text></svg>';

/* 絞り込みの漏斗。側面の「番号で絞り込み」と同じ所作——他を落として一つに
 * するもの——なので、同じ形で述べる。 */
const ONLY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';

/* 起点と終点を 1 行で。
 *
 * 左端に起点、右端に終点、あいだを矢印が結ぶ——線形の路線を、そのまま線形に
 * 置く。ラベルは名前の上に載せ、起点は左、終点は右に寄せて、行の両端が二つの
 * 地点であることを配置だけで述べる。寄せる向きは中身が決めるので、どちらの端
 * かをここで印にして CSS へ渡す。片方しか無い路線でも向きは変わらない。
 *
 * 矢印は `join()` で挟む。片方しか無ければ挟む隙間が無いので出ない——行き先の
 * 無い矢印を引かないためである。 */
const SIDE = { 起点: 'from', 終点: 'to' };

const ARROW = '<span class="arrow" aria-hidden="true"></span>';

const terminusHTML = (ref, { label, name, at }) => {
  const side = SIDE[label] ?? 'from';
  const inner =
    `<span class="lbl">${label}</span>` +
    `<span class="nm">${esc(name)}</span>`;
  return at
    ? `<button type="button" class="end ${side}" data-at="${at.join(',')}" ` +
        `aria-label="国道${ref}号の${label}(${esc(name)})へ移動">` +
        `${inner}</button>`
    : `<div class="end ${side}">${inner}</div>`;
};

const terminiHTML = (ref, termini) =>
  termini.length
    ? `<div class="detail-termini">${termini
        .map((t) => terminusHTML(ref, t))
        .join(ARROW)}</div>`
    : '';

/* 区分の距離。round1() が 0.1 km 未満を切り捨てるので、地図には描かれている
 * のに丸めた値がちょうど 0 になる区分がある(#88)。旧道(formerRowHTML)の
 * ように行ごと落とすと、「その区分がある」という事実そのものが消える——旧道
 * と違い、区分(未開通・工事中・階段など)は短くても在ることに意味がある。
 * だから「0.0 km」ではなく「0.1 km 未満」と書き、無いのではなく短いだけだと
 * 言う。0 かどうかも閾値の書き方も fmtKm に聞く。fmtKm は閲覧者のロケールで
 * 数を組むので、'0.0' や '0.1' と書き写した判定・表記は小数点にコンマを使う
 * 地域で外れる。 */
const kindKmHTML = (km) =>
  fmtKm(km) === fmtKm(0) ? `${fmtKm(0.1)} km 未満` : `${fmtKm(km)} km`;

/* 区分の呼び名は系統ごとに違う。「点線国道」「海上国道」は国道の呼び名で、
 * 都道府県道はそれを持たない(popup.mjs の PREF_KIND_LABELS)。 */
const kindsHTML = (kinds, kindLabels) =>
  kinds.length
    ? '<div class="detail-kinds"><div class="detail-sub">区分別</div>' +
      `<dl class="detail-stats">${kinds
        .map((k) => row(esc(kindLabels[k.kind] ?? k.kind), kindKmHTML(k.km)))
        .join('')}</dl></div>`
    : '';

/* 延長の直下に置く、旧道だけの内訳(#26・#84)。区分別の合計は延長とほぼ
 * 一致するので(国道 10 号なら 791.3 km と 791.4 km)、区分別の下に同じ書体
 * で旧道の行を続けると「四つめの区分」に読める——#26 が禁じている読みで
 * ある。延長の直下に置けば、「うち」が指す先の真下に来る。
 *
 * 0 のときは行ごと出さない。丸める前の値では判定しない——0.04 km のような
 * 値は fmtKm で「0.0 km」になり、丸める前で判定すると「0.0 km」のまま出て
 * しまう。旧道を持たない路線は多くある。重用区間(route.conc_km)は持たない
 * ときも「なし」と書くが、旧道は「なし」とも書かない——持たないことは述べ
 * るに値しないためである。 */
const formerRowHTML = (formerKm) => {
  const km = fmtKm(formerKm);
  // 0 かどうかも fmtKm に聞く。fmtKm は閲覧者のロケールで数を組むので、小数点に
  // コンマを使う地域では 0 が「0,0」になる。'0.0' と書き写した判定はそこで外れ、
  // 旧道を持たない路線に「うち旧道 0,0 km」が出る。
  return km === fmtKm(0) ? '' : row('うち旧道', `${km} km`);
};

/* 関わりのある路線を、標識を並べて述べる。
 *
 * 標識は押せる。ポップアップの見出しと同じ `.shield-btn` で、押せばその路線の
 * 詳細に開き直る(受けるのは app.js の委譲)。標識そのものが路線の名前なので、
 * 脇に「国道N号へ」と書いたボタンを足すより標識自体を的にするほうが短い。
 *
 * 数が多い節では 30 を超えることがある(国道 4 号の交差は 31 路線)。小さいほうの
 * 標識で折り返す——パネルの幅は決め打ちで、入り切らないぶんは .detail-scroll が
 * 飲む。 */
const relShieldHTML = (ref) =>
  `<button type="button" class="shield-btn" data-ref="${ref}" ` +
  `title="国道${ref}号の詳細">${shield(ref, true)}</button>`;

/* 都道府県道の側。標識はヘキサで、鍵は県を伴う——番号だけでは 47 本のどれか
 * 決まらないので、押した先が開くパネルも県を受け取らなければならない。 */
const prefRelShieldHTML = (prefLabel) => (key) => {
  const name = prefRouteName(prefLabel, prefRefOf(key));
  return (
    `<button type="button" class="shield-btn" data-pref="${esc(key)}" ` +
    `title="${esc(name)}の詳細">${hexShield(prefLabel, prefRefOf(key), true)}</button>`
  );
};

const relatedHTML = (groups, shieldOf = relShieldHTML) =>
  groups
    .map(
      (g) =>
        `<div class="detail-rel"><div class="detail-sub">${g.label}</div>` +
        `<div class="rel-shields">${g.refs.map(shieldOf).join('')}</div>` +
        '</div>',
    )
    .join('');

/**
 * 1 路線ぶんの詳細。
 *
 * `route` は aggregate.mjs の routesOf() が返す行、`kinds` は kindsFor() が返す
 * 内訳、`termini` は decreeTerminiOf() が返す起終点、`related` は
 * relatedRoutesOf() が返す関わりのある路線、`formerKm` は formerKmFor() が返す
 * 旧道の距離である。後ろの四つは meta がその欄を持って初めて埋まる(区分別は
 * issue #58、起終点は issue #59、関わりのある路線はその後、旧道の距離は
 * issue #84)。どれが先に入っても壊れないよう、欄が無ければその欄ごと出さない。
 *
 * 見出しは標識だけを出す。標識は番号を書いた路線の名前そのものなので、隣に
 * 「国道N号」と書き添えるのは同じことを二度言うことだった。空いた場所には、
 * その路線について次にできること——記事を読む・地図をその路線だけにする——を
 * ボタンで置く。名前は読み上げのために `h2` に残す(`.sr-only`)。パネルの
 * `aria-labelledby` がそれを指している。
 */
export function detailHTML({
  route,
  kinds = [],
  termini = [],
  related = [],
  formerKm = 0,
}) {
  const { ref } = route;
  const name = `国道${ref}号`;
  return (
    `<header class="detail-hd">${shield(ref)}` +
    `<h2 id="detail-title" class="sr-only">${name}</h2>` +
    '<div class="detail-acts">' +
    `<a class="icon-btn detail-wiki" href="${wikipediaURL(ref)}" ` +
    `target="_blank" rel="noopener" title="Wikipedia「${name}」" ` +
    `aria-label="Wikipedia「${name}」を新しいタブで開く">` +
    `${WIKIPEDIA_ICON}</a>` +
    `<button type="button" class="icon-btn detail-only" data-ref="${ref}" ` +
    `title="${name}だけを表示" aria-label="${name}だけを表示">` +
    `${ONLY_ICON}</button>` +
    '</div></header>' +
    '<div class="detail-scroll">' +
    terminiHTML(ref, termini) +
    '<dl class="detail-stats">' +
    row('延長', `${fmtKm(route.km)} km`) +
    formerRowHTML(formerKm) +
    row('アーク数', route.arcs.toLocaleString()) +
    // 重用が 1 mm も無い路線は 459 のうち珍しくない。0.0 km と書くより、
    // 重用を持たないと言うほうが短い。
    row('重用区間', route.conc_km ? `${fmtKm(route.conc_km)} km` : 'なし') +
    row('最大重用数', route.max_n > 1 ? `${route.max_n} 重用` : '単独指定') +
    '</dl>' +
    kindsHTML(kinds, KIND_LABELS) +
    relatedHTML(related) +
    '</div>'
  );
}

/* ------------------------------------------------------ 都道府県道の詳細 --- */
/**
 * 1 路線ぶんの詳細、都道府県道の側。
 *
 * 国道のパネル(detailHTML)と同じ形にしてある。読む人にとってこれは同じ地図の
 * 同じ場所であって、系統ごとに別の作法を覚え直す場所ではない。違うのは四つ
 * だけである。
 *
 *   標識      ヘキサになり、路線名を見出しに出す
 *   起終点    出ない。都道府県道には全国 1 枚の起終点の台帳が無い
 *   絞り込み  押した状態が残る。ここが選択を述べる唯一の場所である(#109)
 *
 * 「この路線だけ表示」は国道と同じ絵・同じ場所に置くが、押した後の振る舞いだけ
 * が違う。国道のボタンは押すたびにその 1 路線へ置き換えるのに対し、こちらは
 * 押した状態を持ち、もう一度押すと解除する。操作面に都道府県道の節が無い以上、
 * 選んでいることを述べる場所も、解除する口も、このボタンのほかに無い(#109)。
 *
 * 重用の但し書きはここに置かない。「国道マップについて」が持つ
 * (panel.mjs の prefConcurrencyHTML)。パネルは 1 路線の数を述べる場所で、
 * 数え方そのものを述べる場所は、データの但し書きが集まっているあちらである。
 *
 * 見出しに名前を出すのは、ヘキサが県を持たないためである。国道のパネルが名前を
 * 伏せているのは、おにぎりの番号がそのまま路線の名前だからだった。ヘキサの番号
 * だけでは 47 本のどれか決まらないので、ここでは名前が要る。
 *
 * `route` が null なら、県別 meta がまだ届いていない。県の meta は県を開いた
 * ときに 1 県ぶんだけ取りに行くので(app.js の prefMeta)、届くまでの短いあいだ
 * がある。そのあいだも見出しは出す——押した標識がどの路線だったかは、数が
 * 揃う前から分かっていることである。
 */
export function prefDetailHTML({
  region,
  prefLabel,
  ref,
  route = null,
  rank = null,
  kinds = [],
  related = [],
  formerKm = 0,
  failed = false,
  selected = false,
}) {
  const name = prefRouteName(prefLabel, ref);
  const wait = failed
    ? '<p class="detail-wait">数を読み込めませんでした。</p>'
    : '<p class="detail-wait">読み込んでいます…</p>';
  const body = route
    ? '<dl class="detail-stats">' +
      (rank ? row('種別', esc(PREF_RANK_LABELS[rank] ?? rank)) : '') +
      row('延長', `${fmtKm(route.km)} km`) +
      formerRowHTML(formerKm) +
      row('アーク数', route.arcs.toLocaleString()) +
      row('重用区間', route.conc_km ? `${fmtKm(route.conc_km)} km` : 'なし') +
      row('最大重用数', route.max_n > 1 ? `${route.max_n} 重用` : '単独指定') +
      '</dl>' +
      kindsHTML(kinds, PREF_KIND_LABELS) +
      relatedHTML(related, prefRelShieldHTML(prefLabel))
    : wait;

  // 押した後に何が起きるかをそのまま名乗る。押している間の名乗りは「解除」で
  // あって「表示」ではない——同じ文言のまま状態だけ変わると、押した結果が
  // 読み上げからも title からも分からなくなる。
  const onlyText = selected
    ? `${name}だけの表示を解除`
    : `${name}だけを表示（国道も消えます）`;
  const only = region
    ? `<button type="button" class="icon-btn detail-only" ` +
      `data-pref="${esc(prefKeyOf(region, ref))}" aria-pressed="${selected}" ` +
      `title="${esc(onlyText)}" aria-label="${esc(onlyText)}">${ONLY_ICON}</button>`
    : '';

  return (
    `<header class="detail-hd">${hexShield(prefLabel, ref)}` +
    `<h2 id="detail-title" class="detail-name">${esc(name)}</h2>` +
    '<div class="detail-acts">' +
    `<a class="icon-btn detail-wiki" href="${prefWikipediaURL(prefLabel, ref)}" ` +
    `target="_blank" rel="noopener" title="Wikipedia「${esc(name)}」" ` +
    `aria-label="Wikipedia「${esc(name)}」を新しいタブで開く">` +
    `${WIKIPEDIA_ICON}</a>` +
    only +
    '</div></header>' +
    `<div class="detail-scroll">${body}</div>`
  );
}
