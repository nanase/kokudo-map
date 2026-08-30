/* 一つの国道について述べるパネルの中身。
 *
 * ここで壊れやすいのは三つあります。区分別の距離(issue #58)・台帳の起終点
 * (issue #59)・旧道の距離(issue #84)は、どれも組み合わせ表と meta の欄が
 * 揃って初めて埋まるので、欄が無いときに出さないことと、来たときに出す
 * ことの両方を検査します。もう一つは、地名が OpenStreetMap ではなく政令
 * から来るとはいえ、文字列を innerHTML に流す点はポップアップと同じで
 * あることです。
 */
import { describe, expect, test } from 'bun:test';

import {
  decreeTerminiOf,
  detailHTML,
  relatedRoutesOf,
  wikipediaURL,
} from '../web/detail.mjs';
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
  /* `pipeline/pack_web.mjs` が書く形をそのまま写しています。入れ物の名前
   * (`decree.routes`)と、その中の `ref`・`start`・`end`・`how` までを含みます。
   * ここを実物と違う形にしていたために、欄はあるのに詳細の起終点が空のまま
   * でした。名前を思い込みで書くと、この検査は通ったまま画面だけが空になり
   * ます。実データで出ることは `pipeline/render_check.mjs` が確かめます。 */
  const meta = {
    decree: {
      law_num: '昭和四十年政令第五十八号',
      routes: [
        {
          ref: 18,
          via: '安中市　小諸市　上田市　長野市',
          start: { name: '高崎市', lon: 139.0, lat: 36.3, how: 'sole' },
          end: { name: '上越市', lon: 138.2, lat: 37.1, how: 'farthest' },
        },
        // 座標が当たらなかった路線。地名だけを持ちます。
        {
          ref: 20,
          start: { name: '中央区', how: 'no-endpoint' },
          end: { name: '塩尻市', how: 'no-endpoint' },
        },
        { ref: 21, start: null, end: null },
      ],
    },
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
    expect(start.name).toBe('中央区');
    expect(start.at).toBeNull();
  });

  test('読むのは decree.routes である', () => {
    // 見込みで置いていた `decree_termini` を読んでいたので、meta に欄があって
    // も詳細は空のままでした。同じ中身を別の名前で渡しても出ないことを、
    // 名前の取り違えとして固定します。
    const wrong = { decree_termini: meta.decree.routes };
    expect(decreeTerminiOf(wrong, 18)).toEqual([]);
    expect(decreeTerminiOf(meta, 18)).not.toEqual([]);
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

describe('detailHTML — 見出しとボタン', () => {
  test('標識を出し、路線名は読み上げにだけ残す', () => {
    // 標識が路線の名前そのものなので、隣に「国道18号」とは書きません。ただし
    // パネルの aria-labelledby が指す先なので、名前は #detail-title に残します。
    const html = detailHTML({ route: route() });
    expect(html).toContain('aria-label="国道18号"'); // shield() の svg
    expect(html).toContain(
      '<h2 id="detail-title" class="sr-only">国道18号</h2>',
    );
  });

  test('Wikipedia はボタンで、新しいタブで開く', () => {
    const html = detailHTML({ route: route() });
    expect(html).toContain(`href="${wikipediaURL(18)}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('class="icon-btn detail-wiki"');
    // ロゴは写せないので W 一文字で名乗ります。字体は書体が持つので、隣の
    // 漏斗と同じ svg に入れて出します。書体は style.css が当てます。
    expect(html).toContain('<svg viewBox="0 0 24 24" aria-hidden="true">');
    expect(html).toContain('>W</text>');
    expect(html).toContain(
      'aria-label="Wikipedia「国道18号」を新しいタブで開く"',
    );
  });

  test('その路線だけを表示するボタンが番号を持つ', () => {
    const html = detailHTML({ route: route({ ref: 459 }) });
    expect(html).toContain('class="icon-btn detail-only" data-ref="459"');
    // 字が消えてアイコンだけになったので、名乗りは aria-label が持ちます。
    expect(html).toContain('aria-label="国道459号だけを表示"');
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

  // round1() が 0.1 km 未満を切り捨てるので、地図には描かれているのに丸めた
  // 値がちょうど 0 になる区分がある(#88)。行ごと落とすと「階段が 0.0 km
  // ある」より悪い——「階段がある」という事実そのものが消える。
  test('丸めて 0.0 km になる区分は行を落とさず「0.1 km 未満」と出す', () => {
    const html = detailHTML({
      route: route(),
      kinds: [{ kind: 'steps', km: 0.04 }],
    });
    expect(html).toContain(`<dt>${KIND_LABELS.steps}</dt><dd>0.1 km 未満</dd>`);
    expect(html).not.toContain('0.0 km');
  });
});

describe('detailHTML — 旧道', () => {
  // formerKmFor() が拾う「区分別とは別の軸」の距離(#84)。0.0 km と書くより
  // 短いからではなく、旧道を持たない路線が多くあり、持たないことは述べるに
  // 値しないため、行そのものを出さない。重用区間(上のテスト)が「なし」と
  // 書くのとは扱いを変えている。
  test('値が無ければ行ごと出さない(未指定・0)', () => {
    expect(detailHTML({ route: route() })).not.toContain('うち旧道');
    expect(detailHTML({ route: route(), formerKm: 0 })).not.toContain(
      'うち旧道',
    );
  });

  // fmtKm は小数第 1 位までに丸める。丸める前の値で判定すると、0.04 のような
  // 値が「うち旧道 0.0 km」のまま出てしまう。表示する桁——出す判定も同じ
  // 桁——で見る。
  test('丸めて 0.0 km になる値でも出さない', () => {
    expect(detailHTML({ route: route(), formerKm: 0.04 })).not.toContain(
      'うち旧道',
    );
  });

  test('値があれば<dt>うち旧道</dt><dd>N km</dd>を出す', () => {
    const html = detailHTML({ route: route(), formerKm: 30.8 });
    expect(html).toContain('<dt>うち旧道</dt><dd>30.8 km</dd>');
  });

  test('延長の行の直後に来る(区分別より前)', () => {
    // 区分別の合計は延長とほぼ一致する(国道 10 号なら 791.3 km と 791.4 km)。
    // 区分別の下に同じ書体で旧道の行を続けると「四つめの区分」に読める
    // (#26)。延長の直下に置けば、「うち」が指す先の真下に来る。文字列位置
    // を引き算するのではなく、延長と旧道の行がそのまま連続することを直接
    // 見る。
    const html = detailHTML({
      route: route(),
      kinds: [{ kind: 'road', km: 300.2 }],
      formerKm: 30.8,
    });
    expect(html).toMatch(
      /<dt>延長<\/dt><dd>[^<]*<\/dd><dt>うち旧道<\/dt><dd>30\.8 km<\/dd>/,
    );
  });
});

describe('detailHTML — 起点・終点', () => {
  test('起終点が無ければ欄ごと出さない', () => {
    expect(detailHTML({ route: route() })).not.toContain('detail-termini');
  });

  test('座標があれば押せる', () => {
    const html = detailHTML({
      route: route(),
      termini: [{ label: '起点', name: '群馬県高崎市', at: [139.0, 36.3] }],
    });
    expect(html).toContain('data-at="139,36.3"');
    expect(html).toContain('<button type="button" class="end from"');
    expect(html).toContain('aria-label="国道18号の起点(群馬県高崎市)へ移動"');
  });

  test('座標が無ければ押せない', () => {
    const html = detailHTML({
      route: route(),
      termini: [{ label: '起点', name: '東京都中央区', at: null }],
    });
    expect(html).toContain('東京都中央区');
    expect(html).not.toContain('data-at');
    expect(html).not.toContain('<button type="button" class="end');
  });

  test('起点は左、終点は右に寄せる', () => {
    // 寄せる向きだけで両端のどちらであるかを述べるので、向きは中身が持ちます。
    const html = detailHTML({
      route: route(),
      termini: [
        { label: '起点', name: '高崎市', at: [139.0, 36.3] },
        { label: '終点', name: '上越市', at: [138.2, 37.1] },
      ],
    });
    expect(html.indexOf('class="end from"')).toBeLessThan(
      html.indexOf('class="end to"'),
    );
  });

  test('矢印は両端が揃ったときだけ引く', () => {
    const both = detailHTML({
      route: route(),
      termini: [
        { label: '起点', name: '高崎市', at: [139.0, 36.3] },
        { label: '終点', name: '上越市', at: [138.2, 37.1] },
      ],
    });
    expect(both).toContain('class="arrow"');
    // 片方しか無い路線に、行き先の無い矢印は出しません。
    const one = detailHTML({
      route: route(),
      termini: [{ label: '起点', name: '高崎市', at: [139.0, 36.3] }],
    });
    expect(one).not.toContain('class="arrow"');
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

describe('relatedRoutesOf', () => {
  /* `pipeline/pack_web.mjs` が書く三つの欄をそのまま写しています。
   * 18 号を主役にして、重用(117)・起終点の共有(292)・交差(406)を一つずつと、
   * 二つの関わりを同時に持つ相手(19)を置いてあります。 */
  const meta = {
    combinations: [
      { refs: [18, 117], n: 2, km: 4.2 },
      { refs: [18, 19], n: 2, km: 1.1 },
      { refs: [19, 20], n: 2, km: 9.9 },
      { refs: [18], n: 1, km: 300 },
    ],
    shared_termini: [
      { lat: 36.6, lon: 138.1, refs: [18, 19, 292] },
      { lat: 35.0, lon: 137.0, refs: [153, 248] },
    ],
    crossings: [
      [18, 19],
      [18, 292],
      [18, 406],
      [117, 406],
    ],
  };

  const refsOfGroup = (key, ref = 18) =>
    relatedRoutesOf(meta, ref).find((g) => g.key === key)?.refs;

  test('重用は組み合わせ表から拾う', () => {
    expect(refsOfGroup('conc')).toEqual([19, 117]);
  });

  test('起終点の共有は shared_termini から拾う', () => {
    expect(refsOfGroup('termini')).toEqual([292]);
  });

  test('交差は crossings から拾う', () => {
    expect(refsOfGroup('cross')).toEqual([406]);
  });

  test('同じ番号は最も強い関わりの節にだけ出す', () => {
    // 19 は重用も起終点の共有も交差もしています。三つ全部に並べると、同じ
    // 標識が三度出るだけで、読む人が知ることは増えません。
    const groups = relatedRoutesOf(meta, 18);
    const seen = groups.flatMap((g) => g.refs);
    expect(seen.length).toBe(new Set(seen).size);
    expect(refsOfGroup('conc')).toContain(19);
    expect(refsOfGroup('termini')).not.toContain(19);
    expect(refsOfGroup('cross')).not.toContain(19);
    // 292 は起終点を共有し、かつ交差もしています。
    expect(refsOfGroup('cross')).not.toContain(292);
  });

  test('自分自身は出さない', () => {
    for (const g of relatedRoutesOf(meta, 18)) expect(g.refs).not.toContain(18);
  });

  test('番号の順に並べる', () => {
    for (const g of relatedRoutesOf(meta, 18)) {
      expect(g.refs).toEqual([...g.refs].sort((a, b) => a - b));
    }
  });

  test('関わりの無い節は出さない', () => {
    // 248 は起終点を共有するだけで、重用も交差もしていません。
    expect(relatedRoutesOf(meta, 248).map((g) => g.key)).toEqual(['termini']);
    expect(relatedRoutesOf(meta, 999)).toEqual([]);
  });

  test('欄そのものが無い meta でも落ちない', () => {
    // crossings は後から入った欄です。それより前に作った web/data が配られた
    // ままでも、交差の節が出ないだけで他の節は出ます。
    const old = { ...meta, crossings: undefined };
    expect(relatedRoutesOf(old, 18).map((g) => g.key)).toEqual([
      'conc',
      'termini',
    ]);
    expect(relatedRoutesOf({}, 18)).toEqual([]);
    expect(relatedRoutesOf(undefined, 18)).toEqual([]);
  });

  test('番号は文字列で渡されても同じに答える', () => {
    expect(relatedRoutesOf(meta, '18')).toEqual(relatedRoutesOf(meta, 18));
  });
});

describe('detailHTML — 関わりのある国道', () => {
  const related = [
    { key: 'conc', label: '重用する国道', refs: [117] },
    { key: 'cross', label: '交差する国道', refs: [406, 462] },
  ];

  test('関わりが無ければ欄ごと出さない', () => {
    expect(detailHTML({ route: route() })).not.toContain('detail-rel');
  });

  test('節の見出しと標識を出す', () => {
    const html = detailHTML({ route: route(), related });
    expect(html).toContain('重用する国道');
    expect(html).toContain('交差する国道');
    expect(html).toContain('aria-label="国道117号"');
    expect(html).toContain('aria-label="国道462号"');
  });

  test('標識はポップアップと同じ .shield-btn で、押せば開き直せる', () => {
    // 受けるのは app.js の委譲です。ポップアップの見出しと同じ形にしてあるの
    // で、配線は一つで足ります。
    const html = detailHTML({ route: route(), related });
    expect(html).toContain(
      '<button type="button" class="shield-btn" data-ref="406" ' +
        'title="国道406号の詳細">',
    );
  });

  test('小さいほうの標識を使う', () => {
    // 交差する路線は 35 まであります。見出しの 44px で並べるとパネルが埋まります。
    expect(detailHTML({ route: route(), related })).toContain(
      '<span class="shield sm">',
    );
  });
});
