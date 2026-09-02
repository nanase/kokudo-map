/* build/ と web/data/ を木ごと消す命令を、実行の手前で止める。
 *
 * どちらも .gitignore にあり、消えても git では戻らない。取り直しと再生成に
 * 何時間もかかる(中身と大きさは CLAUDE.md の「変えてはいけない判断」)。
 * 2026-08-27、build/ に書いた 168 kB の共有カードを片づけるつもりの
 * `rm -rf build` で、同じ木にあった全部が消えた。
 *
 * 止めるのは木ごと消す形だけである。中の 1 ファイル(`rm build/social.png`)も
 * 保護対象でない下位ディレクトリ(`rm -rf build/brand`)も通す。後始末まで塞ぐと
 * 迂回される。`git clean -x` は無視されているファイルを消すので、build/ を
 * 名指ししていなくても止める。`-n` の下見は通す。
 *
 * 消す先は絶対パスまで解いてからリポジトリのルートと比べる。相対のまま比べて
 * いたころ、`rm -rf ..` は止まるのに `rm -rf <親ディレクトリ>` は通り、
 * `../NationalRouteMap-worktree` は誤って止まっていた。
 *
 * 判定は近似である。命令を正しく解釈するには shell を実装することになるので、
 * 消す形かどうかを形で見る。境目は test/guard-data-dirs.test.mjs が検査する。
 *
 * 判定は decide()、stdin と標準出力は main() が持つ(どちらも末尾)。テストが
 * decide() だけを呼べるように分けてある。
 *
 * 限界: Bash ツールの作業ディレクトリは呼び出しをまたいで残るが、フックには
 * 渡らない。命令の中の `cd` は追うので `cd build && rm -rf pbf` は止まるが、
 * 前の呼び出しで build/ に入ったままの `rm -rf pbf` は通る。木の外で打たれた
 * 相対パスまで止めるほうが害が大きい。
 */
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/* 木ごと消されては困る場所。リポジトリのルートからの相対で述べる。 */
const PROTECTED = [
  'build',
  'build/pbf',
  'build/cache',
  'build/regions',
  'build/prefectural',
  'build/survey',
  'build/tiles',
  'build/tiles-prefectural',
  'build/decree',
  'build/n03',
  'build/n13',
  'build/overpass-baseline',
  'web/data',
];

/**
 * 止めると決めたことを伝える例外。scan() の深いところから decide() まで一息に
 * 戻す。以前は deny の JSON を書いて process.exit(0) していたため、判定だけを
 * 取り出して呼べなかった。
 */
class Denied extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Denied';
    this.reason = reason;
  }
}

const deny = (reason) => {
  throw new Denied(reason);
};

/* 判定中のリポジトリの場所。decide() が入口で書き換え、下の関数が直に読む。
 * 1 回の呼び出しで見る命令は 1 つなので、引数で持ち回らない。 */
let ROOT = '';
let ROOT_PARTS = [];

/* ------------------------------------------------------------- 場所を読む --- */

/**
 * 位置 i のバックスラッシュが、二重引用符の中で次の 1 文字をただの文字として
 * 読ませるか。bash は次が `"` か `\` のときだけそう読み、`C:\Users` はそのまま
 * 残す。単一引用符の中では意味が無く、`\'` は引用符を閉じる。
 *
 * 連なりは左から対で読む。`\\"` は `"` が引用符を閉じ、`\\\"` は最後の `\"` が
 * ただの文字になる。1 文字だけ見て `\"` かを判定すると偶奇を数え違える。
 *
 * posix が偽なら常に読ませない。PowerShell の二重引用符ではバックスラッシュは
 * 常にただの文字で、`"C:\foo\"` はそこで閉じる。bash の規則を当てると引用符が
 * 開いたままになり、後ろの命令が引用符の中身になる。
 */
const escapesNext = (text, i, quote, posix) =>
  posix &&
  quote === '"' &&
  text[i] === '\\' &&
  (text[i + 1] === '"' || text[i + 1] === '\\');

/**
 * 文字を語に割る。引用符の中では区切らない。`echo "…; rm -rf build"` の中身を
 * 命令と読むと、書き留めるだけの命令まで止める。
 */
function tokenize(text, posix) {
  const out = [];
  let word = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escapesNext(text, i, quote, posix)) {
        word += text[++i];
        continue;
      }
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
 * 注記を落とす。`ls build # rm -rf build はしない` の後ろ半分は走らない。
 * 引用符の中の `#` はただの文字である。
 */
function stripComments(text, posix) {
  const out = [];
  for (const line of text.split('\n')) {
    let quote = '';
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (escapesNext(line, i, quote, posix)) {
          i++;
          continue;
        }
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
 * ヒアドキュメントの中身を落とす。書き込む文章であって命令ではない。改行で
 * 段に割ると中の 1 行が命令に見える。docs はその形で `rm -rf build` を載せて
 * いる。
 */
function stripHeredocs(text) {
  /* 区切り語は行の終わりに来る(`cat > notes.md <<'EOF'`)。向き先が後ろに続く
   * `cat <<'EOF' > notes.md` も同じ形である。行の途中の `<<EOF` は文章の中の
   * 文字列で、`<<<`(here-string)は区切り語を取らない。 */
  const OPEN =
    /(?:^|[^<])<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*(?:[<>|]+\s*\S+\s*)*$/;
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = OPEN.exec(lines[i]);
    if (!m) continue;
    /* `bash <<'EOF'` の中身は走る命令である。`cat <<'EOF' | bash` のように
     * shell は行の後ろにも来る。 */
    if (lines[i].split(/[\s|]+/).some((w) => w && SHELLS.test(nameOf(w)))) {
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== m[2]) end++;
    /* 閉じないまま終わったなら区切り語ではなかった。読み飛ばさない。 */
    if (end >= lines.length) continue;
    i = end;
  }
  return out.join('\n');
}

/**
 * 続く行をつなぐ。行末の `\`(bash)、`` ` ``(PowerShell)、`|` は命令がまだ
 * 終わらない印である。改行を区切りに数えると、消す先だけが命令の無い段に
 * 落ちて通ってしまう。
 */
const joinContinuations = (text) =>
  text
    .replace(/\\\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .replace(/\|[ \t]*\r?\n/g, ' | ');

/**
 * 命令を段に割る。引用符の中の区切りは効かない。手前の区切りが `|` 単体だったか
 * を憶えておく。PowerShell は消す先を pipe で渡すので、その段にはオプションしか
 * 無い。
 */
function segments(text, posix) {
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
      if (escapesNext(text, i, quote, posix)) {
        cur += ch + text[i + 1];
        i++;
        continue;
      }
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
 * 語を絶対パスの要素の配列にする。相対パスは cwd から解く。cwd が分からなければ
 * null。glob は残し、どこまで広がるかは保護対象と突き合わせるときに見る。
 */
function toAbsParts(token, cwd) {
  let t = token
    /* 今いる場所を指す書き方。展開されずに来るので、ここで解く。括弧を外すより
     * 先に済ませないと `$(pwd)` の `)` が先に落ちて当たらなくなる。他の変数は
     * 中身が分からないので字として扱う。 */
    .replace(/^\$(env:)?\{?PWD\}?|^\$\(pwd\)|^`pwd`/i, '.')
    .replace(/^\$(env:)?\{?CLAUDE_PROJECT_DIR\}?/, ROOT)
    /* 引用符と、`(cd x && rm -rf build)` の丸括弧と波括弧を外す。 */
    .replace(/^[({'"]+|[)}'"]+$/g, '')
    .replace(/\\/g, '/')
    /* 円記号をスラッシュにすると `\\` が `//` になるので、重なりは畳む。 */
    .replace(/\/{2,}/g, '/');
  if (!t) return null;
  /* Git Bash の絶対パス `/d/nanase/…` を `d:/nanase/…` に寄せる。同じ場所が
   * `D:\nanase\…` とも書かれる。 */
  t = t.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/');

  let abs;
  if (/^[a-zA-Z]:\//.test(t) || t.startsWith('/')) abs = t;
  else if (cwd === null) return null;
  else abs = `${cwd.join('/')}/${t}`;

  const parts = [];
  for (const part of abs.split('/')) {
    /* 先頭の空は POSIX のルート。それ以外の空は畳む。 */
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
 * glob を含むパス要素を、その要素に当たるかの検査にする。`[bw]*` のような文字の
 * 組も glob である。`b*` を止めて `[bw]*` を通しては書き方で答えが割れる。
 * 角括弧は正規表現の文字の組として通し、組み損ねていればただの文字にする。
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
 * 絶対パスをリポジトリからの相対にする。ルートそのものと祖先は空配列で、
 * 保護対象を全部巻き込む。木の外なら null。
 */
function underRoot(parts) {
  if (parts === null) return null;
  /* POSIX のルート。この下に無い物は無い。 */
  if (parts.length === 1 && parts[0] === '') return [];
  const shared = Math.min(parts.length, ROOT_PARTS.length);
  for (let i = 0; i < shared; i++) {
    /* ここも glob で見る。パス要素の突き合わせだけを glob にしていたころ、
     * `rm -rf ../NationalRouteMap*` がリポジトリごと通っていた。 */
    if (!same(parts[i], ROOT_PARTS[i])) return null;
  }
  return parts.length <= ROOT_PARTS.length
    ? []
    : parts.slice(ROOT_PARTS.length);
}

/**
 * パス要素が同じ場所を指すか。まず文字として比べる。`[wip]` のような括弧を
 * 含む名前は glob として読むと自分自身に当たらず、そういう名前の下に置いた
 * リポジトリでフックが丸ごと効かなくなっていた。
 */
const same = (a, b) =>
  a.toLowerCase() === b.toLowerCase() || matcher(a).test(b);

/**
 * その場所が保護対象を巻き込むか。保護対象そのものかその上なら巻き込む。中を
 * 指しているだけ(`build/brand`)なら巻き込まない。
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
 * `build/{pbf,cache}` を `build/pbf` と `build/cache` に開く。開かないと、同じ
 * 物を消す命令が波括弧の位置だけで通ったり止まったりする。
 */
function expandBraces(word, depth = 0) {
  const m = depth > 4 ? null : /^(.*?)\{([^{}]*)\}(.*)$/.exec(word);
  if (!m) return [word];
  return m[2]
    .split(',')
    .flatMap((alt) => expandBraces(`${m[1]}${alt}${m[3]}`, depth + 1));
}

/* --------------------------------------------------------- 消す形を読む --- */

/* cmd のオプション `/s` `/q` は落とさない。Git Bash の drive のルート `/f` と
 * 見分けが付かず、落とすと F: に clone したときだけ穴が開く。消す先として
 * 読むと `s:/` `q:/` になり、リポジトリが S: や Q: に無いかぎり木の外として
 * 無視される。そこに clone すると `rd /s /q` が誤って止まる。再帰かどうかは
 * PS_RECURSIVE が別に見る。 */
const isFlag = (w) => w.startsWith('-');
const RM_RECURSIVE = (w) =>
  /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(w) || w === '--recursive';
/* PowerShell のオプションは前方一致で省略できる。Remove-Item で `-r` から始まる
 * のは -Recurse だけなので、`-r` も `-recu` も同じ意味である。 */
const PS_RECURSIVE = (w) =>
  /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(w) ||
  /* cmd のオプションは `/s/q` と束ねて書ける。1 文字ずつ見るのは、`/usr/share`
   * のようなパスをオプションと読まないため。 */
  (w.startsWith('/') && w.slice(1).toLowerCase().split('/').includes('s'));
const REMOVE = /^(rm|remove-item|ri|rd|rmdir|del|erase)$/i;
/* pipe の手前で中身を並べる命令。引数が無ければ今いる場所の中身を並べる。 */
const LISTING = /^(get-childitem|gci|ls|dir|get-item|gi)$/i;
/* `/usr/bin/rm` も rm である。 */
const nameOf = (w) =>
  w
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');

/* `git clean -x` は無視されているファイルを消す。`--exclude=…` のような長い
 * オプションの中の x は数えない。 */
const CLEAN_IGNORED = (w) => /^-[a-zA-Z]*[xX][a-zA-Z]*$/.test(w);
const DRY_RUN = (w) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w) || w === '--dry-run';
/* 除外の値がルートに解けたとき、その語が本当に全部へ当たるか。`*` と `**`
 * だけの要素でできた語は gitignore の型として全部に当たる。`.` や `..` は
 * ルートに解けても何も外さない。要素が空(先頭・末尾の `/`)なのは構わないが、
 * 値が空なら除外にならない。
 *
 * バックスラッシュはスラッシュに読み替えない。この値は場所ではなく gitignore の
 * 型で、バックスラッシュは次の 1 文字を逃がす。読み替えると `-e '\*'`(git には
 * 「`*` という名前のファイル」)が `/*` に見えて、何も外れていないのに通す。 */
const EXCLUDES_EVERYTHING = (token) => {
  const segs = token.split('/');
  return (
    segs.some((seg) => seg !== '') &&
    segs.every((seg) => seg === '' || /^\*+$/.test(seg))
  );
};
/* find が名前で当てるオプション。値はパス要素の名前に当たるので、保護対象の
 * 名前に当たらないと言える。 */
const NAMES = (w) => /^-(i?name|i?lname)$/.test(w);
/* パス全体に当たるオプション。要素の突き合わせでは当たらないことを言えない。 */
const WHOLE = (w) => /^-(i?path|i?regex|i?wholename)$/.test(w);
/* 保護対象の末尾の名前。find の絞りが当たるかどうかをこれで見る。 */
const PROTECTED_NAMES = [...new Set(PROTECTED.map((p) => p.split('/').pop()))];
/* find の絞り込み。当たったファイルだけを消す形になる。 */
const SELECTS = (w) =>
  /^-(i?name|i?path|i?regex|i?lname|newer[a-zA-Z]*|size|[acm]min|[acm]time|perm|user|group|links|inum|samefile)$/.test(
    w,
  );
/* PowerShell の下見。git clean の -n にあたる。 */
const WHAT_IF = (w) => /^-wh(a(t(i(f)?)?)?)?$/i.test(w);

/* 引数を走らせず、字として並べるだけの命令。ここに挟まった `rm` は
 * 書き留められた字である(`echo rm -rf build >> notes.md`、
 * `grep -rn rm -rf build .`)。 */
const PRINTS =
  /^(echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|sed|awk|diff|comm|curl|wget|write-output|write-host)$/i;

/* 後ろの命令をそのまま走らせる前置き。剥がさないと `sudo rm -rf build` の verb
 * が sudo になる。 */
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
/* shell の組みと制御構文。剥がさないと `(rm -rf build)` や
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
/* SHELLS のうち、二重引用符の中でバックスラッシュが文字を逃がす側。pwsh・
 * powershell・cmd は逃がさない。`powershell -Command "…"` や `cmd /c "…"` の
 * 中身は、呼ばれた側の規則で読む。 */
const isPosixShell = (name) => /^(ba|z|k|da|)sh$/i.test(name);
/* その後ろが命令になるオプション。`-lc` のように束ねても、`-Command` と綴っても
 * 来る。 */
const PAYLOAD_FLAG = (w) =>
  /^-[a-zA-Z]*c$/.test(w) || /^(-{1,2}|\/)(c|command)$/i.test(w);
/* `FOO=1 rm -rf build` の頭に付く代入。 */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
/* 変数で受けた消す先。展開されずに届くので、同じ命令の中で値が決まったぶんだけ
 * 覚える。中身の分からない変数は字のまま扱う。 */
const vars = new Map();
const VAR = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(.*)$/;
/* 変数は変数を指せる(`D=build; E=$D; rm -rf $E`)。解いた先がまた変数なら
 * もう一度解き、同じ名前へ戻ったら止める。 */
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
/* pipe から渡る物の置き場所。場所は書かれていない。 */
const PLACEHOLDER = (w) => /^(\{\}|%|\$_(\..+)?)$/.test(w);
/* 値を取るが、値が場所ではないオプション。`-ErrorAction SilentlyContinue` の
 * 値を消す先と数えると、pipe の手前を見に行かなくなる。`-Force` や `-WhatIf`
 * のようなスイッチは入れない。入れると `Remove-Item -Recurse -Force build` の
 * build が落ちる。 */
const NOT_A_PATH =
  /^-(erroraction|warningaction|informationaction|outbuffer|outvariable|errorvariable|warningvariable|informationvariable|pipelinevariable|depth|stream|encoding)$/i;

/* PowerShell は `-Path:build` とも書ける。オプションとして落とすと値ごと
 * 検査から外れる。 */
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
 * pipe の手前が並べている場所。分からなければ null を返し、消す先と
 * 決めつけない。`find build -type d | sort | xargs rm -rf` の sort のような段は
 * 並べている場所を変えないので、読める段に当たるまで手前へ辿る。絞る段
 * (Where-Object など)が挟まっても手前を見る。何が残るか読めないのは find の
 * -regex と同じである。
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
    /* 名前で絞ってあれば並ぶのは当たった物だけで、木は残る。find の -name と
     * 同じ扱いにし、`gci build -Filter *.log | ri` と
     * `find build -name '*.log' | xargs rm` で答えを変えない。 */
    if (rest.some((w) => /^-(filter|include|exclude)$/i.test(w))) return null;
    const paths = rest.filter((w) => !isFlag(w));
    return paths.length > 0 ? paths : ['.'];
  }
  return undefined;
}

/**
 * `$( … )` と `` ` … ` `` の中身。走る命令である。`echo $(rm -rf build)` は
 * build/ を消す。
 */
function substitutions(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '$' || text[i + 1] !== '(') continue;
    let depth = 1;
    let j = i + 2;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
    }
    if (depth === 0) out.push(text.slice(i + 2, j - 1));
    i = j - 1;
  }
  const ticks = text.split('`');
  for (let i = 1; i < ticks.length; i += 2) out.push(ticks[i]);
  return out;
}

/**
 * 段の中の、組みの括弧の数。`$(date)` と `arr=(a b)` の括弧は組みではないので
 * 数えない。数えると閉じだけが余り、後の本物の部分 shell が一段早く閉じる。
 *
 * 命令置換は段をまたぐ(`$(ls | head -1)` の中に区切りがある)。閉じないまま段が
 * 終わったら、その数を次の段へ持ち越す。
 */
function grouping(text, carried, posix) {
  let opens = 0;
  let closes = 0;
  let subst = carried;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escapesNext(text, i, quote, posix)) {
        i++;
        continue;
      }
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
  return { opens, closes, subst };
}

/* posix に既定値は置かない。どちらの規則で読むかは命令ごとに decide() が
 * 決める。以前の既定値は module scope の POSIX_START を指しており、判定と
 * 入出力が混ざっていた名残だった。 */
function scan(text, startCwd, depth, posix) {
  let cwd = startCwd;
  /* pushd が積んだ場所。popd で戻る。cd しか見ていなかったころ
   * `pushd build && rm -rf pbf` が通っていた。 */
  const stack = [];
  /* 部分 shell に入る前の場所。`(cd /tmp && ls); rm -rf build` の rm は括弧を
   * 出た後、つまりリポジトリのルートで走る。 */
  const subshells = [];
  /* この命令が作る場所。フックが走る時点ではまだ無いが、cd の頃には在る。 */
  const willExist = new Set();
  if (depth > 3) return cwd;

  /* いま繋がっている pipe の段。`|` で来た段は後ろに足し、そうでなければ新しく
   * 始める。 */
  let chain = [];
  const ready = joinContinuations(stripComments(stripHeredocs(text), posix));
  /* 命令置換の中身を先に読む。走る命令であり、同じ shell の中なので規則も
   * 変わらない。 */
  for (const inner of substitutions(ready)) scan(inner, cwd, depth + 1, posix);
  /* 閉じ括弧は、その段の命令を読み終えてから効く。次の段の頭で戻す。 */
  let closing = 0;
  /* 閉じないまま段が終わった命令置換の深さ。 */
  let substDepth = 0;
  for (const segment of segments(ready, posix)) {
    while (closing > 0 && subshells.length > 0) {
      cwd = subshells.pop();
      closing--;
    }
    /* 上で戻し切れなかったぶんはまだ効いていないので、前の段の残りに足す。 */
    const paren = grouping(segment.text, substDepth, posix);
    substDepth = paren.subst;
    closing += paren.closes;
    /* 組みの括弧は語にくっついて来る(`(cd build` の最初の語は `(cd`)。語の頭の
     * 括弧だけを離し、括弧だけの語を落とす。どこでも離すと `${PWD}` や `$(pwd)`
     * まで割れる。消す先の語の末尾に残る閉じ括弧は toAbsParts が外す。 */
    for (let k = 0; k < paren.opens; k++) subshells.push(cwd);
    let words = tokenize(
      segment.text
        .replace(/(^|\s)\(/g, '$1 ( ')
        /* 組みの `{` は後ろに空白が続く。`{a,b}` の `{` は語の一部なので
         * 離さない。離すと展開する前に割れる。 */
        .replace(/(^|\s)\{(?=\s)/g, '$1 { '),
      posix,
    ).filter((w) => !/^[({)}]+$/.test(w));
    /* `for d in build web/data; do …` と `foreach ($d in 'build','web/data')`
     * の値を覚える。for と in は KEYWORDS にあるので、剥がす前に読む。 */
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
    /* PowerShell の代入は `$d = 'build'`(等号が離れて来る)とも `$d='build'`
     * (1 語で来る)とも書く。 */
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
    /* 前に付いた sudo・xargs・制御構文と、そのオプションを落とす。 */
    while (
      words.length > 1 &&
      (WRAPPERS.has(words[0].toLowerCase()) ||
        KEYWORDS.has(words[0].toLowerCase()))
    ) {
      const keyword = KEYWORDS.has(words[0].toLowerCase());
      words = words.slice(1);
      if (!keyword) while (words.length && isFlag(words[0])) words.shift();
    }
    /* 頭の環境変数の代入は落とす。落とす前に値を覚える。`D=build; rm -rf $D`
     * の $D を知っているのはここだけである。 */
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

    /* `eval "rm -rf build"` の中身も命令である。今の shell の続きなので規則は
     * 変わらない。 */
    if (nameOf(verb) === 'eval' && rest.length > 0) {
      scan(rest.join(' '), cwd, depth + 1, posix);
      continue;
    }

    /* `bash -c "…"` や `cmd /c "…"` の中身も命令である。オプションの後ろを
     * 全部渡す(`cmd /c rmdir /s /q build` は語が分かれて来る)。規則は呼ばれた
     * 側に切り替える。`powershell -Command "…"` の中身ではバックスラッシュが
     * 文字を逃がさない。 */
    if (SHELLS.test(nameOf(verb))) {
      const i = rest.findIndex(PAYLOAD_FLAG);
      if (i !== -1 && rest.length > i + 1) {
        scan(
          rest.slice(i + 1).join(' '),
          cwd,
          depth + 1,
          isPosixShell(nameOf(verb)),
        );
        continue;
      }
    }

    /* 同じ命令の中で作る場所を覚える。`mkdir -p tmpwork && cd tmpwork &&
     * rm -rf ../build` の cd を、行き先が無いからと数えないでいた。 */
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
      /* 引数の無い pushd は積んだ場所と入れ替えるが、そこまでは追わない。 */
      const to = rest.find((w) => !isFlag(w));
      /* 行き先が読めないとき(引数が無い、`cd -`、`cd ~`)は動かさない。通すと
       * 木の中に居るかもしれない命令を見逃す。行き先が無いときも cd は
       * 失敗してその場に留まるので、`cd nope; rm -rf build` はルートで build/
       * を消す。 */
      if (!to || to === '-' || to.startsWith('~')) continue;
      /* 行き先も変数で受けられる。消す側だけ展開していたころ
       * `d=build; cd $d; rm -rf pbf` が通っていた。 */
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
      /* git 自身のオプションを読み飛ばして clean を探す。オプションの値
       * (`-c k=v` の k=v、`--git-dir .git` の .git)で打ち切らない。手前に
       * `-C <dir>` があれば走る場所を移す。 */
      const i = rest.indexOf('clean');
      let at = cwd;
      for (let j = 0; j < i; j++) {
        if (rest[j] === '-C' && rest[j + 1] !== undefined) {
          at = toAbsParts(rest[++j], at);
        }
      }
      const after = rest.slice(i + 1);
      const flags = after.filter((w) => w !== '--' && isFlag(w));
      /* `-e <pattern>` と `--exclude <pattern>` は値を取る。その値を pathspec
       * と読むと範囲を絞った扱いになって通ってしまう。短いオプションは
       * 束ねられるので `-xdfe node_modules` の e も同じである。 */
      const values = new Set();
      after.forEach((w, k) => {
        const takesValue = /^-[a-zA-Z]*e$/.test(w) || w === '--exclude';
        if (takesValue && after[k + 1] !== undefined) values.add(k + 1);
      });
      /* 消す範囲を絞る引数と、外す引数。 */
      const paths = after.filter(
        (w, k) => w !== '--' && !isFlag(w) && !values.has(k),
      );
      const excludes = [
        ...after.filter((_, k) => values.has(k)),
        ...after
          .filter((w) => w.startsWith('--exclude='))
          .map((w) => w.slice('--exclude='.length)),
      ];

      /* git clean が歩くのは走った場所から下だけである。docs/ の中で走っても
       * build/ には届かない。 */
      const reach = underRoot(at);
      let risk = reach === null ? [] : hits(reach);
      /* pathspec があれば、そこに入る物だけが対象になる。 */
      if (paths.length > 0) {
        const inScope = paths.flatMap((w) => {
          const rel = underRoot(toAbsParts(w, at));
          return rel === null ? [] : hits(rel);
        });
        risk = risk.filter((protectedPath) => inScope.includes(protectedPath));
      }
      /* 外してあるものは消えない。理由文が名指しを勧めるのに、名指しして
       * 外しても止まるのでは通り道が無い。
       *
       * ルートに解ける除外は、その語が本当に全部へ当たるときだけ「全部外した」
       * と数える(EXCLUDES_EVERYTHING)。prefix === '' を無条件に全部外した
       * 扱いにすると `-e .` が保護対象を通し、無条件に何も外していない
       * 扱いにすると無害な `-e '*'` まで止める。 */
      risk = risk.filter(
        (protectedPath) =>
          !excludes.some((e) => {
            const rel = underRoot(toAbsParts(e, at));
            if (rel === null) return false;
            const prefix = rel.join('/');
            if (prefix === '') return EXCLUDES_EVERYTHING(e);
            return (
              protectedPath === prefix || protectedPath.startsWith(`${prefix}/`)
            );
          }),
      );
      if (
        risk.length > 0 &&
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

    /* 消す命令は先頭とは限らない。`sudo -u me rm -rf build` の -u の値も
     * `env FOO=1 rm …` の代入も、オプションとして落とし切れない。語の並びの
     * 中から探すほうが、包みの種類を数え上げるより確かである。 */
    const at = PRINTS.test(nameOf(verb))
      ? -1
      : words.findIndex((w) => REMOVE.test(nameOf(w)));

    /* find は探す場所を先に書き、消す命令を後ろに置く。
     * `find build -type d -exec rm -rf {} +` の `{}` は場所ではない。 */
    if (nameOf(verb) === 'find') {
      /* `-exec rm -f {} +` も find が再帰するので木の中身は全部消える。
       * `find build -type f | xargs rm -f` と同じ形である。 */
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

      /* 再帰的な rm は当たった物を木ごと消す。名前の絞りが保護対象を外すと
       * 言えるときだけ通す。`-path` や `-regex` は探す場所の直下の build にも
       * 当たり、`-mtime` は名前を絞らない。 */
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
    /* 再帰は手前の段にも書ける。`gci build -Recurse | ri -Force` も
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

    /* この段が自分で名指ししている消す先。オプションの値と pipe の置き場所を
     * 数えると手前の段を見に行かなくなる。`-Path build,web/data` は 1 語で
     * 来る。名指しが無ければ消す先は pipe で渡っている
     * (`gci build | Remove-Item -Recurse`)ので、手前の段が並べている場所を
     * 読む。読めなければ何もしない。 */
    const named = args.filter(
      (w, i) =>
        !isFlag(w) &&
        !PLACEHOLDER(w) &&
        !(i > 0 && NOT_A_PATH.test(args[i - 1])),
    );
    let source = args;
    if (segment.piped && named.length === 0) {
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

/* ------------------------------------------------------------------ 判定 --- */
/**
 * 命令 1 つを判定する。止めるなら理由を、通すなら null を返す。
 *
 * 入出力を持たないので、テストは import して繰り返し呼べる。1 例ごとに node を
 * 起こしていたころは、テストファイル 1 つで全体の 21 秒を使っていた。main() も
 * 同じ関数を呼ぶので、検査されるのは写しではなく本物である。
 */
export function decide({ command, toolName, root }) {
  if (!command.trim()) return null;
  ROOT = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  ROOT_PARTS = ROOT.toLowerCase().split('/');
  /* 前の命令が覚えた変数を持ち越さない。 */
  vars.clear();
  /* フックは Bash と PowerShell の両方を見る(.claude/settings.json の
   * matcher)。二重引用符の中でバックスラッシュが文字を逃がすのは bash
   * だけなので、呼んだ道具の名前で規則を決める。 */
  const posix = !/^powershell$/i.test(toolName);
  try {
    scan(command, ROOT.split('/'), 0, posix);
  } catch (err) {
    if (err instanceof Denied) return err.reason;
    /* フック自身の不具合は握りつぶさない。何も言わずに通すのは、命令が
     * 読めなかったときだけである(main を参照)。 */
    throw err;
  }
  return null;
}

/* ------------------------------------------------------------------ 入口 --- */
/**
 * stdin に届く PreToolUse を読み、止めるなら deny を書いて終わる。
 *
 * 握りつぶすのは stdin の JSON を読めなかったときだけで、そのときは何も言わずに
 * 通す。フックが落ちて作業まで止まるのは行き過ぎである。decide() の予期しない
 * 例外はそのまま投げる。
 */
function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const reason = decide({
    command: String(input?.tool_input?.command ?? ''),
    toolName: String(input?.tool_name ?? ''),
    root: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  });
  if (reason === null) return;
  /* writeSync で書き切ってから終わる。process.stdout.write は Windows の pipe
   * では非同期なので、直後に exit すると deny が届かず、通す側へ倒れうる。 */
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
}

/* node が直に起動したときだけ stdin を読む。import されたとき(テスト)は何も
 * しない。 */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
