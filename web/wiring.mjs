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

import { shareSummaryHTML, shareText } from './panel.mjs';
import { comparePrefKeys, prefRefOf, prefRegionOf } from './prefroute.mjs';
import { DEFAULTS } from './urlstate.mjs';

/**
 * 二つの系統。どれも系統ごとに 1 組しかない三つを、一箇所で結んでおく。
 *
 *   `state` の鍵      その系統を地図に出すかどうか
 *   `toggle`          それを切り替えるチェックボックス(表示状態のパネル)
 *   `before`          「だけ表示」が消す前の値を控える場所
 *
 * 表を分けると、系統を足したり名前を変えたりしたときに、片方だけが古くなる。
 */
const SYSTEMS = {
  national: { toggle: '#t-national', before: 'nationalBefore' },
  pref: { toggle: '#t-pref', before: 'prefBefore' },
};

/** 系統を消し、消す前の値を控える。既に控えてあれば上書きしない。 */
function hideSystem(doc, state, key) {
  const { toggle, before } = SYSTEMS[key];
  if (state[before] === null) state[before] = state[key];
  state[key] = false;
  doc.querySelector(toggle).checked = false;
}

/** 控えた値へ戻し、控えを捨てる。`fallback` は控えが無いときの行き先である。 */
function restoreSystem(doc, state, key, fallback) {
  const { toggle, before } = SYSTEMS[key];
  state[key] = state[before] ?? fallback;
  state[before] = null;
  doc.querySelector(toggle).checked = state[key];
}

/**
 * 路線の選択を丸ごと差し替える。#route-list の各チェックボックスへ反映した
 * うえで applyFilters を呼ぶ。wireControls の「選択解除」ボタンと、
 * app.js の標識クリック(popup)の両方から呼ばれるので、ここに一箇所だけ置く。
 *
 * 選択が空に戻ったときは、「この路線だけ表示」が消した都道府県道を戻す
 * (showRouteOnly)。控えが無ければ何もしない——このボタンは「だけ表示」の解除
 * ではなく選択を空にする物なので、手で切った系統を、そのついでに点け直す理由が
 * ない。行き先を今の値にしてあるのがその「何もしない」である。
 */
export function setSelection(doc, state, refs, applyFilters) {
  state.selected = new Set(refs);
  if (!state.selected.size) restoreSystem(doc, state, 'pref', state.pref);
  for (const cb of doc.querySelectorAll('#route-list input')) {
    cb.checked = state.selected.has(Number(cb.value));
    cb.closest('label').classList.toggle('on', cb.checked);
  }
  applyFilters();
}

/**
 * 「この路線だけ表示」が、押す場所によらず同じことを意味するための約束。
 *
 * 「だけ」と名乗るボタンを押した後の地図に、選んでいない路線が残っていては
 * ならない。だから押した系統の 1 本を残し、もう一方の系統は消す。国道の
 * 459 路線も、都道府県道の 13,234 組も、選んだ 1 本の周りに網として乗った
 * ままでは、何を選んだのかが地図から読めない。
 *
 * 消す前の値を控えて、選択が空に戻ったときにそこへ戻す。ボタンが自分で消した
 * ものを自分で戻す形なので、押す前からその系統を消していた人の画面が、解除で
 * 勝手に賑やかになることはない。控えが無い——共有リンクを開いた直後がそれで
 * ある——ときは既定に戻す。
 *
 * 系統トグルは実際に動かす。地図に何が描かれるかを述べているのはあの二つで
 * あって、「だけ表示」がその裏で別の絞り込みを持つと、同じことを二箇所が
 * 答えることになる。動かした結果は URL にも `national=0` / `pref=0` として乗る。
 */
export function showRouteOnly(doc, state, ref, applyFilters) {
  hideSystem(doc, state, 'pref');
  setSelection(doc, state, [ref], applyFilters);
}

/**
 * 都道府県道を 1 本だけ地図に残す。国道は消える。もう一度呼べば元へ戻す。
 *
 * 国道側(showRouteOnly)と違い、こちらは押した状態を持つ。操作面に都道府県道の
 * 節が無い以上、選んでいることを述べる場所も、解除する口も、このボタンのほかに
 * 無いためである(#109)。国道の選択解除は操作面の #sel-none が引き受ける。
 */
export function togglePrefOnly(doc, state, key, applyFilters) {
  const on = state.prefSelected.size === 1 && state.prefSelected.has(key);
  if (on) {
    state.prefSelected = new Set();
    // このボタン自身が解除の口なので、控えが無くても既定へ戻す。共有リンクを
    // 開いた人の控えは空である——押していないのだから当然で、それでも解除が
    // 何もしないボタンであってはならない。
    restoreSystem(doc, state, 'national', DEFAULTS.national);
  } else {
    hideSystem(doc, state, 'national');
    state.prefSelected = new Set([key]);
  }
  applyFilters();
}

/** 画面が狭いと見なす幅。style.css の @media と同じ値である。 */
export const NARROW_QUERY = '(max-width: 860px)';

/** サイドパネルの一覧・絞り込み・表示トグルを state へ配線する。 */
export function wireControls(doc, state, applyFilters) {
  const $ = (sel) => doc.querySelector(sel);
  const list = $('#route-list');

  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    const ref = Number(cb.value);
    if (cb.checked) state.selected.add(ref);
    else state.selected.delete(ref);
    cb.closest('label').classList.toggle('on', cb.checked);
    applyFilters();
  });

  $('#sel-none').addEventListener('click', () => {
    setSelection(doc, state, [], applyFilters);
  });

  $('#route-filter').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    for (const el of list.querySelectorAll('label')) {
      el.classList.toggle('hidden', q !== '' && !el.dataset.ref.startsWith(q));
    }
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
      // 系統を手で切り替えたら、「だけ表示」が控えていた値は捨てる。利用者が
      // 自分で決めた後の系統を、ボタンが後から戻してよい理由が無い。
      if (SYSTEMS[key]) state[SYSTEMS[key].before] = null;
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
