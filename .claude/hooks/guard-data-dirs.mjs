/* 作り直すのに何時間もかかる生成物を、消す命令の手前で止める。
 *
 * build/ と web/data/ は .gitignore にある。追跡していないので、消えても
 * `git status` は何も言わないし、`git checkout` でも戻らない。中身は
 * japan-latest.osm.pbf 2.5 GB、国土数値情報 N03 約 530 MB、47 都道府県ぶんの
 * 抽出キャッシュとタイルで、取り直しと再生成に何時間もかかる。
 *
 * 2026-08-27、共有カードを build/ に書いたあと、後始末のつもりの
 * `rm -rf build` でこれが全部消えた。作った 168 kB の PNG を消すつもりが、
 * 同じ木にあった全部を巻き込んでいる。捨ててよい物と、取り直しに何時間も
 * かかる物が同じ場所にあり、命令はその区別を持たない。ここが持つ。
 *
 * 止めるのは「木ごと」消す形だけである。中の 1 ファイルを消すこと
 * (`rm build/social.png`)、保護対象でない下位ディレクトリを消すこと
 * (`rm -rf build/brand`) は通す。後始末そのものを塞ぐと、迂回されて意味が
 * 無くなる。
 *
 * `git clean -xdf` も止める。無視されているファイルを消す命令なので、
 * 名指ししていなくても build/ と web/data/ がまるごと対象に入る。
 */
import { readFileSync } from 'node:fs';

/* 木ごと消されては困る場所。リポジトリのルートからの相対で述べる。 */
const PROTECTED = [
  'build',
  'build/pbf',
  'build/cache',
  'build/regions',
  'build/tiles',
  'build/decree',
  'build/n03',
  'build/n13',
  'build/overpass-baseline',
  'web/data',
];

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
};

/* 読めなければ黙って通す。番人が落ちて作業まで止まるのは行き過ぎである。 */
let command = '';
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  command = String(input?.tool_input?.command ?? '');
} catch {
  process.exit(0);
}
if (!command.trim()) process.exit(0);

/* 引用符と ./ と末尾の / を落として、リポジトリ相対の形に揃える。Windows の
 * 円記号と、絶対パスの前半も落とす——同じ場所が三通りの書き方で来る。 */
const ROOT = (process.env.CLAUDE_PROJECT_DIR ?? process.cwd())
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
  .toLowerCase();

function normalize(token) {
  let t = token
    /* 引用符と、`(cd x && rm -rf build)` の丸括弧を外す。 */
    .replace(/^[('"]+|[)'"]+$/g, '')
    .replace(/\\/g, '/')
    /* 円記号を斜線に直すと `\\` が `//` になる。`build//pbf` も同じ場所を
     * 指しているので、重なった斜線はここで畳む。 */
    .replace(/\/{2,}/g, '/');
  if (!t) return '';
  /* Git Bash の絶対パスは `/d/nanase/…`。同じ場所が `d:/nanase/…` とも
   * `D:\nanase\…` とも書かれるので、ここで一つの形に寄せる。 */
  t = t.replace(/^\/([a-zA-Z])\//, '$1:/');
  const lower = t.toLowerCase();
  if (lower.startsWith(`${ROOT}/`)) t = t.slice(ROOT.length + 1);
  else if (lower === ROOT) t = '.';
  t = t.replace(/^\.\//, '').replace(/\/+$/, '');
  /* `build/*` と `build/.` は build/ を消すのと同じことを指す。 */
  t = t.replace(/\/(\*|\.)$/, '');
  return t;
}

/* 今いる場所ごと、あるいはその上ごと消す形。どこで打たれたかはフックには
 * 分からないので、この形は保護対象を巻き込みうるものとして扱う。`*` を
 * 通していたせいで、事故と同じ結果になる `rm -rf *` が素通りしていた。 */
const SWEEPS_CWD = new Set(['', '.', '*', '..']);

/* その語が保護対象を巻き込むか。保護対象そのものと、その上位を巻き込む形の
 * 両方を見る。 */
const hits = (t) =>
  SWEEPS_CWD.has(t) || t.startsWith('../')
    ? [...PROTECTED]
    : PROTECTED.filter((p) => t === p || p.startsWith(`${t}/`));

/* 再帰的に消す形。rm の旗は -rf でも -f -r でも --recursive でも来るので、
 * 旗が何個続いても、そのどれかに r があれば拾う。長い旗を短い旗と分けて
 * 見るのは、--force に r が入っているためである。 */
const RM_FLAG = '(?:-[a-zA-Z]*|--[a-z][a-z-]*)';
const RECURSIVE_RM = new RegExp(
  `^\\s*rm\\s+(?:${RM_FLAG}\\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\\s|$)`,
);
/* PowerShell の旗は前方一致で省略できる。Remove-Item の引数で `-r` から
 * 始まるのは -Recurse だけなので、`-r` も `-recu` も同じ意味になる。 */
const REMOVE_ITEM =
  /^\s*(remove-item|ri|rd|rmdir|del|erase)\b.*?(-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b|\/s\b)/i;
const RMDIR = /^\s*rmdir\s/;
/* 無視されているファイルを消す。build/ を名指ししていなくても対象に入る。 */
const GIT_CLEAN = /^\s*git\s+clean\b.*\s-\S*[xX]/;

/* 命令を段に割る。`cd <repo> && rm -rf node_modules` の cd の引数を rm の
 * 消す先と取り違えないよう、突き合わせるのは消す命令の段だけにする。 */
const segments = command.split(/(?:\|\||&&|[;|&\n])+/);

for (const segment of segments) {
  if (GIT_CLEAN.test(segment)) {
    deny(
      'git clean -x は無視されているファイルを消すので、build/ と web/data/ が' +
        'まるごと対象に入ります。作り直しに何時間もかかります。' +
        '消したい物を名指ししてください。',
    );
  }

  if (
    !RECURSIVE_RM.test(segment) &&
    !REMOVE_ITEM.test(segment) &&
    !RMDIR.test(segment)
  ) {
    continue;
  }

  /* 命令の名前を落とし、残った旗でない語を消す先の候補にする。どれが本当の
   * 引数かを正確に知るには shell を実装することになるので、広く取る。 */
  const words = segment
    .trim()
    .split(/\s+/)
    .slice(1)
    /* 旗を落とす。斜線で始まる語は cmd の `/s` `/q` だけを落とす——
     * `/d/nanase/…/build` は Git Bash の絶対パスであって旗ではない。 */
    .filter((w) => w && !w.startsWith('-') && !/^\/[a-zA-Z]$/.test(w));

  for (const word of words) {
    const hit = hits(normalize(word));
    if (hit.length === 0) continue;
    deny(
      `${word} を再帰的に消すと ${hit.join('・')} を巻き込みます。` +
        'これらは .gitignore にあり、git では戻りません。中身は pbf 2.5 GB と' +
        '47 都道府県ぶんの生成物で、取り直しと再生成に何時間もかかります。' +
        '消したいのが 1 ファイルなら、そのファイルを名指ししてください。' +
        '木ごと消すのが本当に目的なら、利用者に頼んでください。',
    );
  }
}
