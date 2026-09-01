/* index.html の要素と state の対応づけ。
 *
 * app.js が地図を作って boot() を呼ぶのに対し、ここは document・state・
 * 地図側の呼び出し(applyFilters)を引数で受け取るだけなので、地図を作らずに
 * import できる。test/wiring.test.mjs はこの性質を使い、happy-dom に流した
 * index.html へ直接配線して検査する。
 *
 * MapLibre のコントロールと localStorage はここに含めない——対象は
 * 「index.html の要素と state の対応」だけである。wireShare() は
 * navigator.share・navigator.clipboard を呼ぶので、happy-dom では
 * test/wiring.test.mjs の検査対象にしていない。
 */

import {
  PREF_LIST_ROWS,
  prefGroupLabel,
  prefRowsHTML,
  shareSummaryHTML,
  shareText,
} from './panel.mjs';
import {
  comparePrefKeys,
  matchPrefRoutes,
  prefRefOf,
  prefRegionOf,
} from './prefroute.mjs';

/**
 * 一覧のチェックを選択に合わせ直す。
 *
 * 国道の行は番号を、都道府県道の行は `nagano-63` の形の鍵を持つ。番号は県の
 * 中でしか一意でないので、二つは同じ欄では持てない——見分けるのは
 * `data-pref` である。
 */
export function syncRouteList(doc, state) {
  for (const cb of doc.querySelectorAll('#route-list input')) {
    const on = cb.dataset.pref
      ? state.prefSelected.has(cb.dataset.pref)
      : state.selected.has(Number(cb.value));
    cb.checked = on;
    cb.closest('label').classList.toggle('on', on);
  }
}

/**
 * 打たれた番号と、系統の絞り込みを一覧へ反映する。
 *
 * 国道は 459 行が最初から DOM に居るので、当たらない行に印を付けて伏せる。
 * 都道府県道は 13,234 組あり、並べておくことも、打つたびに 13,234 個の class を
 * 付け直すこともできないので、当たった行だけをその場で組む。
 *
 * 打っていないあいだ都道府県道は出さない。全部並べれば選ぶどころではないし、
 * 「番号を打つ」という次の一手をそこで述べたほうが早い。
 *
 * 索引がまだ届いていないことがある。面を開いた時点で取りに行くので、開いてすぐ
 * 打った人だけがここに来る——空を出すと「無い」に読めるので、待っていると言う。
 */
export function applyRouteFilter(doc, state) {
  const q = doc.querySelector('#route-filter').value.trim();

  const natGroup = doc.querySelector('#rl-national');
  let shown = 0;
  for (const el of doc.querySelectorAll('#rl-national-list label')) {
    const hit = q === '' || el.dataset.ref.startsWith(q);
    el.classList.toggle('hidden', !hit);
    if (hit) shown++;
  }
  natGroup.hidden = !state.listNational;
  doc.querySelector('#rl-national-note').hidden = shown > 0;

  const prefGroup = doc.querySelector('#rl-pref');
  const head = doc.querySelector('#rl-pref-head');
  const rows = doc.querySelector('#rl-pref-rows');
  prefGroup.hidden = !state.listPref;
  if (!state.listPref) {
    rows.innerHTML = '';
    return;
  }
  if (q === '') {
    head.textContent = '都道府県道';
    rows.innerHTML =
      '<p class="rl-note">番号を打つと、47 都道府県から探します。</p>';
    return;
  }
  if (!state.prefIndex) {
    head.textContent = '都道府県道';
    rows.innerHTML = '<p class="rl-note">読み込んでいます…</p>';
    return;
  }
  const { matches, total } = matchPrefRoutes(
    state.prefIndex,
    q,
    PREF_LIST_ROWS,
  );
  head.textContent = prefGroupLabel(matches.length, total);
  rows.innerHTML = total
    ? prefRowsHTML(
        matches.map((m) => ({
          ...m,
          prefLabel: state.prefLabels.get(m.region) ?? '',
        })),
        state.prefSelected,
      )
    : '<p class="rl-note">一致する都道府県道はありません。</p>';
}

/**
 * 一覧に出す系統を切り替える。
 *
 * 状態は三つだけである——どちらも、国道だけ、都道府県道だけ。最後の一枚は
 * 押しても外れない。外れたら一覧が空になり、押した人が頼んでいないことが
 * 起きるからである。
 *
 * ここが決めるのは一覧の中身だけで、地図には効かない。地図にどの系統を描くかは
 * 表示の面の系統トグルが持つ(app.js の shown)。
 */
function toggleListSystem(doc, state, key, applyFilters) {
  const other = key === 'listNational' ? 'listPref' : 'listNational';
  if (state[key] && !state[other]) return;
  state[key] = !state[key];
  doc
    .querySelector(key === 'listNational' ? '#sys-national' : '#sys-pref')
    .setAttribute('aria-pressed', String(state[key]));
  applyRouteFilter(doc, state);
  // 一覧から消えた系統の選択はそのまま残る。ここは探す先を絞る欄であって、
  // 選んだものを捨てる場所ではない。地図は applyFilters が描き直す。
  applyFilters();
}

/**
 * 国道の選択を丸ごと差し替える。#route-list の各チェックボックスへ反映した
 * うえで applyFilters を呼ぶ。「この路線だけ表示」と、app.js の標識クリック
 * (popup)の両方から呼ばれるので、ここに一箇所だけ置く。
 */
export function setSelection(doc, state, refs, applyFilters) {
  state.selected = new Set(refs);
  syncRouteList(doc, state);
  applyFilters();
}

/**
 * 選択をすべて空に戻す。「道路を選択」の台にある ✕ が呼ぶ。
 *
 * 二つの系統を同じに扱う。国道と都道府県道のどちらかが上位ということはなく、
 * 「道路を選択」も「選択解除」も両方のためにある——「国道を選択」を「道路を
 * 選択」と改めたのはそのためである。だからここは二つを並べて書き、片方にだけ
 * 効く条件を持たない。
 */
export function clearSelection(doc, state, applyFilters) {
  state.selected = new Set();
  state.prefSelected = new Set();
  syncRouteList(doc, state);
  applyFilters();
}

/**
 * 「この路線だけ表示」——国道を 1 本だけ選ぶ。
 *
 * 選択そのもの以外は何もしない。「だけ」を成り立たせているのは絞り込みの側で
 * ある(app.js の showsNational / showsPref)——どちらかの系統で 1 本でも選べば、
 * 地図に残るのは選んだ道路だけになる。
 *
 * 以前はここが都道府県道の系統トグルを裏で倒し、消す前の値を控えていた。同じ
 * 選択が、一覧のチェックボックスから入ったか、このボタンから入ったかで違う絵に
 * なる形だった——控えの出し入れも、`pref=0` が URL に乗るのも、そのために
 * 要っていた仕掛けである。絞り込みの側を直したので、どちらも要らない。
 */
export function showRouteOnly(doc, state, ref, applyFilters) {
  setSelection(doc, state, [ref], applyFilters);
}

/**
 * 都道府県道を 1 本だけ選ぶ。もう一度呼べば解く。
 *
 * 国道側(showRouteOnly)と違い、こちらは押した状態を持つ。都道府県道の一覧は
 * どこにも出さない(#109)ので、いま 1 本に絞っていることをこのボタン自身が
 * 述べる必要がある。解除はここでもできるが、唯一の口ではない——詳細パネルを
 * 閉じても地図の左上に残る ✕ (clearSelection)が同じことをする。
 *
 * 都道府県道の一覧は画面に無いので、この関数だけは `doc` を要らない。
 */
export function togglePrefOnly(state, key, applyFilters) {
  const on = state.prefSelected.size === 1 && state.prefSelected.has(key);
  state.prefSelected = on ? new Set() : new Set([key]);
  applyFilters();
}

/** 画面が狭いと見なす幅。style.css の @media と同じ値である。 */
export const NARROW_QUERY = '(max-width: 860px)';

/** 面の一覧・絞り込みと、表示のトグルを state へ配線する。 */
export function wireControls(doc, state, applyFilters) {
  const $ = (sel) => doc.querySelector(sel);
  const list = $('#route-list');

  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.dataset.pref) {
      if (cb.checked) state.prefSelected.add(cb.dataset.pref);
      else state.prefSelected.delete(cb.dataset.pref);
    } else {
      const ref = Number(cb.value);
      if (cb.checked) state.selected.add(ref);
      else state.selected.delete(ref);
    }
    cb.closest('label').classList.toggle('on', cb.checked);
    applyFilters();
  });

  $('#sel-none').addEventListener('click', () => {
    clearSelection(doc, state, applyFilters);
  });

  $('#route-filter').addEventListener('input', () => {
    applyRouteFilter(doc, state);
  });

  $('#sys-national').addEventListener('click', () => {
    toggleListSystem(doc, state, 'listNational', applyFilters);
  });
  $('#sys-pref').addEventListener('click', () => {
    toggleListSystem(doc, state, 'listPref', applyFilters);
  });

  for (const el of doc.querySelectorAll('input[name=conc]')) {
    el.addEventListener('change', () => {
      state.conc = doc.querySelector('input[name=conc]:checked').value;
      applyFilters();
    });
  }

  const toggle = (id, key) =>
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.checked;
      // 影の層は種別で絞っていない。押されているアークを地図から外す切り替え
      // があると、そのままでは道の無い影だけが下地図の上に残る。
      state.picked = null;
      applyFilters();
    });
  toggle('#t-national', 'national');
  toggle('#t-pref', 'pref');
  toggle('#t-labels', 'labels');
  toggle('#t-termini', 'termini');
  toggle('#t-expressway', 'expressway');
  toggle('#t-special', 'special');
  toggle('#t-ferry', 'ferry');
  toggle('#t-former', 'former');
}

/**
 * 共有ダイアログの配線。dialog.showModal() は happy-dom に無いので、
 * test/wiring.test.mjs はここを直接は検査しない——対象は #route-list 側の
 * 4 例(検査する例)であり、この関数の切り出しは app.js を import 不要にする
 * ためのものである。
 */
export function wireShare(doc, state) {
  const $ = (sel) => doc.querySelector(sel);
  const dialog = $('#share-dialog');

  // index.html が持つラベル文言をそのまま読む。ここで書き直すと、
  // 表示側を直したときにこちらが暗黙のうちに古くなる。
  const shareState = () => {
    const toggles = [
      ...doc.querySelectorAll('#display-popover .checks label'),
    ].map((label) => ({
      label: label.textContent.trim(),
      checked: label.querySelector('input').checked,
    }));
    const concLabel = doc
      .querySelector('input[name=conc]:checked')
      .closest('label')
      .textContent.trim();
    return {
      selectedRefs: [...state.selected].sort((a, b) => a - b),
      // 都道府県道は番号だけでは 47 本のどれか決まらないので、県の名前も渡す。
      // 持っているのは regions.json を読んだ state.prefLabels である。
      prefRoutes: [...state.prefSelected].sort(comparePrefKeys).map((key) => ({
        ref: prefRefOf(key),
        prefLabel: state.prefLabels.get(prefRegionOf(key)) ?? '',
      })),
      totalRoutes: state.routes.length,
      concLabel,
      toggles,
    };
  };

  let sharingText = false;
  let shareField = { mode: 'url', text: '' };

  const renderShareField = () => {
    $('#share-url').value =
      shareField.mode === 'url' ? doc.location.href : shareField.text;
  };
  const showShareUrl = () => {
    shareField = { mode: 'url', text: '' };
    renderShareField();
  };
  const showShareText = (text) => {
    shareField = { mode: 'text', text: text.replace(/\n/g, ' ') };
    renderShareField();
    const input = $('#share-url');
    input.select();
    input.addEventListener('blur', showShareUrl, { once: true });
  };
  const flashCopied = (btn) => {
    const original = btn.innerHTML;
    btn.innerHTML = CHECK_ICON;
    btn.classList.add('copied');
    btn.setAttribute('aria-label', 'コピーしました');
    btn.disabled = true;
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('copied');
      btn.removeAttribute('aria-label');
      btn.disabled = false;
    }, 1500);
  };

  $('#share-btn').addEventListener('click', () => {
    showShareUrl();
    $('#share-body').innerHTML = shareSummaryHTML(shareState());
    dialog.showModal();
    $('#share-url').select();
  });

  $('#share-copy').addEventListener('click', async () => {
    showShareUrl();
    const input = $('#share-url');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      return;
    }
    flashCopied($('#share-copy'));
  });

  $('#share-text').addEventListener('click', async () => {
    if (sharingText) return;
    sharingText = true;
    showShareUrl();
    const text = shareText(doc.location.href, shareState());
    if (navigator.share) {
      try {
        await navigator.share({ text });
      } catch (err) {
        if (err.name !== 'AbortError') showShareText(text);
      } finally {
        sharingText = false;
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showShareText(text);
      sharingText = false;
      return;
    }
    flashCopied($('#share-text'));
    sharingText = false;
  });
}

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" ' +
  'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" ' +
  'stroke-linejoin="round"/></svg>';
