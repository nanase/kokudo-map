/* index.html の要素と state の対応づけ。document・state・applyFilters を引数で
 * 受け取るだけなので、地図を作らずに import できる。test/wiring.test.mjs は
 * happy-dom に流した index.html へ直接配線して検査する。
 *
 * MapLibre のコントロールと localStorage は含めない。wireShare() は
 * navigator.share・navigator.clipboard を呼ぶので、happy-dom では検査対象に
 * していない。
 */

import { continuationCountOf, onlyButtonHTML } from './detail.mjs';
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
 * 一覧のチェックを選択に合わせ直す。国道の行は番号を、都道府県道の行は
 * `nagano-63` の形のキーを持つ。見分けるのは `data-pref` である。
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
 * 打たれた番号と、系統の絞り込みを一覧へ反映する。国道は 459 行が最初から DOM
 * にあるので、当たらない行を伏せる。都道府県道は 13,234 組あり、
 * 並べておくことも打つたびに class を付け直すこともできないので、当たった
 * 行だけをその場で組む。打っていないあいだ都道府県道は出さず、「番号を打つ」
 * という次の一手を示す。
 *
 * 索引がまだ届いていないことがある(開いてすぐ打った人)。空を出すと「無い」に
 * 読めるので、待っていると言う。落ちたときは落ちたと言う。待っている表示のまま
 * 止めると、いつまでも読み込み中に見える。
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
      '<p class="rl-note">番号を入力すると候補が表示されます</p>';
    return;
  }
  if (!state.prefIndex) {
    head.textContent = '都道府県道';
    rows.innerHTML = state.prefIndexFailed
      ? '<p class="rl-note">都道府県道の一覧を読み込めませんでした。' +
        '面を開き直すと取り直します。</p>'
      : '<p class="rl-note">読み込んでいます…</p>';
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
 * 開いている詳細パネルの「この路線だけ表示」を、いまの選択に合わせ直す。選択が
 * 変わる経路はボタンだけではなく(一覧のチェック、地図の左上の ✕)、どこから
 * 変わっても applyFilters が描き直すので、ボタンのラベルもそこで直す(app.js)。
 * ここを通さないと、✕ で選択を解いた後もパネルのボタンだけが押されたまま残る。
 *
 * パネルの中身は組み直さない。読んでいた位置が先頭に戻り、都道府県道なら県別
 * meta を取りに行く経路にも戻る。ボタンも置き換えず属性だけを移す。押した直後の
 * ボタンには焦点が載っていて、要素ごと入れ替えると焦点が body へ落ち、
 * キーボードで押した人が居場所を失う。
 *
 * ラベルを組むのは detail.mjs である(onlyButtonHTML)。同じ文言をここでも組むと
 * 片方が暗黙のうちに古くなる。
 */
export function syncDetailOnly(doc, state) {
  // パネルには漏斗が二つ在ることがある。見出しの「この 1 本だけ」と、県境で
  // 続く路線の節の「まとめて」である(#155)。どちらかだけを合わせると、
  // 見出しの漏斗で 1 本に絞った後も節が押されたまま残る。
  for (const btn of doc.querySelectorAll('#detail-body .detail-only')) {
    const { selected, html } = onlyStateOf(btn, state);
    const box = doc.createElement('div');
    box.innerHTML = html;
    // 出す属性は onlyButtonHTML が毎回すべて書くので、移すだけで足りる。
    for (const { name, value } of box.firstElementChild.attributes) {
      btn.setAttribute(name, value);
    }
    // 節の漏斗は面も一緒に染める。漏斗は 15px しかなく、地図の上でパネルは
    // 0.62 倍に見えるので、そこでは 9px になる。
    btn.closest('.detail-cont')?.classList.toggle('on', selected);
  }
}

/** その漏斗が名指している物と、いまの選択から見た押した状態。 */
function onlyStateOf(btn, state) {
  const labelOf = (key) => state.prefLabels.get(prefRegionOf(key)) ?? '';
  const group = btn.dataset.prefs;
  if (group) {
    const keys = group.split(',');
    const selected = isOnlyGroup(state.prefSelected, state.selected, keys);
    return {
      selected,
      html: onlyButtonHTML({
        prefKeys: keys,
        // 数え方を組むのは detail.mjs の continuationCountOf 一箇所である。
        count: continuationCountOf(keys.map(labelOf)),
        selected,
      }),
    };
  }
  const key = btn.dataset.pref;
  if (key) {
    const selected = isOnly(state.prefSelected, state.selected, key);
    return {
      selected,
      html: onlyButtonHTML({ prefKey: key, prefLabel: labelOf(key), selected }),
    };
  }
  const ref = Number(btn.dataset.ref);
  const selected = isOnly(state.selected, state.prefSelected, ref);
  return { selected, html: onlyButtonHTML({ ref, selected }) };
}

/** 一覧に出す系統のボタンと、それが持つ state のキー。 */
const SYS_BUTTONS = [
  ['listNational', '#sys-national'],
  ['listPref', '#sys-pref'],
];

/**
 * 二枚のボタンへ、いまの状態を書き戻す。
 *
 * 出ているかどうか(aria-pressed)だけでなく、押しても外れないかどうか
 * (aria-disabled)も述べる。最後の一枚は押せる物に見えてはならず、それは
 * style.css の錠が目に、aria-disabled が読み上げに伝える。押した側だけを
 * 書き換えるのでは足りない——外れない一枚に変わるのは、押されなかった方だから
 * である。
 */
function syncListSystems(doc, state) {
  // 片方だけが出ている状態。そのとき出ている一枚が、外れない一枚になる。
  const alone = state.listNational !== state.listPref;
  for (const [key, sel] of SYS_BUTTONS) {
    const btn = doc.querySelector(sel);
    btn.setAttribute('aria-pressed', String(state[key]));
    btn.setAttribute('aria-disabled', String(state[key] && alone));
  }
}

/**
 * 一覧に出す系統を切り替える。状態は三つだけ(どちらも、国道だけ、
 * 都道府県道だけ)で、最後の一枚は押しても外れない。外れたら一覧が空になる。
 * ここが決めるのは一覧の中身だけで、地図にどの系統を描くかは表示の
 * ポップオーバーの系統トグルが持つ(app.js の shown)。
 */
function toggleListSystem(doc, state, key, applyFilters) {
  const other = key === 'listNational' ? 'listPref' : 'listNational';
  if (state[key] && !state[other]) return;
  state[key] = !state[key];
  syncListSystems(doc, state);
  applyRouteFilter(doc, state);
  // 一覧から消えた系統の選択はそのまま残る。ここは探す先を絞る欄で、
  // 選んだものを捨てる場所ではない。
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
 * 選択をすべて空に戻す。「道路を選択」のグループにある ✕ が呼ぶ。二つの系統を
 * 同じに扱い、片方にだけ効く条件を持たない。
 */
export function clearSelection(doc, state, applyFilters) {
  state.selected = new Set();
  state.prefSelected = new Set();
  syncRouteList(doc, state);
  applyFilters();
}

/**
 * いまこの群だけに絞っているか。詳細パネルの漏斗が押された状態かどうかの答え
 * である。一覧から余分に選んでいるあいだは押されていない(そこで押せば
 * 「だけ」になり、解除にはならない)。詳細パネルの描画(app.js)と下の三つの
 * トグルが同じ関数に聞く。
 *
 * 両系統ぶん数える。国道 63 号と長野県道 63 号を選んでいる画面は 2 本を
 * 描いており、そこで国道のボタンが「解除」と名乗ってはならない。
 *
 * 群を表示している間に見出しの漏斗を押せば、その 1 本に絞れる(#155)。狭いほうが
 * 後から勝ち、そのとき群の側は自動的に「押していない」に戻る。二つの状態を
 * `state.prefSelected` 一つが持ち、ここはそこに群が全部入っているかを見るだけ
 * だからである。
 *
 * 空の群では答えない。何も選んでいない画面が「その空の群だけを表示している」に
 * なってしまう。
 */
export const isOnlyGroup = (selected, other, keys) =>
  keys.length > 0 &&
  other.size === 0 &&
  selected.size === keys.length &&
  keys.every((k) => selected.has(k));

/**
 * いまこの 1 本だけに絞っているか。上の群の判定に 1 本だけを渡した形である。
 * 「だけ」の意味を一箇所に置くために、同じ関数から出す。
 */
export const isOnly = (selected, other, key) =>
  isOnlyGroup(selected, other, [key]);

/**
 * 「この路線だけ表示」。その 1 本だけを選び、もう一度呼べば解く。「だけ」は
 * 文字どおりで、もう一方の系統に残っていた選択も一緒に空になる。片方だけを
 * 入れ替えると、「国道63号だけを表示」を押した画面に長野県道63号が残る。
 *
 * 「だけ」の絵を作るのは絞り込みの側である(mapspec.mjs の shownSystems)。ここは
 * 選択だけを渡し、系統トグルには触らない。以前はここが都道府県道の系統トグルを
 * 裏で倒して消す前の値を控えており、同じ選択が入り口によって
 * 違う絵になっていた。
 *
 * 解けるのは都道府県道側(togglePrefOnly)と揃えるためである。
 */
export function toggleRouteOnly(doc, state, ref, applyFilters) {
  if (isOnly(state.selected, state.prefSelected, ref)) {
    clearSelection(doc, state, applyFilters);
    return;
  }
  state.prefSelected = new Set();
  setSelection(doc, state, [ref], applyFilters);
}

/**
 * 都道府県道を 1 本だけ選ぶ。もう一度呼べば解く。国道側と同じ約束である。解除は
 * 地図の左上の ✕(clearSelection)でもできる。`doc` を受けるのは、国道の選択を
 * 空にするぶん一覧のチェックも外すためである。
 */
export function togglePrefOnly(doc, state, key, applyFilters) {
  togglePrefGroup(doc, state, [key], applyFilters);
}

/**
 * 県境で続く路線の群をまとめて選ぶ。もう一度呼べば解く(#155)。
 *
 * 中身は `togglePrefOnly` と同じで、鍵が 1 本か群かの違いしかない。だから
 * 選択を入れ替える側は 1 つにして、名前だけを二つ残した。呼ぶ側が「1 本」と
 * 「群」を取り違えないためである。選択そのものは `state.prefSelected` が持ち、
 * URL の `proutes` も初めから複数を運ぶので、新しい状態は要らない。
 */
export function togglePrefGroup(doc, state, keys, applyFilters) {
  if (isOnlyGroup(state.prefSelected, state.selected, keys)) {
    clearSelection(doc, state, applyFilters);
    return;
  }
  state.prefSelected = new Set(keys);
  setSelection(doc, state, [], applyFilters);
}

/** 画面が狭いと見なす幅。style.css の @media と同じ値である。 */
export const NARROW_QUERY = '(max-width: 860px)';

/** ポップオーバーの一覧・絞り込みと、表示のトグルを state へ配線する。 */
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

  for (const [key, sel] of SYS_BUTTONS) {
    $(sel).addEventListener('click', () => {
      toggleListSystem(doc, state, key, applyFilters);
    });
  }

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
 * test/wiring.test.mjs はここを検査しない。切り出したのは app.js を import
 * せずに済ませるためである。
 */
export function wireShare(doc, state) {
  const $ = (sel) => doc.querySelector(sel);
  const dialog = $('#share-dialog');

  // index.html が持つラベル文言をそのまま読む。ここで書き直すと、表示側を
  // 直したときにこちらが暗黙のうちに古くなる。
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
