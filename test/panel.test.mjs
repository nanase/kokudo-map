/* サイドパネルの markup を、後ろにあるデータの関数として見る。 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
// 色の写しは置かない。凡例の見本が地図の線と同じ色かどうかを見るので、地図の
// 定義そのものを読む。
import { PREF_GENERAL, PREF_MAJOR } from '../web/mapspec.mjs';
import {
  clearLabel,
  countLabel,
  freshnessHTML,
  legendKindHTML,
  legendNHTML,
  legendPrefHTML,
  PREF_CONCURRENCY_NOTES,
  PREF_SPECIAL_LABEL,
  PREF_SPECIAL_TIP,
  prefConcurrencyHTML,
  prefGroupLabel,
  prefRowsHTML,
  rankingHTML,
  routeListHTML,
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
    // 何も選んでいない状態は「全部出ている」ことであって、0 本ではありません。
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
    // これがあるので、選択数を述べる行は別に不要です。
    expect(clearLabel(1)).toBe('1 路線を選択解除');
    expect(clearLabel(12)).toBe('12 路線を選択解除');
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
      'aria-label="国道7・8・17号が起終点を共有する地点(北緯37.9100・東経139.0500)を地図で表示"',
    );
  });

  test('同じ路線の組が離れた地点にあっても aria-label が重複しない', () => {
    // 全国データには refs が同じで座標が違う組が 32 件ある。座標が入って
    // いないと、2 行とも同じ aria-label になってしまう。
    const other = { refs: [7, 8, 17], lon: 130.4, lat: 33.6 };
    const html = sharedHTML([point, other]);
    const labels = [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map(
      ([, label]) => label,
    );
    expect(new Set(labels).size).toBe(2);
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

  /* 都道府県道の行は選んでいるときだけ出します。行ごと出さなければ、国道だけを
     見ている人のダイアログは今までと変わりません。 */
  test('都道府県道を選んでいなければ、その行は出さない', () => {
    expect(shareSummaryHTML(base)).not.toContain('都道府県道');
  });

  test('都道府県道の選択はヘキサで出す', () => {
    const html = shareSummaryHTML({
      ...base,
      prefRoutes: [{ prefLabel: '長野県', ref: 63 }],
    });
    expect(html).toContain('都道府県道');
    expect(html).toContain('class="shield hex sm"');
    // 番号だけでは 47 本のどれか決まらないので、読み上げには県が要る。
    expect(html).toContain('aria-label="長野県道63号"');
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
  /* 凡例は三つのファイルにまたがる。index.html が静的な markup と <head> の
   * 先読みを、app.js が押されたときの書き直しを、style.css が見本の描き方と
   * 畳んだ状態の効かせ方を持つ。下の検査はどれもこの三つを読む。 */
  const indexHtml = readFileSync(
    new URL('../web/index.html', import.meta.url),
    'utf8',
  );
  const appJs = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const styleCss = readFileSync(
    new URL('../web/style.css', import.meta.url),
    'utf8',
  );

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

  test('index.html の都道府県道の凡例は legendPrefHTML() の出力そのもの', () => {
    expect(staticMarkup('legend-pref')).toBe(legendPrefHTML());
  });

  test('都道府県道の凡例は格を 2 段で述べる', () => {
    const html = legendPrefHTML();
    expect(html).toContain('主要地方道');
    expect(html).toContain('一般都道府県道');
    // 格の 2 段は実線で示す。破線は走れない区分の印なので、格の見本には出ない。
    expect(
      html.match(/class="swatch" style="border-top-color:#[0-9A-F]{6}"/g),
    ).toHaveLength(2);
  });

  test('走れない都道府県道は 1 項目にまとめる', () => {
    // 地図でも区分ごとに層を分けておらず、「点線国道」「海上国道」にあたる
    // 呼び名も都道府県道は持ちません。凡例が地図より細かく分けても、分けた先を
    // 指す線が地図にありません。
    const html = legendPrefHTML();
    expect(html.match(/class="item"/g)).toHaveLength(3);
    expect(html).toContain(PREF_SPECIAL_LABEL);
    expect(html).toContain(`title="${PREF_SPECIAL_TIP}"`);
    expect(PREF_SPECIAL_TIP).toContain('工事中・事業中');
  });

  /* 「道路を選択」の系統ボタンも、押されている間は系統の色で沈みます。都道府県道
     の側の緑は地図の主要地方道と同じ色で、CSS の写しがずれると、押したボタンと
     地図の線が別の緑になります。 */
  test('系統ボタンの緑は、地図の主要地方道と同じ色である', () => {
    expect(styleCss).toContain(`--pref-green: light-dark(${PREF_MAJOR},`);
  });

  test('走れない都道府県道の見本は、格の二色を半分ずつ並べる', () => {
    // 地図では走れない区分も格の色のまま描かれるので(mapspec.mjs の
    // pref-special)、一色では片方の格しか述べられません。破線を描くのは
    // style.css の .legend .swatch.duo > span で、そちらが currentcolor を
    // 読むため、ここが渡すのは border-top-color ではなく color です。
    const html = legendPrefHTML();
    expect(html).toContain(
      '<span class="swatch duo">' +
        `<span style="color:${PREF_MAJOR}"></span>` +
        `<span style="color:${PREF_GENERAL}"></span>` +
        '</span>',
    );
    expect(styleCss).toContain('.legend .swatch.duo > span');
  });

  /* 畳んだ状態を持つ鍵の綴りが一つでもずれると、畳んだまま次に来た人の画面に
   * 凡例が戻る。それがどこも壊さずに起きるので、三つを突き合わせる。 */
  test('凡例の畳み方は、三つのファイルが同じ綴りを使う', () => {
    expect(indexHtml).toContain("localStorage.getItem('legend-open')");
    expect(appJs).toContain("localStorage.setItem('legend-open'");
    expect(indexHtml).toContain("dataset.legend = 'off'");
    expect(appJs).toContain('dataset.legend');
    expect(styleCss).toContain(':root[data-legend="off"] #legend-box');
    expect(styleCss).toContain(':root[data-legend="off"] #legend-open');
  });

  test('凡例には閉じる口と開き直す口の両方がある', () => {
    // 片方しか無いと、畳んだ人が戻れないか、そもそも畳めない。
    expect(indexHtml).toContain('id="legend-close"');
    expect(indexHtml).toContain('id="legend-open"');
    // 開き直す口は自分の外にある物を出すので、何を出すのかを述べる。閉じる口は
    // 閉じる対象の中にいるので述べない——#panel-close・#detail-close と同じ。
    expect(indexHtml).toContain(
      '<button type="button" id="legend-open" aria-controls="legend-box"',
    );
  });

  test('系統ごとの行は頭の語で、どちらの話かを述べる', () => {
    // 同じ画面に二つの尺度が並びます。国道の色は重用の深さ、都道府県道の色は
    // 格です。頭の語が無いと、二つの行が一つの尺度に見えます。
    expect(legendNHTML().startsWith('<span class="lead">国道</span>')).toBe(
      true,
    );
    expect(
      legendPrefHTML().startsWith('<span class="lead">都道府県道</span>'),
    ).toBe(true);
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

  test('更新の間隔が不定期であることを述べる', () => {
    expect(freshness(meta, at('2026-08-16T21:00:00Z'))).toContain(
      '<dt>更新の間隔</dt><dd>不定期</dd>',
    );
  });

  test('どれだけ古くても警告は出さない', () => {
    // 守る間隔を決めていないので、警告を置けば常時点る。常に出ている警告は
    // 情報ではなく背景になる。日付と経過日数だけを出し、判断は閲覧者に委ねる。
    const day = 86400000;
    const base = at(meta.osm_timestamp);
    for (const days of [7, 8, 30, 365]) {
      const html = freshness(meta, base + days * day);
      expect(html).not.toContain('warn');
      expect(html).not.toContain('最近の開通');
      expect(html).toContain(`（${days} 日前）`);
    }
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

/* ------------------------------------ 都道府県道の重用の考え方 --- */
/* 都道府県道の重用は、国道の重用と同じ確かさで出ているわけではありません。数だけ
 * を並べると、出ている数がその路線の重用のすべてだと読まれます。三つはその読みを
 * 止めるためにあるので、文言そのものが仕様です。 */
describe('PREF_CONCURRENCY_NOTES', () => {
  const text = PREF_CONCURRENCY_NOTES.map((n) => n.head + n.body).join('');

  test('三つある', () => {
    expect(PREF_CONCURRENCY_NOTES).toHaveLength(3);
  });

  test('重用が下限であることを、#99 が測った値で述べる', () => {
    expect(text).toContain('11,562.9 km');
    expect(text).toContain('9,187.5 km');
    expect(text).toContain('79.5%');
  });

  test('国道と重用する区間の典拠がリレーションだけであることを述べる', () => {
    expect(text).toContain('ルートリレーション');
  });

  test('国道との重複を重用数に含めていないことを述べる', () => {
    expect(text).toContain('単独指定');
  });

  test('59.8% / 40.8% は出さない', () => {
    // あれは候補 way のうちリレーションが抱える本数の割合で、復元率ではありま
    // せん。画面に置けば延長の割合として読まれます。
    expect(text).not.toContain('59.8');
    expect(text).not.toContain('40.8');
  });
});

describe('prefConcurrencyHTML', () => {
  test('三つとも <details class="fold"> で畳んで入る', () => {
    const html = prefConcurrencyHTML();
    expect(html.match(/<details class="fold">/g)).toHaveLength(3);
    for (const n of PREF_CONCURRENCY_NOTES) {
      expect(html).toContain(`<summary>${n.head}</summary>`);
      expect(html).toContain(`<span>${n.body}</span>`);
    }
  });
});

/* 都道府県道の行は県を述べなければ路線を名指したことになりません。県道 18 号は
 * 47 本あります。 */
describe('prefRowsHTML', () => {
  const rows = [
    { key: 'nagano-63', prefLabel: '長野県', ref: 63 },
    { key: 'tokyo-18', prefLabel: '東京都', ref: 18 },
  ];

  test('鍵をチェックボックスが持ち、県名を字が持つ', () => {
    const html = prefRowsHTML(rows, new Set());
    expect(html).toContain('data-pref="nagano-63"');
    expect(html).toContain('>長野県</span>');
    expect(html).toContain('>東京都</span>');
  });

  test('標識はヘキサで、中は番号だけである', () => {
    // 県名は隣に文字で置きます。この大きさでは標識の中の字は形になりません。
    const html = prefRowsHTML(rows, new Set());
    expect(html).toContain('class="shield hex sm"');
    expect(html).toContain('aria-label="長野県道63号"');
  });

  test('選んでいる行は最初から印が付いている', () => {
    // 打ち直すたびに組み直すので、印は組むときに入れます。
    const html = prefRowsHTML(rows, new Set(['tokyo-18']));
    expect(html).toContain('data-pref="tokyo-18" value="tokyo-18" checked');
    expect(html).toContain('class="pref-row on"');
    expect(html).not.toContain(
      'data-pref="nagano-63" value="nagano-63" checked',
    );
  });
});

describe('prefGroupLabel', () => {
  test('全部出しているときは件数だけを言う', () => {
    expect(prefGroupLabel(47, 47)).toBe('都道府県道 ── 47 件');
  });

  test('切ったときは、切ったと言う', () => {
    // 黙って落とすと「これで全部」と読まれます。
    expect(prefGroupLabel(200, 5123)).toBe('都道府県道 ── 上位 200 / 5,123 件');
  });
});
