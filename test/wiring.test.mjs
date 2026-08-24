/* index.html の要素と state の対応づけ。app.js は地図を作って import できない
 * ので、wiring.mjs だけを happy-dom に流した実物の index.html へ配線して
 * 検査する。マークアップの複製は作らない。 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

import { routeListHTML } from '../web/panel.mjs';
import {
  NARROW_QUERY,
  setSelection,
  wireControls,
  wireRouteFold,
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
    picked: null,
    conc: 'off',
    labels: true,
    termini: true,
    expressway: true,
    special: true,
    ferry: true,
    former: true,
  };
  const applyCalls = [];
  const applyFilters = () => {
    applyCalls.push(new Set(state.selected));
    const clear = document.querySelector('#sel-none');
    clear.disabled = state.selected.size === 0;
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

  test('選択が空のとき「選択解除」ボタンが disabled になる', () => {
    const { document } = setup();
    const clear = document.querySelector('#sel-none');

    document.querySelector('#route-list input[value="7"]').click();
    expect(clear.disabled).toBe(false);

    document.querySelector('#route-list input[value="7"]').click();
    expect(clear.disabled).toBe(true);
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

  test('6 つのトグルすべてが自分のキーだけを変える', () => {
    const { document, window, state } = setup();
    const cases = [
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

/* 折りたたみは画面幅に従う。happy-dom の matchMedia は matches を答えるが、
 * 画面幅を変えても change を自分では発火しないので、境界をまたぐ側は
 * 手で change を投げて確かめる。 */
describe('wireRouteFold — 国道一覧の折りたたみ', () => {
  const fold = (width) => {
    const window = new Window({
      url: 'https://example.invalid/',
      width,
      height: 720,
    });
    const document = window.document;
    document.write(indexHtml);
    // matchMedia は呼ぶたびに別の MediaQueryList を返すので、配線が実際に
    // 購読した一つを捕まえておく。別の個体へ change を投げても届かない。
    const real = window.matchMedia.bind(window);
    const created = [];
    window.matchMedia = (q) => {
      const m = real(q);
      created.push(m);
      return m;
    };
    wireRouteFold(document);
    return {
      window,
      document,
      block: document.querySelector('#route-block'),
      mq: created[0],
    };
  };

  const resize = ({ window, mq }, width) => {
    window.happyDOM.setViewport({ width, height: 720 });
    mq.dispatchEvent(new window.Event('change'));
  };

  test('広い画面では開いている', () => {
    expect(fold(1280).block.open).toBe(true);
  });

  test('狭い画面では畳まれている', () => {
    expect(fold(375).block.open).toBe(false);
  });

  test('狭い画面から広げると開く', () => {
    const ctx = fold(375);
    expect(ctx.block.open).toBe(false);

    resize(ctx, 1280);
    expect(ctx.block.open).toBe(true);
  });

  test('広い画面から狭めると畳まれる', () => {
    const ctx = fold(1280);
    expect(ctx.block.open).toBe(true);

    resize(ctx, 375);
    expect(ctx.block.open).toBe(false);
  });

  /* 畳む幅は style.css の @media と wiring.mjs の二箇所にある。片方だけ
   * 動かすと、見出しを消したまま中身も畳まれた画面ができる。 */
  test('畳む幅が style.css の @media と一致する', () => {
    const css = readFileSync(
      new URL('../web/style.css', import.meta.url),
      'utf8',
    );
    expect(NARROW_QUERY).toBe('(max-width: 860px)');
    expect(css).toContain('@media (max-width: 860px)');
  });

  test('畳んだままでも絞り込み欄と選択解除は一覧の外にある', () => {
    const { document, block } = fold(375);
    expect(block.open).toBe(false);
    expect(block.contains(document.querySelector('#route-filter'))).toBe(false);
    expect(block.contains(document.querySelector('#sel-none'))).toBe(false);
  });
});
