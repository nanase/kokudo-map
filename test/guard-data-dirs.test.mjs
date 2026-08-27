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
 * 番人に渡すリポジトリは、この repo 自身ではなく仮の木にする。番人は
 * `cd` の行き先が実在するかを見るので、この repo を渡すと判定が手元の
 * build/ の有無に左右される。build/ は .gitignore にあり、CI には無い。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, '.claude', 'hooks', 'guard-data-dirs.mjs');

/* .claude/settings.json は番人を node で起動する。bun test の
 * process.execPath は bun なので、それで検査すると本番と違う処理系を
 * 見ることになる。 */
const NODE = 'node';

/* 仮の木。守る場所と同じ形だけを作る。 */
const REPO = mkdtempSync(join(tmpdir(), 'guard-')).replace(/\\/g, '/');
beforeAll(() => {
  for (const dir of ['build/pbf', 'build/cache', 'web/data', 'docs']) {
    mkdirSync(join(REPO, dir), { recursive: true });
  }
});
afterAll(() => {
  for (const dir of [REPO, AWAY]) rmSync(dir, { recursive: true, force: true });
});
/* 同じ場所の別の書き方。Windows の `d:/…` は Git Bash では `/d/…` になる。
 * ubuntu には drive letter が無いので、その場合は元のままになる。 */
const REPO_POSIX = REPO.replace(/^([a-zA-Z]):/, '/$1');
const REPO_BACKSLASH = REPO.replace(/\//g, '\\');
/* この木の外。隣に同じ名前の物があっても番人の持ち場ではない。 */
const OUTSIDE = `${REPO}-other`;
/* 実在する、この木の外の場所。行き先が無ければ cd は失敗する扱いなので、
 * 「外へ移ってから消す」を試すには実在する場所が要る。仮の木の隣に作る
 * ——上に置くと祖先になり、そこを消せば当然巻き込む。 */
const AWAY = mkdtempSync(join(tmpdir(), 'away-')).replace(/\\/g, '/');
/* リポジトリを含む上のディレクトリ。ここを消せば当然巻き込む。 */
const PARENT = dirname(REPO).replace(/\\/g, '/');
/* 仮の木の名前。命令の中に書くときは必ずここから取る。 */
const NAME = basename(REPO);
/* 仮の木が載っている drive の根。Git Bash では `/c` とも `/c/` とも書く。 */
const DRIVE = REPO.replace(/^([a-zA-Z]):.*$/, '/$1');

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
/* 改行。素の文字列の中に書けないので名前を付ける。 */
const NL = String.fromCharCode(10);

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

  // 行を続ける書き方。改行を区切りと数えると、消す先だけが命令の無い段に
  // 落ちる。
  test.each([
    [['rm -rf \\', 'build']],
    [['rm -rf \\', 'build/pbf \\', 'build/cache']],
    [['Get-ChildItem build |', 'Remove-Item -Recurse -Force']],
    [['Remove-Item -Recurse -Force `', 'build']],
  ])('%s', (lines) => denies(lines.join('\n')));

  // 波括弧は開く。同じ物を消す命令が、波括弧の位置だけで答えを変えない。
  test.each([
    ['rm -rf build/{pbf,cache}'],
    ['rm -rf {build,web/data}'],
    // 保護対象が後ろに来る組み。語の頭の `{` を組みの括弧として離すと、
    // 展開する前に割れて素通りしていた。
    ['rm -rf {node_modules,build}'],
    ['rm -rf ./{node_modules,build}'],
    ['rm -rf build/pbf build/cache'],
  ])('%s', denies);

  // 変数で受けた消す先。同じ命令の中で値が決まっているものは読む。
  test.each([
    ['D=build; rm -rf $D'],
    [`D=build && rm -rf ${D}{D}`],
    ['for d in build web/data; do rm -rf $d; done'],
    ['DIR=build; rm -rf $DIR/pbf'],
    // PowerShell の書き方でも同じ。
    ["$d = 'build'; Remove-Item -Recurse -Force $d"],
    ["foreach ($d in 'build','web/data') { Remove-Item -Recurse -Force $d }"],
  ])('%s', denies);

  // 同じ場所の別の綴り。斜線の有無で答えを変えない。
  test.each([
    [`rm -rf ${D}(pwd)`],
    ['rm -rf `pwd`/build'],
    [`rm -rf ${D}{PWD}`],
    [`rm -rf ${DRIVE}`],
    [`rm -rf ${DRIVE}/`],
    ['rm -rf /'],
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
    [`rm -rf ../${NAME}`],
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
    [`rm -rf ../${NAME}*`],
    [`rm -rf ${PARENT}/${NAME}*`],
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
    // shell に食わせるヒアドキュメントの中身は、書き込む文章ではなく命令。
    [["bash <<'EOF'", 'rm -rf build', 'EOF'].join(NL)],
    // find は探す場所を先に書く。rm の後ろにあるのは `{}` である。
    ['find build -type d -exec rm -rf {} +'],
    ['find web/data -delete'],
    // 場所を書かない find は、今いる場所から探す。
    ['cd build; find -delete'],
    ['cd build && find -type d -exec rm -rf {} +'],
    // pipe の先の rm も同じ。手前が絞らずに並べているなら、消えるのは木で
    // ある。書き方だけで答えを変えない。
    ['find build -type d | xargs rm -rf'],
    ['find build -type d -print0 | xargs -0 rm -rf'],
    ['find web/data | xargs rm -rf'],
    ['ls | xargs rm -rf'],
    // 再帰は手前の段にも書ける。
    ['Get-ChildItem build -Recurse | Remove-Item -Force'],
    ['gci -Path build -Recurse | ri -Force'],
    ['find build -type f | xargs rm -f'],
    // 絞りを足すと壊す範囲が広がる形。当たる先そのものを見る。
    ['find . -type d -name build -exec rm -rf {} +'],
    // find は再帰する。-exec の rm に -r が無くても木の中身は全部消える。
    ['find build -exec rm -f {} +'],
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
    // 手前にも引数が無ければ、消えるのは今いる場所の中身である。
    ['Get-ChildItem | Remove-Item -Recurse -Force'],
    ['ls | ri -Recurse -Force'],
    ['gci . | ri -r -Force'],
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
    // PowerShell と cmd は同じことを別の名前で書く。
    ['Set-Location build; Remove-Item -Recurse -Force pbf'],
    ['sl build; Remove-Item -Recurse -Force pbf'],
    ['chdir build && rm -rf pbf'],
    ['pushd build && rm -rf pbf && popd'],
    [`pushd ${AWAY} && popd && rm -rf build`],
    // 行き先が無ければ cd は失敗し、shell はルートに留まる。
    ['cd nope; rm -rf build'],
    ['cd -; rm -rf build'],
    // 積んでいなければ popd は失敗し、shell はその場に留まる。
    ['popd; rm -rf build'],
    // 部分 shell を出れば場所は戻る。括弧の外で走る rm はルートで走る。
    [`(cd ${AWAY} && ls); rm -rf build`],
    // 入れ子の部分 shell。`))` は 2 つである。
    ['(cd build && (ls)); rm -rf build'],
    ['cd build && rm -rf ../build/pbf'],
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
    // 範囲を絞る引数が保護対象を指していれば、絞っていても止める。
    ['git clean -xdf build'],
    ['git clean -xdf -- web/data'],
    // 値を取る旗の値は pathspec ではない。範囲を絞った扱いにしない。
    ['git clean -xdf -e node_modules'],
    ['git clean -e foo -xdf'],
    ['git clean --exclude foo -xdf'],
    // 短い旗は束ねられる。末尾の e も値を取る。
    ['git clean -xdfe node_modules'],
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
    // 範囲を絞ってあり、そこに保護対象が入らない。理由文が「名指しして
    // ください」と言うのだから、名指しした先は通らなければならない。
    ['git clean -xdf web/vendor'],
    ['git clean -xdf -- docs'],
    // git clean が歩くのは走った場所から下だけ。docs/ からは build/ に
    // 届かない。
    ['cd docs && git clean -xdf'],
    ['git -C docs clean -xdf'],
  ])('%s', allows);

  // pipe の手前は、rm にとっては探す場所であって消す先ではない。名前で
  // 絞ってあれば、消えるのは当たったファイルだけで木は残る。-delete でも
  // 答えは同じでなければならない。
  test.each([
    ["find . -name '*.tmp' | xargs rm -rf"],
    ["find build -name '*.log' -print0 | xargs -0 rm -rf"],
    ["find build -name '*.log' -delete"],
    ['find build -mtime +30 -delete'],
    // find 自身の -print を rm の旗と読み違えない。
    ['find build -name pbf -print -delete'],
    ["find build -name '*.log' -exec rm -rf {} +"],
  ])('%s', allows);

  // PowerShell の下見。git clean の -n と同じで、何も消さない。
  test.each([
    ['Remove-Item build -Recurse -WhatIf'],
    ['Remove-Item -Recurse -Force -WhatIf build'],
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
    [`cd ${AWAY} && rm -rf build`],
    // 括弧を付けても答えは変わらない。書き方が違うだけの同じ命令である。
    [`(cd ${AWAY} && rm -rf build)`],
    [`cd ${AWAY} && git clean -xdf`],
    [`rm -rf ${PARENT}/other*`],
    // 隣に置いた worktree の後始末。木の上へ出て別の枝へ降りるので、
    // `..` に潰して全部に当てると、事実でない理由で止めることになる。
    [`rm -rf ../${NAME}-worktree`],
    [`rm -rf ${PARENT}/${NAME}-worktree`],
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
