/* 押したアークが自分について述べること。
 *
 * ここでは二つが、画面上は問題なく見える形で間違っていたことがあります。
 * 1 画素の下に複数が重なるとき、その押下がどのアークを指すのか。そして OSM の
 * 文字が、文字のままページへ届くかどうかです。
 */
import { describe, expect, test } from 'bun:test';

import {
  deepest,
  KIND_LABELS,
  PREF_KIND_LABELS,
  popupHTML,
  prefPopupHTML,
  prefRefsOf,
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
    // 次第で、福岡の四重用では国道 202 号が単独で報告されました。
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
    // クリックした 1 本の way の長さです。延長と書くと国道 4 号が 0.13 km に
    // 見えます。
    const html = popupHTML(arc({ km: 0.1276 }));
    expect(html).toContain('<dt>区間長</dt><dd>0.13 km</dd>');
    expect(html).not.toContain('<dt>延長</dt>');
  });

  test('旧道のときだけ備考が出る', () => {
    expect(popupHTML(arc({ former: 1 }))).toContain(
      '<dt>備考</dt><dd>旧道</dd>',
    );
    expect(popupHTML(arc({ former: 0 }))).not.toContain('旧道');
  });

  test('OSM へのリンクは way の id を指す', () => {
    const html = popupHTML(arc({ id: 195557224 }));
    expect(html).toContain('https://www.openstreetmap.org/way/195557224');
    expect(html).toContain('>way/195557224</a>');
  });
});

/* ---------------------------------------------------------- 都道府県道 --- */
describe('prefRefsOf', () => {
  test('区切り文字で囲まれた鍵の並びにする。数には直さない', () => {
    expect(prefRefsOf(',nagano-2,nagano-93,')).toEqual([
      'nagano-2',
      'nagano-93',
    ]);
  });

  test('空や欠落でも落ちない', () => {
    expect(prefRefsOf('')).toEqual([]);
    expect(prefRefsOf(undefined)).toEqual([]);
  });
});

describe('prefPopupHTML', () => {
  /* build_prefectural.py が書く属性です。国道と違って `updated` を持ちません。 */
  const parc = (over) => ({
    id: 173704782,
    pref: 'nagano',
    refs: ',nagano-60,',
    n: 1,
    kind: 'road',
    rank: 'major',
    src: 'relation',
    former: 0,
    revoked: 0,
    name: '長野荒瀬原線',
    km: 0.335,
    ...over,
  });

  test('標識は県を伴う鍵を持つ。番号だけでは 47 本のどれか決まらない', () => {
    const html = prefPopupHTML(parc(), '長野県');
    expect(html).toContain('data-pref="nagano-60"');
    expect(html).not.toContain('data-ref=');
    expect(html).toContain('長野県道60号の詳細');
  });

  test('指定のぶんだけ標識が出て、重用数を述べる', () => {
    expect(prefPopupHTML(parc(), '長野県')).toContain('単独指定');
    const two = prefPopupHTML(
      parc({ refs: ',nagano-60,nagano-399,', n: 2 }),
      '長野県',
    );
    expect(two).toContain('2 重用');
    expect(two.match(/class="shield-btn"/g)).toHaveLength(2);
  });

  test('県の呼び分けは県の名前が持つ', () => {
    expect(prefPopupHTML(parc({ refs: ',tokyo-7,' }), '東京都')).toContain(
      '東京都道7号',
    );
    expect(prefPopupHTML(parc({ refs: ',hokkaido-106,' }), '北海道')).toContain(
      '北海道道106号',
    );
    expect(prefPopupHTML(parc({ refs: ',osaka-1,' }), '大阪府')).toContain(
      '大阪府道1号',
    );
  });

  test('区分は都道府県道の言い方に直す', () => {
    // 「点線国道」「海上国道」は国道の呼び名です。都道府県道は持ちません。
    const html = prefPopupHTML(parc({ kind: 'foot' }), '長野県');
    expect(html).toContain(PREF_KIND_LABELS.foot);
    expect(html).not.toContain(KIND_LABELS.foot);
  });

  test('最終更新の行は出さない。県道のアークがその欄を持たないため', () => {
    const html = prefPopupHTML(parc(), '長野県');
    expect(html).not.toContain('最終更新');
    // 国道の側は今までどおり出す。
    expect(popupHTML(arc())).toContain('最終更新');
  });

  test('残りの欄は国道と同じことを訊く', () => {
    const html = prefPopupHTML(parc({ former: 1 }), '長野県');
    expect(html).toContain('<dt>名称</dt><dd>長野荒瀬原線</dd>');
    expect(html).toContain('<dt>区間長</dt><dd>0.34 km</dd>');
    expect(html).toContain(SRC_LABELS.relation);
    expect(html).toContain('<dt>備考</dt><dd>旧道</dd>');
    expect(html).toContain('https://www.openstreetmap.org/way/173704782');
  });

  test('OSM の名称はエスケープしてから入れる', () => {
    const html = prefPopupHTML(
      parc({ name: '<img src=x onerror=alert(1)>' }),
      '長野県',
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});
