/* Everything the sidebar shows, as functions of the data.
 *
 * The panel has no numbers of its own. The viewer never holds the arcs, so
 * every total, every list and every count is read out of national.meta.json —
 * see aggregate.mjs for the two sums underneath. What is left is turning those
 * answers into markup, which is a plain function of them and belongs where it
 * can be checked.
 *
 * app.js keeps the part that cannot be: which element each string goes into,
 * and when.
 */
import { esc } from './html.mjs';
import {
  COLOR_CONSTRUCTION,
  COLOR_FERRY,
  COLOR_FOOT,
  COLOR_UNOPENED,
  N_COLORS,
  N_LABELS,
} from './mapspec.mjs';
import { shieldRow } from './shield.mjs';

/* How many rows the folded lists show. Both are ordered by the build, so a
 * prefix is the top of the ranking rather than an arbitrary sample. */
export const RANKING_ROWS = 25;
export const SHARED_ROWS = 20;

/** 7 日を超えたら、最近の開通が入っていない可能性を述べる。 */
export const STALE_DAYS = 7;

/* ------------------------------------------------------------------ 路線 --- */
/** The checkbox list of every route the data contains. */
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
/** The footer's four numbers. An empty selection means everything. */
export const statsHTML = (selectedCount, totalRoutes, { arcs, km, conc }) =>
  `<dt>選択路線</dt><dd>${selectedCount || totalRoutes} / ${totalRoutes}</dd>` +
  `<dt>対象アーク</dt><dd>${arcs.toLocaleString()}</dd>` +
  `<dt>延長</dt><dd>${km.toLocaleString(undefined, { maximumFractionDigits: 0 })} km</dd>` +
  `<dt>重用アーク</dt><dd>${conc.toLocaleString()}</dd>`;

/**
 * What the clear button says.
 *
 * It states how much it would undo, so nothing else has to state how much is
 * selected. A line under the list saying "1 路線を選択中。" was a second answer
 * to a question this button and the count above both answer already.
 */
export const clearLabel = (selectedCount) =>
  selectedCount ? `${selectedCount} 路線を選択解除` : '選択解除';

/* -------------------------------------------------------------- 重用一覧 --- */
/**
 * The concurrent sections a selection is asking about.
 *
 * Concurrency is a property of the road, so `n >= 2` is asked of the arc and
 * not of the selection; the selection only narrows which of those sections are
 * listed. An empty selection lists them all.
 */
export const concurrencies = (combos, selected) =>
  combos.filter(
    (e) => e.n >= 2 && (!selected.size || e.refs.some((r) => selected.has(r))),
  );

/** "25 / 1,237 組" on the folded tab, or nothing when there is nothing. */
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
          const label = `${routeLabel(t.refs)}が起終点を共有する地点を地図で表示`;
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
 * よい。`toggles` と `concLabel` はラベル文字列を own しない — index.html の
 * チェックボックス・ラジオボタンの表示文言をそのまま渡してもらう形にして
 * ある。ここで文言を書き直すと、表示側を直したときにこちらが黙って古くなる。
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
 * The one-line title + URL an SNS share sheet expects, e.g.
 * "国道マップ - 292号\nhttps://…". `url` is a parameter rather than read from
 * `location` here, keeping this a pure function of state like the rest of the
 * panel.
 */
export const shareText = (url, { selectedRefs }) =>
  `国道マップ${selectedRefs.length ? ` - ${selectedRefs.join('・')}号` : ''}\n${url}`;

/* ------------------------------------------------------------------ 凡例 --- */
/**
 * `tip` は補足であって名前の一部ではないので、表示上はカッコ書きにせず
 * `title` 属性へ渡す — ホバーで読めれば足り、常に文字として並べておく理由が
 * ない。`title` を持つ項目だけカーソルを help にし、補足があることを示す。
 */
const swatch = (color, text, dashed, tip) =>
  `<span class="item"${tip ? ` title="${esc(tip)}"` : ''}>` +
  `<span class="swatch" style="border-top-color:${color}` +
  `${dashed ? ';border-top-style:dashed' : ''}"></span>${text}</span>`;

export const legendNHTML = () =>
  N_COLORS.map((c, i) => swatch(c, N_LABELS[i], false)).join('');

export const legendKindHTML = () =>
  [
    [COLOR_FOOT, '点線国道', '徒歩道・階段'],
    [COLOR_CONSTRUCTION, '工事中・事業中', null],
    [COLOR_UNOPENED, '未開通区間', '計画・未着工'],
    [COLOR_FERRY, '海上国道', '航路'],
  ]
    .map(([c, t, tip]) => swatch(c, t, true, tip))
    .join('');

/* ------------------------------------------------------------ データ基準 --- */
const utc = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
  `${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:` +
  `${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

/**
 * State plainly which day of OpenStreetMap this map shows.
 *
 * Two different dates matter and are easy to confuse. `osm_timestamp` is the
 * moment the OSM database was read, which is how current we are. The per-way
 * edit dates are when each road was last touched by a mapper, which is what
 * actually determines whether a new bypass is here yet.
 *
 * `now` is a parameter so that "how old is this" has one input rather than a
 * hidden one.
 */
export function freshnessHTML(meta, now = Date.now()) {
  const base = new Date(meta.osm_timestamp);
  const ageDays = Math.floor((now - base.getTime()) / 86400000);
  const ageText =
    ageDays <= 0 ? '当日' : ageDays === 1 ? '1 日前' : `${ageDays} 日前`;
  const stale = ageDays > STALE_DAYS;

  return (
    '<dt>データ基準</dt>' +
    `<dd class="${stale ? 'warn' : ''}">${utc(base)}（${ageText}）</dd>` +
    '<dt>区間の更新</dt>' +
    `<dd>${esc(meta.oldest_edit)} 〜 ${esc(meta.newest_edit)}</dd>` +
    '<dt>OSM 取得元</dt>' +
    `<dd>${esc(meta.endpoints.join(' / '))}</dd>` +
    (stale
      ? '<dt></dt><dd class="warn">最近の開通は反映されていない可能性があります</dd>'
      : '')
  );
}
