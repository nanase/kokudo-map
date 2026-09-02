/* 地図の上のポップオーバーと凡例が出すものを、データの関数として組み立てる。
 * 閲覧側はアークを手元に持たないので、合計も一覧も個数も national.meta.json
 * から読む(和は aggregate.mjs)。残るのはその答えを markup に直すことで、
 * 純関数なので検査できる場所に置く。どの文字列をどの要素へいつ入れるかは app.js
 * が持つ。
 */
import { esc } from './html.mjs';
import {
  COLOR_CONSTRUCTION,
  COLOR_FERRY,
  COLOR_FOOT,
  COLOR_UNOPENED,
  N_COLORS,
  N_LABELS,
  PREF_GENERAL,
  PREF_MAJOR,
  PREF_RANK_LABELS,
} from './mapspec.mjs';
import { hexShield, prefRouteName, shieldRow } from './shield.mjs';

/* ポップオーバーが出す行数。どちらもビルドが並べ替えて配るので、頭から取れば
 * 上位がそのまま出る。 */
export const RANKING_ROWS = 25;
export const SHARED_ROWS = 20;

/* 「道路を選択」が一度に出す都道府県道の行数。全国に 13,234 組あり、「1」の
 * 一致だけで数千件になる。それが打っている途中の 1 文字ごとに起きるので、DOM
 * にする数をここで切る。切ったことは見出しが示す(prefGroupLabel)。 */
export const PREF_LIST_ROWS = 200;

/* ------------------------------------------------------------------ 路線 --- */
/** データにあるすべての路線を並べたチェックボックスの一覧。 */
export const routeListHTML = (routes) =>
  routes
    .map(
      (r) =>
        `<label data-ref="${r.ref}" title="${r.km} km / 最大 ${r.max_n} 重用">` +
        `<input type="checkbox" value="${r.ref}">` +
        `<span>${r.ref}</span>` +
        (r.max_n > 1 ? `<span class="mn">×${r.max_n}</span>` : '') +
        '</label>',
    )
    .join('');

/* ------------------------------------------------------------------ 集計 --- */
/** 「国道マップについて」が出す四つの数。選択が空なら全部を意味する。 */
export const statsHTML = (selectedCount, totalRoutes, { arcs, km, conc }) =>
  `<dt>選択路線</dt><dd>${selectedCount || totalRoutes} / ${totalRoutes}</dd>` +
  `<dt>対象アーク</dt><dd>${arcs.toLocaleString()}</dd>` +
  `<dt>延長</dt><dd>${km.toLocaleString(undefined, { maximumFractionDigits: 0 })} km</dd>` +
  `<dt>重用アーク</dt><dd>${conc.toLocaleString()}</dd>`;

/**
 * 選択解除のボタンのラベル。どれだけ取り消すかを示すので、選択数を出す場所が
 * 他に不要である。一覧の下の「1 路線を選択中。」は、同じ問いへの二つ目の
 * 答えだった。
 */
export const clearLabel = (selectedCount) =>
  selectedCount ? `${selectedCount} 路線を選択解除` : '選択解除';

/**
 * 都道府県道の群の見出し。切ったときはそう言う。「上位」と言えるのは、番号の
 * 昇順に意味があるからである。
 */
export const prefGroupLabel = (shown, total) =>
  total > shown
    ? `都道府県道 ── 上位 ${shown} / ${total.toLocaleString()} 件`
    : `都道府県道 ── ${total} 件`;

/**
 * 都道府県道の行。番号は県の中でしか一意でない(県道 18 号は 47 本ある)ので、
 * 行は県を示す。標識は地図と同じヘキサで番号だけを入れ、県は隣に文字で置く。
 * 標識の中に県名を入れても、この大きさでは形にならない(shield.mjs の
 * hexShield)。
 */
export const prefRowsHTML = (rows, selected) =>
  rows
    .map(({ key, prefLabel, ref }) => {
      const name = prefRouteName(prefLabel, ref);
      const on = selected.has(key);
      return (
        `<label class="pref-row${on ? ' on' : ''}" title="${esc(name)}">` +
        `<input type="checkbox" data-pref="${esc(key)}" value="${esc(key)}"` +
        `${on ? ' checked' : ''}>` +
        hexShield(prefLabel, ref, true) +
        `<span class="nm">${esc(prefLabel)}</span></label>`
      );
    })
    .join('');

/* -------------------------------------------------------------- 重用一覧 --- */
/* 並べる行を選ぶのは aggregate.mjs の concurrencies() である。組み合わせ表を
   選択で絞る規則はそこに一度だけ書いてある。 */

/** ポップオーバーの見出しに出す「25 / 1,237 組」。何も無いときは何も
 * 出さない。 */
export const countLabel = (shown, total, unit) =>
  total ? `${shown} / ${total} ${unit}` : '';

/* aria-label が無いと、行が押せることも押した結果(地図上のその範囲へ移動)も
 * スクリーンリーダー利用者に伝わらない。ボタンの内容の代わりに
 * 読み上げられるので、標識・距離・名称もここに畳み込む。 */
const routeLabel = (refs) => `国道${refs.join('・')}号`;

export const rankingHTML = (rows) =>
  rows.length
    ? rows
        .map((e) => {
          const label =
            `${routeLabel(e.refs)}の重用区間 ${e.km.toFixed(1)}km` +
            (e.names.length ? `、${esc(e.names.join(' / '))}` : '') +
            'を地図で表示';
          return (
            `<button type="button" class="row" data-refs="${e.refs.join(',')}" ` +
            `data-bbox="${e.bbox.join(',')}" aria-label="${label}">` +
            `<span class="shields">${shieldRow(e.refs, true)}</span>` +
            `<span class="km">${e.km.toFixed(1)} km</span>` +
            (e.names.length
              ? `<span class="nm">${esc(e.names.join(' / '))}</span>`
              : '') +
            '</button>'
          );
        })
        .join('')
    : '<p class="empty">該当する重用区間はありません。</p>';

export const sharedHTML = (rows) =>
  rows.length
    ? rows
        .map((t) => {
          // 同じ路線の組が離れた土地で複数回起終点を共有することがあり
          // (全国データで 32 組)、refs だけでは行を跨いで aria-label が
          // 重複する。座標を足して行ごとに一意にする。
          const label =
            `${routeLabel(t.refs)}が起終点を共有する地点` +
            `(北緯${t.lat.toFixed(4)}・東経${t.lon.toFixed(4)})を地図で表示`;
          return (
            `<button type="button" class="row" data-refs="${t.refs.join(',')}" ` +
            `data-at="${t.lon},${t.lat}" aria-label="${label}">` +
            `<span class="shields">${shieldRow(t.refs, true)}</span>` +
            `<span class="km">${t.refs.length} 路線</span>` +
            '</button>'
          );
        })
        .join('')
    : '<p class="empty">該当地点はありません。</p>';

/* ------------------------------------------------------------------ 共有 --- */
/**
 * 共有ダイアログが出す、いまの表示状態の要約。ダイアログの中でこの状態は
 * 変更できないので、読み取り専用の説明でよい。`toggles` と `concLabel` の文言は
 * index.html のチェックボックス・ラジオボタンからそのまま渡してもらう。ここで
 * 書き直すと、表示側を直したときにこちらが暗黙のうちに古くなる。
 */
export const shareSummaryHTML = ({
  selectedRefs,
  prefRoutes = [],
  totalRoutes,
  concLabel,
  toggles,
}) =>
  '<div class="share-row"><span class="lbl">選択路線</span>' +
  `<span class="shields">${
    selectedRefs.length
      ? shieldRow(selectedRefs, true)
      : `<span class="all">すべて（${totalRoutes} 路線）</span>`
  }</span></div>` +
  // 都道府県道の行は選んでいるときだけ出す。選んでいないことは国道と同じく
  // 「すべて」を意味するが、13,234 組という数を出しても役に立たない。行ごと
  // 出さなければ、国道だけを見ている人のダイアログは今までと変わらない。
  (prefRoutes.length
    ? '<div class="share-row"><span class="lbl">都道府県道</span>' +
      `<span class="shields">${prefRoutes
        .map((r) => hexShield(r.prefLabel, r.ref, true))
        .join('')}</span></div>`
    : '') +
  '<div class="share-row"><span class="lbl">重用区間</span>' +
  `<span>${esc(concLabel)}</span></div>` +
  '<div class="share-row"><span class="lbl">表示</span>' +
  '<ul class="share-toggles">' +
  toggles
    .map((t) => `<li class="${t.checked ? 'on' : 'off'}">${esc(t.label)}</li>`)
    .join('') +
  '</ul></div>';

/**
 * SNS の共有シートが期待する、題と URL の 1 行
 * (「国道マップ - 292号\nhttps://…」)。`url` は `location` から読まず引数で
 * 受け取り、状態の純関数のままにする。都道府県道は「長野県道63号」と県ごと
 * 書く。番号だけでは 47 本のどれか決まらない。
 */
export const shareText = (url, { selectedRefs, prefRoutes = [] }) => {
  const names = [];
  if (selectedRefs.length) names.push(`${selectedRefs.join('・')}号`);
  for (const r of prefRoutes) names.push(prefRouteName(r.prefLabel, r.ref));
  return `国道マップ${names.length ? ` - ${names.join('・')}` : ''}\n${url}`;
};

/* ------------------------------------------------------------------ 凡例 --- */
/**
 * `tip` は補足であって名前の一部ではないので、カッコ書きにせず `title` 属性へ
 * 渡す。`title` を持つ項目だけカーソルを help にする。
 */
const item = (mark, text, tip) =>
  `<span class="item"${tip ? ` title="${esc(tip)}"` : ''}>${mark}${text}</span>`;

/** 1 色の見本。地図の線と同じく、実線か破線かで走れるかどうかを述べる。 */
const rule = (color, dashed) =>
  `<span class="swatch" style="border-top-color:${color}` +
  `${dashed ? ';border-top-style:dashed' : ''}"></span>`;

/** 1 色の見本を持つ項目。凡例の 10 項目のうち 9 つがこの形である。 */
const swatch = (color, text, dashed, tip) =>
  item(rule(color, dashed), text, tip);

/**
 * 二色を半分ずつ並べた破線の見本。都道府県道の走れない区間だけが使う。地図では
 * 走れない区分も格の色のまま描かれる(mapspec.mjs の `pref-special`)ので、
 * どちらの格でも破線になることを見本が示す。色は `border-top-color` ではなく
 * `color` で渡す。半分ずつに割ると 1 本が 10px になり、
 * `border-top-style: dashed` が刻みを 1 本に丸めて実線に見える。破線は
 * style.css の repeating-linear-gradient が `currentcolor` で描く。
 */
const duoRule = (major, general) =>
  '<span class="swatch duo">' +
  `<span style="color:${major}"></span>` +
  `<span style="color:${general}"></span>` +
  '</span>';

/**
 * 行の頭に置く、その行がどの系統の話かを示す語。`単独指定`・`二重用` は国道の
 * 重用の深さ、`主要地方道`・`一般都道府県道` は都道府県道の格で、色の意味が
 * 行ごとに違う。頭の語が無いと二つの行が一つの尺度に見える。
 */
const lead = (text) => `<span class="lead">${text}</span>`;

export const legendNHTML = () =>
  lead('国道') + N_COLORS.map((c, i) => swatch(c, N_LABELS[i], false)).join('');

/**
 * 走れない都道府県道をひとまとめにした項目の、名前と補足。国道は区分ごとに行を
 * 持つが(`legendKindHTML`)、都道府県道は区分ごとの呼び名を持たず、地図でも
 * 区分ごとに層を分けていない(mapspec.mjs の `prefLineLayers`)ので、一つで
 * 足りる。名前の頭を「工事中・事業中」にするのは、国道側の同じ区分と同じ語で
 * 呼ぶためである。
 */
export const PREF_SPECIAL_LABEL = '工事中・事業中など';
export const PREF_SPECIAL_TIP = '工事中・事業中／未開通／徒歩道・階段／航路';

/**
 * 都道府県道の格と、走れない区間。色が表すのは格であって重用の深さではない。
 * 国道が四色を深さに使っているので、八色を配ると読めなくなる。都道府県道の
 * 重用は太さで表す(mapspec.mjs)。破線は国道の行(`legendKindHTML`)に混ぜず、緑の
 * 実線の隣に置く。
 */
export const legendPrefHTML = () =>
  lead('都道府県道') +
  swatch(PREF_MAJOR, PREF_RANK_LABELS.major, false) +
  swatch(PREF_GENERAL, PREF_RANK_LABELS.general, false) +
  item(duoRule(PREF_MAJOR, PREF_GENERAL), PREF_SPECIAL_LABEL, PREF_SPECIAL_TIP);

export const legendKindHTML = () =>
  [
    [COLOR_FOOT, '点線国道', '徒歩道・階段'],
    [COLOR_CONSTRUCTION, '工事中・事業中', null],
    [COLOR_UNOPENED, '未開通区間', '計画・未着工'],
    [COLOR_FERRY, '海上国道', '航路'],
  ]
    .map(([c, t, tip]) => swatch(c, t, true, tip))
    .join('');

/* ---------------------------------------------- 都道府県道の重用の考え方 --- */
/**
 * 重用について、「国道マップについて」が出す三つ。都道府県道の重用は国道の
 * 重用と同じ確かさで出ているわけではなく、数だけ並べると、出ている数がその
 * 路線の重用のすべてだと読まれる。
 *
 * 置き場所は詳細パネルではなくダイアログである。パネルは 1 路線の数を
 * 出す場所で、データの但し書きは既にここに集まっている(freshnessHTML)。凡例は
 * 色の意味を示す場所なので置かない(#101)。数は #99 の検証の実測で、
 * docs/results.md「重用の復元」が持つ。
 *
 * 「復元率」という語は出さない。見に来た人が OSM の仕組みを知っている前提を
 * 置けない。59.8% / 40.8% も出さない。あれは「候補 way のうち
 * ルートリレーションが抱える本数の割合」であって復元率ではなく、画面に置けば
 * 延長の割合として読まれる。
 */
export const PREF_CONCURRENCY_NOTES = [
  {
    head: '表示されている重用部分は一部です',
    body:
      '道路統計年報に記載の重用延長 11,562.9 km に対し、国道マップで表示して' +
      'いるのは 9,187.5 km（79.5%）です。',
  },
  {
    head: '国道との重用区間の典拠',
    body: 'OSM のルートリレーションを典拠としています。',
  },
  {
    head: '国道との重複は重用数に含めていません',
    body:
      '「2 重用」は都道府県道どうしの本数です。国道と重なる区間でも、' +
      '都道府県道が 1 本なら「単独指定」と表示します。',
  },
];

/**
 * 上の三つをダイアログに組む。見出しは index.html の <h3> が持つ。項目は
 * `<details>` で畳み、開閉の状態は残さない。凡例の開閉(#115)は localStorage に
 * 残すが、あちらは地図の上の帯の見え方である。この三つはダイアログを
 * 開いたときだけ現れる但し書きで、操作面の他の `.fold` と同じく状態を
 * 持たせない。
 */
export const prefConcurrencyHTML = () =>
  PREF_CONCURRENCY_NOTES.map(
    (n) =>
      `<details class="fold"><summary>${esc(n.head)}</summary>` +
      `<span>${esc(n.body)}</span></details>`,
  ).join('');

/* ------------------------------------------------------------ データ基準 --- */
const utc = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
  `${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:` +
  `${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

/**
 * いつ時点の OpenStreetMap を出しているか。日付は二つあり、取り違えやすい。
 * `osm_timestamp` は OSM のデータベースを読んだ時刻で、way ごとの編集日は
 * 投稿者が最後に触った日である。新しいバイパスが入っているかを決めるのは
 * 後者である。`now` を引数にして、「どれだけ古いか」の入力を一つにする。
 *
 * 古さの警告は出さない。更新の間隔を約束していない以上、その警告は
 * 点きっぱなしになり、情報ではなく背景になる。間隔は不定期だと示し、判断は
 * 読む人に委ねる。
 */
export function freshnessHTML(meta, now = Date.now()) {
  const base = new Date(meta.osm_timestamp);
  const ageDays = Math.floor((now - base.getTime()) / 86400000);
  const ageText =
    ageDays <= 0 ? '当日' : ageDays === 1 ? '1 日前' : `${ageDays} 日前`;
  return (
    '<dt>データ基準</dt>' +
    `<dd>${utc(base)}（${ageText}）</dd>` +
    '<dt>更新の間隔</dt>' +
    '<dd>不定期</dd>' +
    '<dt>区間の更新</dt>' +
    `<dd>${esc(meta.oldest_edit)} 〜 ${esc(meta.newest_edit)}</dd>` +
    '<dt>OSM 取得元</dt>' +
    `<dd>${esc(meta.endpoints.join(' / '))}</dd>`
  );
}
