/* 一つの国道について語る箱の中身。
 *
 * ここで壊れやすいのは二つあります。区分別の距離(issue #58)と台帳の起終点
 * (issue #59)は組み合わせ表と meta の欄が揃って初めて埋まるので、欄が無いとき
 * に出さないことと、来たときに出すことの両方を検査します。もう一つは、地名が
 * OpenStreetMap ではなく政令から来るとはいえ、文字列を innerHTML に流す点は
 * ポップアップと同じであることです。
 */
import { describe, expect, test } from 'bun:test';

import { decreeTerminiOf, detailHTML, wikipediaURL } from '../web/detail.mjs';
import { KIND_LABELS } from '../web/popup.mjs';

const route = (over) => ({
  ref: 18,
  km: 314.7,
  arcs: 1204,
  conc_km: 42.3,
  max_n: 3,
  ...over,
});

describe('wikipediaURL', () => {
  test('日本語版の「国道N号」を指す', () => {
    expect(wikipediaURL(18)).toBe(
      `https://ja.wikipedia.org/wiki/${encodeURIComponent('国道18号')}`,
    );
  });

  test('番号が違えば記事も違う', () => {
    expect(wikipediaURL(459)).not.toBe(wikipediaURL(45));
  });
});

describe('decreeTerminiOf', () => {
  const meta = {
    decree_termini: [
      {
        ref: 18,
        start: { name: '群馬県高崎市', lon: 139.0, lat: 36.3 },
        end: { name: '新潟県上越市', lon: 138.2, lat: 37.1 },
      },
      // 座標が当たらなかった路線。地名だけを持ちます。
      {
        ref: 20,
        start: { name: '東京都中央区' },
        end: { name: '長野県塩尻市' },
      },
      { ref: 21, start: null, end: null },
    ],
  };

  test('起点・終点をこの順で返す', () => {
    expect(decreeTerminiOf(meta, 18).map((t) => t.label)).toEqual([
      '起点',
      '終点',
    ]);
    expect(decreeTerminiOf(meta, 18)[0].at).toEqual([139.0, 36.3]);
  });

  test('座標が無ければ地名だけを持つ', () => {
    const [start] = decreeTerminiOf(meta, 20);
    expect(start.name).toBe('東京都中央区');
    expect(start.at).toBeNull();
  });

  test('地名すら無い欄は出さない', () => {
    expect(decreeTerminiOf(meta, 21)).toEqual([]);
  });

  test('欄そのものが無い meta でも落ちない', () => {
    // 欄が載る前の national.meta.json がこれです。
    expect(decreeTerminiOf({}, 18)).toEqual([]);
    expect(decreeTerminiOf(undefined, 18)).toEqual([]);
  });

  test('表に無い路線は空である', () => {
    expect(decreeTerminiOf(meta, 999)).toEqual([]);
  });
});

describe('detailHTML — 見出しとリンク', () => {
  test('標識と路線名を出す', () => {
    const html = detailHTML({ route: route() });
    expect(html).toContain('国道18号');
    expect(html).toContain('aria-label="国道18号"'); // shield() の svg
  });

  test('Wikipedia へのリンクは新しいタブで開く', () => {
    const html = detailHTML({ route: route() });
    expect(html).toContain(`href="${wikipediaURL(18)}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  test('その路線だけを表示するボタンが番号を持つ', () => {
    const html = detailHTML({ route: route({ ref: 459 }) });
    expect(html).toContain('class="mini detail-only" data-ref="459"');
    expect(html).toContain('国道459号だけを表示');
  });
});

describe('detailHTML — 統計', () => {
  test('延長・アーク数・重用区間・最大重用数を出す', () => {
    const html = detailHTML({ route: route() });
    expect(html).toContain('<dt>延長</dt><dd>314.7 km</dd>');
    expect(html).toContain('<dt>アーク数</dt><dd>1,204</dd>');
    expect(html).toContain('<dt>重用区間</dt><dd>42.3 km</dd>');
    expect(html).toContain('<dt>最大重用数</dt><dd>3 重用</dd>');
  });

  test('重用を持たない路線はそう述べる', () => {
    // 0.0 km と書くより短く、単独指定であることが読み取れます。
    const html = detailHTML({ route: route({ conc_km: 0, max_n: 1 }) });
    expect(html).toContain('<dt>重用区間</dt><dd>なし</dd>');
    expect(html).toContain('<dt>最大重用数</dt><dd>単独指定</dd>');
  });

  test('km は小数第 1 位まで揃える', () => {
    const html = detailHTML({ route: route({ km: 12, conc_km: 4 }) });
    expect(html).toContain('12.0 km');
    expect(html).toContain('4.0 km');
  });
});

describe('detailHTML — 区分別', () => {
  test('内訳が無ければ欄ごと出さない', () => {
    expect(detailHTML({ route: route() })).not.toContain('区分別');
    expect(detailHTML({ route: route(), kinds: [] })).not.toContain('区分別');
  });

  test('内訳が来れば読める区分名で出す', () => {
    const html = detailHTML({
      route: route(),
      kinds: [
        { kind: 'road', km: 300.2 },
        { kind: 'ferry', km: 14.5 },
      ],
    });
    expect(html).toContain('区分別');
    expect(html).toContain(`<dt>${KIND_LABELS.road}</dt><dd>300.2 km</dd>`);
    expect(html).toContain(`<dt>${KIND_LABELS.ferry}</dt><dd>14.5 km</dd>`);
  });

  test('対応表に無い区分はそのまま出す', () => {
    // 生成側が新しい区分を足したとき、空欄になるより生の値が見えたほうがよいです。
    const html = detailHTML({
      route: route(),
      kinds: [{ kind: 'newkind', km: 1 }],
    });
    expect(html).toContain('newkind');
  });
});

describe('detailHTML — 起点・終点', () => {
  test('起終点が無ければ欄ごと出さない', () => {
    expect(detailHTML({ route: route() })).not.toContain('detail-termini');
  });

  test('座標があれば押せる行になる', () => {
    const html = detailHTML({
      route: route(),
      termini: [{ label: '起点', name: '群馬県高崎市', at: [139.0, 36.3] }],
    });
    expect(html).toContain('data-at="139,36.3"');
    expect(html).toContain('<button type="button" class="row"');
    expect(html).toContain('aria-label="国道18号の起点(群馬県高崎市)へ移動"');
  });

  test('座標が無ければ押せない行になる', () => {
    const html = detailHTML({
      route: route(),
      termini: [{ label: '起点', name: '東京都中央区', at: null }],
    });
    expect(html).toContain('東京都中央区');
    expect(html).not.toContain('data-at');
    expect(html).not.toContain('<button type="button" class="row"');
  });

  test('地名はエスケープしてから入れる', () => {
    const html = detailHTML({
      route: route(),
      termini: [
        { label: '起点', name: '<img src=x onerror=alert(1)>', at: [1, 2] },
      ],
    });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});
