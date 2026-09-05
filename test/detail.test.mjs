/* 一つの国道の詳細パネルの中身。壊れやすいのは、区分別の距離(#58)・政令上の
 * 起終点(#59)・旧道の距離(#84)が組み合わせ表と meta の欄が揃って初めて埋まる
 * ことで、欄が無いときに出さないことと来たときに出すことの両方を検査します。
 * もう一つは、地名が政令から来るとはいえ文字列を innerHTML に流す点は
 * ポップアップと同じであることです。
 */
import { describe, expect, test } from 'bun:test';

import {
  continuationCountOf,
  continuationOf,
  decreeTerminiOf,
  detailHTML,
  fmtKm,
  onlyButtonHTML,
  prefDetailHTML,
  prefWikipediaURL,
  relatedRoutesOf,
  WIKIPEDIA_ICON,
  wikipediaURL,
} from '../web/detail.mjs';
import { KIND_LABELS, PREF_KIND_LABELS } from '../web/popup.mjs';
import { comparePrefKeys } from '../web/prefroute.mjs';

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
  /* `pipeline/pack_web.mjs` が書く形(`decree.routes` と、その中の `ref`・
   * `start`・`end`・`how`)をそのまま写しています。実物と違う形にしていた
   * ために、欄はあるのに詳細の起終点が空のままでした。実データで出ることは
   * `pipeline/render_check.mjs` が確かめます。 */
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
    // パネルの aria-labelledby が指す先なので、名前は #detail-title に
    // 残します。
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
    // ロゴは写せないので W 一文字で名乗ります。印そのものは detail.mjs の
    // WIKIPEDIA_ICON が持つので、SHIELD_PATH と同じように本物を import して
    // 突き合わせます。写せば同じ答えが二箇所に並びます。
    expect(html).toContain(WIKIPEDIA_ICON);
    expect(html).toContain(
      'aria-label="Wikipedia「国道18号」を新しいタブで開く"',
    );
  });

  test('その路線だけを表示するボタンが番号を持つ', () => {
    const html = detailHTML({ route: route({ ref: 459 }) });
    expect(html).toContain('class="icon-btn detail-only" data-ref="459"');
    // 字が消えてアイコンだけになったので、ラベルは aria-label が持ちます。
    expect(html).toContain('aria-label="国道459号だけを表示"');
  });

  /* 都道府県道のパネル(prefDetailHTML)と同じボタンです。押した状態を
   * 持たなかったころ、国道は押して 1 本にできるのに、同じ場所で
   * 解除できませんでした。 */
  test('押した状態は active と aria-pressed と名乗りに出る', () => {
    const off = detailHTML({ route: route({ ref: 459 }) });
    expect(off).toContain('class="icon-btn detail-only"');
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('国道459号だけを表示');

    const on = detailHTML({ route: route({ ref: 459 }), selected: true });
    expect(on).toContain('class="icon-btn detail-only active"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('国道459号だけの表示を解除');
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
    // 生成側が新しい区分を足したとき、空欄になるより生の値が
    // 見えたほうがよいです。
    const html = detailHTML({
      route: route(),
      kinds: [{ kind: 'newkind', km: 1 }],
    });
    expect(html).toContain('newkind');
  });

  // round1() が 0.1 km 未満を切り捨てるので、地図には描かれているのに丸めた値が
  // 0 になる区分がある(#88)。行ごと落とすと「階段がある」事実そのものが消える。
  test('丸めて 0.0 km になる区分は行を落とさず「0.1 km 未満」と出す', () => {
    const html = detailHTML({
      route: route(),
      kinds: [{ kind: 'steps', km: 0.04 }],
    });
    // 期待値も fmtKm で組む。'0.1' と書き写すと、小数点にコンマを使うロケール
    // で実装の出力(fmtKm(0.1))と食い違う。
    expect(html).toContain(
      `<dt>${KIND_LABELS.steps}</dt><dd>${fmtKm(0.1)} km 未満</dd>`,
    );
    expect(html).not.toContain(`${fmtKm(0)} km</dd>`);
  });
});

describe('detailHTML — 旧道', () => {
  // formerKmFor() が拾う、区分別とは別の軸の距離(#84)。旧道を持たない路線が
  // 多く、持たないことは書くに値しないので行そのものを出さない。重用区間が
  // 「なし」と書くのとは扱いが違う。
  test('値が無ければ行ごと出さない(未指定・0)', () => {
    expect(detailHTML({ route: route() })).not.toContain('うち旧道');
    expect(detailHTML({ route: route(), formerKm: 0 })).not.toContain(
      'うち旧道',
    );
  });

  // fmtKm は小数第 1 位までに丸める。丸める前の値で判定すると 0.04 が「うち旧道
  // 0.0 km」のまま出るので、表示する桁で見る。
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
    // 区分別の下に続けると「四つめの区分」に読める(#26)。延長と旧道の
    // 行がそのまま連続することを直接見る。
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

  test('同じ番号は最も強い関わりの区画にだけ出す', () => {
    // 19 は重用も起終点の共有も交差もしています。三つ全部に並べると、同じ
    // 標識が三度出るだけで、読む人が知ることは増えません。
    const groups = relatedRoutesOf(meta, 18);
    const seen = groups.flatMap((g) => g.refs);
    expect(seen.length).toBe(new Set(seen).size);
    expect(refsOfGroup('conc')).toContain(19);
    expect(refsOfGroup('termini')).not.toContain(19);
    expect(refsOfGroup('cross')).not.toContain(19);
    // 292 は起終点が重なり、かつ交差もしています。
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

  test('関わりの無い区画は出さない', () => {
    // 248 は起終点が重なるだけで、重用も交差もしていません。
    expect(relatedRoutesOf(meta, 248).map((g) => g.key)).toEqual(['termini']);
    expect(relatedRoutesOf(meta, 999)).toEqual([]);
  });

  test('欄そのものが無い meta でも落ちない', () => {
    // crossings は後から入った欄です。それより前に作った web/data が配られた
    // ままでも、交差の区画が出ないだけで他の区画は出ます。
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

  test('区画の見出しと標識を出す', () => {
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
    // 交差する路線は 35 まであります。見出しの 44px で並べるとパネルが
    // 埋まります。
    expect(detailHTML({ route: route(), related })).toContain(
      '<span class="shield sm">',
    );
  });
});

/* ---------------------------------------------------------- 都道府県道 --- */
describe('prefWikipediaURL', () => {
  test('「<県>道N号」で引く。路線名は入れない', () => {
    expect(prefWikipediaURL('長野県', 63)).toBe(
      `https://ja.wikipedia.org/wiki/${encodeURIComponent('長野県道63号')}`,
    );
  });

  test('県・都・府・道の呼び分けは県の名前が持つ', () => {
    // 「県道」「都道」「府道」「道道」は、県の名前の末尾が既に持っています。
    // 呼び分けの表は要りません。
    for (const [label, want] of [
      ['東京都', '東京都道7号'],
      ['大阪府', '大阪府道7号'],
      ['北海道', '北海道道7号'],
    ]) {
      expect(prefWikipediaURL(label, 7)).toBe(
        `https://ja.wikipedia.org/wiki/${encodeURIComponent(want)}`,
      );
    }
  });

  test('県が違えば別の記事を指す。番号だけでは決まらない', () => {
    expect(prefWikipediaURL('長野県', 18)).not.toBe(
      prefWikipediaURL('愛知県', 18),
    );
  });
});

describe('relatedRoutesOf — 都道府県道', () => {
  /* pack_web_pref.mjs が県ごとに書く二つの欄です。`shared_termini`
   * はありません。都道府県道には全国 1 枚の起終点の表がないためです。 */
  const meta = {
    combinations: [
      { refs: ['nagano-60'], n: 1, km: 20 },
      { refs: ['nagano-60', 'nagano-399'], n: 2, km: 1.9 },
      { refs: ['nagano-60', 'nagano-366'], n: 2, km: 0.4 },
      { refs: ['nagano-96', 'nagano-373'], n: 2, km: 3 },
    ],
    crossings: [
      ['nagano-60', 'nagano-96'],
      ['nagano-60', 'nagano-373'],
      ['nagano-60', 'nagano-399'],
    ],
  };
  const opts = {
    system: '都道府県道',
    compare: comparePrefKeys,
    normalize: String,
  };
  const groups = relatedRoutesOf(meta, 'nagano-60', opts);
  const pick = (key) => groups.find((g) => g.key === key)?.refs;

  test('鍵のまま拾い、番号の順に並べる', () => {
    expect(pick('conc')).toEqual(['nagano-366', 'nagano-399']);
    expect(pick('cross')).toEqual(['nagano-96', 'nagano-373']);
  });

  test('重用する相手を交差にも出さない', () => {
    // 399 は交差の欄にもいますが、重用として既に言ってあります。
    expect(pick('cross')).not.toContain('nagano-399');
  });

  test('起終点の区画は出ない。県別 meta がその欄を持たない', () => {
    expect(groups.map((g) => g.key)).toEqual(['conc', 'cross']);
  });

  test('見出しは都道府県道と名乗る', () => {
    expect(groups.map((g) => g.label)).toEqual([
      '重用する都道府県道',
      '交差する都道府県道',
    ]);
  });
});

describe('prefDetailHTML', () => {
  const prefRoute = {
    ref: 'nagano-60',
    km: 23.5,
    arcs: 41,
    conc_km: 1.9,
    max_n: 2,
  };
  const full = (over) =>
    prefDetailHTML({
      prefLabel: '長野県',
      ref: 60,
      route: prefRoute,
      rank: 'major',
      kinds: [{ kind: 'road', km: 23.5 }],
      related: [
        { key: 'conc', label: '重用する都道府県道', refs: ['nagano-399'] },
      ],
      ...over,
    });

  test('見出しは路線の名前を出す。ヘキサは県を持たない', () => {
    expect(full()).toContain('class="shield hex"');
    expect(full()).toContain('>長野県道60号</h2>');
    // 国道のパネルは名前を伏せます。おにぎりの番号がそのまま名前だからです。
    expect(detailHTML({ route: route() })).toContain('class="sr-only"');
  });

  test('Wikipedia へ送る', () => {
    expect(full()).toContain(`href="${prefWikipediaURL('長野県', 60)}"`);
  });

  /* 操作パネルに都道府県道の区画は無いので、選んでいることを示す場所も解除する
   * 操作も、このボタンのほかにありません(#109)。 */
  test('「だけを表示」は県を伴う鍵を持つ', () => {
    expect(full({ region: 'nagano' })).toContain(
      'class="icon-btn detail-only" data-pref="nagano-60"',
    );
  });

  /* 見た目は `active`、読み上げは `aria-pressed` が持ちます。二つに分けるのは
     地図の上のトグルボタン(app.js の cycleButton)と同じ作法です。 */
  test('押した状態は active と aria-pressed と名乗りに出る', () => {
    const off = full({ region: 'nagano' });
    expect(off).toContain('class="icon-btn detail-only"');
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('長野県道60号だけを表示');

    const on = full({ region: 'nagano', selected: true });
    expect(on).toContain('class="icon-btn detail-only active"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('長野県道60号だけの表示を解除');
  });

  /* 県が分からなければキーを作れません。県を伴わない呼び出しでは、押しても何も
   * 指せないボタンを出さないでおきます。 */
  test('県を渡さなければボタンごと出さない', () => {
    expect(full()).not.toContain('detail-only');
  });

  test('数が届く前も、読めなかったときも、ボタンは出したままにする', () => {
    expect(full({ region: 'nagano', route: null })).toContain('detail-only');
    expect(full({ region: 'nagano', failed: true })).toContain('detail-only');
  });

  test('起終点は出さない。都道府県道に全国 1 枚の起終点の表が無い', () => {
    expect(full()).not.toContain('detail-termini');
  });

  test('数と区分別を出し、区分は都道府県道の言い方にする', () => {
    const html = prefDetailHTML({
      prefLabel: '長野県',
      ref: 60,
      route: prefRoute,
      kinds: [{ kind: 'ferry', km: 1.2 }],
    });
    expect(html).toContain('<dt>延長</dt><dd>23.5 km</dd>');
    expect(html).toContain('<dt>重用区間</dt><dd>1.9 km</dd>');
    expect(html).toContain('<dt>最大重用数</dt><dd>2 重用</dd>');
    expect(html).toContain(PREF_KIND_LABELS.ferry);
    expect(html).not.toContain(KIND_LABELS.ferry);
  });

  test('0.1 km 未満の区分は「0.1 km 未満」と出す(#93 と同じ作法)', () => {
    const html = prefDetailHTML({
      prefLabel: '長野県',
      ref: 60,
      route: prefRoute,
      kinds: [{ kind: 'steps', km: 0 }],
    });
    expect(html).toContain(`${fmtKm(0.1)} km 未満`);
    expect(html).not.toContain(`<dd>${fmtKm(0)} km</dd>`);
  });

  test('種別は渡されたときだけ出す', () => {
    expect(full()).toContain('<dt>種別</dt><dd>主要地方道</dd>');
    expect(full({ rank: null })).not.toContain('<dt>種別</dt>');
  });

  test('重用を持たない路線は「なし」と言う', () => {
    const html = prefDetailHTML({
      prefLabel: '長野県',
      ref: 60,
      route: { ...prefRoute, conc_km: 0, max_n: 1 },
    });
    expect(html).toContain('<dt>重用区間</dt><dd>なし</dd>');
    expect(html).toContain('<dt>最大重用数</dt><dd>単独指定</dd>');
  });

  test('関わりのある路線の標識も県を伴う鍵を持つ', () => {
    expect(full()).toContain('data-pref="nagano-399"');
    expect(full()).toContain('class="shield hex sm"');
  });

  test('重用の但し書きはパネルに出さない', () => {
    // 置き場所は「国道マップについて」です(panel.mjs)。パネルは 1 路線の数を
    // 述べる場所で、数え方そのものを述べる場所ではありません。
    const html = full();
    expect(html).not.toContain('11,562.9');
    expect(html).not.toContain('79.5%');
  });

  test('数が届く前は待たせる。見出しは先に出す', () => {
    const html = prefDetailHTML({ prefLabel: '長野県', ref: 60 });
    expect(html).toContain('>長野県道60号</h2>');
    expect(html).toContain('読み込んでいます');
    expect(html).not.toContain('<dt>延長</dt>');
  });

  test('読めなかったときはそう言う', () => {
    const html = prefDetailHTML({ prefLabel: '長野県', ref: 60, failed: true });
    expect(html).toContain('読み込めませんでした');
    expect(html).not.toContain('読み込んでいます');
  });
});

/* 県境で続く路線の区画(#155・#162)。数え方は例外表を持たない規則なので、
 * 都・道・府・県 の組み合わせを全部当てられます。567 群のうち 136 群は「県」
 * だけでは言えないので、ここが崩れると 4 分の 1 の群が嘘の見出しを持ちます。 */
describe('continuationCountOf', () => {
  const SUFFIX = ['都', '道', '府', '県'];
  const LABEL = { 都: '東京都', 道: '北海道', 府: '大阪府', 県: '長野県' };

  test('群に入っている 都・道・府・県 だけを、都 → 道 → 府 → 県 の順に並べる', () => {
    // 空でない部分集合 15 通りを全部当てます。順は並べ方であって、渡した順では
    // ありません。
    for (let bits = 1; bits < 16; bits++) {
      const kinds = SUFFIX.filter((_, i) => bits & (1 << i));
      const labels = kinds.map((k) => LABEL[k]);
      const want = `${kinds.length}${kinds.join('')}`;
      expect(continuationCountOf(labels)).toBe(want);
      expect(continuationCountOf([...labels].reverse())).toBe(want);
    }
  });

  test('実データの群を当てる', () => {
    expect(continuationCountOf(['長野県', '愛知県', '静岡県'])).toBe('3県');
    expect(continuationCountOf(['千葉県', '埼玉県', '東京都'])).toBe('3都県');
    expect(continuationCountOf(['京都府', '大阪府'])).toBe('2府');
    expect(continuationCountOf(['栃木県', '群馬県', '茨城県', '埼玉県'])).toBe(
      '4県',
    );
  });

  test('数は群の県の数である。同じ字が続いても足し合わない', () => {
    expect(continuationCountOf(['長野県', '愛知県'])).toBe('2県');
    expect(continuationCountOf(['京都府', '大阪府', '兵庫県'])).toBe('3府県');
  });

  test('同じ県が 2 度入っても 1 度しか数えない', () => {
    // 県境を 2 度またぐ路線が作る群です。秋田県道131号・秋田県道210号・
    // 山形県道210号 は 3 本で 2 県です(#162)。本数を出すと `3県` になります。
    expect(continuationCountOf(['秋田県', '秋田県', '山形県'])).toBe('2県');
    expect(continuationCountOf(['長野県', '山梨県', '長野県'])).toBe('2県');
  });
});

describe('continuationOf', () => {
  const meta = {
    continuations: [
      {
        refs: ['aichi-1', 'nagano-1', 'shizuoka-1'],
        name: '飯田富山佐久間線',
        km: 91.4,
        src: 'both',
      },
      { refs: ['gunma-93', 'nagano-93'], name: '下仁田臼田線', km: 34.5 },
    ],
  };

  test('自分が入っている群を返す', () => {
    expect(continuationOf(meta, 'nagano-1')?.name).toBe('飯田富山佐久間線');
    expect(continuationOf(meta, 'shizuoka-1')?.name).toBe('飯田富山佐久間線');
    expect(continuationOf(meta, 'nagano-93')?.name).toBe('下仁田臼田線');
  });

  test('群に入らない路線には何も返さない', () => {
    expect(continuationOf(meta, 'nagano-152')).toBeNull();
  });

  /* 欄は後から入りました。古い web/data を配ったままでも、区画が出ないだけで
   * 壊れてはいけません。`crossings` と同じ事情です。 */
  test('欄を持たない meta でも落ちない', () => {
    expect(continuationOf({}, 'nagano-1')).toBeNull();
    expect(continuationOf(null, 'nagano-1')).toBeNull();
  });
});

describe('prefDetailHTML — 複数の都道府県にわたる区画', () => {
  const prefLabels = new Map([
    ['nagano', '長野県'],
    ['aichi', '愛知県'],
    ['shizuoka', '静岡県'],
    ['gifu', '岐阜県'],
    ['chiba', '千葉県'],
    ['saitama', '埼玉県'],
    ['tokyo', '東京都'],
    ['kyoto', '京都府'],
    ['osaka', '大阪府'],
    ['tochigi', '栃木県'],
    ['gunma', '群馬県'],
    ['ibaraki', '茨城県'],
  ]);
  const panel = (region, ref, continuation) =>
    prefDetailHTML({
      region,
      prefLabel: prefLabels.get(region),
      ref,
      route: {
        ref: `${region}-${ref}`,
        km: 45,
        arcs: 137,
        conc_km: 3.4,
        max_n: 2,
      },
      related: [
        { key: 'conc', label: '重用する都道府県道', refs: [`${region}-83`] },
      ],
      continuation,
      prefLabels,
    });

  const NAGANO1 = {
    refs: ['aichi-1', 'nagano-1', 'shizuoka-1'],
    name: '飯田富山佐久間線',
    km: 91.4,
    src: 'both',
  };

  test('見出しは群の中身どおりに数える', () => {
    expect(panel('nagano', 1, NAGANO1)).toContain(
      '>3県にわたる都道府県道</span>',
    );
    expect(
      panel('chiba', 54, {
        refs: ['chiba-54', 'saitama-54', 'tokyo-54'],
        name: '松戸草加線',
        km: 27.3,
      }),
    ).toContain('>3都県にわたる都道府県道</span>');
    expect(
      panel('kyoto', 6, {
        refs: ['kyoto-6', 'osaka-6'],
        name: '枚方亀岡線',
        km: 33.5,
      }),
    ).toContain('>2府にわたる都道府県道</span>');
    expect(
      panel('tochigi', 9, {
        refs: ['gunma-9', 'ibaraki-9', 'saitama-9', 'tochigi-9'],
        name: '佐野古河線',
        km: 20.3,
      }),
    ).toContain('>4県にわたる都道府県道</span>');
  });

  test('合算延長は区画が持つ。統計の <dl> は県別の値のまま', () => {
    const html = panel('nagano', 1, NAGANO1);
    expect(html).toContain('あわせて 91.4 km');
    // 県別の延長は 45.0 km です。両方が同じ画面に出ますが、置き場所が違います。
    expect(html).toContain('<dt>延長</dt><dd>45.0 km</dd>');
    expect(html).not.toContain('<dd>91.4 km</dd>');
  });

  test('路線名を出す', () => {
    expect(panel('nagano', 1, NAGANO1)).toContain(
      '<div class="cont-name">飯田富山佐久間線</div>',
    );
  });

  /* 538 群のうち 27 群では名前が取れません。欄そのものが無い形で来るので、
   * 行ごと出しません。名前が無いことを理由に群を落とすことはしません。 */
  test('名前が取れない群では行ごと出さない', () => {
    const html = panel('aichi', 193, {
      refs: ['aichi-193', 'gifu-193'],
      km: 19.2,
      src: 'geometry',
    });
    expect(html).toContain('>2県にわたる都道府県道</span>');
    expect(html).toContain('あわせて 19.2 km');
    expect(html).not.toContain('cont-name');
  });

  test('相手のチップは県名を伴い、押せばその県の詳細に開き直る', () => {
    const html = panel('nagano', 1, NAGANO1);
    expect(html).toContain('data-pref="aichi-1"');
    expect(html).toContain('data-pref="shizuoka-1"');
    expect(html).toContain('<span class="pref">愛知県</span>');
    expect(html).toContain('title="愛知県道1号の詳細"');
    // 押した先を決めるのは app.js の委譲です。重用・交差の標識と同じ口を使う
    // ので、新しい委譲は要りません。
    expect(html).toContain('class="shield-btn cont-chip"');
  });

  /* チップに並ぶ鍵。`refs` には自分自身も入っているので、外して並べます。
   * 自分の標識は見出しに出ています。 */
  const chipsOf = (html) =>
    [...html.matchAll(/cont-chip" data-pref="([^"]+)"/g)].map((m) => m[1]);

  test('自分自身はチップに出さない。標識は見出しに出ている', () => {
    const html = panel('nagano', 1, NAGANO1);
    expect(chipsOf(html)).toEqual(['aichi-1', 'shizuoka-1']);
    // 見出しの「だけを表示」は自分を名指します。チップと同じ属性を使うので、
    // 「出ていない」はパネル全体ではなくチップの中で言います。
    expect(html).toContain('class="icon-btn detail-only" data-pref="nagano-1"');
  });

  test('チップは meta の並び(番号順・県名順)のまま出す', () => {
    expect(
      chipsOf(
        panel('tochigi', 9, {
          refs: ['gunma-9', 'ibaraki-9', 'saitama-9', 'tochigi-9'],
          name: '佐野古河線',
          km: 20.3,
        }),
      ),
    ).toEqual(['gunma-9', 'ibaraki-9', 'saitama-9']);
  });

  /* 県境の向こうまで同じ道であることは、一点で交わることより強い関わりです。
   * 区画の順もそう並べます。 */
  test('関わりの区画より前に来る', () => {
    const html = panel('nagano', 1, NAGANO1);
    expect(html.indexOf('detail-cont')).toBeGreaterThan(-1);
    expect(html.indexOf('detail-cont')).toBeLessThan(
      html.indexOf('重用する都道府県道'),
    );
  });

  /* 見出しのボタンだけを数えます。区画の中にも絞り込みアイコンが居る(#155)
   * ので、パネル全体を数えると区画が出たかどうかで答えが変わってしまいます。 */
  const headButtons = (html) =>
    html.slice(0, html.indexOf('</header>')).match(/class="icon-btn/g)
      ?.length ?? 0;

  test('群に入らない路線では区画そのものが出ない', () => {
    const html = panel('nagano', 152, null);
    expect(html).not.toContain('detail-cont');
    expect(html).not.toContain('にわたる都道府県道');
    // 見出しのボタンの数は変わりません。Wikipedia と絞り込みアイコンの二つの
    // ままです。
    expect(headButtons(html)).toBe(2);
  });

  test('見出しのボタンは群があっても増えない', () => {
    expect(headButtons(panel('nagano', 1, NAGANO1))).toBe(2);
  });

  test('数が届く前は区画も出ない', () => {
    const html = prefDetailHTML({
      region: 'nagano',
      prefLabel: '長野県',
      ref: 1,
      continuation: NAGANO1,
      prefLabels,
    });
    expect(html).toContain('読み込んでいます');
    expect(html).not.toContain('detail-cont');
  });
});

/* 区画の絞り込みアイコン(#155)。見出しの絞り込みアイコンと同じ部品で、鍵が群
 * になり名乗りが変わるだけです。絵も押した状態の持ち方も同じにしてあります。 */
describe('onlyButtonHTML — 群', () => {
  const GROUP = ['aichi-1', 'nagano-1', 'shizuoka-1'];
  const btn = (over) =>
    onlyButtonHTML({ prefKeys: GROUP, count: '3県', ...over });

  test('群の全員を data-prefs で名指す', () => {
    expect(btn()).toContain('data-prefs="aichi-1,nagano-1,shizuoka-1"');
    // 1 本を名指す属性は出しません。押した先を取り違えます。
    expect(btn()).not.toContain('data-pref="');
    expect(btn()).not.toContain('data-ref=');
  });

  test('名乗りは数え方から組む', () => {
    expect(btn()).toContain('aria-label="3県まとめて表示"');
    expect(btn()).toContain('title="3県まとめて表示"');
  });

  test('押している間は解除と名乗る', () => {
    expect(btn({ selected: true })).toContain(
      'aria-label="まとめての表示を解除"',
    );
  });

  test('押した状態の持ち方は見出しの絞り込みアイコンと同じである', () => {
    expect(btn()).toContain('class="icon-btn detail-only"');
    expect(btn()).toContain('aria-pressed="false"');
    expect(btn({ selected: true })).toContain(
      'class="icon-btn detail-only active"',
    );
    expect(btn({ selected: true })).toContain('aria-pressed="true"');
  });

  /* 絵は変えません。範囲は絵ではなく置き場所が述べます。見出しの絞り込み
   * アイコンの隣には標識と路線名があり、区画の絞り込みアイコンの隣には相手の
   * チップがあります。 */
  test('絵は見出しの絞り込みアイコンと同じである', () => {
    const one = onlyButtonHTML({ ref: 18 });
    const icon = one.slice(one.indexOf('<svg'), one.indexOf('</button>'));
    expect(btn()).toContain(icon);
  });
});
