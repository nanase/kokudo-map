/* index.html の要素と state の対応づけ。app.js は地図を作って import できない
 * ので、wiring.mjs だけを happy-dom に流した実物の index.html へ配線して
 * 検査する。マークアップの複製は作らない。 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

import { routeListHTML } from '../web/panel.mjs';
import {
  clearSelection,
  NARROW_QUERY,
  setSelection,
  showRouteOnly,
  togglePrefOnly,
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
  document.querySelector('#route-list').innerHTML = routeListHTML(routes);

  const state = {
    selected: new Set(),
    prefSelected: new Set(),
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
    showRouteOnly(document, state, 8, applyFilters);

    expect(state.selected).toEqual(new Set([8]));
    expect(state.pref).toBe(true);
    expect(tPref(document).checked).toBe(true);
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

describe('wireControls — 絞り込み', () => {
  test('絞り込み入力が、一致しない行に hidden を付ける', () => {
    const { document, window } = setup();
    const input = document.querySelector('#route-filter');
    input.value = '8';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    const label = (ref) => document.querySelector(`label[data-ref="${ref}"]`);
    expect(label(8).classList.contains('hidden')).toBe(false);
    expect(label(7).classList.contains('hidden')).toBe(true);
  });

  test('絞り込みを空に戻すとすべて出す', () => {
    const { document, window } = setup();
    const input = document.querySelector('#route-filter');
    input.value = '8';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.value = '';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    for (const label of document.querySelectorAll('#route-list label')) {
      expect(label.classList.contains('hidden')).toBe(false);
    }
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
   * ための約束で、app.js の registerPane が台を「面の持ち物」として使う。 */
  test('面はボタンと同じ台の中にある', () => {
    const document = load(1280);
    for (const [btn, pane] of [
      ['#select-btn', '#select-popover'],
      ['#ranking-btn', '#ranking-popover'],
      ['#shared-btn', '#shared-popover'],
    ]) {
      const ctrl = document.querySelector(btn).closest('.ui-ctrl');
      expect(ctrl.contains(document.querySelector(pane))).toBe(true);
    }
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
    expect(clear.closest('.ui-ctrl').contains(pane)).toBe(true);
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
