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
 * 無くなる。`git clean -x` は無視されているファイルを消す命令なので、
 * build/ を名指ししていなくても止める——ただし `-n` の下見は通す。
 *
 * 判定は近似である。命令文字列を正しく解釈するには shell を実装することに
 * なるので、消す形かどうかと、消す先がどこかを、形で見ている。境目は
 * test/guard-data-dirs.test.mjs が検査する。
 *
 * 見えないもの: Bash ツールの作業ディレクトリは呼び出しをまたいで残るが、
 * フックには渡らない。命令の中の `cd` は追うので `cd build && rm -rf pbf`
 * は止まるが、前の呼び出しで build/ に入ったままの `rm -rf pbf` は
 * 素通りする。木の外で打たれた相対パスを片端から止めるほうが害が大きい。
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

const ROOT = (process.env.CLAUDE_PROJECT_DIR ?? process.cwd())
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
  .toLowerCase();

/* ------------------------------------------------------------- 場所を読む --- */

/**
 * 段を語に割る。引用符の中では区切らない——`echo "…; rm -rf build"` の
 * 中身を命令と読むと、書き留めるだけの命令まで止めてしまう。
 */
function tokenize(text) {
  const out = [];
  let word = '';
  let quote = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (word) out.push(word);
      word = '';
      continue;
    }
    word += ch;
  }
  if (word) out.push(word);
  return out;
}

/** 命令を段に割る。区切りも引用符の中では効かない。 */
function segments(text) {
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      out.push(cur);
      cur = '';
      /* `&&` と `||` は 2 文字で 1 つの区切り。 */
      if (text[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * パスの段を畳む。末尾の `*` `**` `.` は「その中身ぜんぶ」を指すので、
 * 親そのものを指しているのと同じに扱う——`build/*` も `build/**` も
 * `rm -rf build` と同じ結果になる。
 */
function tidy(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    /* リポジトリより上へ出た。何が入っているか分からないので、
     * 巻き込みうる形として扱う。 */
    if (part === '..') {
      if (parts.length === 0) return '..';
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  while (parts.length && /^\*+$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join('/');
}

/**
 * 語をリポジトリ相対の形にする。この木の外を指していれば null。
 * 相対パスは cwd から解く。cwd 自体が木の外なら、その先も外である。
 */
function toRepoPath(token, cwd) {
  let t = token
    /* 引用符と、`(cd x && rm -rf build)` の丸括弧を外す。 */
    .replace(/^[('"]+|[)'"]+$/g, '')
    .replace(/\\/g, '/')
    /* 円記号を斜線に直すと `\\` が `//` になる。重なった斜線は畳む。 */
    .replace(/\/{2,}/g, '/');
  if (!t) return null;
  /* Git Bash の絶対パスは `/d/nanase/…`。同じ場所が `d:/nanase/…` とも
   * `D:\nanase\…` とも書かれるので、ここで一つの形に寄せる。 */
  t = t.replace(/^\/([a-zA-Z])\//, '$1:/');

  if (/^[a-zA-Z]:\//.test(t) || t.startsWith('/')) {
    const lower = t.toLowerCase();
    if (lower === ROOT) return '';
    if (lower.startsWith(`${ROOT}/`)) return tidy(t.slice(ROOT.length + 1));
    return null;
  }
  if (cwd === null) return null;
  return tidy(cwd ? `${cwd}/${t}` : t);
}

/**
 * その場所が保護対象を巻き込むか。`''`(リポジトリのルート)と `..` は
 * 全部を巻き込む。
 */
const hits = (path) =>
  path === '' || path === '..'
    ? [...PROTECTED]
    : PROTECTED.filter((p) => path === p || p.startsWith(`${path}/`));

/* --------------------------------------------------------- 消す形を読む --- */

const isFlag = (w) => w.startsWith('-') || /^\/[a-zA-Z]$/.test(w);
const RM_RECURSIVE = (w) =>
  /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(w) || w === '--recursive';
/* PowerShell の旗は前方一致で省略できる。Remove-Item の引数で `-r` から
 * 始まるのは -Recurse だけなので、`-r` も `-recu` も同じ意味になる。 */
const PS_RECURSIVE = (w) =>
  /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(w) || /^\/s$/i.test(w);
const PS_REMOVE = /^(remove-item|ri|rd|rmdir|del|erase)$/i;

/* `git clean -x` は無視されているファイルを消す。長い旗の中の x は数えない
 * ——`--exclude=…` は消す範囲を狭める旗である。 */
const CLEAN_IGNORED = (w) => /^-[a-zA-Z]*[xX][a-zA-Z]*$/.test(w);
const DRY_RUN = (w) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w) || w === '--dry-run';

let cwd = '';
for (const segment of segments(command)) {
  const words = tokenize(segment);
  if (words.length === 0) continue;
  const [verb, ...rest] = words;

  if (verb === 'cd') {
    /* 引数の無い cd、`cd -`、`cd ~` の行き先は分からない。 */
    const to = rest.find((w) => !isFlag(w));
    cwd = to && to !== '-' && !to.startsWith('~') ? toRepoPath(to, cwd) : null;
    continue;
  }

  if (verb === 'git' && rest[0] === 'clean') {
    const flags = rest.slice(1);
    if (flags.some(CLEAN_IGNORED) && !flags.some(DRY_RUN)) {
      deny(
        'git clean -x は無視されているファイルを消すので、build/ と web/data/ が' +
          'まるごと対象に入ります。取り直しと再生成に何時間もかかります。' +
          '消したい物を名指しするか、まず -n で下見してください。',
      );
    }
    continue;
  }

  const recursive =
    (verb === 'rm' && rest.some(RM_RECURSIVE)) ||
    (PS_REMOVE.test(verb) && rest.some(PS_RECURSIVE));
  if (!recursive) continue;

  /* 旗でない語を消す先の候補にする。どれが本当の引数かを正確に知るには
   * shell を実装することになるので、広く取る。 */
  for (const word of rest) {
    if (isFlag(word)) continue;
    const path = toRepoPath(word, cwd);
    if (path === null) continue;
    const hit = hits(path);
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
