/* 一つの国道の詳細パネル。
 *
 * ポップアップは押したアーク 1 本について述べる。路線そのもの(延長、重用の
 * 割合、台帳の起終点)を述べる場所は無かった。ポップアップの標識を押すと開く。
 *
 * panel.mjs・popup.mjs と同じく、中身の組み立てはデータの純関数としてここに
 * 置く。地図が必要な部分(その地点へ飛ぶ、パネルのぶん地図をずらす)だけが app.js
 * に残る。数は数えず、aggregate.mjs が national.meta.json の組み合わせ表から
 * 出したものを受け取る。同じ数を二度計算すると片方が暗黙のうちに古くなる。
 */
import { esc } from './html.mjs';
import { PREF_RANK_LABELS } from './mapspec.mjs';
import { KIND_LABELS, PREF_KIND_LABELS } from './popup.mjs';
import { prefKeyOf, prefRefOf, prefRegionOf } from './prefroute.mjs';
import { hexShield, prefRouteName, shield } from './shield.mjs';

/** 路線の記事。日本語版 Wikipedia は「国道N号」で立項が揃っている。 */
export const wikipediaURL = (ref) =>
  `https://ja.wikipedia.org/wiki/${encodeURIComponent(`国道${ref}号`)}`;

/**
 * 都道府県道の記事。「長野県道63号」の形で引ける。路線名は入れない。way の
 * `name` は路線名ではなく、その場所の呼び名(「環状1号線」「1条通」「大網街道」
 * 「豊永橋」)である。
 *
 * 地図が持つ 13,234 組のうち、素の形で引けるのは 11,891 組、89.9% である。
 * 連名指定も解ける(徳島県道1号 は「徳島県道・香川県道1号徳島引田線」への
 * リダイレクト)。引けない 1,343 組(10.1%)は赤リンクになる(記事が
 * `宮崎県道14号佐土原国富線` しか無く、素の形のリダイレクトが無い)。ビルド時に
 * 存在を確かめて出し分けることはしない。この地図は更新の間隔を約束しておらず、
 * 古くなった「記事が無い」は赤リンクより悪い。
 */
export const prefWikipediaURL = (prefLabel, ref) =>
  `https://ja.wikipedia.org/wiki/${encodeURIComponent(prefRouteName(prefLabel, ref))}`;

/**
 * 台帳(政令)の起点・終点。national.meta.json がその欄を持たなければ空である。
 * 欄は `decree.routes` で、`pipeline/pack_web.mjs` が書く。この関数を書いた
 * 時点では `decree_termini` という名前を見込んでおり、#64 が載せた名前と
 * 違ったので、欄はあるのに何も出ない状態が続いていた。
 * `pipeline/render_check.mjs` が実データで出ることを毎回確かめる。meta を
 * 読むのはここ 1 箇所だけにして、欄の形が変わっても直す場所を一つにする。
 *
 * 座標が当たらなかった路線は地名だけを持つ。その場合も欄は出す。
 * 飛べないだけで、どこが起終点かは示せる。
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
 * いま見ている路線に関わる路線を、関わり方ごとに分けて返す。三つの関わり方は
 * meta の別の欄が持つ。
 *
 * | 節       | 読む欄           | 意味                             |
 * | ---      | ---              | ---                              |
 * | 重用     | `combinations`   | 同じ道を一緒に走っている         |
 * | 起終点   | `shared_termini` | 路線の端が同じ地点にある         |
 * | 交差     | `crossings`      | 別々の道が平面で交わる           |
 *
 * 同じ番号は一度しか出さない。重用する相手は重用の切れ目で必ず交差し、起終点を
 * 共有する相手はその地点で必ず交わるので、上の表の順に強い関わりから拾い、先に
 * 拾った番号は後の節へ落とさない。
 *
 * 欄を持たない meta では、その節ごと空になる。`crossings` は後から入った
 * 欄なので、古い web/data を配ったままでも壊れない。都道府県道の県別 meta は
 * `shared_termini` を持たない(全国 1 枚の起終点の台帳が無い)ので、その
 * 節はいつも空になる。
 *
 * `system` は系統の呼び名で、節の見出しに入る。`compare` は路線の並べ方、
 * `normalize` は渡された路線を表のキーに揃える関数である。国道のキーは番号、
 * 都道府県道のキーは `nagano-18` の文字列で、表の中の値と `===` で
 * 突き合わせる。
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

  // 番号の順に並べる。重用の長さや交差の回数で並べる手もあるが、標識には
  // 番号しか無いので、その順の理由が画面から読めない。
  const sorted = (s) => [...s].sort(compare);
  return [
    { key: 'conc', label: `重用する${system}`, refs: sorted(conc) },
    { key: 'termini', label: `起終点を共有する${system}`, refs: sorted(ends) },
    { key: 'cross', label: `交差する${system}`, refs: sorted(cross) },
  ].filter((g) => g.refs.length);
}

/**
 * いま見ている路線が属する群。県境で番号が変わらずに続く路線を束ねた物で、
 * 県別 meta の `continuations` が持つ(pipeline/pack_web_pref.mjs、issue #155)。
 *
 * 路線は高々一つの群にしか入らない。群は「県境で端点を共有し番号も同じ」組の
 * 連結成分なので、二つの群に同時に入れば、それは一つの群である。
 *
 * 群を持たない県の meta には欄そのものが無い。`crossings` と同じく後から入った
 * 欄なので、古い web/data を配ったままでも節が出ないだけで壊れない。
 */
export function continuationOf(meta, key) {
  return meta?.continuations?.find((c) => c.refs.includes(key)) ?? null;
}

/* 群がまたがる先を数える語。都 → 道 → 府 → 県 の順に並べる。 */
const SPAN_ORDER = '都道府県';

/**
 * 群の大きさの言い方。「3県」「3都県」「2府」のように、群に実際に入っている
 * 都・道・府・県 だけを並べて数を付ける。
 *
 * 「複数県にわたる」とは書けない。538 群のうち 134 群(24.9%)は「県」だけでは
 * 言えず、京都府と大阪府だけで閉じる 14 群には県が 1 つも入らない(内訳は
 * 県だけ 404・府と県 69・都と県 51・府だけ 14)。「複数の都道府県にわたる」は
 * 正しいが 16 字あり、節の見出しの 1 行に収まらない。
 *
 * 渡すのは群の全員の県名(`web/data/regions.json` の `label`)である。数はその
 * 本数で足りる。群の中で番号は一つに揃っており、同じ県に同じ番号の路線は 1 本
 * しか無いので、路線の数と県の数は必ず一致する。
 *
 * 例外表を持たない。北海道は群に入らないので `道` は出ないが、規則としては
 * 同じに扱う。C 回の漏斗の `title`(`3都県まとめて表示`)もここを読む。同じ
 * 文言を二箇所で組むと片方が暗黙のうちに古くなる。
 */
export function continuationCountOf(labels) {
  const tails = new Set(labels.map((l) => l.slice(-1)));
  const kinds = [...SPAN_ORDER].filter((c) => tails.has(c)).join('');
  return `${labels.length}${kinds}`;
}

/* 小数第 1 位まで。組み合わせ表の km がその桁で丸めてある。export して
 * テストにも本物の定義を使わせ、書式を二箇所で持たない。 */
export const fmtKm = (km) =>
  km.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

const row = (dt, dd) => `<dt>${dt}</dt><dd>${dd}</dd>`;

/* Wikipedia の記事へ。あちらのロゴはパブリックドメインではないので写さず、
 * 記事の見出しが使う系統の書体で W 一文字を出す。字体は書体が持つ(style.css の
 * `.detail-wiki text`)。以前は端末の書体に頼っており、Garamond 系を持たない
 * 端末では総称の serif に落ちて V の重なりを持たない別の W が出ていた。いまは
 * 標識の番号と同じように自前で配る。
 *
 * 隣の漏斗と同じ svg にしてある。textLength は shield.mjs の番号と同じ用途で、
 * どの書体でも枠から食み出させない。21 は EB Garamond の W の送り幅(font-size
 * 22px で 20.97px)で、この書体では伸び縮みしない。20 だったころは 20/24 に
 * 潰れ、細い斜め線がさらに細くなっていた。 */
export const WIKIPEDIA_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<text x="12" y="18.4" text-anchor="middle" textLength="21" ' +
  'lengthAdjust="spacingAndGlyphs">W</text></svg>';

/* 絞り込みの漏斗。「番号で絞り込み」と同じく他を落として一つにする操作なので、
 * 同じ形にする。 */
const ONLY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';

/**
 * 「この路線だけ表示」のボタン。国道と都道府県道が同じ物を使い、どちらも押した
 * 状態を持つ。地図を 1 本に絞っているあいだ、それを示す場所も解く操作も、この
 * ボタンのほかに無い場面がある(都道府県道には一覧が無く(#109)、国道の一覧も
 * ポップオーバーを開かなければ見えない)。
 *
 * ラベルは押した後に何が起きるかを表す。押している間は「解除」であって「表示」
 * ではない。同じ文言のまま状態だけ変わると、押した結果が読み上げからも title
 * からも分からない。見た目は `active`、読み上げは `aria-pressed` が持つ(app.js
 * の cycleButton と同じ)。
 *
 * キーは `ref`(国道)か `prefKey` + `prefLabel`(都道府県道)、または `prefKeys` +
 * `count`(県境で続く路線の群)を渡す。都道府県道の番号だけでは 47 本のどれか
 * 決まらない。
 *
 * パネルを組み立てるときだけでなく、選択が他所で変わったときにも呼ぶ(app.js の
 * syncDetailOnly)。押した状態の文字列を 2 箇所で組むと片方が暗黙のうちに
 * 古くなる。
 */
export function onlyButtonHTML({
  ref = null,
  prefKey = null,
  prefKeys = null,
  prefLabel = '',
  count = '',
  selected = false,
}) {
  /* 群を名指す形が三つめである(#155)。絵も押した状態の持ち方も 1 本のときと
   * 同じで、違うのは鍵が複数になることと名乗りだけである。範囲は絵ではなく
   * 置き場所が述べる。見出しの漏斗の隣には標識と路線名があり「長野県道1号だけ
   * を表示」と読め、節の漏斗の隣には相手のカードがあり「この 3 本を表示」と
   * 読める。同じ絵であるほうが、同じ操作だと分かる。
   *
   * `count` は continuationCountOf() が組んだ「3県」「3都県」「2府」である。
   * 数え方をここで組み直さない。 */
  if (prefKeys) {
    const text = selected ? 'まとめての表示を解除' : `${count}まとめて表示`;
    return (
      `<button type="button" class="icon-btn detail-only${selected ? ' active' : ''}" ` +
      `data-prefs="${esc(prefKeys.join(','))}" aria-pressed="${selected}" ` +
      `title="${esc(text)}" aria-label="${esc(text)}">${ONLY_ICON}</button>`
    );
  }
  const name = prefKey
    ? prefRouteName(prefLabel, prefRefOf(prefKey))
    : `国道${ref}号`;
  const attr = prefKey ? `data-pref="${esc(prefKey)}"` : `data-ref="${ref}"`;
  const text = selected ? `${name}だけの表示を解除` : `${name}だけを表示`;
  return (
    `<button type="button" class="icon-btn detail-only${selected ? ' active' : ''}" ` +
    `${attr} aria-pressed="${selected}" ` +
    `title="${esc(text)}" aria-label="${esc(text)}">${ONLY_ICON}</button>`
  );
}

/* 起点と終点を 1 行で。左端に起点、右端に終点、あいだを矢印が結ぶ。ラベルは
 * 名前の上に載せ、起点は左、終点は右に寄せる。どちらの端かをここで印にして CSS
 * へ渡す。片方しか無い路線でも向きは変わらない。矢印は `join()` で挟むので、
 * 片方しか無ければ出ない。 */
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

/* 区分の距離。round1() が 0.1 km 未満を切り捨てるので、地図には描かれているのに
 * 丸めた値が 0 になる区分がある(#88)。旧道(formerRowHTML)のように行ごと落とすと
 * 「その区分がある」事実が消える。区分(未開通・工事中・階段など)は
 * 短くてもあることに意味があるので、「0.0 km」ではなく「0.1 km 未満」と書く。
 * 0 かどうかも閾値の書き方も fmtKm に聞く。fmtKm は閲覧者のロケールで数を
 * 組むので、'0.0' と書き写した判定は小数点にコンマを使う地域で外れる。 */
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
 * 一致するので(国道 10 号なら 791.3 km と 791.4 km)、区分別の下に続けると
 * 「四つめの区分」に読める(#26 が禁じている読み)。延長の直下なら「うち」が
 * 指す先の真下に来る。
 *
 * 0 のときは行ごと出さない。丸める前の値では判定しない。0.04 km は fmtKm で
 * 「0.0 km」になるので、丸める前で判定すると「0.0 km」のまま出る。
 * 重用区間(route.conc_km)は持たないときも「なし」と書くが、旧道は書かない。
 */
const formerRowHTML = (formerKm) => {
  const km = fmtKm(formerKm);
  // 0 かどうかも fmtKm に聞く。小数点にコンマを使う地域では 0 が「0,0」になり、
  // '0.0' と書き写した判定では旧道を持たない路線に「うち旧道 0,0 km」が出る。
  return km === fmtKm(0) ? '' : row('うち旧道', `${km} km`);
};

/* 関わりのある路線を、標識を並べて示す。標識は押せる。ポップアップの見出しと
 * 同じ `.shield-btn` で、押せばその路線の詳細に開き直る(app.js の委譲)。
 * 標識そのものが路線の名前なので、脇にボタンを足すより標識自体を的にするほうが
 * 短い。数が多い節では 30 を超える(国道 4 号の交差は 31 路線)。小さいほうの
 * 標識で折り返し、入り切らないぶんは .detail-scroll がスクロールする。 */
const relShieldHTML = (ref) =>
  `<button type="button" class="shield-btn" data-ref="${ref}" ` +
  `title="国道${ref}号の詳細">${shield(ref, true)}</button>`;

/* 都道府県道の側。標識はヘキサで、キーは県を伴う。番号だけでは 47 本のどれか
 * 決まらない。 */
const prefRelShieldHTML = (prefLabel) => (key) => {
  const name = prefRouteName(prefLabel, prefRefOf(key));
  return (
    `<button type="button" class="shield-btn" data-pref="${esc(key)}" ` +
    `title="${esc(name)}の詳細">${hexShield(prefLabel, prefRefOf(key), true)}</button>`
  );
};

/* 群の相手のカード。重用・交差の節はヘキサだけを並べるが、あちらの相手は必ず
 * 同じ県で、番号だけで名指せる。この節の相手は別の都道府県であり、538 群のうち
 * 525 群は番号まで同じである。「1」の隣に「1」を並べても何も述べていないので、
 * 県名を添えたカードにする。ここに並ぶのは多くて 3 枚(4 県の群が 1 件)で、
 * 交差の 31 本とは事情が違う。
 *
 * 押した先は重用・交差の標識と同じである。`.shield-btn` と `data-pref` を持つ
 * ので、app.js の委譲がそのまま拾う。新しい口は開けない。 */
const contChipHTML = (prefLabels) => (key) => {
  const label = prefLabels?.get(prefRegionOf(key)) ?? '';
  const ref = prefRefOf(key);
  const name = prefRouteName(label, ref);
  return (
    `<button type="button" class="shield-btn cont-chip" data-pref="${esc(key)}" ` +
    `title="${esc(name)}の詳細">${hexShield(label, ref, true)}` +
    `<span class="pref">${esc(label)}</span></button>`
  );
};

/**
 * 複数の都道府県にわたる路線の節。長野県道1号・愛知県道1号・静岡県道1号は
 * 飯田富山佐久間線 として県境で直接つながっているが、県別の数だけでは
 * それを述べられない(issue #155)。
 *
 * 関わりの節(重用・交差)より前に置く。県境の向こうまで同じ道であることは、
 * 一点で交わることより強い関わりである。パネルの中でこの節だけが地の色を持つ
 * のも同じ理由で、いちばん強い関わりであることが読まなくても分かる。
 *
 * `cont` は continuationOf() が返す行、`prefLabels` は 県 → 県名 の対応表
 * (app.js の `state.prefLabels`)である。`refs` には自分自身も入っているので、
 * カードからは外す。自分の標識は見出しに出ている。
 *
 * 路線名は取れないことがある(538 群のうち 27 群)。そのときは行ごと出さない。
 * 欄そのものが無い形で来るので、`name` の有無で分かる。
 */
const continuationHTML = (key, cont, prefLabels, selected) => {
  // 県が分からなければ自分の鍵も作れない。外せない自分がカードに並ぶくらいなら
  // 節ごと出さない。「だけを表示」が region を要求するのと同じ事情である。
  if (!cont || !key) return '';
  const labelOf = (k) => prefLabels?.get(prefRegionOf(k)) ?? '';
  const count = continuationCountOf(cont.refs.map(labelOf));
  const others = cont.refs.filter((k) => k !== key);
  return (
    `<div class="detail-cont${selected ? ' on' : ''}">` +
    '<div class="cont-head">' +
    `<span class="detail-sub">${count}にわたる都道府県道</span>` +
    // 数は見出しが言うので、ここでは言わない。同じ数を二箇所で言わない。
    `<span class="cont-km">あわせて ${fmtKm(cont.km)} km</span>` +
    '</div>' +
    (cont.name ? `<div class="cont-name">${esc(cont.name)}</div>` : '') +
    // 漏斗は行の右端に置く。何を絞るのかは、隣に並んだカードが述べる。押した
    // 状態は枠の色も担う。漏斗は 15px しかなく、地図の上でパネルは 0.62 倍に
    // 見えるので、そこでは 9px になる。効いていることを述べるのは面のほうで
    // ある。
    '<div class="cont-row">' +
    `<div class="cont-chips">${others.map(contChipHTML(prefLabels)).join('')}</div>` +
    onlyButtonHTML({ prefKeys: cont.refs, count, selected }) +
    '</div></div>'
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
 * 1 路線ぶんの詳細。`route` は aggregate.mjs の routesOf() が返す行、`kinds` は
 * kindsFor()、`termini` は decreeTerminiOf()、`related` は relatedRoutesOf()、
 * `formerKm` は formerKmFor() の結果である。後ろの四つは meta がその欄を持って
 * 初めて埋まる(区分別は #58、起終点は #59、関わりのある路線はその後、旧道の
 * 距離は #84)。欄が無ければその欄ごと出さない。
 *
 * 見出しは標識だけを出す。標識が路線の名前そのものなので、「国道N号」と
 * 書き添えない。空いた場所にはその路線について次にできること(記事を読む・その
 * 路線だけにする)をボタンで置く。名前は読み上げのために `h2` に残し
 * (`.sr-only`)、パネルの `aria-labelledby` がそれを指す。
 */
export function detailHTML({
  route,
  kinds = [],
  termini = [],
  related = [],
  formerKm = 0,
  selected = false,
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
    onlyButtonHTML({ ref, selected }) +
    '</div></header>' +
    '<div class="detail-scroll">' +
    terminiHTML(ref, termini) +
    '<dl class="detail-stats">' +
    row('延長', `${fmtKm(route.km)} km`) +
    formerRowHTML(formerKm) +
    row('アーク数', route.arcs.toLocaleString()) +
    // 重用が無い路線は珍しくない。0.0 km と書くより、重用を持たないと言うほうが
    // 短い。
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
 * 1 路線ぶんの詳細、都道府県道の側。国道のパネル(detailHTML)と同じ形にする。
 * 違うのは、標識がヘキサになり路線名を見出しに出すことと、起終点が出ないこと
 * (都道府県道には全国 1 枚の起終点の台帳が無い)だけである。
 *
 * 「この路線だけ表示」は国道と同じ物である(onlyButtonHTML)。操作パネルに
 * 都道府県道の節が無いので、選んでいることを示す場所も解除する操作もこの
 * ボタンのほかに無い(#109)。重用の但し書きは「国道マップについて」が持つ
 * (panel.mjs の prefConcurrencyHTML)。パネルは 1 路線の数を出す場所で、
 * 数え方を説明する場所ではない。
 *
 * 見出しに名前を出すのは、ヘキサが県を持たないためである。国道はおにぎりの
 * 番号がそのまま路線の名前だが、ヘキサの番号だけでは 47 本のどれか決まらない。
 *
 * 国道に無い節が一つある。県境で番号が変わらずに続く路線を束ねた節で、
 * `continuation` は continuationOf() の結果、`prefLabels` は 県 → 県名 の
 * 対応表である。国道の番号は全国で一意なので、あちらに同じ節は要らない。
 *
 * 押した状態は二つある。`selected` は見出しの漏斗(この 1 本だけ)、
 * `groupSelected` は節の漏斗(群をまとめて)である。排他ではない。群を表示して
 * いる間に見出しの漏斗を押せば 1 本に絞れる。狭いほうが後から勝ち、その結果は
 * `state.prefSelected` 一つが持つ(wiring.mjs の isOnly と isOnlyGroup)。
 *
 * `route` が null なら、県別 meta がまだ届いていない(app.js の prefMeta)。
 * そのあいだも見出しは出す。押した標識がどの路線かは、数が揃う前から分かる。
 */
export function prefDetailHTML({
  region,
  prefLabel,
  ref,
  route = null,
  rank = null,
  kinds = [],
  related = [],
  continuation = null,
  prefLabels = null,
  formerKm = 0,
  failed = false,
  selected = false,
  groupSelected = false,
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
      continuationHTML(
        region ? prefKeyOf(region, ref) : null,
        continuation,
        prefLabels,
        groupSelected,
      ) +
      relatedHTML(related, prefRelShieldHTML(prefLabel))
    : wait;

  // 国道のパネルと同じボタンである(onlyButtonHTML)。県を伴うキーで名指す。
  const only = region
    ? onlyButtonHTML({ prefKey: prefKeyOf(region, ref), prefLabel, selected })
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
