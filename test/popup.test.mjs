/* What a clicked arc says about itself.
 *
 * Two things here have been wrong before in ways that looked fine on screen:
 * which arc a click is about when several lie under one pixel, and whether
 * OSM's own text reaches the page as text.
 */
import { describe, expect, test } from 'bun:test';

import {
  deepest,
  KIND_LABELS,
  popupHTML,
  refsOf,
  SRC_LABELS,
} from '../web/popup.mjs';

const arc = (over) => ({
  refs: ',18,',
  n: 1,
  kind: 'road',
  src: 'relation',
  former: 0,
  name: '国道18号',
  km: 1.204,
  updated: '2025-12-28',
  id: 12345,
  ...over,
});

describe('deepest', () => {
  const hit = (n) => ({ properties: { n, id: n } });

  test('最も深い重用のアークを選ぶ', () => {
    // 交差点や立体交差では複数のアークが 1 画素の下に重なります。返る順はタイル
    // 次第で、福岡の四重用では 国道202号 が単独で報告されました。
    expect(deepest([hit(1), hit(4), hit(2)]).n).toBe(4);
  });

  test('並び順に依らない', () => {
    expect(deepest([hit(6), hit(1)]).n).toBe(6);
    expect(deepest([hit(1), hit(6)]).n).toBe(6);
  });

  test('1 本しか無ければそれを返す', () => {
    expect(deepest([hit(3)]).n).toBe(3);
  });

  test('n が文字列で来ても数として比べる', () => {
    // ベクタタイルの属性は文字列で届くことがあります。文字列比較だと '10' < '9'。
    expect(
      deepest([{ properties: { n: '9' } }, { properties: { n: '10' } }]).n,
    ).toBe('10');
  });
});

describe('refsOf', () => {
  test('区切り文字で囲まれた文字列を数の配列にする', () => {
    expect(refsOf(',7,8,17,')).toEqual([7, 8, 17]);
  });

  test('単独指定でも配列になる', () => {
    expect(refsOf(',18,')).toEqual([18]);
  });

  test('空や欠落でも落ちない', () => {
    expect(refsOf('')).toEqual([]);
    expect(refsOf(undefined)).toEqual([]);
  });
});

describe('popupHTML', () => {
  test('重用数を述べ、単独なら単独と言う', () => {
    expect(popupHTML(arc({ refs: ',18,' }))).toContain('単独指定');
    expect(popupHTML(arc({ refs: ',7,8,17,' }))).toContain('3 重用');
  });

  test('指定のぶんだけ標識のボタンが出る', () => {
    const html = popupHTML(arc({ refs: ',7,8,17,49,403,459,' }));
    expect(html.match(/class="shield-btn"/g)).toHaveLength(6);
    expect(html).toContain('data-ref="459"');
  });

  test('区分と典拠は読める言葉に直す', () => {
    expect(popupHTML(arc({ kind: 'ferry' }))).toContain(KIND_LABELS.ferry);
    expect(popupHTML(arc({ src: 'tag' }))).toContain(SRC_LABELS.tag);
  });

  test('対応表に無い値はそのまま出す', () => {
    // 生成側が新しい種別を足したとき、空欄になるより生の値が見えたほうがよいです。
    expect(popupHTML(arc({ kind: 'newkind' }))).toContain('newkind');
  });

  test('OSM の名称はエスケープしてから入れる', () => {
    const html = popupHTML(arc({ name: '<img src=x onerror=alert(1)>' }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  test('名称が無ければダッシュを出す', () => {
    expect(popupHTML(arc({ name: '' }))).toContain('<dt>名称</dt><dd>—</dd>');
    expect(popupHTML(arc({ name: null }))).toContain('<dt>名称</dt><dd>—</dd>');
  });

  test('長さは区間長であって延長ではない', () => {
    // クリックした 1 本の way の長さです。延長と書くと 国道4号 が 0.13 km に
    // 見えます。
    const html = popupHTML(arc({ km: 0.1276 }));
    expect(html).toContain('<dt>区間長</dt><dd>0.13 km</dd>');
    expect(html).not.toContain('<dt>延長</dt>');
  });

  test('旧道のときだけ備考が出る', () => {
    expect(popupHTML(arc({ former: 1 }))).toContain('旧道（指定解除前）');
    expect(popupHTML(arc({ former: 0 }))).not.toContain('旧道');
  });

  test('OSM へのリンクは way の id を指す', () => {
    const html = popupHTML(arc({ id: 195557224 }));
    expect(html).toContain('https://www.openstreetmap.org/way/195557224');
    expect(html).toContain('>way/195557224</a>');
  });
});
