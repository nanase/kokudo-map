/* 押したアークのポップアップ。地図は自前の属性を持たず、ポップアップに
 * 出るものはアークを描いたベクタタイルから出てくる。生の属性を読める形に
 * 直す純関数なので、検査できるようにここへ置く。app.js に残るのは押された地点の
 * 当たり判定と、結果を画面に出すことだけである。
 */
import { esc } from './html.mjs';
import { prefRefOf } from './prefroute.mjs';
import { hexShield, prefRouteName, shield } from './shield.mjs';

/** OSM の区分を、読む人の言い方に直したもの。 */
export const KIND_LABELS = {
  road: '車道',
  expressway: '車道（自動車専用道路）',
  construction: '工事中・事業中',
  unopened: '未開通区間（計画・未着工）',
  foot: '点線国道（徒歩道）',
  steps: '点線国道（階段）',
  ferry: '海上国道（航路）',
};

/**
 * 同じ区分を都道府県道について述べるときの言い方。「点線国道」「海上国道」は
 * 国道の呼び名で、都道府県道の徒歩道・階段・航路には定まった呼び名が無い
 * (mapspec.mjs の prefLineLayers)ので、区分そのものを言う。
 */
export const PREF_KIND_LABELS = {
  road: '車道',
  expressway: '車道（自動車専用道路）',
  construction: '工事中・事業中',
  unopened: '未開通区間（計画・未着工）',
  foot: '徒歩道',
  steps: '階段',
  ferry: '航路',
};

/** その指定を OSM のどのタグから読んだか。`ref タグ` は、その番号の
 * ルートリレーションに所属していないか所属先の番号を解決できず、way 自身の
 * `ref` から読んだという意味である。 */
export const SRC_LABELS = {
  relation: 'ルートリレーション',
  name: '名称（国道N号）',
  tag: 'ref タグ（リレーション未登録）',
};

/**
 * 押した地点の下にあるもののうち、その押下が指しているアーク。交差点・並走・
 * 立体交差では複数のアークが 1 画素の下に重なり、返る順はタイルの順で深さとは
 * 無関係である。福岡の四重用を押したとき、国道 202 号の単独指定と報告された。
 * 最も深いアークが上に描かれている(`line-sort-key`)ので、それを説明する。
 */
export function deepest(hits) {
  return hits.reduce((a, b) =>
    Number(b.properties.n) > Number(a.properties.n) ? b : a,
  ).properties;
}

/**
 * アークが持つ指定を数の並びにする。ベクタタイルに配列の型は無いので、
 * 区切り文字で囲んだ文字列のまま運ばれてくる。
 */
export const refsOf = (refs) =>
  String(refs ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);

/** アークが持つ都道府県道の指定をキーの並びにする。`refsOf` と同じ形の文字列で
 * 運ばれてくるが、中身は `nagano-63` のキーである。 */
export const prefRefsOf = (refs) =>
  String(refs ?? '')
    .split(',')
    .filter(Boolean);

const row = (dt, dd) =>
  `<div class="pop-row"><dt>${dt}</dt><dd>${dd}</dd></div>`;

/** 重用の深さを言う語。1 本しか指定していないアークは「単独指定」である。 */
const depthLabel = (n) => (n > 1 ? `${n} 重用` : '単独指定');

/**
 * アーク 1 本の素性を並べる欄。国道と都道府県道で同じで、違うのは区分の呼び名と
 * 最終更新を持つかどうかだけである。都道府県道のアークは `updated` を持たない
 * (pipeline/build_prefectural.py)ので、行ごと落とす。欄の有無は呼ぶ側が
 * 指定する。タイルの属性が来なかったのか、その系統が持たないのかは欠けた
 * 値からは見分けられない。
 */
const factsHTML = (p, { kindLabels, updated }) =>
  '<dl style="margin:0;display:grid;gap:3px">' +
  row('名称', esc(p.name) || '—') +
  row('区分', esc(kindLabels[p.kind] || p.kind)) +
  // 路線の延長ではなく、押した道 1 本(OSM の way 1 本)の長さである。「延長」と
  // 書くと、国道 4 号が 0.13 km しかないように読めた。
  row('区間長', `${Number(p.km).toFixed(2)} km`) +
  (updated ? row('最終更新', esc(p.updated) || '—') : '') +
  row('典拠', esc(SRC_LABELS[p.src] || p.src)) +
  (Number(p.former) ? row('備考', '旧道') : '') +
  row(
    'OSM',
    `<a href="https://www.openstreetmap.org/way/${esc(p.id)}" ` +
      `target="_blank" rel="noopener">way/${esc(p.id)}</a>`,
  ) +
  '</dl>';

/** タイルが持つ 1 本ぶんの属性から、ポップアップの中身を組む。 */
export function popupHTML(p) {
  const refs = refsOf(p.refs);

  // 見出しの標識は、その路線 1 本の詳細(detail.mjs)を開く。押しても選択は
  // 変わらない。「その路線だけを表示」は詳細の中のボタンが持つ。標識を
  // 押しただけで他の 458 路線が消えるのは、詳細を読みたいだけの人には
  // 行き過ぎだった。
  const heading = refs
    .map(
      (r) =>
        `<button type="button" class="shield-btn" data-ref="${r}" ` +
        `title="国道${r}号の詳細">${shield(r)}</button>`,
    )
    .join('');

  return (
    `<div class="pop-hd">${heading}` +
    `<span class="pop-n">${depthLabel(refs.length)}</span></div>` +
    factsHTML(p, { kindLabels: KIND_LABELS, updated: true })
  );
}

/**
 * 都道府県道のアークのポップアップ。国道と同じ形で、違うのは標識(ヘキサ)と県の
 * 名前が必要なことだけである。番号は県の中でしか一意でないので、標識の名前も
 * 詳細を開くキーも県を伴う。`prefLabel` は「長野県」のような県の名前で、
 * 呼ぶ側が regions.json から引いて渡す。
 *
 * z8 未満では出せない。低ズームのタイルは `id`・`name`・`km`・`src` を
 * 落としている(pipeline/pack_web_pref.mjs)。押せないことを伝えるのは呼ぶ側の
 * 仕事である(app.js の syncCursor)。
 */
export function prefPopupHTML(p, prefLabel) {
  const keys = prefRefsOf(p.refs);

  const heading = keys
    .map((key) => {
      const ref = prefRefOf(key);
      const name = prefRouteName(prefLabel, ref);
      return (
        `<button type="button" class="shield-btn" data-pref="${esc(key)}" ` +
        `title="${esc(name)}の詳細">${hexShield(prefLabel, ref)}</button>`
      );
    })
    .join('');

  return (
    `<div class="pop-hd">${heading}` +
    `<span class="pop-n">${depthLabel(keys.length)}</span></div>` +
    factsHTML(p, { kindLabels: PREF_KIND_LABELS, updated: false })
  );
}
