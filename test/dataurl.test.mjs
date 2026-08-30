/* 配信データの URL の基点。書き換えるのは web/dataurl.mjs の 1 行だけであり、
 * pages.yml の sed がその行を書き換えることは CI のワークフローの中で確かめる
 * ので、ここでは手元のまま(相対パス)の組み立てだけを確かめます。
 */
import { describe, expect, test } from 'bun:test';

import { dataURL } from '../web/dataurl.mjs';

describe('dataURL', () => {
  test('ファイル名を基点に繋げる', () => {
    expect(dataURL('national-routes.pmtiles')).toBe(
      'data/national-routes.pmtiles',
    );
    expect(dataURL('regions.json')).toBe('data/regions.json');
    expect(dataURL('national.meta.json')).toBe('data/national.meta.json');
  });
});
