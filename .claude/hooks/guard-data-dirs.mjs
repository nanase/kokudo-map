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
import { existsSync, readFileSync, writeSync } from 'node:fs';

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
 * 注記を落とす。`ls build # rm -rf build はしない` の後ろ半分は書いてある
 * だけで、走らない。引用符の中の `#` は字である。
 */
function stripComments(text) {
  const out = [];
  for (const line of text.split('\n')) {
    let quote = '';
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      /* 語の頭に来た `#` だけが注記を開く。`a#b` は 1 語である。 */
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        cut = i;
        break;
      }
    }
    out.push(cut === -1 ? line : line.slice(0, cut));
  }
  return out.join('\n');
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
    /* `bash <<'EOF'` の中身は書き込む文章ではなく、走る命令である。
     * `cat <<'EOF' | bash` も同じで、shell は行の後ろにも来る。 */
    if (lines[i].split(/[\s|]+/).some((w) => w && SHELLS.test(nameOf(w)))) {
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== m[2]) end++;
    /* 閉じないまま終わったなら、それは札ではなかった。読み飛ばさない。 */
    if (end >= lines.length) continue;
    i = end;
  }
  return out.join('\n');
}

/**
 * 続く行をつなぐ。行末の `\` (bash) と `` ` `` (PowerShell) と `|` は、
 * そこで命令が終わらないことを言っている。改行を区切りとして数えると、
 * 消す先だけが命令の無い段に落ちて素通りする。
 */
const joinContinuations = (text) =>
  text
    .replace(/\\\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .replace(/\|[ \t]*\r?\n/g, ' | ');

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
    /* 今いる場所を指す書き方。展開されないまま来るので、ここで解く。括弧を
     * 外すより先に済ませる——後にすると `$(pwd)` の `)` が先に落ちて、
     * この行が当たらなくなる。他の変数は中身が分からないので字として扱う。 */
    .replace(/^\$(env:)?\{?PWD\}?|^\$\(pwd\)|^`pwd`/i, '.')
    .replace(/^\$(env:)?\{?CLAUDE_PROJECT_DIR\}?/, ROOT)
    /* 引用符と、`(cd x && rm -rf build)` の丸括弧と波括弧を外す。 */
    .replace(/^[({'"]+|[)}'"]+$/g, '')
    .replace(/\\/g, '/')
    /* 円記号を斜線に直すと `\\` が `//` になる。重なった斜線は畳む。 */
    .replace(/\/{2,}/g, '/');
  if (!t) return null;
  /* Git Bash の絶対パスは `/d/nanase/…`。同じ場所が `d:/nanase/…` とも
   * `D:\nanase\…` とも書かれるので、ここで一つの形に寄せる。 */
  t = t.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/');

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

/**
 * glob を含む段を、その段に当たるかどうかの検査に変える。`[bw]*` のような
 * 字の組も glob である——`b*` を止めて `[bw]*` を通すのでは、書き方だけで
 * 答えが割れる。角括弧はそのまま正規表現の字の組として通し、組み損ねて
 * いれば字として扱う。
 */
function matcher(part) {
  const glob = part
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${glob}$`, 'i');
  } catch {
    return new RegExp(`^${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  }
}

/**
 * 絶対パスをリポジトリからの相対にする。ルートそのものと、その祖先は
 * 空配列——保護対象を全部巻き込む。木の外なら null。
 */
function underRoot(parts) {
  if (parts === null) return null;
  /* POSIX の根。この下に無い物は無い。 */
  if (parts.length === 1 && parts[0] === '') return [];
  const shared = Math.min(parts.length, ROOT_PARTS.length);
  for (let i = 0; i < shared; i++) {
    /* glob でも見る。段ごとの突き合わせだけを glob にしていたので、
     * `rm -rf ../NationalRouteMap*` がリポジトリごと持っていけた。 */
    if (!same(parts[i], ROOT_PARTS[i])) return null;
  }
  return parts.length <= ROOT_PARTS.length
    ? []
    : parts.slice(ROOT_PARTS.length);
}

/**
 * 段が同じ場所を指すか。まず字として比べる——`[wip]` のような括弧を含む
 * 名前は、glob として読むと字の組になって自分自身に当たらない。リポジトリを
 * そういう名前の下に置いた人の手元で、番人が丸ごと効かなくなっていた。
 */
const same = (a, b) =>
  a.toLowerCase() === b.toLowerCase() || matcher(a).test(b);

/**
 * その場所が保護対象を巻き込むか。保護対象そのものか、その上を指していれば
 * 巻き込む。中を指しているだけ(`build/brand`)なら巻き込まない。
 */
function hits(rel) {
  if (rel.length === 0) return [...PROTECTED];
  return PROTECTED.filter((p) => {
    const parts = p.split('/');
    if (rel.length > parts.length) return false;
    return rel.every((seg, i) => same(seg, parts[i]));
  });
}

/**
 * `build/{pbf,cache}` を `build/pbf` と `build/cache` に開く。開かないと、
 * 同じ物を消す命令が、波括弧の位置だけで通ったり止まったりする。
 */
function expandBraces(word, depth = 0) {
  const m = depth > 4 ? null : /^(.*?)\{([^{}]*)\}(.*)$/.exec(word);
  if (!m) return [word];
  return m[2]
    .split(',')
    .flatMap((alt) => expandBraces(`${m[1]}${alt}${m[3]}`, depth + 1));
}

/* --------------------------------------------------------- 消す形を読む --- */

/* cmd の旗 `/s` `/q` は落とさない。Git Bash が drive の根を指して書く
 * `/f` と見分けが付かないためで、落とすと F: に clone したときだけ穴が
 * 開く。旗として残しても、消す先として読んでも、行き着く先は同じである
 * ——`/s` は `s:/` になり、この木の外として無視される。再帰かどうかは
 * PS_RECURSIVE が別に見ているので、`rd /s /q build` は止まったままである。 */
const isFlag = (w) => w.startsWith('-');
const RM_RECURSIVE = (w) =>
  /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(w) || w === '--recursive';
/* PowerShell の旗は前方一致で省略できる。Remove-Item の引数で `-r` から
 * 始まるのは -Recurse だけなので、`-r` も `-recu` も同じ意味になる。 */
const PS_RECURSIVE = (w) =>
  /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(w) ||
  /* cmd の旗は `/s/q` と束ねて書ける。字ごとに見る——`/usr/share` のような
   * 道筋を旗と読まないため。 */
  (w.startsWith('/') && w.slice(1).toLowerCase().split('/').includes('s'));
const REMOVE = /^(rm|remove-item|ri|rd|rmdir|del|erase)$/i;
/* pipe の手前で中身を並べるもの。引数が無ければ、並べるのは今いる場所の
 * 中身である。 */
const LISTING = /^(get-childitem|gci|ls|dir|get-item|gi)$/i;
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
/* find が名前で当てる旗。値は段の名前に当たるので、保護対象の名前に
 * 当たらないことを言える。 */
const NAMES = (w) => /^-(i?name|i?lname)$/.test(w);
/* 道筋そのものに当たる旗。段の名前ではないので、当たらないことを段の
 * 突き合わせでは言えない。 */
const WHOLE = (w) => /^-(i?path|i?regex|i?wholename)$/.test(w);
/* 保護対象の末尾の名前。find の絞りが当たるかどうかはここで見る。 */
const PROTECTED_NAMES = [...new Set(PROTECTED.map((p) => p.split('/').pop()))];
/* find の絞り込み。当たったファイルだけを消す形になる。 */
const SELECTS = (w) =>
  /^-(i?name|i?path|i?regex|i?lname|newer[a-zA-Z]*|size|[acm]min|[acm]time|perm|user|group|links|inum|samefile)$/.test(
    w,
  );
/* PowerShell の下見。git clean の -n にあたる。止めすぎると迂回される。 */
const WHAT_IF = (w) => /^-wh(a(t(i(f)?)?)?)?$/i.test(w);

/* 引数を走らせず、字として並べるだけの命令。ここに挟まった `rm` は書き
 * 留められた字であって、走る命令ではない——`echo rm -rf build >> notes.md`
 * や `grep -rn rm -rf build .` を止めないため。 */
const PRINTS =
  /^(echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|sed|awk|diff|comm|curl|wget|write-output|write-host)$/i;

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
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
/* 変数で受けた消す先。展開はされないまま届くので、同じ命令の中で値が
 * 決まっているぶんだけ覚えておく。中身の分からない変数は字のまま扱う。 */
const vars = new Map();
const VAR = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(.*)$/;
/* 変数は変数を指せる——`D=build; E=$D; rm -rf $E`。解いた先がまた変数なら
 * もう一度解く。同じ名前へ戻ったらそこで止める。 */
function expandVars(word, seen = new Set()) {
  const m = VAR.exec(word);
  const values = m && vars.get(m[1]);
  if (!values || seen.has(m[1])) return [word];
  const next = new Set(seen).add(m[1]);
  return values.flatMap((v) => expandVars(`${v}${m[2]}`, next));
}

/**
 * 消す先の候補を保護対象と突き合わせ、当たれば止める。どれが本当の引数かを
 * 正確に知るには shell を実装することになるので、候補は広く取る。
 */
/* PowerShell は旗と値を `-Path:build` とも書ける。旗として落とすと、
 * 値ごと検査から外れる。 */
const flagValue = (w) => (/^-[A-Za-z]+:(.+)$/.exec(w) ?? [])[1];

function report(candidates, cwd) {
  for (const candidate of candidates) {
    const word = flagValue(candidate) ?? candidate;
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

/**
 * pipe の手前が並べている場所。並べているのが分かるものだけを返し、
 * 分からなければ null——手前が読めないものを消す先と決めつけない。
 *
 * 段は何段でも挟まる。`find build -type d | sort | xargs rm -rf` の sort も
 * `gci build | Where-Object {…} | ri` の Where-Object も、並べている場所を
 * 変えはしない。読める段に当たるまで手前へ辿る。絞る段が挟まっていても
 * 手前を見るのは、何が残るか読めないからで、find の -regex を通さないのと
 * 同じ判断である。
 */
function pipedTargets(chain) {
  for (let i = chain.length - 1; i >= 0; i--) {
    const found = listedBy(chain[i]);
    if (found !== undefined) return found;
  }
  return null;
}

/** その段が場所を並べているなら、その場所。読めない段なら undefined。 */
function listedBy(words) {
  if (words.length === 0) return undefined;
  const head = nameOf(words[0]);
  const rest = words.slice(1);
  if (head === 'find') {
    /* 名前や大きさで絞ってあれば、並ぶのは当たったファイルだけである。 */
    if (rest.some(SELECTS)) return null;
    const paths = [];
    for (const w of rest) {
      if (w.startsWith('-')) break;
      paths.push(w);
    }
    return paths.length > 0 ? paths : ['.'];
  }
  if (LISTING.test(head)) {
    /* 名前で絞ってあれば、並ぶのは当たったものだけで木は残る。find の
     * -name と同じ扱いにする——`gci build -Filter *.log | ri` と
     * `find build -name '*.log' | xargs rm` で答えを変えない。 */
    if (rest.some((w) => /^-(filter|include|exclude)$/i.test(w))) return null;
    const paths = rest.filter((w) => !isFlag(w));
    return paths.length > 0 ? paths : ['.'];
  }
  return undefined;
}

/**
 * 段の中の、組みの括弧の数。`$(date)` と `arr=(a b)` の括弧は組みではない
 * ので数えない——数えると、閉じだけが余って、後の本物の部分 shell が
 * 一段早く閉じたことになる。
 */
function grouping(text) {
  let opens = 0;
  let closes = 0;
  let subst = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      /* 語の頭に来た括弧だけが組みである。 */
      if (i === 0 || /\s/.test(text[i - 1])) opens++;
      else subst++;
      continue;
    }
    if (ch === ')') {
      if (subst > 0) subst--;
      else closes++;
    }
  }
  return { opens, closes };
}

function scan(text, startCwd, depth = 0) {
  let cwd = startCwd;
  /* pushd が積んだ場所。popd で戻る。cd しか見ていなかったころ、
   * `pushd build && rm -rf pbf` が素通りしていた。 */
  const stack = [];
  /* 部分 shell に入る前の場所。`(cd /tmp && ls); rm -rf build` の rm が
   * 走るのは、括弧を出た後——つまりリポジトリのルートである。 */
  const subshells = [];
  /* この命令が作る場所。フックが走る時点ではまだ無いが、cd の頃には在る。 */
  const willExist = new Set();
  if (depth > 3) return cwd;

  /* いま繋がっている pipe の段。`|` で来た段は後ろに足し、そうでなければ
   * そこから新しく始める。 */
  let chain = [];
  const ready = joinContinuations(stripComments(stripHeredocs(text)));
  /* 閉じ括弧は、その段の命令を読み終えてから効く。次の段の頭で戻す。 */
  let closing = 0;
  for (const segment of segments(ready)) {
    while (closing > 0 && subshells.length > 0) {
      cwd = subshells.pop();
      closing--;
    }
    /* 前の段の残りに足す——上で戻し切れなかったぶんは、まだ効いていない。 */
    const paren = grouping(segment.text);
    closing += paren.closes;
    /* 組みの括弧は語にくっついて来る——`(cd build` の最初の語は `(cd`。
     * 離してから、括弧だけの語を落とす。閉じ括弧は消す先の語の末尾に付いた
     * まま残るが、そちらは toAbsParts が外す。
     *
     * 離すのは語の頭に来た括弧だけである。どこでも離すと `${PWD}` や
     * `$(pwd)` まで割れて、今いる場所を指す語が読めなくなる。 */
    for (let k = 0; k < paren.opens; k++) subshells.push(cwd);
    let words = tokenize(
      segment.text
        .replace(/(^|\s)\(/g, '$1 ( ')
        /* 組みの `{` は後ろに空白が続く。`{a,b}` の `{` は語の一部なので
         * 離さない——離すと展開する前に割れる。 */
        .replace(/(^|\s)\{(?=\s)/g, '$1 { '),
    ).filter((w) => !/^[({)}]+$/.test(w));
    /* `for d in build web/data; do …` と `foreach ($d in 'build','web/data')`
     * の値を覚える。for と in は KEYWORDS にあるので、剥がす前に読まないと
     * in の左右が分からなくなる。 */
    if (/^(for|foreach)$/i.test(words[0] ?? '') && words[2] === 'in') {
      const key = (words[1] ?? '').replace(/^\$\{?|\}?$/g, '');
      if (key) {
        vars.set(
          key,
          words
            .slice(3)
            .filter((w) => !isFlag(w))
            .flatMap((w) => w.split(',')),
        );
      }
    }
    /* PowerShell の代入は `$d = 'build'` とも `$d='build'` とも書く。
     * 前者は等号が離れて来て、後者は 1 語で来る。 */
    const assign = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(=(.*))?$/.exec(
      words[0] ?? '',
    );
    if (assign) {
      const [, key, joined, value] = assign;
      if (joined) vars.set(key, [value]);
      else if (words[1] === '=' && words[2] !== undefined)
        vars.set(key, [words[2]]);
      else if (/^=/.test(words[1] ?? '')) vars.set(key, [words[1].slice(1)]);
    }
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
    /* 頭の環境変数の代入は落とす。落とす前に値を覚える——`D=build;
     * rm -rf $D` の $D が何かを知っているのは、ここだけである。 */
    while (words.length > 0 && ASSIGNMENT.test(words[0])) {
      const [, key, value] = ASSIGNMENT.exec(words[0]);
      vars.set(key, [value]);
      if (words.length === 1) break;
      words = words.slice(1);
    }
    const upstream = segment.piped ? chain : [];
    chain = segment.piped ? [...chain, words] : [words];
    if (words.length === 0) continue;
    const [verb, ...rest] = words;

    /* `eval "rm -rf build"` の中身も命令である。 */
    if (nameOf(verb) === 'eval' && rest.length > 0) {
      scan(rest.join(' '), cwd, depth + 1);
      continue;
    }

    /* `bash -c "…"` や `cmd /c "…"` の中身も命令である。旗の後ろを全部
     * 渡す——`cmd /c rmdir /s /q build` は語が分かれて来る。 */
    if (SHELLS.test(nameOf(verb))) {
      const i = rest.findIndex(PAYLOAD_FLAG);
      if (i !== -1 && rest.length > i + 1) {
        scan(rest.slice(i + 1).join(' '), cwd, depth + 1);
        continue;
      }
    }

    /* `mkdir -p tmpwork && cd tmpwork && rm -rf ../build` の cd を、行き先が
     * 無いからと数えないでいた。作るのは同じ命令の中である。 */
    if (/^(mkdir|md|new-item)$/i.test(verb)) {
      for (const w of rest) {
        if (isFlag(w)) continue;
        const made = toAbsParts(w, cwd);
        if (made) willExist.add(made.join('/').toLowerCase());
      }
      continue;
    }

    /* PowerShell は同じことを Set-Location と書く。cmd は chdir と書く。 */
    const moves = /^(cd|chdir|set-location|sl|pushd|push-location)$/i.test(
      verb,
    );
    if (moves) {
      if (/^(pushd|push-location)$/i.test(verb)) stack.push(cwd);
      /* 引数の無い cd/pushd、`cd -`、`cd ~` の行き先は分からない。
       * pushd は引数が無いと積んだ場所と入れ替えるが、そこまでは追わない。 */
      const to = rest.find((w) => !isFlag(w));
      /* 行き先が読めないとき——引数が無い、`cd -`、`cd ~`——は動かさない。
       * 「どこか分からない」で通すと、木の中に居るかもしれない命令を
       * 見逃す。行き先が無いときも同じで、cd は失敗して shell はその場に
       * 留まる。`cd nope; rm -rf build` はルートで build/ を消す命令である。 */
      if (!to || to === '-' || to.startsWith('~')) continue;
      /* 行き先も変数で受けられる。`d=build; cd $d; rm -rf pbf` は、消す側
       * だけを展開していたころ素通りしていた。 */
      let moved = null;
      for (const candidate of expandVars(to)) {
        const parts = toAbsParts(candidate, cwd);
        if (parts === null) continue;
        const where = parts.join('/');
        if (!existsSync(where) && !willExist.has(where.toLowerCase())) continue;
        moved = parts;
        break;
      }
      if (moved === null) continue;
      cwd = moved;
      continue;
    }

    if (/^(popd|pop-location)$/i.test(verb)) {
      /* 積んでいなければ popd は失敗し、shell はその場に留まる。 */
      if (stack.length > 0) cwd = stack.pop();
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
      const after = rest.slice(i + 1);
      const flags = after.filter((w) => w !== '--' && isFlag(w));
      /* `-e <pattern>` と `--exclude <pattern>` は値を取る。その値を
       * pathspec と読むと、範囲を絞った扱いになって素通りする。短い旗は
       * 束ねられるので、`-xdfe node_modules` の e も同じである。 */
      const values = new Set();
      after.forEach((w, k) => {
        const takesValue = /^-[a-zA-Z]*e$/.test(w) || w === '--exclude';
        if (takesValue && after[k + 1] !== undefined) values.add(k + 1);
      });
      /* 消す範囲を絞る引数。付いていれば、そこに保護対象が入るときだけ止める
       * ——理由文が「名指ししてください」と言うのに、名指しすると止まるのでは
       * 通り道が無い。 */
      const paths = after.filter(
        (w, k) => w !== '--' && !isFlag(w) && !values.has(k),
      );
      const scoped =
        paths.length > 0 &&
        !paths.some((w) => {
          const rel = underRoot(toAbsParts(w, at));
          return rel !== null && hits(rel).length > 0;
        });
      /* git clean が歩くのは、走った場所から下だけである。木の外はもちろん、
       * docs/ の中で走っても build/ には届かない。走る場所が保護対象を
       * 含むときだけ止める。 */
      const reach = underRoot(at);
      if (
        reach !== null &&
        hits(reach).length > 0 &&
        !scoped &&
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
    const at = PRINTS.test(nameOf(verb))
      ? -1
      : words.findIndex((w) => REMOVE.test(nameOf(w)));

    /* find は探す場所を先に書き、消す命令を後ろに置く。
     * `find build -type d -exec rm -rf {} +` の `{}` は場所ではない——
     * 場所は find の引数として前に書いてある。 */
    if (nameOf(verb) === 'find') {
      /* `-exec rm -f {} +` も、find が再帰するので木の中身は全部消える。
       * `find build -type f | xargs rm -f` を止めているのと同じ形である。 */
      const deletes = rest.includes('-delete') || at > 0;
      if (!deletes) continue;
      const paths = [];
      for (const w of rest) {
        if (w.startsWith('-')) break;
        paths.push(w);
      }
      /* 場所を書かない find は、今いる場所から探す。 */
      const roots = paths.length > 0 ? paths : ['.'];
      if (!rest.some(SELECTS)) {
        report(roots, cwd);
        continue;
      }

      /* 絞ってある。`-delete` は空でないディレクトリを消せないので、消える
       * のは当たったファイルだけで、探す場所そのものは残る。 */
      if (at < 1 || !words.slice(at + 1).some(RM_RECURSIVE)) continue;

      /* 再帰的な rm は、当たった物を木ごと消す。絞りが保護対象を外すと
       * 言えるときだけ通す。言えるのは名前で絞る旗だけで、`-path` や
       * `-regex` は道筋に当たるし、`-mtime` は名前を絞らない。
       * 道筋で当てる find は、探す場所の直下の build にも当たる。 */
      const named = rest
        .map((w, k) => (NAMES(w) ? rest[k + 1] : null))
        .filter((w) => w !== undefined && w !== null);
      const provable =
        named.length > 0 &&
        !rest.some(WHOLE) &&
        !named.some((pat) =>
          PROTECTED_NAMES.some((name) => matcher(pat).test(name)),
        );
      if (provable) continue;
      report(roots, cwd);
      continue;
    }

    if (at === -1) continue;
    const name = nameOf(words[at]);
    const args = words.slice(at + 1);
    /* 再帰は手前の段にも書ける——`gci build -Recurse | ri -Force` も
     * `find build -type f | xargs rm -f` も、消えるのは木の中身である。 */
    const deep =
      segment.piped &&
      upstream.some(
        (stage) =>
          stage.some(PS_RECURSIVE) || nameOf(stage[0] ?? '') === 'find',
      );
    const recursive =
      deep ||
      (name === 'rm' ? args.some(RM_RECURSIVE) : args.some(PS_RECURSIVE));
    if (!recursive) continue;
    /* 下見は何も消さない。 */
    if (name !== 'rm' && args.some(WHAT_IF)) continue;
    /* `git rm -r --cached build` が触るのは索引だけで、ファイルは残る。 */
    if (at > 0 && nameOf(words[at - 1]) === 'git' && args.includes('--cached'))
      continue;

    /* 消す先は pipe でも渡る——`gci build | Remove-Item -Recurse` も
     * `find build -type d | xargs rm -rf` も、消す段には旗しか無い。手前の
     * 段が何を並べているかを読む。読めなければ何もしない。
     * `-Path build,web/data` のように読点で並べても 1 語で来る。 */
    let source = args;
    if (segment.piped && !args.some((w) => !isFlag(w))) {
      const piped = pipedTargets(upstream);
      if (piped === null) continue;
      source = piped;
    }
    const targets = source.flatMap((w) =>
      expandVars(w).flatMap((v) =>
        expandBraces(v).flatMap((x) => x.split(',')),
      ),
    );

    report(targets, cwd);
  }
  return cwd;
}

scan(command, ROOT.split('/'));
