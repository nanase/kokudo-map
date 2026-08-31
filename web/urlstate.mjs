/* 絞り込みと表示状態を URL のクエリ文字列に載せる。
 *
 * 地図の位置・角度は MapLibre 自身がハッシュ(#zoom/lat/lng/...)に書いているので、
 * ここはそれと衝突しないようクエリ文字列(?...)側だけを扱う。
 *
 * 既定値と同じ項目は URL に出さない。典型的な共有——「この 1 路線だけ見せたい」
 * ——では選択路線が少なく、他の項目はほぼ既定値のままなので、これだけで
 * URL は短く保たれる。選択が多いときは encodeRoutes の範囲表記が効く。
 */
import { prefRefOf, prefRegionOf } from './prefroute.mjs';

export const DEFAULTS = {
  conc: 'off',
  labels: true,
  termini: true,
  expressway: true,
  special: true,
  ferry: true,
  former: true,
  national: true,
  pref: true,
};

const TOGGLE_KEYS = [
  'labels',
  'termini',
  'expressway',
  'special',
  'ferry',
  'former',
  'national',
  'pref',
];

// このモジュールが読み書きするクエリの鍵。`?region=` は別の役目(app.js の
// 初期表示の指定)なので、意図してここに入れない。クエリ文字列を書き直す同期が
// 「こちらの鍵」と「他人の鍵」を見分け、後者に触らずに済む。
export const MANAGED_KEYS = ['routes', 'proutes', 'conc', ...TOGGLE_KEYS];

/**
 * 路線番号の集合を範囲表記へまとめる。[1,2,3,5,7,8,9] -> "1-3,5,7-9"
 *
 * 国道番号は洗い替えのたびに近い番号がまとまって選ばれやすい(路線一覧の連番
 * チェック、隣接県のひとまとまり、など)ので、範囲表記はでたらめな順序の羅列
 * より短くなることが多い。単発の番号でも "-" が付かないぶん損はしない。
 */
export function encodeRoutes(refs) {
  const sorted = [...refs].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  for (const n of sorted) {
    if (start === null) {
      start = prev = n;
    } else if (n === prev + 1) {
      prev = n;
    } else {
      parts.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = prev = n;
    }
  }
  if (start !== null) {
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  }
  return parts.join(',');
}

/**
 * 一つの範囲が展開してよい番号の数。
 *
 * この地図に在る番号は、国道が 507 まで、都道府県道が 1199 まで
 * (pipeline/build_prefectural.py の `MAX_REF`。それより上は市道・都市計画道路
 * である)。桁の違う範囲は、路線を指しているのではなく壊れた項目である。
 *
 * ここで止めないと、`?routes=1-999999999` の一行が数億回の同期ループと配列に
 * なり、リンクを開いた側の画面が地図の出る前に止まる。実在するかどうかを
 * 確かめるのは app.js の役目だが、確かめてもらうためにはまず展開が終わらねば
 * ならない。
 */
const MAX_SPAN = 2000;

/**
 * encodeRoutes の逆。壊れた項目(数字でない、範囲が逆順、広すぎる範囲)は読み
 * 飛ばす — 手で書き換えられた URL でも、有効な項目だけは復元したい。
 */
export function decodeRoutes(text) {
  if (!text) return [];
  const out = [];
  for (const part of text.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b - a >= MAX_SPAN) continue;
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

/**
 * 都道府県道の選択を鍵の文字列へ畳む。
 * ['nagano-63','nagano-64','tokyo-18'] -> 'nagano:63-64;tokyo:18'
 *
 * 国道の鍵とは別の鍵(`proutes`)に置く。`routes` の形は変えない——いま共有されて
 * いるリンクが開けなくなるためである。
 *
 * 県ごとにまとめてから、県の中を encodeRoutes に渡す。路線番号は県の中でしか
 * 一意でないので、県が違えば同じ番号が別の路線を指す。畳む単位も県までである。
 *
 * 県の並びはスラグの昇順にする。選んだ順に左右されない形にしておくと、同じ選択
 * からは同じ URL が出て、共有したリンクが押すたびに違う文字列になることがない。
 *
 * 県のスラグは `?region=` と同じ語彙である。`nagano:63` は読んで意味が分かり、
 * 手で書き換えることもできる。
 */
export function encodePrefRoutes(keys) {
  const byRegion = new Map();
  for (const key of keys) {
    const region = prefRegionOf(key);
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(prefRefOf(key));
  }
  return [...byRegion]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([region, refs]) => `${region}:${encodeRoutes(refs)}`)
    .join(';');
}

/**
 * encodePrefRoutes の逆。壊れた項目は読み飛ばす——decodeRoutes と同じ作法で、
 * 手で書き換えられた URL でも有効な項目だけは復元する。
 *
 * 県の名前は小文字の英字だけである(pipeline/regions.py)。それ以外の形は、県を
 * 名乗っていない何かなので落とす。実在する県かどうかはここでは見ない——47 県の
 * 一覧を持っているのは regions.json を読んだ側(app.js)であり、この関数は
 * 文字列の形だけを引き受ける。
 */
export function decodePrefRoutes(text) {
  if (!text) return [];
  const out = [];
  for (const part of text.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const region = part.slice(0, at);
    if (!/^[a-z]+$/.test(region)) continue;
    for (const ref of decodeRoutes(part.slice(at + 1))) {
      out.push(`${region}-${ref}`);
    }
  }
  return out;
}

/** state から、既定値と違う項目だけを持つクエリ文字列を作る。 */
export function encodeState(state) {
  const p = new URLSearchParams();
  if (state.selected.size) p.set('routes', encodeRoutes(state.selected));
  if (state.prefSelected.size) {
    p.set('proutes', encodePrefRoutes(state.prefSelected));
  }
  if (state.conc !== DEFAULTS.conc) p.set('conc', state.conc);
  for (const key of TOGGLE_KEYS) {
    if (state[key] !== DEFAULTS[key]) p.set(key, state[key] ? '1' : '0');
  }
  return p.toString();
}

/**
 * クエリ文字列から、既定値との差分だけを返す。書かれていない項目は結果に
 * 出ない——呼び出し側が state に直接上書きできる形で、触れなかった項目を
 * 誤って既定値へ戻すことがない。
 */
export function decodeURLState(search) {
  const p = new URLSearchParams(search);
  const out = {};

  const routes = p.get('routes');
  if (routes) out.selected = new Set(decodeRoutes(routes));

  const prefRoutes = p.get('proutes');
  if (prefRoutes) out.prefSelected = new Set(decodePrefRoutes(prefRoutes));

  if (p.get('conc') === 'all') out.conc = 'all';

  for (const key of TOGGLE_KEYS) {
    if (p.has(key)) out[key] = p.get(key) !== '0';
  }
  return out;
}
