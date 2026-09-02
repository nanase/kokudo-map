/* index.html の要素と state の対応づけ。app.js は地図を作って import できない
 * ので、wiring.mjs だけを happy-dom に流した実物の index.html へ配線して
 * 検査する。マークアップの複製は作らない。 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

import { detailHTML, prefDetailHTML } from '../web/detail.mjs';
import { routeListHTML } from '../web/panel.mjs';
import {
  applyRouteFilter,
  clearSelection,
  NARROW_QUERY,
  setSelection,
  syncDetailOnly,
  togglePrefOnly,
  toggleRouteOnly,
  wireControls,
} from '../web/wiring.mjs';

const indexHtml = readFileSync(
  new URL('../web/index.html', import.meta.url),
  'utf8',
);

const ROUTES = [
  { ref: 7, km: 10, arcs: 1, max_n: 1 },
  { ref: 8, km: 20, arcs: 1, max_n: 2 },
];

/**
 * app.js の boot() を模す最小限のセットアップ。buildUI() が #route-list を
 * innerHTML で丸ごと置き換えるので、ここでも routeListHTML() の出力を先に
 * 流し込んでから配線する。
 *
 * applyFilters は本物の app.js のそれではなく、配線が呼び出す先として
 * 「選択が変われば #sel-none の disabled を更新する」という一点だけを担う
 * 最小限のスタブ。地図・データ取得を必要とする本物の applyFilters は
 * この検査の対象外(範囲外)である。
 */
function setup(routes = ROUTES) {
  const window = new Window({ url: 'https://example.invalid/' });
  const document = window.document;
  document.write(indexHtml);
  document.querySelector('#rl-national-list').innerHTML = routeListHTML(routes);

  const state = {
    selected: new Set(),
    prefSelected: new Set(),
    // 県 → 番号。本物は pref/index.json を開いた物で、面を開いたときに届く。
    prefIndex: new Map([
      ['nagano', [18, 63, 180]],
      ['tokyo', [7, 18, 181]],
    ]),
    prefLabels: new Map([
      ['nagano', '長野県'],
      ['tokyo', '東京都'],
    ]),
    prefIndexFailed: false,
    listNational: true,
    listPref: true,
    picked: null,
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
  const applyCalls = [];
  const applyFilters = () => {
    applyCalls.push(new Set(state.selected));
    const clear = document.querySelector('#sel-none');
    // 本物の updateStats と同じ数え方。両系統の合計が 0 のあいだ ✕ は居ない。
    clear.hidden = state.selected.size + state.prefSelected.size === 0;
  };

  wireControls(document, state, applyFilters);
  applyRouteFilter(document, state);
  return { window, document, state, applyCalls, applyFilters };
}

describe('wireControls — 路線の選択', () => {
  test('チェックボックスを操作すると state.selected が変わる', () => {
    const { document, state } = setup();
    document.querySelector('#route-list input[value="7"]').click();
    expect(state.selected.has(7)).toBe(true);

    document.querySelector('#route-list input[value="7"]').click();
    expect(state.selected.has(7)).toBe(false);
  });

  test('選択が空のとき「選択解除」ボタンは出ない', () => {
    const { document } = setup();
    const clear = document.querySelector('#sel-none');

    document.querySelector('#route-list input[value="7"]').click();
    expect(clear.hidden).toBe(false);

    document.querySelector('#route-list input[value="7"]').click();
    expect(clear.hidden).toBe(true);
  });

  test('「選択解除」ボタンは選択を空にし、チェックボックスも外す', () => {
    const { document, state } = setup();
    const cb7 = document.querySelector('#route-list input[value="7"]');
    cb7.click();
    document.querySelector('#sel-none').click();

    expect(state.selected.size).toBe(0);
    expect(cb7.checked).toBe(false);
  });

  test('setSelection は #route-list のチェック状態を state に合わせる', () => {
    const { document, state, applyFilters } = setup();
    setSelection(document, state, [8], applyFilters);

    expect(state.selected).toEqual(new Set([8]));
    expect(document.querySelector('#route-list input[value="7"]').checked).toBe(
      false,
    );
    expect(document.querySelector('#route-list input[value="8"]').checked).toBe(
      true,
    );
  });
});

/* 「この路線だけ表示」は選択を差し替えるだけである。「だけ」を成り立たせて
 * いるのは絞り込みの側(mapspec.mjs の shownSystems)で、押した場所によらず
 * 同じ絵になる。系統トグルは触らない。 */
describe('この路線だけ表示', () => {
  const tPref = (doc) => doc.querySelector('#t-pref');
  const tNational = (doc) => doc.querySelector('#t-national');

  test('国道を 1 本残しても、系統トグルには触らない', () => {
    const { document, state, applyFilters } = setup();
    toggleRouteOnly(document, state, 8, applyFilters);

    expect(state.selected).toEqual(new Set([8]));
    expect(state.pref).toBe(true);
    expect(tPref(document).checked).toBe(true);
  });

  /* 押して 1 本にしたボタンは、同じ場所で押せば戻せる。都道府県道だけが
     解除できて国道はできない、という非対称を作らない。 */
  test('もう一度押すと国道の選択が解ける', () => {
    const { document, state, applyFilters } = setup();
    toggleRouteOnly(document, state, 8, applyFilters);
    toggleRouteOnly(document, state, 8, applyFilters);

    expect(state.selected.size).toBe(0);
    expect(document.querySelector('#route-list input[value="8"]').checked).toBe(
      false,
    );
  });

  test('別の国道を押したときは、その 1 本に入れ替わる', () => {
    const { document, state, applyFilters } = setup();
    toggleRouteOnly(document, state, 8, applyFilters);
    toggleRouteOnly(document, state, 7, applyFilters);

    expect(state.selected).toEqual(new Set([7]));
  });

  /* 一覧から 2 本選んでいるあいだは「だけ」になっていない。そこで押すのは
     解除ではなく、その 1 本へ絞ることである。 */
  test('複数選んでいるときに押すと、その 1 本へ絞る', () => {
    const { document, state, applyFilters } = setup();
    document.querySelector('#route-list input[value="7"]').click();
    document.querySelector('#route-list input[value="8"]').click();

    toggleRouteOnly(document, state, 8, applyFilters);

    expect(state.selected).toEqual(new Set([8]));
  });

  test('都道府県道を 1 本選んでも、系統トグルには触らない', () => {
    const { document, state, applyFilters } = setup();
    togglePrefOnly(state, 'nagano-63', applyFilters);

    expect(state.prefSelected).toEqual(new Set(['nagano-63']));
    expect(state.national).toBe(true);
    expect(tNational(document).checked).toBe(true);
  });

  test('もう一度押すと都道府県道の選択が解ける', () => {
    const { state, applyFilters } = setup();
    togglePrefOnly(state, 'nagano-63', applyFilters);
    togglePrefOnly(state, 'nagano-63', applyFilters);

    expect(state.prefSelected.size).toBe(0);
  });

  test('別の路線を押したときは、その 1 本に入れ替わる', () => {
    const { state, applyFilters } = setup();
    togglePrefOnly(state, 'nagano-63', applyFilters);
    togglePrefOnly(state, 'tokyo-18', applyFilters);

    expect(state.prefSelected).toEqual(new Set(['tokyo-18']));
  });

  /* 国道と同じ扱いである。2 本選んでいるあいだのボタンは「解除」ではない。 */
  test('都道府県道も、複数選んでいるときは 1 本へ絞る', () => {
    const { state, applyFilters } = setup();
    state.prefSelected = new Set(['nagano-63', 'tokyo-18']);

    togglePrefOnly(state, 'nagano-63', applyFilters);

    expect(state.prefSelected).toEqual(new Set(['nagano-63']));
  });

  /* 手で消した系統を、選択解除が点け直すことはありません。系統トグルは
     選択とは別の物です。 */
  test('選択解除は系統トグルに触らない', () => {
    const { document, state } = setup();
    state.pref = false;
    tPref(document).checked = false;

    document.querySelector('#route-list input[value="7"]').click();
    document.querySelector('#sel-none').click();

    expect(state.selected.size).toBe(0);
    expect(state.pref).toBe(false);
    expect(tPref(document).checked).toBe(false);
  });
});

/* 絞り込み欄は一つで、国道にも都道府県道にも当たる。国道は 459 行が最初から
 * DOM に居るので伏せ、都道府県道は当たった行だけをその場で組む。 */
describe('wireControls — 絞り込み', () => {
  const type = (document, window, q) => {
    const input = document.querySelector('#route-filter');
    input.value = q;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const prefRows = (document) =>
    [...document.querySelectorAll('#rl-pref-rows input')].map(
      (i) => i.dataset.pref,
    );

  test('絞り込み入力が、一致しない国道の行に hidden を付ける', () => {
    const { document, window } = setup();
    type(document, window, '8');

    const label = (ref) => document.querySelector(`label[data-ref="${ref}"]`);
    expect(label(8).classList.contains('hidden')).toBe(false);
    expect(label(7).classList.contains('hidden')).toBe(true);
  });

  test('絞り込みを空に戻すとすべて出す', () => {
    const { document, window } = setup();
    type(document, window, '8');
    type(document, window, '');

    for (const label of document.querySelectorAll('#rl-national-list label')) {
      expect(label.classList.contains('hidden')).toBe(false);
    }
  });

  /* 打つまで都道府県道は出しません。13,234 組を並べても選べません。 */
  test('打つまで都道府県道は出ない', () => {
    const { document } = setup();
    expect(prefRows(document)).toEqual([]);
    expect(document.querySelector('#rl-pref-rows').textContent).toContain(
      '番号を入力すると候補が表示されます',
    );
  });

  test('打つと同じ欄が都道府県道にも当たる', () => {
    const { document, window } = setup();
    type(document, window, '18');

    // 番号が先、同じ番号の中は県の順。前方一致なので 180・181 も残る。
    expect(prefRows(document)).toEqual([
      'nagano-18',
      'tokyo-18',
      'nagano-180',
      'tokyo-181',
    ]);
  });

  test('一致が無ければ、無いと言う', () => {
    const { document, window } = setup();
    type(document, window, '999');
    expect(prefRows(document)).toEqual([]);
    expect(document.querySelector('#rl-pref-rows').textContent).toContain(
      '一致する都道府県道はありません',
    );
  });

  /* 索引は面を開いたときに取りに行きます。開いてすぐ打った人には間に合わない
     ことがあり、空を出すと「無い」に読めます。 */
  test('索引が届く前は、待っていると言う', () => {
    const { document, window, state } = setup();
    state.prefIndex = null;
    type(document, window, '18');
    expect(prefRows(document)).toEqual([]);
    expect(document.querySelector('#rl-pref-rows').textContent).toContain(
      '読み込んでいます',
    );
  });

  /* 落ちたときに待っている表示のまま止めると、いつまでも読み込み中に見えます。 */
  test('索引が取れなかったときは、取れなかったと言う', () => {
    const { document, window, state } = setup();
    state.prefIndex = null;
    state.prefIndexFailed = true;
    type(document, window, '18');
    expect(document.querySelector('#rl-pref-rows').textContent).toContain(
      '読み込めませんでした',
    );
  });

  test('都道府県道の行を押すと state.prefSelected が変わる', () => {
    const { document, window, state } = setup();
    type(document, window, '18');

    const cb = document.querySelector('#rl-pref-rows input[value="nagano-18"]');
    cb.click();
    expect(state.prefSelected.has('nagano-18')).toBe(true);

    cb.click();
    expect(state.prefSelected.has('nagano-18')).toBe(false);
  });

  test('選んでいる都道府県道は、組み直しても印が付いたまま', () => {
    const { document, window } = setup();
    type(document, window, '18');
    document.querySelector('#rl-pref-rows input[value="nagano-18"]').click();

    type(document, window, '');
    type(document, window, '18');

    const cb = document.querySelector('#rl-pref-rows input[value="nagano-18"]');
    expect(cb.checked).toBe(true);
    expect(cb.closest('label').classList.contains('on')).toBe(true);
  });
});

/* 一覧に出す系統は三状態しかありません。どちらも外れると一覧が空になり、
 * 押した人が頼んでいないことが起きます。 */
describe('wireControls — 一覧に出す系統', () => {
  const pressed = (document, sel) =>
    document.querySelector(sel).getAttribute('aria-pressed');

  test('既定はどちらも選ばれている', () => {
    const { document, state } = setup();
    expect(state.listNational).toBe(true);
    expect(state.listPref).toBe(true);
    expect(pressed(document, '#sys-national')).toBe('true');
    expect(pressed(document, '#sys-pref')).toBe('true');
  });

  test('片方を押すと、その系統だけが一覧から消える', () => {
    const { document, state } = setup();
    document.querySelector('#sys-pref').click();

    expect(state.listPref).toBe(false);
    expect(pressed(document, '#sys-pref')).toBe('false');
    expect(document.querySelector('#rl-pref').hidden).toBe(true);
    expect(document.querySelector('#rl-national').hidden).toBe(false);
  });

  test('最後の一枚は押しても外れない', () => {
    const { document, state } = setup();
    document.querySelector('#sys-pref').click();
    document.querySelector('#sys-national').click();

    expect(state.listNational).toBe(true);
    expect(state.listPref).toBe(false);
    expect(pressed(document, '#sys-national')).toBe('true');
  });

  /* 一覧から消えた系統の選択はそのまま残ります。ここは探す先を絞る欄で
     あって、選んだものを捨てる場所ではありません。 */
  test('一覧から消しても、選択は捨てない', () => {
    const { document, window, state } = setup();
    const input = document.querySelector('#route-filter');
    input.value = '18';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.querySelector('#rl-pref-rows input[value="nagano-18"]').click();

    document.querySelector('#sys-pref').click();

    expect(state.prefSelected.has('nagano-18')).toBe(true);
  });
});

describe('wireControls — 重用区間', () => {
  test('ラジオボタンを切り替えると state.conc が変わる', () => {
    const { document, window, state } = setup();
    const all = document.querySelector('input[name=conc][value="all"]');
    all.checked = true;
    all.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(state.conc).toBe('all');
  });
});

describe('wireControls — 表示のトグル', () => {
  test('表示のトグルが state を変え、state.picked を null に戻す', () => {
    const { document, window, state } = setup();
    state.picked = 12345;

    const t = document.querySelector('#t-labels');
    t.checked = false;
    t.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(state.labels).toBe(false);
    expect(state.picked).toBeNull();
  });

  test('8 つのトグルすべてが自分のキーだけを変える', () => {
    const { document, window, state } = setup();
    const cases = [
      ['#t-national', 'national'],
      ['#t-pref', 'pref'],
      ['#t-termini', 'termini'],
      ['#t-expressway', 'expressway'],
      ['#t-special', 'special'],
      ['#t-ferry', 'ferry'],
      ['#t-former', 'former'],
    ];
    for (const [id, key] of cases) {
      const el = document.querySelector(id);
      el.checked = false;
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(state[key]).toBe(false);
    }
    // labels はどのケースでも触っていない。
    expect(state.labels).toBe(true);
  });
});

/* 「選択削除」は国道と都道府県道の両方を引き受ける。「国道を選択」を
 * 「道路を選択」と改めたのはそのためで、系統をまたいで一つある選択を、
 * 一つの ✕ が空に戻す。 */
describe('clearSelection — 両系統の選択解除', () => {
  test('国道と都道府県道の両方を空にする', () => {
    const { document, state, applyFilters } = setup();
    document.querySelector('#route-list input[value="7"]').click();
    togglePrefOnly(state, 'nagano-63', applyFilters);

    clearSelection(document, state, applyFilters);

    expect(state.selected.size).toBe(0);
    expect(state.prefSelected.size).toBe(0);
  });

  /* 詳細パネルを閉じても、地図の上の ✕ から戻せる。閉じたパネルの中にしか
   * 解除が無かったころ、県道を 1 本選んだ人は国道へ戻れなかった。 */
  test('都道府県道だけを選んでいても、✕ が解除する', () => {
    const { document, state, applyFilters } = setup();
    togglePrefOnly(state, 'nagano-63', applyFilters);

    document.querySelector('#sel-none').click();

    expect(state.prefSelected.size).toBe(0);
  });

  test('一覧のチェックも外す', () => {
    const { document, state, applyFilters } = setup();
    const cb = document.querySelector('#route-list input[value="7"]');
    cb.click();

    clearSelection(document, state, applyFilters);

    expect(cb.checked).toBe(false);
    expect(cb.closest('label').classList.contains('on')).toBe(false);
  });
});

/* 地図の上のボタンから出る面。押すまで開かないので、最初は三つとも hidden で
 * ある。開け閉ては app.js が持つので、ここが見るのは骨格だけである。 */
describe('地図の上の面', () => {
  const load = (width) => {
    const window = new Window({
      url: 'https://example.invalid/',
      width,
      height: 720,
    });
    window.document.write(indexHtml);
    return window.document;
  };

  test('三つの面はどの画面幅でも閉じて始まる', () => {
    for (const width of [1280, 375]) {
      const document = load(width);
      for (const id of [
        '#select-popover',
        '#ranking-popover',
        '#shared-popover',
      ]) {
        expect(document.querySelector(id).hidden).toBe(true);
      }
    }
  });

  /* 面は自分のボタンと同じ台の中に居る。位置合わせの計算をどこにも持たない
   * ための約束で、app.js の registerPane が台を「面の持ち物」として使う。
   * 「道路を選択」だけは例外である——次のテストが理由とあわせて見る。 */
  test('面はボタンと同じ台の中にある', () => {
    const document = load(1280);
    for (const [btn, pane] of [
      ['#ranking-btn', '#ranking-popover'],
      ['#shared-btn', '#shared-popover'],
    ]) {
      const ctrl = document.querySelector(btn).closest('.ui-ctrl');
      expect(ctrl.contains(document.querySelector(pane))).toBe(true);
    }
  });

  /* 「道路を選択」の面だけは #select-btn の台ではなく #ranking-btn の台に
   * 居る。#select-btn は選んだ本数の札(#sel-count)ぶん幅が変わり、その台を
   * 基準にすると路線を選ぶたびに面が横へズレ動く。#ranking-btn の台に札は
   * 無く幅が変わらないので、位置の基準として借りる(#128)。開け閉ては
   * 変わらず #select-btn が持つ。 */
  test('「道路を選択」の面は #ranking-btn の台を位置の基準にする', () => {
    const document = load(1280);
    const rankingCtrl = document
      .querySelector('#ranking-btn')
      .closest('.ui-ctrl');
    expect(
      rankingCtrl.contains(document.querySelector('#select-popover')),
    ).toBe(true);
  });

  /* 絞り込み欄と一覧は面の中、選択解除は面の外。選択は地図に効いており、
   * 面を開かずに戻したいことがある。 */
  test('絞り込みと一覧は面の中、選択解除は面の外にある', () => {
    const document = load(1280);
    const pane = document.querySelector('#select-popover');
    expect(pane.contains(document.querySelector('#route-filter'))).toBe(true);
    expect(pane.contains(document.querySelector('#route-list'))).toBe(true);

    const clear = document.querySelector('#sel-none');
    expect(pane.contains(clear)).toBe(false);
  });

  /* 狭い画面と見なす幅は style.css の @media と wiring.mjs の二箇所にある。
   * 片方だけ動かすと、パネルの見た目と地図がずらす向きが食い違う。 */
  test('狭い画面の幅が style.css の @media と一致する', () => {
    const css = readFileSync(
      new URL('../web/style.css', import.meta.url),
      'utf8',
    );
    expect(NARROW_QUERY).toBe('(max-width: 860px)');
    expect(css).toContain(`@media ${NARROW_QUERY}`);
  });
});

/* 選択が変わる口はパネルのボタンだけではありません。一覧のチェックからも、
 * 地図の左上の ✕ からも変わります。開いたままのパネルがそれを知らないと、
 * 解除した後もボタンだけが押されたまま残ります。
 *
 * 本物のパネル(detail.mjs)を流し込んで検査します。押した状態の名乗りを組む
 * のはあちらなので、写しを置くとその写しを検査することになります。 */
describe('syncDetailOnly — 開いているパネルの名乗り', () => {
  const only = (doc) => doc.querySelector('#detail-body .detail-only');
  const shown = (doc) => ({
    pressed: only(doc).getAttribute('aria-pressed'),
    active: only(doc).classList.contains('active'),
    label: only(doc).getAttribute('aria-label'),
  });

  const openNational = (doc, ref, selected) => {
    doc.querySelector('#detail-body').innerHTML = detailHTML({
      route: { ref, km: 20, arcs: 1, max_n: 1 },
      selected,
    });
  };
  const openPref = (doc, selected) => {
    doc.querySelector('#detail-body').innerHTML = prefDetailHTML({
      region: 'nagano',
      prefLabel: '長野県',
      ref: 63,
      selected,
    });
  };

  test('✕ で解いたら、国道のパネルも押されていない姿に戻る', () => {
    const { document, state, applyFilters } = setup();
    toggleRouteOnly(document, state, 8, applyFilters);
    openNational(document, 8, true);

    clearSelection(document, state, applyFilters);
    syncDetailOnly(document, state);

    expect(shown(document)).toEqual({
      pressed: 'false',
      active: false,
      label: '国道8号だけを表示',
    });
  });

  /* 利用者が最初に見つけた不具合はこちらです。都道府県道は解除できるのに、
     パネルの側が押された姿のまま残っていました。 */
  test('✕ で解いたら、都道府県道のパネルも戻る', () => {
    const { document, state, applyFilters } = setup();
    togglePrefOnly(state, 'nagano-63', applyFilters);
    openPref(document, true);

    clearSelection(document, state, applyFilters);
    syncDetailOnly(document, state);

    expect(shown(document)).toEqual({
      pressed: 'false',
      active: false,
      label: '長野県道63号だけを表示',
    });
  });

  test('一覧から選び直したら、押された姿になる', () => {
    const { document, state, applyFilters } = setup();
    openNational(document, 8, false);

    setSelection(document, state, [8], applyFilters);
    syncDetailOnly(document, state);

    expect(shown(document)).toEqual({
      pressed: 'true',
      active: true,
      label: '国道8号だけの表示を解除',
    });
  });

  /* 押した直後のボタンには焦点が載っています。要素ごと入れ替えると、
     キーボードで押した人はその場で居場所を失います。 */
  test('ボタンそのものは入れ替えない', () => {
    const { document, state, applyFilters } = setup();
    openNational(document, 8, false);
    const before = only(document);

    setSelection(document, state, [8], applyFilters);
    syncDetailOnly(document, state);

    expect(only(document)).toBe(before);
  });

  test('パネルが開いていなければ何もしない', () => {
    const { document, state } = setup();
    expect(() => syncDetailOnly(document, state)).not.toThrow();
  });
});
