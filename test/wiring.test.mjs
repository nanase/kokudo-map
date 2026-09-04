/* index.html の要素と state の対応づけ。app.js は地図を作って import できない
 * ので、wiring.mjs だけを happy-dom に流した実物の index.html へ配線して
 * 検査する。マークアップの複製は作らない。 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

import { detailHTML, prefDetailHTML } from '../web/detail.mjs';
import { routeListHTML } from '../web/panel.mjs';
import { decodeURLState, encodeState } from '../web/urlstate.mjs';
import {
  applyRouteFilter,
  clearSelection,
  isOnly,
  isOnlyGroup,
  NARROW_QUERY,
  setSelection,
  syncDetailOnly,
  togglePrefGroup,
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
 * innerHTML で置き換えるので、routeListHTML() の出力を先に流し込んでから
 * 配線する。applyFilters は本物ではなく、「選択が変われば #sel-none の hidden
 * を更新する」だけのスタブである。
 */
function setup(routes = ROUTES) {
  const window = new Window({ url: 'https://example.invalid/' });
  const document = window.document;
  document.write(indexHtml);
  document.querySelector('#rl-national-list').innerHTML = routeListHTML(routes);

  const state = {
    selected: new Set(),
    prefSelected: new Set(),
    // 県 → 番号。本物は pref/index.json を開いた物で、ポップオーバーを
    // 開いたときに届く。
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
    prefPicked: null,
    conc: 'off',
    labels: true,
    termini: true,
    expressway: true,
    special: true,
    ferry: true,
    former: true,
    national: true,
    pref: true,
    prefSpecial: true,
  };
  const applyCalls = [];
  const applyFilters = () => {
    applyCalls.push(new Set(state.selected));
    const clear = document.querySelector('#sel-none');
    // 本物の updateStats と同じ数え方。両系統の合計が 0 のあいだ ✕ は出ない。
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
    togglePrefOnly(document, state, 'nagano-63', applyFilters);

    expect(state.prefSelected).toEqual(new Set(['nagano-63']));
    expect(state.national).toBe(true);
    expect(tNational(document).checked).toBe(true);
  });

  test('もう一度押すと都道府県道の選択が解ける', () => {
    const { document, state, applyFilters } = setup();
    togglePrefOnly(document, state, 'nagano-63', applyFilters);
    togglePrefOnly(document, state, 'nagano-63', applyFilters);

    expect(state.prefSelected.size).toBe(0);
  });

  test('別の路線を押したときは、その 1 本に入れ替わる', () => {
    const { document, state, applyFilters } = setup();
    togglePrefOnly(document, state, 'nagano-63', applyFilters);
    togglePrefOnly(document, state, 'tokyo-18', applyFilters);

    expect(state.prefSelected).toEqual(new Set(['tokyo-18']));
  });

  /* 国道と同じ扱いである。2 本選んでいるあいだのボタンは「解除」ではない。 */
  test('都道府県道も、複数選んでいるときは 1 本へ絞る', () => {
    const { document, state, applyFilters } = setup();
    state.prefSelected = new Set(['nagano-63', 'tokyo-18']);

    togglePrefOnly(document, state, 'nagano-63', applyFilters);

    expect(state.prefSelected).toEqual(new Set(['nagano-63']));
  });

  /* 「だけ」は系統をまたいで文字どおりの意味である。国道63号と長野県道63号を
   * 選んでいる画面は 2 本を描いているので、そこでボタンは「解除」ではなく、
   * 押せばもう一方の系統の選択も空になる。 */
  test('もう一方の系統に残っていた選択も空にする', () => {
    const { document, state, applyFilters } = setup();
    document.querySelector('#route-list input[value="7"]').click();
    state.prefSelected = new Set(['nagano-63']);

    toggleRouteOnly(document, state, 7, applyFilters);

    expect(state.selected).toEqual(new Set([7]));
    expect(state.prefSelected.size).toBe(0);
  });

  test('都道府県道の側も、国道の選択を空にして一覧のチェックを外す', () => {
    const { document, state, applyFilters } = setup();
    const cb = document.querySelector('#route-list input[value="7"]');
    cb.click();

    togglePrefOnly(document, state, 'nagano-63', applyFilters);

    expect(state.prefSelected).toEqual(new Set(['nagano-63']));
    expect(state.selected.size).toBe(0);
    expect(cb.checked).toBe(false);
  });

  /* 二つの系統に 1 本ずつ選んでいるあいだは「だけ」になっていない。ここで
   * ボタンが「解除」と名乗ると、押した人は国道が丸ごと消える画面を受け取る
   * (mapspec.mjs の shownSystems)。 */
  test('他系統に選択が残っていれば、押されていない扱いにする', () => {
    const { state } = setup();
    state.selected = new Set([63]);
    state.prefSelected = new Set(['nagano-63']);

    expect(isOnly(state.selected, state.prefSelected, 63)).toBe(false);
    expect(isOnly(state.prefSelected, state.selected, 'nagano-63')).toBe(false);
  });

  /* 手で消した系統を、選択解除が点け直すことはない。系統トグルは選択とは別の
   * 物である。 */
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

  /* 打つまで都道府県道は出さない。13,234 組を並べても選べない。 */
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

  /* 索引はポップオーバーを開いたときに取りに行く。開いてすぐ打った人には間に
   * 合わないことがあり、空を出すと「無い」に読める。 */
  test('索引が届く前は、待っていると言う', () => {
    const { document, window, state } = setup();
    state.prefIndex = null;
    type(document, window, '18');
    expect(prefRows(document)).toEqual([]);
    expect(document.querySelector('#rl-pref-rows').textContent).toContain(
      '読み込んでいます',
    );
  });

  /* 落ちたときに待っている表示のまま止めると、いつまでも読み込み中に見える。 */
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

/* 一覧に出す系統は三状態しかない。どちらも外れると一覧が空になり、押した人が
 * 頼んでいないことが起きる。 */
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

  /* 一覧から消えた系統の選択はそのまま残る。ここは探す先を絞る欄で、
   * 選んだものを捨てる場所ではない。 */
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
  test('表示のトグルが state を変え、state.picked と state.prefPicked を null に戻す', () => {
    const { document, window, state } = setup();
    state.picked = 12345;
    state.prefPicked = 67890;

    const t = document.querySelector('#t-labels');
    t.checked = false;
    t.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(state.labels).toBe(false);
    expect(state.picked).toBeNull();
    // labels は都道府県道の pref-labels にも効くので、県道側の影も戻す
    // (issue #171)。
    expect(state.prefPicked).toBeNull();
  });

  test('9 つのトグルすべてが自分のキーだけを変える', () => {
    const { document, window, state } = setup();
    const cases = [
      ['#t-national', 'national'],
      ['#t-pref', 'pref'],
      ['#t-termini', 'termini'],
      ['#t-expressway', 'expressway'],
      ['#t-special', 'special'],
      ['#t-ferry', 'ferry'],
      ['#t-former', 'former'],
      ['#t-pref-special', 'prefSpecial'],
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
    togglePrefOnly(document, state, 'nagano-63', applyFilters);

    clearSelection(document, state, applyFilters);

    expect(state.selected.size).toBe(0);
    expect(state.prefSelected.size).toBe(0);
  });

  /* 詳細パネルを閉じても、地図の上の ✕ から戻せる。閉じたパネルの中にしか
   * 解除が無かったころ、県道を 1 本選んだ人は国道へ戻れなかった。 */
  test('都道府県道だけを選んでいても、✕ が解除する', () => {
    const { document, state, applyFilters } = setup();
    togglePrefOnly(document, state, 'nagano-63', applyFilters);

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

/* 地図の上のボタンから出るポップオーバー。押すまで開かないので、最初は三つとも
 * hidden である。開け閉ては app.js が持つので、ここが見るのは
 * 骨格だけである。 */
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

  /* ポップオーバーは自分のボタンと同じグループの中にある。位置合わせの計算を
   * 持たないための約束で、app.js の registerPane がグループを「持ち物」として
   * 使う。「道路を選択」だけは例外で、次のテストが理由とあわせて見る。 */
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

  /* 「道路を選択」のポップオーバーだけは #select-btn ではなく #ranking-btn の
   * グループにある。#select-btn は選んだ本数のバッジ(#sel-count)ぶん幅が
   * 変わり、そのグループを基準にすると路線を選ぶたびに横へずれる。#ranking-btn
   * のグループは幅が変わらないので、位置の基準として借りる(#128)。開け閉ては
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

  /* 絞り込み欄と一覧はポップオーバーの中、選択解除は外。選択は地図に
   * 効いており、ポップオーバーを開かずに戻したいことがある。 */
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

/* 選択が変わる経路はパネルのボタンだけではない。一覧のチェックからも、地図の
 * 左上の ✕ からも変わる。開いたままのパネルがそれを知らないと、解除した後も
 * ボタンだけが押されたまま残る。本物のパネル(detail.mjs)を流し込んで検査する。
 * 押した状態のラベルを組むのはあちらなので、写しを置くとその写しを
 * 検査することになる。 */
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

  /* 利用者が最初に見つけた不具合はこちらである。都道府県道は解除できるのに、
   * パネルの側が押された姿のまま残っていた。 */
  test('✕ で解いたら、都道府県道のパネルも戻る', () => {
    const { document, state, applyFilters } = setup();
    togglePrefOnly(document, state, 'nagano-63', applyFilters);
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

  /* 押した直後のボタンには焦点が載っている。要素ごと入れ替えると、キーボードで
   * 押した人はその場で居場所を失う。 */
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

/* 県境で続く路線の群をまとめて選ぶ(#155)。ここが捕まえるのは、二つの漏斗が
 * 同じ `state.prefSelected` を奪い合う場面です。見出しの漏斗で 1 本に絞った
 * 後も節が押されたまま残る、あるいはその逆が起きると、画面が地図と違うことを
 * 言います。 */
describe('まとめて表示 — 群の選択', () => {
  // 長野県と東京都は setup() の prefLabels に居ます。末尾が 県 と 都 なので
  // 数え方も「2都県」になり、県だけでは言えない群の形も一緒に通ります。
  const GROUP = ['nagano-18', 'tokyo-18'];

  test('押すと群の全員が選ばれる', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, GROUP, applyFilters);
    expect([...state.prefSelected].sort()).toEqual([...GROUP].sort());
    expect(state.selected.size).toBe(0);
  });

  test('もう一度押すと解ける', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, GROUP, applyFilters);
    togglePrefGroup(document, state, GROUP, applyFilters);
    expect(state.prefSelected.size).toBe(0);
  });

  test('群だけを選んでいるときに押した状態になる', () => {
    const { document, state, applyFilters } = setup();
    expect(isOnlyGroup(state.prefSelected, state.selected, GROUP)).toBe(false);
    togglePrefGroup(document, state, GROUP, applyFilters);
    expect(isOnlyGroup(state.prefSelected, state.selected, GROUP)).toBe(true);
  });

  test('群の外が 1 本でも混ざれば押した状態ではない', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, [...GROUP, 'nagano-63'], applyFilters);
    expect(isOnlyGroup(state.prefSelected, state.selected, GROUP)).toBe(false);
  });

  /* 国道 18 号と長野県道18号を選んでいる画面は 3 本を描いています。そこで節が
   * 「解除」と名乗ってはなりません。1 本のときの isOnly と同じ約束です。 */
  test('もう一方の系統が残っていれば押した状態ではない', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, GROUP, applyFilters);
    state.selected = new Set([18]);
    expect(isOnlyGroup(state.prefSelected, state.selected, GROUP)).toBe(false);
  });

  test('空の群では押した状態にならない', () => {
    const { state } = setup();
    expect(isOnlyGroup(state.prefSelected, state.selected, [])).toBe(false);
  });

  /* 狭いほうが後から勝ちます。群を表示している間に見出しの漏斗を押せば、
   * その 1 本に絞れます。 */
  test('見出しの漏斗を押すと 1 本に絞れ、節は押した状態でなくなる', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, GROUP, applyFilters);
    togglePrefOnly(document, state, 'nagano-18', applyFilters);
    expect([...state.prefSelected]).toEqual(['nagano-18']);
    expect(isOnly(state.prefSelected, state.selected, 'nagano-18')).toBe(true);
    expect(isOnlyGroup(state.prefSelected, state.selected, GROUP)).toBe(false);
  });

  test('節の漏斗を押すと群へ広がる', () => {
    const { document, state, applyFilters } = setup();
    togglePrefOnly(document, state, 'nagano-18', applyFilters);
    togglePrefGroup(document, state, GROUP, applyFilters);
    expect(isOnlyGroup(state.prefSelected, state.selected, GROUP)).toBe(true);
  });

  test('✕ で解ける。1 本のときと同じ口である', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, GROUP, applyFilters);
    clearSelection(document, state, applyFilters);
    expect(state.prefSelected.size).toBe(0);
    expect(isOnlyGroup(state.prefSelected, state.selected, GROUP)).toBe(false);
  });

  /* 共有リンクは選択をそのまま運びます。`proutes` は初めから複数を運ぶので、
   * 群のために新しい欄は要りません。 */
  test('URL に乗り、開き直して同じ選択に戻る', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, GROUP, applyFilters);
    const search = encodeState(state);
    expect(search).toContain('proutes=');
    const back = decodeURLState(`?${search}`);
    expect([...back.prefSelected].sort()).toEqual([...GROUP].sort());
  });
});

describe('syncDetailOnly — 節の漏斗', () => {
  const GROUP = ['nagano-18', 'tokyo-18'];
  const CONT = { refs: GROUP, name: '甲乙線', km: 12.3, src: 'both' };
  const openWithGroup = (doc, { selected = false, groupSelected = false }) => {
    doc.querySelector('#detail-body').innerHTML = prefDetailHTML({
      region: 'nagano',
      prefLabel: '長野県',
      ref: 18,
      route: { ref: 'nagano-18', km: 20, arcs: 1, max_n: 1 },
      continuation: CONT,
      prefLabels: new Map([
        ['nagano', '長野県'],
        ['tokyo', '東京都'],
      ]),
      selected,
      groupSelected,
    });
  };
  const contFunnel = (doc) => doc.querySelector('.cont-row .detail-only');
  const headFunnel = (doc) => doc.querySelector('.detail-acts .detail-only');
  const box = (doc) => doc.querySelector('.detail-cont');

  test('節の漏斗は群を名指し、数え方から名乗る', () => {
    const { document } = setup();
    openWithGroup(document, {});
    expect(contFunnel(document).dataset.prefs).toBe(GROUP.join(','));
    expect(contFunnel(document).getAttribute('aria-label')).toBe(
      '2都県まとめて表示',
    );
  });

  test('押した状態は漏斗と節の枠の両方に出る', () => {
    const { document } = setup();
    openWithGroup(document, { groupSelected: true });
    expect(contFunnel(document).classList.contains('active')).toBe(true);
    expect(contFunnel(document).getAttribute('aria-pressed')).toBe('true');
    expect(contFunnel(document).getAttribute('aria-label')).toBe(
      'まとめての表示を解除',
    );
    expect(box(document).classList.contains('on')).toBe(true);
  });

  /* 選択が他所で変わったときも追随します。✕ で解いた後に節だけが押されたまま
   * 残ると、地図と画面が違うことを言います。 */
  test('✕ で解いたら節も戻る', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, GROUP, applyFilters);
    openWithGroup(document, { groupSelected: true });

    clearSelection(document, state, applyFilters);
    syncDetailOnly(document, state);

    expect(contFunnel(document).getAttribute('aria-pressed')).toBe('false');
    expect(contFunnel(document).classList.contains('active')).toBe(false);
    expect(box(document).classList.contains('on')).toBe(false);
  });

  test('一覧から群を選び直したら押した姿になる', () => {
    const { document, state, applyFilters } = setup();
    openWithGroup(document, {});

    togglePrefGroup(document, state, GROUP, applyFilters);
    syncDetailOnly(document, state);

    expect(contFunnel(document).getAttribute('aria-pressed')).toBe('true');
    expect(box(document).classList.contains('on')).toBe(true);
  });

  /* 二つの漏斗は排他ではありません。どちらも同じ `state.prefSelected` を見る
   * ので、狭いほうを押せば広いほうが自動的に「押していない」に戻ります。 */
  test('見出しの漏斗で 1 本に絞ると、節だけが戻る', () => {
    const { document, state, applyFilters } = setup();
    togglePrefGroup(document, state, GROUP, applyFilters);
    openWithGroup(document, { groupSelected: true });

    togglePrefOnly(document, state, 'nagano-18', applyFilters);
    syncDetailOnly(document, state);

    expect(headFunnel(document).getAttribute('aria-pressed')).toBe('true');
    expect(contFunnel(document).getAttribute('aria-pressed')).toBe('false');
    expect(box(document).classList.contains('on')).toBe(false);
  });

  test('節を持たないパネルでも落ちない', () => {
    const { document, state, applyFilters } = setup();
    document.querySelector('#detail-body').innerHTML = prefDetailHTML({
      region: 'nagano',
      prefLabel: '長野県',
      ref: 63,
      route: { ref: 'nagano-63', km: 20, arcs: 1, max_n: 1 },
    });
    togglePrefOnly(document, state, 'nagano-63', applyFilters);
    syncDetailOnly(document, state);
    expect(contFunnel(document)).toBeNull();
    expect(headFunnel(document).getAttribute('aria-pressed')).toBe('true');
  });
});
