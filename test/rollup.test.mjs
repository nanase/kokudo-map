/* 県境で番号が変わらずに続く路線を束ねる計算です。ここが捕まえるのは、群が
 * 膨らむ方向の間違いです。番号の違う隣接を辺にすると、埼玉と東京の 24・25・36・
 * 234 号が 8 路線の塊になります。同じ県どうしを辺にすると、県内の交差点が全部
 * 群になります。どちらも「つながっている」と言えてしまうぶん、出来上がった数を
 * 見ただけでは間違いに見えません。
 *
 * 路線名の側は逆で、落とす方向の間違いを捕まえます。前置きの外し方を間違えると
 * 名前が丸ごと消え、名前の無い群として静かに配られます。
 */
import { describe, expect, test } from 'bun:test';

import {
  addEndpoints,
  borderPairs,
  groupsOf,
  pickName,
  relationRouteName,
  sharedRouteName,
} from '../pipeline/rollup.mjs';

/** アーク 1 本。端点だけを見るので、途中の節点も置ける。 */
const arc = (refs, coords) => ({
  refs_list: refs,
  geometry: { coordinates: coords },
});

const num = (key) => Number(key.slice(key.lastIndexOf('-') + 1));
const prefOf = (key) => key.slice(0, key.lastIndexOf('-'));
const partsOf = (key) => [prefOf(key), num(key)];
const byRef = (a, b) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0);

describe('addEndpoints', () => {
  test('端だけを索引に入れ、途中の節点は入れない', () => {
    const at = addEndpoints([
      arc(
        ['nagano-1'],
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      ),
    ]);
    expect([...at.keys()].sort()).toEqual(['0,0', '2,2']);
  });

  test('県ごとに何度呼んでも同じ索引に積める', () => {
    const at = new Map();
    addEndpoints(
      [
        arc(
          ['nagano-1'],
          [
            [0, 0],
            [1, 1],
          ],
        ),
      ],
      at,
    );
    addEndpoints(
      [
        arc(
          ['aichi-1'],
          [
            [1, 1],
            [2, 2],
          ],
        ),
      ],
      at,
    );
    expect([...at.get('1,1')].sort()).toEqual(['aichi-1', 'nagano-1']);
  });

  test('一本しか踏まない端点は配列のまま置かれる', () => {
    const at = addEndpoints([
      arc(
        ['nagano-1'],
        [
          [0, 0],
          [1, 1],
        ],
      ),
    ]);
    expect(Array.isArray(at.get('0,0'))).toBe(true);
  });
});

describe('borderPairs', () => {
  const pairsOf = (feats) => borderPairs(addEndpoints(feats), partsOf);

  test('番号が同じで県が違えば組になる', () => {
    expect(
      pairsOf([
        arc(
          ['nagano-1'],
          [
            [0, 0],
            [1, 1],
          ],
        ),
        arc(
          ['aichi-1'],
          [
            [1, 1],
            [2, 2],
          ],
        ),
      ]),
    ).toEqual([['aichi-1', 'nagano-1']]);
  });

  test('番号が違う隣接は採らない', () => {
    expect(
      pairsOf([
        arc(
          ['saitama-24'],
          [
            [0, 0],
            [1, 1],
          ],
        ),
        arc(
          ['tokyo-234'],
          [
            [1, 1],
            [2, 2],
          ],
        ),
      ]),
    ).toEqual([]);
  });

  test('同じ県どうしは採らない', () => {
    expect(
      pairsOf([
        arc(
          ['nagano-1'],
          [
            [0, 0],
            [1, 1],
          ],
        ),
        arc(
          ['nagano-152'],
          [
            [1, 1],
            [2, 2],
          ],
        ),
      ]),
    ).toEqual([]);
  });

  test('端点を共有しなければ組にならない', () => {
    expect(
      pairsOf([
        arc(
          ['nagano-1'],
          [
            [0, 0],
            [1, 1],
          ],
        ),
        arc(
          ['aichi-1'],
          [
            [9, 9],
            [8, 8],
          ],
        ),
      ]),
    ).toEqual([]);
  });

  test('片方の途中の節点で触れているだけでは組にならない', () => {
    expect(
      pairsOf([
        arc(
          ['nagano-1'],
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        ),
        arc(
          ['aichi-1'],
          [
            [1, 1],
            [3, 3],
          ],
        ),
      ]),
    ).toEqual([]);
  });

  test('重用しているアークどうしでも、番号が同じ組だけを拾う', () => {
    expect(
      pairsOf([
        arc(
          ['nagano-1', 'nagano-152'],
          [
            [0, 0],
            [1, 1],
          ],
        ),
        arc(
          ['aichi-1', 'aichi-9'],
          [
            [1, 1],
            [2, 2],
          ],
        ),
      ]),
    ).toEqual([['aichi-1', 'nagano-1']]);
  });

  test('同じ組が何度出ても 1 つに畳む', () => {
    expect(
      pairsOf([
        arc(
          ['nagano-1'],
          [
            [0, 0],
            [1, 1],
          ],
        ),
        arc(
          ['aichi-1'],
          [
            [1, 1],
            [2, 2],
          ],
        ),
        arc(
          ['nagano-1'],
          [
            [5, 5],
            [1, 1],
          ],
        ),
      ]),
    ).toEqual([['aichi-1', 'nagano-1']]);
  });
});

describe('groupsOf', () => {
  test('つながる組をひと続きの群にする', () => {
    const [g] = groupsOf(
      [
        ['nagano-1', 'aichi-1', 'geometry'],
        ['aichi-1', 'shizuoka-1', 'geometry'],
      ],
      byRef,
    );
    expect(g.refs).toEqual(['aichi-1', 'nagano-1', 'shizuoka-1']);
  });

  test('つながらない組は別々の群になる', () => {
    expect(
      groupsOf(
        [
          ['nagano-1', 'aichi-1', 'geometry'],
          ['gunma-93', 'nagano-93', 'geometry'],
        ],
        byRef,
      ).map((g) => g.refs),
    ).toEqual([
      ['aichi-1', 'nagano-1'],
      ['gunma-93', 'nagano-93'],
    ]);
  });

  test('片方の信号しか出さなければ、その出どころを名乗る', () => {
    expect(groupsOf([['nagano-1', 'aichi-1', 'relation']], byRef)[0].src).toBe(
      'relation',
    );
  });

  test('二つの信号が同じ群を出せば both になる', () => {
    expect(
      groupsOf(
        [
          ['nagano-1', 'aichi-1', 'geometry'],
          ['nagano-1', 'aichi-1', 'relation'],
        ],
        byRef,
      )[0].src,
    ).toBe('both');
  });

  test('片方の信号が伸ばした群も both になる', () => {
    const [g] = groupsOf(
      [
        ['nagano-1', 'aichi-1', 'relation'],
        ['aichi-1', 'shizuoka-1', 'geometry'],
      ],
      byRef,
    );
    expect(g.refs.length).toBe(3);
    expect(g.src).toBe('both');
  });

  test('群も群の中も、番号順・県名順に並ぶ', () => {
    expect(
      groupsOf(
        [
          ['tokyo-54', 'chiba-54', 'geometry'],
          ['nagano-1', 'aichi-1', 'geometry'],
        ],
        byRef,
      ).map((g) => g.refs),
    ).toEqual([
      ['aichi-1', 'nagano-1'],
      ['chiba-54', 'tokyo-54'],
    ]);
  });

  test('辺が無ければ群も無い', () => {
    expect(groupsOf([], byRef)).toEqual([]);
  });
});

describe('relationRouteName', () => {
  test('県道N号の前置きを外す', () => {
    expect(relationRouteName('岐阜県道・三重県道23号　北方多度線')).toBe(
      '北方多度線',
    );
  });

  test('県が 1 つでも外す', () => {
    expect(relationRouteName('長野県道1号飯田富山佐久間線')).toBe(
      '飯田富山佐久間線',
    );
  });

  test('都と府も外す', () => {
    expect(relationRouteName('東京都道・埼玉県道54号松戸草加線')).toBe(
      '松戸草加線',
    );
    expect(relationRouteName('京都府道・大阪府道6号枚方亀岡線')).toBe(
      '枚方亀岡線',
    );
  });

  test('前置きが無ければそのまま採る', () => {
    expect(relationRouteName('飯田富山佐久間線')).toBe('飯田富山佐久間線');
  });

  test('番号までしか無い名前からは採らない', () => {
    expect(relationRouteName('岩手県道・秋田県道1号')).toBeNull();
  });

  test('name が無ければ採らない', () => {
    expect(relationRouteName(null)).toBeNull();
    expect(relationRouteName(undefined)).toBeNull();
  });

  test('路線名の中の 号 は残す', () => {
    expect(relationRouteName('東京都道318号環状七号線')).toBe('環状七号線');
  });

  test('種別の前置きも外す', () => {
    expect(relationRouteName('主要地方道沼田檜枝岐線')).toBe('沼田檜枝岐線');
    expect(relationRouteName('一般県道甲乙線')).toBe('甲乙線');
  });

  test('県道N号と種別が続いていても外す', () => {
    expect(
      relationRouteName('群馬県道・長野県道94号主要地方道東御嬬恋線'),
    ).toBe('東御嬬恋線');
  });
});

describe('pickName', () => {
  test('多い方を採る', () => {
    expect(
      pickName(
        new Map([
          ['甲線', 1],
          ['乙線', 4],
        ]),
      ),
    ).toBe('乙線');
  });

  test('同数なら短い方を採る', () => {
    expect(
      pickName(
        new Map([
          ['飯田富山佐久間線', 2],
          ['佐久間線', 2],
        ]),
      ),
    ).toBe('佐久間線');
  });

  test('同数で同じ長さなら綴り順で採る', () => {
    expect(
      pickName(
        new Map([
          ['乙線', 2],
          ['甲線', 2],
        ]),
      ),
    ).toBe('乙線');
  });

  test('入力の並びが変わっても答えは変わらない', () => {
    const rows = [
      ['甲線', 2],
      ['乙線', 2],
      ['丙線', 5],
    ];
    expect(pickName(new Map(rows))).toBe(
      pickName(new Map([...rows].reverse())),
    );
  });

  test('候補が無ければ何も返さない', () => {
    expect(pickName(new Map())).toBeNull();
  });
});

describe('sharedRouteName', () => {
  const namesOf = (rows) =>
    new Map(rows.map(([key, names]) => [key, new Map(names)]));

  test('群の全員が持つ名前を採る', () => {
    expect(
      sharedRouteName(
        ['aichi-1', 'nagano-1'],
        namesOf([
          ['aichi-1', [['飯田富山佐久間線', 3]]],
          ['nagano-1', [['飯田富山佐久間線', 5]]],
        ]),
      ),
    ).toBe('飯田富山佐久間線');
  });

  test('片方しか持たない名前は採らない', () => {
    expect(
      sharedRouteName(
        ['aichi-1', 'nagano-1'],
        namesOf([
          ['aichi-1', [['三州街道', 9]]],
          ['nagano-1', [['飯田富山佐久間線', 5]]],
        ]),
      ),
    ).toBeNull();
  });

  test('線 で終わらない名前は採らない', () => {
    expect(
      sharedRouteName(
        ['aichi-1', 'nagano-1'],
        namesOf([
          ['aichi-1', [['大網街道', 2]]],
          ['nagano-1', [['大網街道', 2]]],
        ]),
      ),
    ).toBeNull();
  });

  test('号 を含む名前は採らない', () => {
    expect(
      sharedRouteName(
        ['aichi-1', 'nagano-1'],
        namesOf([
          ['aichi-1', [['環状1号線', 2]]],
          ['nagano-1', [['環状1号線', 2]]],
        ]),
      ),
    ).toBeNull();
  });

  test('候補が複数あれば、多い方を採る', () => {
    expect(
      sharedRouteName(
        ['aichi-1', 'nagano-1'],
        namesOf([
          [
            'aichi-1',
            [
              ['甲線', 1],
              ['乙線', 4],
            ],
          ],
          [
            'nagano-1',
            [
              ['甲線', 1],
              ['乙線', 4],
            ],
          ],
        ]),
      ),
    ).toBe('乙線');
  });

  test('名前を持たない路線が居れば採らない', () => {
    expect(
      sharedRouteName(
        ['aichi-1', 'nagano-1'],
        namesOf([['aichi-1', [['飯田富山佐久間線', 3]]]]),
      ),
    ).toBeNull();
  });
});
