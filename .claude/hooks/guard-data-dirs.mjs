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
 * 消す先は必ず絶対パスまで解いてから、リポジトリのルートと突き合わせる。
 * 相対のまま比べていたころ、`rm -rf ..` は止まるのに
 * `rm -rf <親ディレクトリ>` は通り、`../NationalRouteMap-worktree` は
 * 事実でない理由で止まっていた。書き方が違うだけの同じ命令に、別の答えを
 * 出してはいけない。
 *
 * 判定は近似である。命令文字列を正しく解釈するには shell を実装することに
 * なるので、消す形かどうかを形で見ている。境目は
 * test/guard-data-dirs.test.mjs が検査する。
 *
 * 見えないもの: Bash ツールの作業ディレクトリは呼び出しをまたいで残るが、
 * フックには渡らない。命令の中の `cd` は追うので `cd build && rm -rf pbf`
 * は止まるが、前の呼び出しで build/ に入ったままの `rm -rf pbf` は
 * 素通りする。木の外で打たれた相対パスを片端から止めるほうが害が大きい。
 */
import { readFileSync, writeSync } from 'node:fs';

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
  /* writeSync で書き切ってから終わる。process.stdout.write は Windows の
   * pipe では非同期なので、直後に exit すると deny が届かないまま——
   * つまり黙って通す側に倒れたまま——終わりうる。 */
  writeSync(
    1,
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
  .replace(/\/+$/, '');
const ROOT_PARTS = ROOT.toLowerCase().split('/');

/* ------------------------------------------------------------- 場所を読む --- */

/**
 * 文字を語に割る。引用符の中では区切らない——`echo "…; rm -rf build"` の
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

/**
 * ヒアドキュメントの中身を落とす。書き込む文章であって命令ではないのに、
 * 改行で段に割ると中の一行が命令に見える。docs がまさにその形で
 * `rm -rf build` を載せている。
 */
function stripHeredocs(text) {
  /* 札は行の終わりに来る——`cat > notes.md <<'EOF'`。後ろに向き先が続く
   * `cat <<'EOF' > notes.md` も同じ形である。行の途中に現れる `<<EOF` は
   * 文章の中の文字列で、`<<<` (here-string) は札を取らない。 */
  const OPEN =
    /(?:^|[^<])<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*(?:[<>|]+\s*\S+\s*)*$/;
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = OPEN.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== m[2]) end++;
    /* 閉じないまま終わったなら、それは札ではなかった。読み飛ばさない。 */
    if (end >= lines.length) continue;
    i = end;
  }
  return out.join('\n');
}

/**
 * 命令を段に割る。区切りも引用符の中では効かない。手前の区切りが `|` 単体
 * だったかを憶えておく——PowerShell は消す先を pipe で渡すので、その段には
 * 旗しか無い。
 */
function segments(text) {
  const out = [];
  let cur = '';
  let quote = '';
  let piped = false;
  const push = (nextPiped) => {
    out.push({ text: cur, piped });
    cur = '';
    piped = nextPiped;
  };
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
      /* `&&` と `||` は 2 文字で 1 つの区切り。 */
      const doubled = text[i + 1] === ch;
      push(ch === '|' && !doubled);
      if (doubled) i++;
      continue;
    }
    cur += ch;
  }
  push(false);
  return out;
}

/**
 * 語を絶対パスの段の配列にする。相対パスは cwd から解く。cwd 自体が
 * 分からなければ null。glob はそのまま残す——どこまで広がるかは
 * 保護対象と突き合わせるときに見る。
 */
function toAbsParts(token, cwd) {
  let t = token
    /* 引用符と、`(cd x && rm -rf build)` の丸括弧を外す。 */
    .replace(/^[('"]+|[)'"]+$/g, '')
    /* 今いる場所を指す書き方。展開されないまま来るので、ここで解く。
     * これ以外の変数は中身が分からないので、そのまま字として扱う。 */
    .replace(/^\$\{?PWD\}?|^\$\(pwd\)/i, '.')
    .replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, ROOT)
    .replace(/\\/g, '/')
    /* 円記号を斜線に直すと `\\` が `//` になる。重なった斜線は畳む。 */
    .replace(/\/{2,}/g, '/');
  if (!t) return null;
  /* Git Bash の絶対パスは `/d/nanase/…`。同じ場所が `d:/nanase/…` とも
   * `D:\nanase\…` とも書かれるので、ここで一つの形に寄せる。 */
  t = t.replace(/^\/([a-zA-Z])\//, '$1:/');

  let abs;
  if (/^[a-zA-Z]:\//.test(t) || t.startsWith('/')) abs = t;
  else if (cwd === null) return null;
  else abs = `${cwd.join('/')}/${t}`;

  const parts = [];
  for (const part of abs.split('/')) {
    /* 先頭の空は POSIX の根。それ以外の空は畳む。 */
    if (part === '' && parts.length > 0) continue;
    if (part === '.') continue;
    if (part === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(part);
  }
  /* 末尾の `*` `**` は「その中身ぜんぶ」で、親を指すのと同じ結果になる。 */
  while (parts.length > 1 && /^\*+$/.test(parts[parts.length - 1])) parts.pop();
  return parts;
}

/** glob を含む段を、その段に当たるかどうかの検査に変える。 */
const matcher = (part) =>
  new RegExp(
    `^${part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i',
  );

/**
 * 絶対パスをリポジトリからの相対にする。ルートそのものと、その祖先は
 * 空配列——保護対象を全部巻き込む。木の外なら null。
 */
function underRoot(parts) {
  if (parts === null) return null;
  const shared = Math.min(parts.length, ROOT_PARTS.length);
  for (let i = 0; i < shared; i++) {
    /* ここも glob で見る。段ごとの突き合わせだけを glob にしていたので、
     * `rm -rf ../NationalRouteMap*` がリポジトリごと持っていけた。 */
    if (!matcher(parts[i]).test(ROOT_PARTS[i])) return null;
  }
  return parts.length <= ROOT_PARTS.length
    ? []
    : parts.slice(ROOT_PARTS.length);
}

/**
 * その場所が保護対象を巻き込むか。保護対象そのものか、その上を指していれば
 * 巻き込む。中を指しているだけ(`build/brand`)なら巻き込まない。
 */
function hits(rel) {
  if (rel.length === 0) return [...PROTECTED];
  return PROTECTED.filter((p) => {
    const parts = p.split('/');
    if (rel.length > parts.length) return false;
    return rel.every((seg, i) => matcher(seg).test(parts[i]));
  });
}

/* --------------------------------------------------------- 消す形を読む --- */

const isFlag = (w) => w.startsWith('-') || /^\/[a-zA-Z]$/.test(w);
const RM_RECURSIVE = (w) =>
  /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(w) || w === '--recursive';
/* PowerShell の旗は前方一致で省略できる。Remove-Item の引数で `-r` から
 * 始まるのは -Recurse だけなので、`-r` も `-recu` も同じ意味になる。 */
const PS_RECURSIVE = (w) =>
  /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(w) || /^\/s$/i.test(w);
const REMOVE = /^(rm|remove-item|ri|rd|rmdir|del|erase)$/i;
/* `/usr/bin/rm` も rm である。 */
const nameOf = (w) =>
  w
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');

/* `git clean -x` は無視されているファイルを消す。長い旗の中の x は数えない
 * ——`--exclude=…` は消す範囲を狭める旗である。 */
const CLEAN_IGNORED = (w) => /^-[a-zA-Z]*[xX][a-zA-Z]*$/.test(w);
const DRY_RUN = (w) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w) || w === '--dry-run';

/* 命令の前に付いて、後ろの命令をそのまま走らせるもの。剥がさないと
 * `sudo rm -rf build` の verb が sudo になって素通りする。 */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'time',
  'command',
  'xargs',
  'nice',
]);
/* shell の組みと制御構文。これも剥がさないと `(rm -rf build)` や
 * `if true; then rm -rf build; fi` の verb が `(` や `then` になる。 */
const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'for',
  'case',
  'in',
  '!',
]);
/* -c に続く文字列を命令として走らせるもの。中をもう一度読む。 */
const SHELLS = /^(ba|z|k|da|)sh$|^(pwsh|powershell|cmd)(\.exe)?$/i;
/* その後ろが命令になる旗。`-lc` のように束ねて書かれることも、
 * `-Command` と綴り切られることもある。 */
const PAYLOAD_FLAG = (w) =>
  /^-[a-zA-Z]*c$/.test(w) || /^(-{1,2}|\/)(c|command)$/i.test(w);
/* `FOO=1 rm -rf build` の頭に付く代入。 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function scan(text, startCwd, depth = 0) {
  let cwd = startCwd;
  if (depth > 3) return cwd;

  let previous = [];
  for (const segment of segments(stripHeredocs(text))) {
    /* 組みの括弧は語にくっついて来る——`(cd build` の最初の語は `(cd`。
     * 離してから、括弧だけの語を落とす。閉じ括弧は消す先の語の末尾に付いた
     * まま残るが、そちらは toAbsParts が外す。
     *
     * 離すのは語の頭に来た括弧だけである。どこでも離すと `${PWD}` や
     * `$(pwd)` まで割れて、今いる場所を指す語が読めなくなる。 */
    let words = tokenize(
      segment.text.replace(/(^|\s)([({])/g, '$1 $2 '),
    ).filter((w) => !/^[({)}]+$/.test(w));
    /* 前に付いた sudo・xargs・制御構文と、その旗を落とす。 */
    while (
      words.length > 1 &&
      (WRAPPERS.has(words[0].toLowerCase()) ||
        KEYWORDS.has(words[0].toLowerCase()))
    ) {
      const keyword = KEYWORDS.has(words[0].toLowerCase());
      words = words.slice(1);
      if (!keyword) while (words.length && isFlag(words[0])) words.shift();
    }
    /* 頭の環境変数の代入も落とす。 */
    while (words.length > 1 && ASSIGNMENT.test(words[0]))
      words = words.slice(1);
    const upstream = previous;
    previous = words;
    if (words.length === 0) continue;
    const [verb, ...rest] = words;

    /* `bash -c "…"` や `cmd /c "…"` の中身も命令である。旗の後ろを全部
     * 渡す——`cmd /c rmdir /s /q build` は語が分かれて来る。 */
    if (SHELLS.test(nameOf(verb))) {
      const i = rest.findIndex(PAYLOAD_FLAG);
      if (i !== -1 && rest.length > i + 1) {
        scan(rest.slice(i + 1).join(' '), cwd, depth + 1);
        continue;
      }
    }

    if (verb === 'cd') {
      /* 引数の無い cd、`cd -`、`cd ~` の行き先は分からない。 */
      const to = rest.find((w) => !isFlag(w));
      cwd =
        to && to !== '-' && !to.startsWith('~') ? toAbsParts(to, cwd) : null;
      continue;
    }

    if (nameOf(verb) === 'git' && rest.includes('clean')) {
      /* git 自身の旗を読み飛ばして clean を探す。`-C <dir>` は走る場所を
       * 変えるので、そこも見る。 */
      /* 旗の値(`-c k=v` の k=v、`--git-dir .git` の .git)で打ち切らない。
       * clean そのものを探し、その手前に `-C <dir>` があれば走る場所を移す。 */
      const i = rest.indexOf('clean');
      let at = cwd;
      for (let j = 0; j < i; j++) {
        if (rest[j] === '-C' && rest[j + 1] !== undefined) {
          at = toAbsParts(rest[++j], at);
        }
      }
      const flags = rest.slice(i + 1);
      /* 木の外で走る git clean は、この repo の生成物を消さない。 */
      if (
        underRoot(at) !== null &&
        flags.some(CLEAN_IGNORED) &&
        !flags.some(DRY_RUN)
      ) {
        deny(
          'git clean -x は無視されているファイルを消すので、build/ と web/data/ が' +
            'まるごと対象に入ります。取り直しと再生成に何時間もかかります。' +
            '消したい物を名指しするか、まず -n で下見してください。',
        );
      }
      continue;
    }

    /* 消す命令は先頭とは限らない。`sudo -u me rm -rf build` の -u の値も、
     * `env FOO=1 rm …` の代入も、旗として落とし切れる形ではない。語の並びの
     * 中から探すほうが、包みの種類を数え上げるより確かである。 */
    const at = words.findIndex((w) => REMOVE.test(nameOf(w)));
    if (at === -1) continue;
    const name = nameOf(words[at]);
    const args = words.slice(at + 1);
    const recursive =
      name === 'rm' ? args.some(RM_RECURSIVE) : args.some(PS_RECURSIVE);
    if (!recursive) continue;
    /* `git rm -r --cached build` が触るのは索引だけで、ファイルは残る。 */
    if (at > 0 && nameOf(words[at - 1]) === 'git' && args.includes('--cached'))
      continue;

    /* PowerShell は消す先を pipe で渡す——`gci build | Remove-Item -Recurse`。
     * その段には旗しか無いので、手前の段の語を消す先として見る。
     * `-Path build,web/data` のように読点で並べても 1 語で来る。 */
    const targets = (
      segment.piped && !args.some((w) => !isFlag(w)) ? upstream : args
    ).flatMap((w) => w.split(','));

    /* 旗でない語を消す先の候補にする。どれが本当の引数かを正確に知るには
     * shell を実装することになるので、広く取る。 */
    for (const word of targets) {
      if (!word || isFlag(word)) continue;
      const rel = underRoot(toAbsParts(word, cwd));
      if (rel === null) continue;
      const hit = hits(rel);
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
  return cwd;
}

scan(command, ROOT.split('/'));
