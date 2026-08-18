/* What a clicked arc says about itself.
 *
 * The map holds no attributes of its own: everything in a popup comes out of
 * the vector tile the arc was drawn from. Turning those raw properties into
 * something readable is a plain function of them, so it lives here where it
 * can be checked, and app.js is left with the part that needs a live map —
 * hit-testing the click and putting the result on screen.
 */
import { esc } from './html.mjs';
import { shield } from './shield.mjs';

/** OSM's own words for what kind of way this is, in the reader's. */
export const KIND_LABELS = {
  road: '車道',
  expressway: '車道（自動車専用道路）',
  construction: '工事中・事業中',
  unopened: '未開通区間（計画・未着工）',
  foot: '点線国道（徒歩道）',
  steps: '点線国道（階段）',
  ferry: '海上国道（航路）',
};

/** Which OSM tagging the designation was read out of. `ref タグ` means no route
 *  relation lists this road, so the number is inferred from its own tags. */
export const SRC_LABELS = {
  relation: 'ルートリレーション',
  name: '名称（国道N号）',
  tag: 'ref タグ（リレーション未登録）',
};

/**
 * The arc a click is about, out of everything under the cursor.
 *
 * A junction, a parallel alignment or a grade separation puts several arcs
 * under one pixel, and they come back in the tile's order, which is arbitrary:
 * a click on the four-fold stack in 福岡 reported 国道202号 alone. The deepest
 * one is the one drawn on top (`line-sort-key`) and the one the map exists to
 * keep, so that is the one described.
 */
export function deepest(hits) {
  return hits.reduce((a, b) =>
    Number(b.properties.n) > Number(a.properties.n) ? b : a,
  ).properties;
}

/**
 * The designations on an arc, as numbers.
 *
 * A vector tile has no array type, so they travel as the same
 * delimiter-wrapped string the filters test.
 */
export const refsOf = (refs) =>
  String(refs ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);

const row = (dt, dd) =>
  `<div class="pop-row"><dt>${dt}</dt><dd>${dd}</dd></div>`;

/** The popup body for one arc's tile properties. */
export function popupHTML(p) {
  const refs = refsOf(p.refs);

  // Each sign in the header is a way to say "only this one". A road carrying
  // six designations is exactly where that is worth asking for, and the sign is
  // already the name of the route in the reader's hand.
  const heading = refs
    .map(
      (r) =>
        `<button type="button" class="shield-btn" data-ref="${r}" ` +
        `title="国道${r}号だけを表示">${shield(r)}</button>`,
    )
    .join('');

  return (
    `<div class="pop-hd">${heading}` +
    `<span class="pop-n">${refs.length > 1 ? `${refs.length} 重用` : '単独指定'}</span></div>` +
    '<dl style="margin:0;display:grid;gap:3px">' +
    row('名称', esc(p.name) || '—') +
    row('区分', esc(KIND_LABELS[p.kind] || p.kind)) +
    // Not the route's length: the length of the one road that was clicked,
    // which is one OSM way. Labelled 延長 it read as though 国道4号 were
    // 0.13 km long.
    row('区間長', `${Number(p.km).toFixed(2)} km`) +
    row('最終更新', esc(p.updated) || '—') +
    row('典拠', esc(SRC_LABELS[p.src] || p.src)) +
    (Number(p.former) ? row('備考', '旧道（指定解除前）') : '') +
    row(
      'OSM',
      `<a href="https://www.openstreetmap.org/way/${esc(p.id)}" ` +
        `target="_blank" rel="noopener">way/${esc(p.id)}</a>`,
    ) +
    '</dl>'
  );
}
