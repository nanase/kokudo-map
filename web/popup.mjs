/* 押したアークが自分について述べること。
 *
 * 地図は自前の属性を持たない。ポップアップに出るものは、そのアークを描いた
 * ベクタタイルから出てくる。生の属性を読める形に直すのはその純関数なので、
 * 検査できるようにここへ置く。app.js に残るのは生きた地図が必要な部分——
 * 押された地点の当たり判定と、結果を画面に出すこと——だけである。
 */
import { esc } from './html.mjs';
import { shield } from './shield.mjs';

/** その way が何かを OSM が述べる言い方を、読む人の言い方に直したもの。 */
export const KIND_LABELS = {
  road: '車道',
  expressway: '車道（自動車専用道路）',
  construction: '工事中・事業中',
  unopened: '未開通区間（計画・未着工）',
  foot: '点線国道（徒歩道）',
  steps: '点線国道（階段）',
  ferry: '海上国道（航路）',
};

/** その指定を OSM のどのタグから読んだか。`ref タグ` は、その番号を述べる
 *  ルートリレーションが無く——所属していないか、所属先の番号を解決できないか
 *  ——way 自身の `ref` から読んだという意味である。 */
export const SRC_LABELS = {
  relation: 'ルートリレーション',
  name: '名称（国道N号）',
  tag: 'ref タグ（リレーション未登録）',
};

/**
 * 押した地点の下にあるもののうち、その押下が指しているアーク。
 *
 * 交差点・並走・立体交差では複数のアークが 1 画素の下に重なる。返る順はタイル
 * の順で、深さとは無関係である。福岡の四重用を押したとき、国道 202 号の単独
 * 指定と報告されたのがこの形だった。最も深いアークが上に描かれているもので
 * (`line-sort-key`)、地図が守ろうとしているものでもあるので、それを説明する。
 */
export function deepest(hits) {
  return hits.reduce((a, b) =>
    Number(b.properties.n) > Number(a.properties.n) ? b : a,
  ).properties;
}

/**
 * アークが持つ指定を、数の並びにする。
 *
 * ベクタタイルに配列の型は無いので、絞り込み式が検査するのと同じ、区切り文字
 * で囲んだ文字列のまま運ばれてくる。
 */
export const refsOf = (refs) =>
  String(refs ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);

const row = (dt, dd) =>
  `<div class="pop-row"><dt>${dt}</dt><dd>${dd}</dd></div>`;

/** タイルが持つ 1 本ぶんの属性から、ポップアップの中身を組む。 */
export function popupHTML(p) {
  const refs = refsOf(p.refs);

  // 見出しの標識はどれも、その路線 1 本について地図が述べること(detail.mjs)
  // を開く。六重用の道こそ、それを訊きたくなる場所である。標識は読む人の手の
  // 中にある路線の名前そのものでもある。
  //
  // 押しても選択は変わらない。「その路線だけを表示」は詳細の中のボタンが持つ
  // ——標識を押しただけで地図から他の 458 路線が消えるのは、詳細を読みたい
  // だけの人にとっては行き過ぎだった。
  const heading = refs
    .map(
      (r) =>
        `<button type="button" class="shield-btn" data-ref="${r}" ` +
        `title="国道${r}号の詳細">${shield(r)}</button>`,
    )
    .join('');

  return (
    `<div class="pop-hd">${heading}` +
    `<span class="pop-n">${refs.length > 1 ? `${refs.length} 重用` : '単独指定'}</span></div>` +
    '<dl style="margin:0;display:grid;gap:3px">' +
    row('名称', esc(p.name) || '—') +
    row('区分', esc(KIND_LABELS[p.kind] || p.kind)) +
    // 路線の延長ではなく、押した道 1 本、つまり OSM の way 1 本の長さである。
    // 「延長」と書くと、国道 4 号が 0.13 km しかないように読めた。
    row('区間長', `${Number(p.km).toFixed(2)} km`) +
    row('最終更新', esc(p.updated) || '—') +
    row('典拠', esc(SRC_LABELS[p.src] || p.src)) +
    (Number(p.former) ? row('備考', '旧道') : '') +
    row(
      'OSM',
      `<a href="https://www.openstreetmap.org/way/${esc(p.id)}" ` +
        `target="_blank" rel="noopener">way/${esc(p.id)}</a>`,
    ) +
    '</dl>'
  );
}
