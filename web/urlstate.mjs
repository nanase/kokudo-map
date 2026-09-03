/* 絞り込みと表示状態を URL のクエリ文字列に載せる。地図の位置・角度は MapLibre
 * がハッシュ(#zoom/lat/lng/...)に書くので、衝突しないようクエリ文字列(?...)
 * 側だけを扱う。既定値と同じ項目は URL に出さない。典型的な共有(「この
 * 1 路線だけ見せたい」)では他の項目はほぼ既定値なので URL は短く保たれる。
 * 選択が多いときは encodeRoutes の範囲表記が効く。
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

// このモジュールが読み書きするクエリのキー。`?region=` は別の役目(app.js の
// 初期表示)なので入れない。クエリ文字列を書き直す同期が、他のキーに触らずに
// 済む。
export const MANAGED_KEYS = ['routes', 'proutes', 'conc', ...TOGGLE_KEYS];

/**
 * 路線番号の集合を範囲表記へまとめる。[1,2,3,5,7,8,9] -> "1-3,5,7-9"。
 * 近い番号がまとまって選ばれやすい(連番チェック、隣接県)ので、羅列より
 * 短くなることが多い。
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
 * 一つの範囲が展開してよい番号の数。この地図の番号は国道が 507 まで、
 * 都道府県道が 1199 まで(pipeline/build_prefectural.py の `MAX_REF`)で、桁の
 * 違う範囲は壊れた項目である。ここで止めないと `?routes=1-999999999` が数億回の
 * ループと配列になり、開いた側の画面が地図の出る前に止まる。実在の確認は app.js
 * の役目だが、その前に展開が終わる必要がある。
 */
const MAX_SPAN = 2000;

/**
 * encodeRoutes の逆。壊れた項目(数字でない、範囲が逆順、広すぎる範囲)は
 * 読み飛ばす。手で書き換えられた URL でも、有効な項目だけは復元する。
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
 * 都道府県道の選択をキーの文字列へ畳む。['nagano-63','nagano-64','tokyo-18'] ->
 * 'nagano:63-64;tokyo:18'
 *
 * 国道とは別のキー(`proutes`)に置く。`routes` の形を変えると、いま
 * 共有されているリンクが開けなくなる。県ごとにまとめてから県の中を encodeRoutes
 * に渡す。番号は県の中でしか一意でないので、畳む単位も県までである。県の並びは
 * スラグの昇順にし、同じ選択からは同じ URL が出るようにする。県のスラグは
 * `?region=` と同じ語彙で、`nagano:63` は読んで意味が分かる。
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
 * encodePrefRoutes の逆。壊れた項目は読み飛ばす(decodeRoutes と同じ)。県の
 * 名前は小文字の英字だけ(pipeline/regions.py)で、それ以外の形は落とす。実在する
 * 県かどうかは見ない。47 県の一覧を持つのは regions.json を読んだ側(app.js)
 * である。
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
 * 出ないので、呼び出し側が state に直接上書きしても、触れなかった項目が既定値へ
 * 戻らない。
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
