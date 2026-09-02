/* 信用できない文字列が HTML になる唯一の場所。
 *
 * OpenStreetMap は誰でも編集できるので、道の `name` は見知らぬ誰かが書いた
 * 入力で、ビルドを経てここへ届きます。操作パネルとポップアップが出す文字列は
 * すべて `esc` を通ります。それを確かめるのがこのファイルです。
 */
import { describe, expect, test } from 'bun:test';

import { esc } from '../web/html.mjs';

describe('esc', () => {
  test('要素を開かせない', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(esc('</script>')).toBe('&lt;/script&gt;');
  });

  test('属性から抜け出させない', () => {
    // `title="..."` の中に置かれても、引用符を閉じて属性を足せません。
    expect(esc('" onmouseover="alert(1)')).toBe(
      '&quot; onmouseover=&quot;alert(1)',
    );
    expect(esc("' onmouseover='alert(1)")).toBe(
      '&#39; onmouseover=&#39;alert(1)',
    );
  });

  test('& を先に置き換えるので二重エスケープにならない', () => {
    // '<' → '&lt;' としたあとに & を処理すると '&amp;lt;' になります。
    expect(esc('<')).toBe('&lt;');
    expect(esc('&')).toBe('&amp;');
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  test('日本語や記号はそのまま通す', () => {
    expect(esc('尾駮バイパス')).toBe('尾駮バイパス');
    expect(esc('7・8・17')).toBe('7・8・17');
    expect(esc('国道18号（上田バイパス）')).toBe('国道18号（上田バイパス）');
  });

  test('null と undefined は空文字になる', () => {
    // popup の「名称」は値が無ければ — を出します。'null' と出てはいけません。
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  test('数値は文字列になる', () => {
    expect(esc(0)).toBe('0');
    expect(esc(459)).toBe('459');
  });

  test('置き換える字はこの 5 つだけである', () => {
    const dangerous = ['&', '<', '>', '"', "'"];
    for (const c of dangerous) expect(esc(c)).not.toBe(c);
    for (const c of [...'abc123 　、。/\\:;=-_()[]{}']) expect(esc(c)).toBe(c);
  });
});
