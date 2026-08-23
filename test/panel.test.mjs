/* The sidebar's markup, as a function of the data behind it. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  clearLabel,
  concurrencies,
  countLabel,
  freshnessHTML,
  legendKindHTML,
  legendNHTML,
  rankingHTML,
  routeListHTML,
  STALE_DAYS,
  sharedHTML,
  shareSummaryHTML,
  shareText,
  statsHTML,
} from '../web/panel.mjs';

/** 呼び出しが多いので短く別名を置く。 */
const freshness = freshnessHTML;

const combo = (refs, km, arcs) => ({
  refs,
  n: refs.length,
  km,
  arcs,
  names: [],
  bbox: [138, 36, 139, 37],
});

describe('routeListHTML', () => {
  const routes = [
    { ref: 7, km: 114.2, arcs: 10, max_n: 6 },
    { ref: 2, km: 50, arcs: 5, max_n: 1 },
  ];

  test('番号ごとにチェックボックスを出す', () => {
    const html = routeListHTML(routes);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('value="7"');
  });

  test('重用がある路線にだけ深さの印が付く', () => {
    const html = routeListHTML(routes);
    expect(html).toContain('×6');
    expect(html).not.toContain('×1');
  });

  test('絞り込みのために番号を data 属性に持つ', () => {
    // 「15」と打つと 15・150・151… が残る前方一致に使います。
    expect(routeListHTML(routes)).toContain('data-ref="7"');
  });
});

describe('statsHTML', () => {
  const totals = { arcs: 151101, km: 70290, conc: 22188 };

  test('選択が空なら全路線を分子にする', () => {
    // 何も選んでいない状態は「全部出ている」ことであって、0 本ではない。
    expect(statsHTML(0, 459, totals)).toContain(
      '<dt>選択路線</dt><dd>459 / 459</dd>',
    );
  });

  test('選択があればその数を出す', () => {
    expect(statsHTML(3, 459, totals)).toContain(
      '<dt>選択路線</dt><dd>3 / 459</dd>',
    );
  });

  test('大きな数は桁を区切る', () => {
    const html = statsHTML(0, 459, totals);
    expect(html).toContain('151,101');
    expect(html).toContain('22,188');
  });

  test('延長は小数を出さない', () => {
    expect(statsHTML(0, 459, { arcs: 1, km: 70290.47, conc: 0 })).toContain(
      '70,290 km',
    );
  });
});

describe('clearLabel', () => {
  test('選択が無ければ何を解除するかも言わない', () => {
    expect(clearLabel(0)).toBe('選択解除');
  });

  test('選択があれば数を自分で言う', () => {
    // これがあるので、選択数を述べる行が別に要りません。
    expect(clearLabel(1)).toBe('1 路線を選択解除');
    expect(clearLabel(12)).toBe('12 路線を選択解除');
  });
});

describe('concurrencies', () => {
  const combos = [
    combo([7], 100, 1000),
    combo([7, 8], 10, 100),
    combo([17, 49], 5, 50),
  ];

  test('単独指定は重用ではない', () => {
    expect(concurrencies(combos, new Set())).toHaveLength(2);
  });

  test('選択はどれを並べるかだけを絞る', () => {
    // 重用かどうかは道路の性質であって、選択の結果ではありません。
    const picked = concurrencies(combos, new Set([7]));
    expect(picked).toHaveLength(1);
    expect(picked[0].refs).toEqual([7, 8]);
  });

  test('選ばれた番号が重用の片側にあれば残る', () => {
    expect(concurrencies(combos, new Set([49]))[0].refs).toEqual([17, 49]);
  });

  test('該当が無ければ空になる', () => {
    expect(concurrencies(combos, new Set([999]))).toEqual([]);
  });
});

describe('countLabel', () => {
  test('全体と表示数の両方を述べる', () => {
    expect(countLabel(25, 1237, '組')).toBe('25 / 1237 組');
  });

  test('全体が 0 なら何も言わない', () => {
    // 折り畳んだ見出しに「0 / 0 組」と出るより、何も出ないほうがよいです。
    expect(countLabel(0, 0, '組')).toBe('');
  });
});

describe('rankingHTML', () => {
  test('行は自分の範囲を持ち、そこへ飛べる', () => {
    // 表を再走査して範囲を求めていた頃は、四国の四分の一を映していました。
    const html = rankingHTML([combo([7, 8], 4.21, 18)]);
    expect(html).toContain('data-bbox="138,36,139,37"');
    expect(html).toContain('data-refs="7,8"');
  });

  test('標識と延長を出す', () => {
    const html = rankingHTML([combo([7, 8], 4.21, 18)]);
    expect(html).toContain('4.2 km');
    expect(html.match(/<svg/g)).toHaveLength(2);
  });

  test('名称はエスケープする', () => {
    const row = { ...combo([7, 8], 4.21, 18), names: ['<b>栗ノ木</b>'] };
    expect(rankingHTML([row])).toContain('&lt;b&gt;栗ノ木&lt;/b&gt;');
  });

  test('名称が無ければその欄を出さない', () => {
    expect(rankingHTML([combo([7, 8], 4.21, 18)])).not.toContain('class="nm"');
  });

  test('該当が無ければそう言う', () => {
    expect(rankingHTML([])).toContain('該当する重用区間はありません');
  });

  test('押すと何が起きるかを aria-label で伝える', () => {
    const html = rankingHTML([combo([7, 8], 4.21, 18)]);
    expect(html).toContain(
      'aria-label="国道7・8号の重用区間 4.2kmを地図で表示"',
    );
  });

  test('aria-label は名称も含める', () => {
    const row = { ...combo([7, 8], 4.21, 18), names: ['栗ノ木'] };
    expect(rankingHTML([row])).toContain(
      'aria-label="国道7・8号の重用区間 4.2km、栗ノ木を地図で表示"',
    );
  });

  test('aria-label の名称もエスケープする', () => {
    const row = { ...combo([7, 8], 4.21, 18), names: ['<b>栗ノ木</b>'] };
    expect(rankingHTML([row])).toContain(
      '&lt;b&gt;栗ノ木&lt;/b&gt;を地図で表示',
    );
  });
});

describe('sharedHTML', () => {
  const point = { refs: [7, 8, 17], lon: 139.05, lat: 37.91 };

  test('地点は座標を持ち、そこへ飛べる', () => {
    expect(sharedHTML([point])).toContain('data-at="139.05,37.91"');
  });

  test('集まる路線の数を出す', () => {
    expect(sharedHTML([point])).toContain('3 路線');
  });

  test('該当が無ければそう言う', () => {
    expect(sharedHTML([])).toContain('該当地点はありません');
  });

  test('押すと何が起きるかを aria-label で伝える', () => {
    expect(sharedHTML([point])).toContain(
      'aria-label="国道7・8・17号が起終点を共有する地点を地図で表示"',
    );
  });
});

describe('shareSummaryHTML', () => {
  const base = {
    selectedRefs: [],
    totalRoutes: 459,
    concLabel: '強調しない',
    toggles: [
      { label: '路線番号', checked: true },
      { label: '海上国道', checked: false },
    ],
  };

  test('選択が無ければ全路線であることを言う', () => {
    expect(shareSummaryHTML(base)).toContain('すべて（459 路線）');
  });

  test('選択があれば標識で出す', () => {
    const html = shareSummaryHTML({ ...base, selectedRefs: [7, 8] });
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).not.toContain('すべて');
  });

  test('重用区間の状態はそのまま述べる', () => {
    expect(shareSummaryHTML(base)).toContain('強調しない');
  });

  test('チェックボックスの状態をon/offで出す', () => {
    const html = shareSummaryHTML(base);
    expect(html).toContain('<li class="on">路線番号</li>');
    expect(html).toContain('<li class="off">海上国道</li>');
  });

  test('文言はエスケープする', () => {
    const html = shareSummaryHTML({
      ...base,
      concLabel: '<b>x</b>',
      toggles: [{ label: '<i>y</i>', checked: true }],
    });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('&lt;i&gt;y&lt;/i&gt;');
  });
});

describe('shareText', () => {
  const url = 'https://nanase.cc/kokudo-map/?routes=292#7.99/37.093/139.145';

  test('選択が無ければ路線番号を言わない', () => {
    expect(shareText(url, { selectedRefs: [] })).toBe(`国道マップ\n${url}`);
  });

  test('選択があれば号数をタイトルに入れる', () => {
    expect(shareText(url, { selectedRefs: [292] })).toBe(
      `国道マップ - 292号\n${url}`,
    );
  });

  test('複数選択は・で並べる', () => {
    expect(shareText(url, { selectedRefs: [15, 17] })).toBe(
      `国道マップ - 15・17号\n${url}`,
    );
  });
});

describe('凡例', () => {
  test('重用の深さは 4 段である', () => {
    expect(legendNHTML().match(/class="item"/g)).toHaveLength(4);
    expect(legendNHTML()).toContain('単独指定');
    expect(legendNHTML()).toContain('四重用以上');
  });

  test('補足はカッコ書きではなく title 属性に持たせる', () => {
    // 表示上はカッコ書きを省き、ホバーのツールチップに回す。
    const html = legendKindHTML();
    expect(html).not.toContain('（');
    expect(html).toContain('title="徒歩道・階段"');
    expect(html).toContain('title="計画・未着工"');
    expect(html).toContain('title="航路"');
  });

  test('補足の無い項目に title は付かない', () => {
    const chunk = legendKindHTML()
      .split('<span class="item"')
      .find((s) => s.includes('工事中'));
    expect(chunk.startsWith('>')).toBe(true);
  });

  test('走れない種別は破線で示す', () => {
    // 地図でも破線なので、凡例も破線でなければ対応が読み取れません。
    const html = legendKindHTML();
    expect(html.match(/border-top-style:dashed/g)).toHaveLength(4);
  });

  /* index.html はこの二つの凡例だけ、生成を待たずに static な HTML として
   * 埋め込んである — vendor/*.js が読み終わるまで app.js 自体が動けず、遅い
   * 回線では凡例だけ空のまま出てから遅れて現れて見えていた。static にした
   * 代わり、legendNHTML()/legendKindHTML() と食い違えば古いままになりうる
   * ので、ここで一致を検査する。 */
  const indexHtml = readFileSync(
    new URL('../web/index.html', import.meta.url),
    'utf8',
  );
  const staticMarkup = (id) => {
    const m = indexHtml.match(
      new RegExp(`<div id="${id}" class="legend">([\\s\\S]*?)</div>`),
    );
    return m?.[1] ?? null;
  };

  test('index.html の単独指定などの凡例は legendNHTML() の出力そのもの', () => {
    expect(staticMarkup('legend-n')).toBe(legendNHTML());
  });

  test('index.html の種別の凡例は legendKindHTML() の出力そのもの', () => {
    expect(staticMarkup('legend-kind')).toBe(legendKindHTML());
  });
});

describe('freshnessHTML', () => {
  const meta = {
    osm_timestamp: '2026-08-16T20:21:06Z',
    oldest_edit: '2009-08-14',
    newest_edit: '2026-08-16',
    endpoints: ['Geofabrik japan-latest.osm.pbf'],
  };
  const at = (iso) => new Date(iso).getTime();

  test('基準時刻は UTC で出す', () => {
    // 閲覧者の時間帯で表示すると、同じデータが人によって違う日付になります。
    expect(freshness(meta, at('2026-08-16T21:00:00Z'))).toContain(
      '2026-08-16 20:21Z',
    );
  });

  test('当日・1 日前・n 日前を言い分ける', () => {
    expect(freshness(meta, at('2026-08-16T23:00:00Z'))).toContain('（当日）');
    expect(freshness(meta, at('2026-08-18T00:00:00Z'))).toContain('（1 日前）');
    expect(freshness(meta, at('2026-08-21T00:00:00Z'))).toContain('（4 日前）');
  });

  test('7 日までは警告しない', () => {
    const html = freshness(meta, at('2026-08-23T20:21:06Z'));
    expect(html).not.toContain('warn');
    expect(html).not.toContain('最近の開通');
  });

  test('7 日を超えたら警告する', () => {
    const html = freshness(meta, at('2026-08-25T00:00:00Z'));
    expect(html).toContain('warn');
    expect(html).toContain('最近の開通は反映されていない可能性があります');
  });

  test('境界は STALE_DAYS が決める', () => {
    const day = 86400000;
    const base = at(meta.osm_timestamp);
    expect(freshness(meta, base + STALE_DAYS * day)).not.toContain('warn');
    expect(freshness(meta, base + (STALE_DAYS + 1) * day)).toContain('warn');
  });

  test('区間の更新と取得元も述べる', () => {
    const html = freshnessHTML(meta, at('2026-08-16T21:00:00Z'));
    expect(html).toContain('2009-08-14 〜 2026-08-16');
    expect(html).toContain('Geofabrik');
  });

  test('取得元の文字列もエスケープする', () => {
    const bad = { ...meta, endpoints: ['<script>x</script>'] };
    expect(freshnessHTML(bad, at('2026-08-16T21:00:00Z'))).toContain(
      '&lt;script&gt;',
    );
  });
});
