/* index.html の要素と state の対応づけ。
 *
 * app.js が地図を作って boot() を呼ぶのに対し、ここは document・state・
 * 地図側の呼び出し(applyFilters)を引数で受け取るだけなので、地図を作らずに
 * import できる。test/wiring.test.mjs はこの性質を使い、happy-dom に流した
 * index.html へ直接配線して検査する。
 *
 * MapLibre のコントロールと localStorage はここに含めない — 対象は
 * 「index.html の要素と state の対応」だけである。wireShare() は
 * navigator.share・navigator.clipboard を呼ぶので、happy-dom では
 * test/wiring.test.mjs の検査対象にしていない。
 */

import { shareSummaryHTML, shareText } from './panel.mjs';

/**
 * 路線の選択を丸ごと差し替える。#route-list の各チェックボックスへ反映した
 * うえで applyFilters を呼ぶ。wireControls の「選択解除」ボタンと、
 * app.js の標識クリック(popup)の両方から呼ばれるので、ここに一箇所だけ置く。
 */
export function setSelection(doc, state, refs, applyFilters) {
  state.selected = new Set(refs);
  for (const cb of doc.querySelectorAll('#route-list input')) {
    cb.checked = state.selected.has(Number(cb.value));
    cb.closest('label').classList.toggle('on', cb.checked);
  }
  applyFilters();
}

/** 画面が狭いと見なす幅。style.css の @media と同じ値である。 */
export const NARROW_QUERY = '(max-width: 860px)';

/** サイドバーの一覧・絞り込み・表示トグルを state へ配線する。 */
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

  $('#sel-none').addEventListener('click', (e) => {
    // この釦は <summary> の中に居る。押した click はそのまま summary まで
    // 上がり、既定の動作として折りたたみを開け閉てしてしまう——選択を外した
    // だけで一覧が開くのは、押した人が頼んでいないことである。
    e.preventDefault();
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
      // The shadow layer is not restricted by kind, so a toggle that takes the
      // picked arc off the map would otherwise leave its shadow lying on the
      // basemap with no road inside it.
      state.picked = null;
      applyFilters();
    });
  toggle('#t-labels', 'labels');
  toggle('#t-termini', 'termini');
  toggle('#t-expressway', 'expressway');
  toggle('#t-special', 'special');
  toggle('#t-ferry', 'ferry');
  toggle('#t-former', 'former');
}

/**
 * 共有ダイアログの配線。dialog.showModal() は happy-dom に無いので、
 * test/wiring.test.mjs はここを直接は検査しない — 対象は #route-list 側の
 * 4 例(検査する例)であり、この関数の切り出しは app.js を import 不要にする
 * ためのものである。
 */
export function wireShare(doc, state) {
  const $ = (sel) => doc.querySelector(sel);
  const dialog = $('#share-dialog');

  // index.html が持つラベル文言をそのまま読む。ここで書き直すと、
  // 表示側を直したときにこちらが黙って古くなる。
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
