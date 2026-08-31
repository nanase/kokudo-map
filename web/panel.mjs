/* サイドパネルが出すものを、データの関数として組み立てる。
 *
 * 操作面は自前の数を持たない。閲覧側はアークを手元に持たないので、合計も一覧も
 * 個数も、すべて national.meta.json から読む——その下にある二つの和は
 * aggregate.mjs にある。残るのはその答えを markup に直すことで、これも純関数
 * なので、検査できる場所に置く。
 *
 * そうできない部分——どの文字列をどの要素へ、いつ入れるか——は app.js が持つ。
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
import { shieldRow } from './shield.mjs';

/* 畳んだ一覧が出す行数。どちらもビルドが並べ替えて配るので、頭から取れば
 * 上位がそのまま出る。任意の抜き取りではない。 */
export const RANKING_ROWS = 25;
export const SHARED_ROWS = 20;

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
/** 「国道マップについて」が述べる四つの数。選択が空なら全部を意味する。 */
export const statsHTML = (selectedCount, totalRoutes, { arcs, km, conc }) =>
  `<dt>選択路線</dt><dd>${selectedCount || totalRoutes} / ${totalRoutes}</dd>` +
  `<dt>対象アーク</dt><dd>${arcs.toLocaleString()}</dd>` +
  `<dt>延長</dt><dd>${km.toLocaleString(undefined, { maximumFractionDigits: 0 })} km</dd>` +
  `<dt>重用アーク</dt><dd>${conc.toLocaleString()}</dd>`;

/**
 * 選択解除のボタンが名乗る文言。
 *
 * どれだけ取り消すかを述べるので、選択数を述べる場所が他に不要である。一覧の下に
 * 「1 路線を選択中。」と出していた行は、このボタンと上の数が既に答えている
 * 問いへの二つ目の答えだった。
 */
export const clearLabel = (selectedCount) =>
  selectedCount ? `${selectedCount} 路線を選択解除` : '選択解除';

/**
 * 畳んだ国道一覧の見出しが述べる数。
 *
 * 選択が無いときは 0 ではなく「すべて」と言う。選択が空であることは
 * 「何も出ていない」ではなく「全部出ている」を意味するので、0 と書くと
 * 地図の見え方と逆になる。共有ダイアログも同じ言い方をする。
 */
export const selectionLabel = (selectedCount, totalRoutes) =>
  selectedCount
    ? `${selectedCount} / ${totalRoutes} 路線`
    : `すべて（${totalRoutes} 路線）`;

/* -------------------------------------------------------------- 重用一覧 --- */
/* 並べる行を選ぶのは aggregate.mjs の concurrencies() である。組み合わせ表を
   選択で絞る規則はそこに一度だけ書いてある。 */

/** 畳んだ見出しに出す「25 / 1,237 組」。何も無いときは何も出さない。 */
export const countLabel = (shown, total, unit) =>
  total ? `${shown} / ${total} ${unit}` : '';

/* aria-label が無いと、行が押せることも押した結果(地図上のその範囲へ
   移動すること)もスクリーンリーダー利用者には伝わらない。この文字列が
   ボタンの内容の代わりに読み上げられるので、標識・距離・名称の情報も
   ここに畳み込む。 */
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
 * 共有ダイアログが出す、いまの表示状態の要約。
 *
 * ダイアログの中でこの状態は変更できないので、ここは読み取り専用の説明で
 * よい。`toggles` と `concLabel` はラベル文字列を自分で持たない——index.html の
 * チェックボックス・ラジオボタンの表示文言をそのまま渡してもらう形にして
 * ある。ここで文言を書き直すと、表示側を直したときにこちらが暗黙のうちに古くなる。
 */
export const shareSummaryHTML = ({
  selectedRefs,
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
  '<div class="share-row"><span class="lbl">重用区間</span>' +
  `<span>${esc(concLabel)}</span></div>` +
  '<div class="share-row"><span class="lbl">表示</span>' +
  '<ul class="share-toggles">' +
  toggles
    .map((t) => `<li class="${t.checked ? 'on' : 'off'}">${esc(t.label)}</li>`)
    .join('') +
  '</ul></div>';

/**
 * SNS の共有シートが期待する、題と URL の 1 行。例は
 * 「国道マップ - 292号\nhttps://…」である。`url` はここで `location` から読まず
 * 引数で受け取る。操作面の他と同じく、状態の純関数のままにするためである。
 */
export const shareText = (url, { selectedRefs }) =>
  `国道マップ${selectedRefs.length ? ` - ${selectedRefs.join('・')}号` : ''}\n${url}`;

/* ------------------------------------------------------------------ 凡例 --- */
/**
 * `tip` は補足であって名前の一部ではないので、表示上はカッコ書きにせず
 * `title` 属性へ渡す——ホバーで読めれば足り、常に文字として並べておく理由が
 * ない。`title` を持つ項目だけカーソルを help にし、補足があることを示す。
 */
const swatch = (color, text, dashed, tip) =>
  `<span class="item"${tip ? ` title="${esc(tip)}"` : ''}>` +
  `<span class="swatch" style="border-top-color:${color}` +
  `${dashed ? ';border-top-style:dashed' : ''}"></span>${text}</span>`;

/**
 * 行の頭に置く、その行がどの系統の話かを述べる語。
 *
 * 地図に二つの系統が載った時点で要る。`単独指定`・`二重用` は国道の重用の深さ
 * を、`主要地方道`・`一般都道府県道` は都道府県道の格を述べており、色の意味が
 * 行ごとに違う。頭の語が無いと、二つの行が一つの尺度に見える。
 */
const lead = (text) => `<span class="lead">${text}</span>`;

export const legendNHTML = () =>
  lead('国道') + N_COLORS.map((c, i) => swatch(c, N_LABELS[i], false)).join('');

/**
 * 都道府県道の格。色が述べるのは格であって重用の深さではない——国道が既に
 * 四色を深さに使っているので、同じ画面で八色を配ると、どの色が何を述べて
 * いるかが読めなくなる。都道府県道の重用は太さが述べる(mapspec.mjs)。
 */
export const legendPrefHTML = () =>
  lead('都道府県道') +
  swatch(PREF_MAJOR, PREF_RANK_LABELS.major, false) +
  swatch(PREF_GENERAL, PREF_RANK_LABELS.general, false);

export const legendKindHTML = () =>
  [
    [COLOR_FOOT, '点線国道', '徒歩道・階段'],
    [COLOR_CONSTRUCTION, '工事中・事業中', null],
    [COLOR_UNOPENED, '未開通区間', '計画・未着工'],
    [COLOR_FERRY, '海上国道', '航路'],
  ]
    .map(([c, t, tip]) => swatch(c, t, true, tip))
    .join('');

/* ---------------------------------------------- 都道府県道の重用の数え方 --- */
/**
 * 重用について、「国道マップについて」が述べる三つ。
 *
 * 都道府県道の重用は、国道の重用と同じ確かさで出ているわけではない。数だけを
 * 並べると、出ている数がその路線の重用のすべてだと読まれる。三つはその読みを
 * 止めるためにある。
 *
 * 置き場所は詳細パネルではなく、この紙である。パネルは 1 路線の数を述べる場所
 * で、数え方そのものを述べる場所ではない。データの但し書きは既にここに集まって
 * いる(freshnessHTML)。凡例の帯にも置けない——あそこは色が何を述べているかを
 * 述べる場所である(#101 の A 回)。
 *
 * 数は #99 の検証の実測で、docs/results.md「重用の復元」が持っている。ここは
 * その文言であって、計算をする場所ではない。
 *
 * 「復元率」という語は出さない。この地図を見に来た人が OSM の仕組みを知って
 * いる前提を置けないためである。二つ目は、国道と重用する区間の復元率だけを別に
 * 出せないこと——年報の重用延長が相手別に分かれていない——にも触れていたが、
 * 落とした。典拠がリレーションだけであることは述べてあり、そこから先は、語を
 * 説明するための語が要る。
 *
 * 59.8% / 40.8% も出さない。あれは「候補 way のうちルートリレーションが抱える
 * 本数の割合」であって復元率ではなく、画面に置けば延長の割合として読まれる。
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

/** 上の三つを紙に組む。見出しは index.html の <h3> が持つ。 */
export const prefConcurrencyHTML = () =>
  PREF_CONCURRENCY_NOTES.map(
    (n) =>
      `<div class="note"><b>${esc(n.head)}</b><span>${esc(n.body)}</span></div>`,
  ).join('');

/* ------------------------------------------------------------ データ基準 --- */
const utc = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
  `${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:` +
  `${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

/**
 * いつ時点の OpenStreetMap を出しているかを、そのまま述べる。
 *
 * 効いてくる日付は二つあり、取り違えやすい。`osm_timestamp` は OSM の
 * データベースを読んだ時刻で、こちらがどれだけ新しいかを述べる。way ごとの
 * 編集日は、その道を投稿者が最後に触った日で、新しいバイパスがもう入って
 * いるかを実際に決めているのはこちらである。
 *
 * `now` を引数にしてあるのは、「どれだけ古いか」の入力を隠さず一つにする
 * ためである。
 *
 * 古さの警告は出さない。更新の間隔を約束していない以上、その警告は点きっぱなし
 * になり、常に点いている警告は情報ではなく背景である。代わりに操作面は本当の
 * ことを述べ——間隔は不定期である——判断は読む人に委ねる。
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
