/* 生成物を守る番人 (.claude/hooks/guard-data-dirs.mjs) の判定。
 *
 * 番人は shell の命令文字列を読んで、build/ や web/data/ を木ごと消す形だけを
 * 止める。命令を正しく解釈するには shell を実装することになるので、実際には
 * 「消す形か」「消す先か」を近似して見ている。近似は、通しすぎても止めすぎても
 * 役に立たない——通せば取り直しに何時間もかかる物が消え、止めれば迂回される。
 *
 * だからここで検査するのは境目である。番人そのものを子プロセスとして起動して、
 * 本物の判定を通す。判定の写しを検査しても検証にはならない。
 *
 * 場所は必ず REPO から組み立てる。手元の絶対パスを書き写すと、CI の
 * ubuntu では同じ命令が木の外を指すことになり、そこだけ落ちる。
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, '.claude', 'hooks', 'guard-data-dirs.mjs');

/* .claude/settings.json は番人を node で起動する。bun test の
 * process.execPath は bun なので、それで検査すると本番と違う処理系を
 * 見ることになる。 */
const NODE = 'node';

const REPO = ROOT.replace(/\\/g, '/');
/* 同じ場所の別の書き方。Windows の `d:/…` は Git Bash では `/d/…` になる。
 * ubuntu には drive letter が無いので、その場合は元のままになる。 */
const REPO_POSIX = REPO.replace(/^([a-zA-Z]):/, '/$1');
const REPO_BACKSLASH = REPO.replace(/\//g, '\\');
/* この木の外。隣に同じ名前の物があっても番人の持ち場ではない。 */
const OUTSIDE = `${REPO}-other`;
/* リポジトリを含む上のディレクトリ。ここを消せば当然巻き込む。 */
const PARENT = dirname(REPO).replace(/\\/g, '/');

/** 番人に命令を渡し、止めたなら理由を、通したなら null を返す。 */
function ask(command) {
  const out = execFileSync(NODE, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    encoding: 'utf8',
  });
  if (!out.trim()) return null;
  const { hookSpecificOutput } = JSON.parse(out);
  expect(hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(hookSpecificOutput.permissionDecision).toBe('deny');
  return hookSpecificOutput.permissionDecisionReason;
}

/* 展開されないまま届く変数を書くための一字。素の文字列に `${` と書くと、
 * 書き忘れたテンプレート文字列と区別が付かない。 */
const D = '$';

const denies = (command) => expect(ask(command)).toContain('巻き込みます');
const allows = (command) => expect(ask(command)).toBeNull();

describe('木ごと消す形を止める', () => {
  // 2026-08-27 に実際に打たれ、build/ を全部消した命令がこれ。
  test.each([
    ['rm -rf build'],
    [`cd ${REPO} && rm -rf build`],
    ['rm -rf build/'],
    ['rm -rf ./build'],
    ['ls && rm -rf build && echo done'],
    ['rm -rf .'],
  ])('%s', denies);

  // 末尾の glob は「その中身ぜんぶ」で、親を消すのと同じ結果になる。
  // `*` だけを剥がしていたので、globstar の形が素通りしていた。
  test.each([
    ['rm -rf build/*'],
    ['rm -rf build/**'],
    ['rm -rf build/**/*'],
    ['rm -rf build/.'],
  ])('%s', denies);

  // 今いる場所ごと、あるいはその上ごと。どこで打たれたかは番人には分からない
  // ので、巻き込みうる形として扱う。`rm -rf *` は事故と同じ結果になる。
  test.each([
    ['rm -rf *'],
    ['rm -rf ./*'],
    ['rm -rf */'],
    ['rm -rf ..'],
    ['rm -rf ../NationalRouteMap'],
  ])('%s', denies);

  // 同じ場所が三通りの書き方で来る。
  test.each([
    [`rm -rf ${REPO}/build`],
    [`rm -rf ${REPO_POSIX}/build`],
    [`rm -rf "${REPO_BACKSLASH}\\build"`],
  ])('%s', denies);

  // リポジトリごと、あるいはその上ごと。相対で書けば止まるのに絶対で書けば
  // 通る、という食い違いがあった。書き方が違うだけの同じ命令である。
  test.each([
    [`rm -rf ${REPO}`],
    [`rm -rf ${PARENT}`],
    [`cd ${PARENT} && rm -rf ${basename(REPO)}`],
  ])('%s', denies);

  // 前方一致の glob。リポジトリのルートで `build*` は build に展開される。
  // ルートの段に当たる glob も同じ——リポジトリごと持っていく。
  test.each([
    ['rm -rf build*'],
    ['rm -rf b*'],
    ['rm -rf web/*'],
    ['rm -rf ../NationalRouteMap*'],
    [`rm -rf ${PARENT}/NationalRouteMap*`],
  ])('%s', denies);

  // 前に付いた命令や組みに隠れる。verb を段の先頭語だけで見ると素通りする。
  // 部分 shell は、作業ディレクトリを持ち帰らせないための自然な書き方なので
  // 当たりやすい。
  test.each([
    ['sudo rm -rf build'],
    ['xargs rm -rf build'],
    ['nohup rm -rf build'],
    ['bash -c "rm -rf build"'],
    ["sh -c 'cd build && rm -rf pbf'"],
    ['(rm -rf build)'],
    ['(cd build && rm -rf pbf)'],
    ['{ rm -rf build; }'],
    ['if true; then rm -rf build; fi'],
    ['for d in a b; do rm -rf build; done'],
    // 旗の値も代入も、旗として落とし切れる形ではない。
    ['sudo -u me rm -rf build'],
    ['env FOO=1 rm -rf build'],
    ['FOO=1 rm -rf build'],
    // 命令の綴りは名前だけとは限らない。git も同じで、rm 側だけ名前で
    // 見ていたので `/usr/bin/git clean -xdf` が素通りしていた。
    ['/usr/bin/rm -rf build'],
    ['/bin/rm -rf build'],
    ['rm.exe -rf build'],
    // -c の後ろは一語とは限らないし、旗の綴りも一通りではない。
    ['cmd /c rmdir /s /q build'],
    ['bash -lc "rm -rf build"'],
    ['powershell -Command "Remove-Item -Recurse build"'],
  ])('%s', denies);

  // 今いる場所を指す書き方。展開されないまま番人に届く。
  test.each([
    [`rm -rf "${D}PWD/build"`],
    [`rm -rf ${D}{PWD}/build`],
    [`rm -rf ${D}(pwd)/build`],
    [`rm -rf ${D}CLAUDE_PROJECT_DIR/build`],
  ])('%s', denies);

  // PowerShell は消す先を pipe でも読点でも渡す。どちらも 1 語では来ない。
  test.each([
    ['Remove-Item -Recurse -Force -Path build,web/data'],
    ['Get-ChildItem build | Remove-Item -Recurse -Force'],
    ['gci web/data | Remove-Item -Recurse -Force'],
  ])('%s', denies);

  // 木ごと消す形が、文章の後ろに続いていても読む。閉じない `<<EOF` で
  // 後ろを捨てていた。
  test('閉じない <<EOF の後ろも読む', () => {
    denies(['echo "docs mention <<EOF style"', 'rm -rf build'].join('\n'));
  });

  // 命令の中で場所が変わる。作業ディレクトリを追わないと、build/ の中から
  // 打たれた相対パスが素通りする。場所を変えるのは cd だけではない。
  test.each([
    ['cd build && rm -rf pbf'],
    ['pushd build && rm -rf pbf'],
    ['pushd build && rm -rf pbf && popd'],
    ['pushd /tmp && popd && rm -rf build'],
    ['cd web && rm -rf data'],
    ['cd build/pbf && rm -rf .'],
    [`(cd ${REPO} && rm -rf build)`],
  ])('%s', denies);

  // 旗は一続きとは限らない。--force に r が入っているので、長い旗を短い旗と
  // 同じ形で見ると `rm --force x` まで再帰扱いになる。
  test.each([['rm -f -r build'], ['rm -r -f build'], ['rm --recursive build']])(
    '%s',
    denies,
  );

  // build/ の下も、消えれば取り直しになるものは同じく止める。
  test.each([
    ['rm -rf build/pbf'],
    ['rm -rf build/cache'],
    ['rm -rf build/n03'],
    ['rm -rf build/overpass-baseline'],
    ['rm -rf web/data'],
  ])('%s', denies);

  // PowerShell と cmd の言い方でも同じ物が消える。PowerShell の旗は
  // 前方一致で省略できるので、-r は -Recurse である。
  test.each([
    ['Remove-Item -Recurse -Force build'],
    ['Remove-Item -Force -Recurse build'],
    ['Remove-Item -r -Force build'],
    ['Remove-Item -Recu build'],
    ['rmdir /s /q build'],
  ])('%s', denies);

  // 名指ししていなくても、無視されているファイルを消せば build/ が対象に入る。
  // git 自身の旗の先にある clean も読む。`-C` は走る場所を変える。旗の値
  // (`-c k=v` の k=v)で読み取りを打ち切らない。
  test.each([
    ['git clean -xdf'],
    ['git clean -fdx'],
    [`cd ${REPO} && git clean -xdf`],
    ['git -C . clean -xdf'],
    [`git -C ${REPO} clean -xdf`],
    ['cd build && git clean -xdf'],
    ['git -c core.autocrlf=false clean -xdf'],
    ['git --git-dir .git clean -xdf'],
    ['git --work-tree . clean -xdf'],
    ['/usr/bin/git clean -xdf'],
    ['git.exe clean -xdf'],
  ])('%s', (command) => {
    expect(ask(command)).toContain('git clean -x');
  });
});

describe('後始末は通す', () => {
  // ここを塞ぐと迂回される。番人が止めるのは木ごと消す形だけである。
  test.each([
    ['rm build/social.png'],
    ['rm -f build/social.png'],
    ['rm --force build/social.png'],
    ['rm -rf build/brand'],
    ['rm -rf node_modules'],
    ['rm -rf web/vendor'],
    ['cd build && rm social.png'],
  ])('%s', allows);

  // 何も消さない下見と、消す範囲を狭める旗。--exclude の x を -x と
  // 読み違えない。
  test.each([
    ['git clean -fd'],
    ['git clean -ndx'],
    ['git clean --dry-run -x'],
    ['git clean --exclude=foo.txt -fd'],
  ])('%s', allows);

  // POSIX の rmdir は空のディレクトリしか消せない。再帰の旗が無ければ、
  // build/ を名指ししていても何も起きない。
  test('rmdir build', () => allows('rmdir build'));

  // git rm --cached が触るのは索引だけで、ファイルは残る。
  test('git rm -r --cached build', () => allows('git rm -r --cached build'));

  // 消す命令ではない。cd の引数を rm の消す先と取り違えない。
  test.each([
    [`cd ${REPO} && rm -rf node_modules`],
    [`cd ${REPO} && rm build/social.png`],
    [`cd ${REPO} && bun run test`],
    ['ls -la build'],
    ['git status'],
    ['mise run pack'],
    ['node scripts/make_brand.mjs --card 1280x640 --out build/social.png'],
  ])('%s', allows);

  // 引用符の中も、# の後ろも命令ではない。書き留めるだけの命令まで止めない。
  test.each([
    ['grep -rn "rm -rf build" docs/'],
    ['ls build # rm -rf build はしない'],
    ['echo ok  # cd build && rm -rf pbf'],
    ['echo "後始末: ; rm -rf build" >> notes.md'],
    ["git commit -m 'rm -rf build をやめた'"],
  ])('%s', allows);

  // ヒアドキュメントの中身も書き込む文章であって命令ではない。改行で段に
  // 割ると、中の一行が命令に見える。向き先は札の前にも後にも書ける。
  test.each([
    [["cat > notes.md <<'EOF'", '後始末は rm -rf build ではない', 'EOF']],
    [["cat <<'EOF' > notes.md", '後始末は rm -rf build ではない', 'EOF']],
    // 札が二つ。閉じた行を数え違えると、二つめの中身が命令として戻る。
    [
      [
        "cat > a.md <<'EOF'",
        'rm -rf build と書いてある',
        'EOF',
        "cat > b.md <<'EOF'",
        'ここにも rm -rf build と書いてある',
        'EOF',
      ],
    ],
  ])('%s', (lines) => allows(lines.join('\n')));

  // この木の外は番人の持ち場ではない。
  test.each([
    ['rm -rf /c/temp/scratch'],
    [`rm -rf ${OUTSIDE}/build`],
    ['rm -rf /tmp/claude/scratch'],
    ['cd /tmp && rm -rf build'],
    // 括弧を付けても答えは変わらない。書き方が違うだけの同じ命令である。
    ['(cd /tmp && rm -rf build)'],
    ['cd /tmp && git clean -xdf'],
    [`rm -rf ${PARENT}/other*`],
    // 隣に置いた worktree の後始末。木の上へ出て別の枝へ降りるので、
    // `..` に潰して全部に当てると、事実でない理由で止めることになる。
    ['rm -rf ../NationalRouteMap-worktree'],
    [`rm -rf ${PARENT}/NationalRouteMap-worktree`],
  ])('%s', allows);
});

describe('読めない入力で作業を止めない', () => {
  // 番人が落ちて命令まで通らなくなるのは行き過ぎである。通して構わない。
  test.each([[''], ['{'], ['{"tool_input":{}}'], ['null']])('%p', (payload) => {
    const out = execFileSync(NODE, [HOOK], {
      input: payload,
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });
});
