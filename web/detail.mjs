/* 一つの国道について語る場所。
 *
 * ポップアップは押したアーク 1 本について述べる。路線そのもの——延長、どれだけ
 * が重用か、台帳の起終点はどこか——を述べる場所は、これまで地図のどこにも無
 * かった。ポップアップの標識を押すと開くのがこの箱である。
 *
 * panel.mjs・popup.mjs と同じ作法で、中身の組み立てはデータの純関数としてここ
 * に置く。地図が要る部分——その地点へ飛ぶこと、箱のぶん地図をずらすこと——だけ
 * が app.js に残る。
 *
 * 数はここでは数えない。すべて aggregate.mjs が national.meta.json の組み合わせ
 * 表から出したものを受け取る。同じ数を二度計算すると、片方が黙って古くなる。
 */
import { esc } from './html.mjs';
import { KIND_LABELS } from './popup.mjs';
import { shield } from './shield.mjs';

/** 路線の記事。日本語版 Wikipedia は「国道N号」で立項が揃っている。 */
export const wikipediaURL = (ref) =>
  `https://ja.wikipedia.org/wiki/${encodeURIComponent(`国道${ref}号`)}`;

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

/* 小数第 1 位まで。組み合わせ表の km がその桁で丸めてある。 */
const fmtKm = (km) =>
  km.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

const row = (dt, dd) => `<dt>${dt}</dt><dd>${dd}</dd>`;

/* 新しいタブで開くことを、文字ではなく印で述べる。 */
const EXTERNAL_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M14 4h6v6M20 4l-8.5 8.5" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"/></svg>';

const terminiHTML = (ref, termini) =>
  termini.length
    ? `<div class="detail-termini">${termini
        .map(({ label, name, at }) =>
          at
            ? `<button type="button" class="row" data-at="${at.join(',')}" ` +
              `aria-label="国道${ref}号の${label}(${esc(name)})へ移動">` +
              `<span class="lbl">${label}</span>` +
              `<span class="nm">${esc(name)}</span></button>`
            : `<div class="row"><span class="lbl">${label}</span>` +
              `<span class="nm">${esc(name)}</span></div>`,
        )
        .join('')}</div>`
    : '';

const kindsHTML = (kinds) =>
  kinds.length
    ? '<div class="detail-kinds"><div class="detail-sub">区分別</div>' +
      `<dl class="detail-stats">${kinds
        .map((k) =>
          row(esc(KIND_LABELS[k.kind] ?? k.kind), `${fmtKm(k.km)} km`),
        )
        .join('')}</dl></div>`
    : '';

/**
 * 1 路線ぶんの詳細。
 *
 * `route` は aggregate.mjs の routesOf() が返す行、`kinds` は kindsFor() が返す
 * 内訳、`termini` は decreeTerminiOf() が返す起終点である。後ろの二つは meta が
 * その欄を持って初めて埋まる(区分別は issue #58、起終点は issue #59)。どちらが
 * 先に入っても壊れないよう、欄が無ければその欄ごと出さない。
 */
export function detailHTML({ route, kinds = [], termini = [] }) {
  const { ref } = route;
  const name = `国道${ref}号`;
  return (
    `<header class="detail-hd">${shield(ref)}` +
    `<h2 id="detail-title">${name}</h2></header>` +
    '<div class="detail-scroll">' +
    `<a class="detail-wiki" href="${wikipediaURL(ref)}" target="_blank" ` +
    `rel="noopener">Wikipedia「${name}」${EXTERNAL_ICON}</a>` +
    terminiHTML(ref, termini) +
    '<dl class="detail-stats">' +
    row('延長', `${fmtKm(route.km)} km`) +
    row('アーク数', route.arcs.toLocaleString()) +
    // 重用が 1 mm も無い路線は 459 のうち珍しくない。0.0 km と書くより、
    // 重用を持たないと言うほうが短い。
    row('重用区間', route.conc_km ? `${fmtKm(route.conc_km)} km` : 'なし') +
    row('最大重用数', route.max_n > 1 ? `${route.max_n} 重用` : '単独指定') +
    '</dl>' +
    kindsHTML(kinds) +
    `<button type="button" class="mini detail-only" data-ref="${ref}">` +
    `${name}だけを表示</button>` +
    '</div>'
  );
}
