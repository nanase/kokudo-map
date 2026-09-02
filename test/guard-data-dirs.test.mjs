/* 生成物を守るフック(.claude/hooks/guard-data-dirs.mjs)の判定を検査する。
 *
 * フックは shell の命令文字列から、build/ や web/data/ を木ごと消す形だけを
 * 近似で見分ける。通しすぎれば取り直しに何時間もかかる物が消え、止めすぎれば
 * 迂回されるので、検査するのは境目である。
 *
 * 呼ぶのはフックの判定そのもの decide() である。判定の写しを検査しても
 * 検証にはならない。境目は 250 例を超え、以前は 1 例ごとに node を子
 * プロセスとして起こして 1 回 85 ms、このファイルだけでテスト全体の 21 秒を
 * 使っていた。
 *
 * プロセスを跨がないと検査できないもの(stdin の読み方、deny の JSON の形、
 * settings.json が使う node で同じ答えが返ること)だけを、下の「取り決め」で子
 * プロセスのまま残す。
 *
 * フックに渡すリポジトリは、この repo 自身ではなく仮の木にする。フックは `cd`
 * の行き先が実在するかを見るので、この repo を渡すと判定が手元の build/ の
 * 有無に左右される。build/ は .gitignore にあり、CI には無い。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from '../.claude/hooks/guard-data-dirs.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, '.claude', 'hooks', 'guard-data-dirs.mjs');

/* .claude/settings.json はフックを node で起動する。bun test の
 * process.execPath は bun なので、本番と同じ処理系を名指しする。
 * 「取り決め」だけが使う。 */
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
/* この木の外。隣に同じ名前の物があってもフックの持ち場ではない。 */
const OUTSIDE = `${REPO}-other`;
/* 実在する、この木の外の場所。行き先が無ければ cd は失敗する扱いなので、
 * 「外へ移ってから消す」を試すには実在する場所が必要である。仮の木の隣に作る。
 * 上に置くと祖先になり、そこを消せば巻き込む。 */
const AWAY = mkdtempSync(join(tmpdir(), 'away-')).replace(/\\/g, '/');
/* リポジトリを含む上のディレクトリ。ここを消せば当然巻き込む。 */
const PARENT = dirname(REPO).replace(/\\/g, '/');
/* 仮の木の名前。命令の中に書くときは必ずここから取る。 */
const NAME = basename(REPO);
/* 仮の木が載っている drive のルート。Git Bash では `/c` とも `/c/` とも
 * 書く。 */
const DRIVE = REPO.replace(/^([a-zA-Z]):.*$/, '/$1');

/** フックに命令を渡し、止めたなら理由を、通したなら null を返す。 */
const ask = (command, toolName = 'Bash') =>
  decide({ command, toolName, root: REPO });

/** PowerShell を呼んだ体でフックに命令を渡す。 */
const askPowerShell = (command) => ask(command, 'PowerShell');

/** 同じ問いを settings.json と同じ道(node の子プロセス、stdin、標準出力)で
 *  通す。「取り決め」だけが使う。 */
function askViaProcess(command, { toolName = 'Bash', root = REPO } = {}) {
  const out = execFileSync(NODE, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  });
  return out.trim();
}

/* 展開されないまま届く変数を書くための一字。素の文字列に `${` と書くと、
 * 書き忘れたテンプレート文字列と区別が付かない。 */
const D = '$';
/* 改行。素の文字列の中に書けないので名前を付ける。 */
const NL = String.fromCharCode(10);
/* 円記号。素の文字列に書くと、続く字と組んで別の字になる。 */
const BS = String.fromCharCode(92);

/* 止まったことだけを見る。理由文を要求すると、文面の違う git clean の側で
 * 落ちる。 */
const denies = (command) => expect(ask(command)).not.toBeNull();
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
    // 保護対象が後ろに来る組み。語の頭の `{` を組みの括弧として離すと、展開する
    // 前に割れて通っていた。
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
    // 変数は変数を指せる。1 段だけ解いても届かない。
    ['D=build; E=$D; rm -rf $E'],
    ['A=build; B=$A; C=$B; rm -rf $C/pbf'],
    // PowerShell の書き方でも同じ。
    ["$d = 'build'; Remove-Item -Recurse -Force $d"],
    ["$d='build'; Remove-Item -Recurse -Force $d"],
    ["foreach ($d in 'build','web/data') { Remove-Item -Recurse -Force $d }"],
  ])('%s', denies);

  // 同じ場所の別の綴り。スラッシュの有無で答えを変えない。
  test.each([
    [`rm -rf ${D}(pwd)`],
    ['rm -rf `pwd`/build'],
    [`rm -rf ${D}{PWD}`],
    [`rm -rf ${DRIVE}`],
    // cmd のオプションと同じ文字の drive も、ルートを指していれば同じである。
    [`rm -rf ${DRIVE.toLowerCase()}`],
    [`rm -rf ${DRIVE}/`],
    ['rm -rf /'],
  ])('%s', denies);

  // 末尾の glob は「その中身ぜんぶ」で、親を消すのと同じ結果になる。`*` だけを
  // 剥がしていたので、globstar の形が通っていた。
  test.each([
    ['rm -rf build/*'],
    ['rm -rf build/**'],
    ['rm -rf build/**/*'],
    ['rm -rf build/.'],
  ])('%s', denies);

  // 今いる場所ごと、あるいはその上ごと。どこで打たれたかはフックに
  // 分からないので、巻き込みうる形として扱う。
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

  // リポジトリごと、あるいはその上ごと。相対で書けば止まるのに絶対で書けば通る
  // 食い違いがあった。
  test.each([
    [`rm -rf ${REPO}`],
    [`rm -rf ${PARENT}`],
    [`cd ${PARENT} && rm -rf ${basename(REPO)}`],
  ])('%s', denies);

  // 前方一致の glob。リポジトリのルートで `build*` は build に展開される。
  // ルートの段に当たる glob はリポジトリごと持っていく。
  test.each([
    ['rm -rf build*'],
    ['rm -rf b*'],
    // 字の組も glob である。`b*` を止めて `[bw]*` を通さない。
    ['rm -rf [bw]*'],
    ['rm -rf build/[pc]*'],
    ['rm -rf buil?'],
    ['rm -rf web/*'],
    [`rm -rf ../${NAME}*`],
    [`rm -rf ${PARENT}/${NAME}*`],
  ])('%s', denies);

  // 前に付いた命令や組みに隠れる。verb を段の先頭語だけで見ると通る。部分 shell
  // は作業ディレクトリを持ち帰らせない自然な書き方なので当たりやすい。
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
    // オプションの値も代入も、オプションとして落とし切れる形ではない。
    ['sudo -u me rm -rf build'],
    ['env FOO=1 rm -rf build'],
    ['FOO=1 rm -rf build'],
    // 命令はパス付きでも来る。rm 側だけ名前で見ていたので
    // `/usr/bin/git clean -xdf` が通っていた。
    ['/usr/bin/rm -rf build'],
    ['/bin/rm -rf build'],
    ['rm.exe -rf build'],
    // -c の後ろは一語とは限らないし、オプションの綴りも一通りではない。
    ['cmd /c rmdir /s /q build'],
    // shell に食わせるヒアドキュメントの中身は、書き込む文章ではなく命令。
    [["bash <<'EOF'", 'rm -rf build', 'EOF'].join(NL)],
    // shell は行の後ろにも来る。
    [["cat <<'EOF' | bash", 'rm -rf build', 'EOF'].join(NL)],
    [["cat <<'EOF' | sh", 'rm -rf build', 'EOF'].join(NL)],
    // find は探す場所を先に書く。rm の後ろにあるのは `{}` である。
    ['find build -type d -exec rm -rf {} +'],
    ['find web/data -delete'],
    // 場所を書かない find は、今いる場所から探す。
    ['cd build; find -delete'],
    ['cd build && find -type d -exec rm -rf {} +'],
    // pipe の先の rm も同じ。手前が絞らずに並べているなら、消えるのは木である。
    ['find build -type d | xargs rm -rf'],
    ['find build -type d -print0 | xargs -0 rm -rf'],
    ['find web/data | xargs rm -rf'],
    ['ls | xargs rm -rf'],
    // 再帰は手前の段にも書ける。
    ['Get-ChildItem build -Recurse | Remove-Item -Force'],
    // 段は何段でも挟まる。挟まった段は並べる場所を変えない。
    ['find build -type d | sort | xargs rm -rf'],
    ['gci build -Recurse | Where-Object { $_.Name } | Remove-Item -Force'],
    // オプションの値と pipe の置き場所は、この段が名指しした消す先ではない。
    // 数えると手前の段を見に行かなくなる。
    [
      'Get-ChildItem build | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',
    ],
    ['Get-ChildItem build | ForEach-Object { Remove-Item $_ -Recurse -Force }'],
    ['gci build | % { ri $_.FullName -Recurse -Force }'],
    ['find build -type d | xargs -I % rm -rf %'],
    ['find build -type d | xargs -I{} rm -rf {}'],
    ['gci -Path build -Recurse | ri -Force'],
    ['find build -type f | xargs rm -f'],
    // 絞りを足すと壊す範囲が広がる形。当たる先そのものを見る。
    ['find . -type d -name build -exec rm -rf {} +'],
    // パスや正規表現で当てる絞りは、保護対象を外すと言えない。
    ["find . -path '*/build' -exec rm -rf {} +"],
    ["find build -regex '.*' -exec rm -rf {} +"],
    ['find build -mtime +30 -exec rm -rf {} +'],
    // find は再帰する。-exec の rm に -r が無くても木の中身は全部消える。
    ['find build -exec rm -f {} +'],
    ['bash -lc "rm -rf build"'],
    ['eval "rm -rf build"'],
    ['eval "cd build && rm -rf pbf"'],
    // 命令置換の中身も走る命令である。
    ['echo $(rm -rf build)'],
    ['x=$(rm -rf build)'],
    ['echo `rm -rf build`'],
    ['powershell -Command "Remove-Item -Recurse build"'],
    // 引用符の中の `\"` を閉じと数えると、続く `'` が閉じない単一引用符を
    // 開き、後ろの `&& rm -rf build` が引用符の中身になって通ってしまう。sed は
    // PRINTS にあるので、正しく読めば全体が 1 引数で済む。
    [`sed -i "s/${BS}"/'/g" f.txt && rm -rf build`],
    // バックスラッシュの連なりは左から対で読む。直前に偶数個並べば互いに対に
    // なって消え、直後の引用符は普通に閉じる(`"a\\"`)。1 字先だけ見ると偶奇を
    // 数え違え、後ろの `&& rm -rf build` が引用符の中身になる。
    [`echo "a${BS}${BS}" && rm -rf build`],
  ])('%s', denies);

  // 今いる場所を指す書き方。展開されないままフックに届く。
  test.each([
    [`rm -rf "${D}PWD/build"`],
    [`rm -rf ${D}{PWD}/build`],
    [`rm -rf ${D}(pwd)/build`],
    [`rm -rf ${D}CLAUDE_PROJECT_DIR/build`],
    // PowerShell は環境変数を $env: で読む。
    [`Remove-Item -Recurse -Force "${D}env:CLAUDE_PROJECT_DIR${BS}build"`],
    [`Remove-Item -Recurse -Force ${D}env:PWD/build`],
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

  // 文章の後ろに続く木ごと消す形も読む。閉じない `<<EOF` で後ろを捨てていた。
  test('閉じない <<EOF の後ろも読む', () => {
    denies(['echo "docs mention <<EOF style"', 'rm -rf build'].join('\n'));
  });

  // 命令の中で場所が変わる。作業ディレクトリを追わないと、build/ の中から
  // 打たれた相対パスが通る。場所を変えるのは cd だけではない。
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
    // `$(…)` と `arr=(…)` の括弧は組みではない。数えると後の部分 shell が一段
    // 早く閉じる。
    ['echo $(date) ; (cd build && rm -rf pbf)'],
    ['arr=(a b); (cd build && rm -rf pbf)'],
    // 命令置換は段をまたぐ。数えかけを持ち越さないと、部分 shell が一段早く
    // 閉じる。
    ['(cd build; echo $(ls | head -1); rm -rf pbf)'],
    ['(cd build && echo $(ls | head -1) && rm -rf pbf)'],
    ['cd build && rm -rf ../build/pbf'],
    // 行き先は同じ命令の中で作られる。無いからと数えないと通る。
    ['mkdir -p tmpwork && cd tmpwork && rm -rf ../build'],
    // 行き先も変数で受けられる。消す側だけ展開していた。
    ['d=build; cd $d; rm -rf pbf'],
    ['$d = "build"; Set-Location $d; Remove-Item -Recurse -Force pbf'],
    ['mkdir -p build/tmp && cd build/tmp && rm -rf ../../build'],
    ['cd web && rm -rf data'],
    ['cd build/pbf && rm -rf .'],
    [`(cd ${REPO} && rm -rf build)`],
  ])('%s', denies);

  // オプションは一続きとは限らない。--force に r が入っているので、長い
  // オプションを短いものと同じ形で見ると `rm --force x` まで再帰扱いになる。
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
    ['rm -rf build/survey'],
    ['rm -rf build/prefectural'],
    ['rm -rf build/tiles-prefectural'],
    ['rm -rf web/data'],
  ])('%s', denies);

  // PowerShell と cmd の言い方でも同じ物が消える。PowerShell のオプションは
  // 前方一致で省略できるので、-r は -Recurse である。
  test.each([
    ['Remove-Item -Recurse -Force build'],
    ['Remove-Item -Force -Recurse build'],
    ['Remove-Item -r -Force build'],
    // -Force はスイッチで値を取らない。後ろの語は消す先である。
    ['Remove-Item -Recurse -Force build'],
    ['gci docs | Remove-Item -Recurse -Force build'],
    ['Remove-Item -Recu build'],
    ['rmdir /s /q build'],
    // cmd のオプションは束ねて書ける。
    ['rd /s/q build'],
    ['rd /q/s build'],
    ['cmd /c rd /s/q build'],
    // PowerShell はオプションと値を `:` でも繋ぐ。
    ['Remove-Item -Path:build -Recurse -Force'],
  ])('%s', denies);

  // 名指ししていなくても、無視されているファイルを消せば build/ が対象に入る。
  // git 自身のオプションの先にある clean も読む。`-C` は走る場所を変える。
  // オプションの値(`-c k=v` の k=v)で読み取りを打ち切らない。
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
    // 値を取るオプションの値は pathspec ではない。範囲を絞った扱いにしない。
    ['git clean -xdf -e node_modules'],
    ['git clean -e foo -xdf'],
    ['git clean --exclude foo -xdf'],
    // 短いオプションは束ねられる。末尾の e も値を取る。
    ['git clean -xdfe node_modules'],
    // 外した先が保護対象を覆っていなければ、残りは消える。
    ['git clean -xdf -e node_modules'],
    // 根に解ける除外は「全部外した」ではなく「何も外していない」。git の
    // `-e` が取るのは gitignore の型で、`.` は何も外さない。
    ['git clean -xdf -e .'],
    ['git clean -xdf -e ..'],
    // `\*` は git には「`*` という名前のファイル」で、build/ も web/data/ も
    // 外れない。バックスラッシュをスラッシュに読み替えてパスとして解くと `*`
    // だけの除外と区別が付かず、通してしまう。
    [String.raw`git clean -xdf -e '\*'`],
  ])('%s', (command) => {
    expect(ask(command)).toContain('git clean -x');
  });
});

describe('後始末は通す', () => {
  // ここを塞ぐと迂回される。フックが止めるのは木ごと消す形だけである。
  test.each([
    ['rm build/social.png'],
    ['rm -f build/social.png'],
    ['rm --force build/social.png'],
    ['rm -rf build/brand'],
    ['rm -rf node_modules'],
    ['rm -rf web/vendor'],
    // 組み損ねた角括弧は字である。落ちずに、当たらないままにする。
    ['rm -rf [broken'],
    ['cd build && rm social.png'],
  ])('%s', allows);

  // 何も消さない下見と、消す範囲を狭めるオプション。--exclude の x を -x と
  // 読み違えない。
  test.each([
    ['git clean -fd'],
    ['git clean -ndx'],
    ['git clean --dry-run -x'],
    ['git clean --exclude=foo.txt -fd'],
    // 範囲を絞ってあり、そこに保護対象が入らない。理由文が名指しを勧めるの
    // だから、名指しした先は通す。
    ['git clean -xdf web/vendor'],
    ['git clean -xdf -- docs'],
    // 保護対象を名指しで外してある。同じ理由で通す。
    ['git clean -xdf -e build -e web/data'],
    ['git clean -xdf --exclude=build --exclude=web/data'],
    // `*` や `**` だけの除外はパスとしては根に解けるが、gitignore の型として
    // 本当に全部へ当たるので無害である。根に解けたことだけで「何も
    // 外していない」と決めると止めてしまう。
    ["git clean -xdf -e '*'"],
    ["git clean -xdf -e '**'"],
    // git clean が歩くのは走った場所から下だけ。docs/ からは build/ に
    // 届かない。
    ['cd docs && git clean -xdf'],
    // 部分 shell の中で docs へ移っている。消えるのは docs/build である。
    ['echo $(date) ; (cd docs && rm -rf build)'],
    ['git -C docs clean -xdf'],
  ])('%s', allows);

  // pipe の手前は rm にとって探す場所であって消す先ではない。名前で絞ってあれば
  // 消えるのは当たったファイルだけで、木は残る。-delete でも同じ。
  test.each([
    ["find . -name '*.tmp' | xargs rm -rf"],
    ["find build -name '*.log' -print0 | xargs -0 rm -rf"],
    // 手前が読めない段なら、消す先と決めつけない。
    ['echo build | xargs rm -rf'],
    // 自分で名指ししているなら、手前は見ない。
    ['ls | rm -rf node_modules'],
    ["find build -name '*.log' -delete"],
    ['find build -mtime +30 -delete'],
    // find 自身の -print を rm のオプションと読み違えない。
    ['find build -name pbf -print -delete'],
    ["find build -name '*.log' -exec rm -rf {} +"],
    // PowerShell の絞り込みも同じ。`-Filter` の値は場所ではない。
    ['Get-ChildItem build -Recurse -Filter *.log | Remove-Item -Force'],
    ['Get-ChildItem docs -Recurse -Filter build* | Remove-Item -Force'],
  ])('%s', allows);

  // PowerShell の下見。git clean の -n と同じで、何も消さない。
  test.each([
    ['Remove-Item build -Recurse -WhatIf'],
    ['Remove-Item -Recurse -Force -WhatIf build'],
  ])('%s', allows);

  // POSIX の rmdir は空のディレクトリしか消せない。再帰のオプションが無ければ、
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
    // 引数を走らせず字として並べるだけの命令。引用符が無くても同じである。
    ['echo rm -rf build >> notes.md'],
    ['grep -rn rm -rf build .'],
    ['printf "rm -rf build"'],
    ['ls build # rm -rf build はしない'],
    ['echo ok  # cd build && rm -rf pbf'],
    ['echo "後始末: ; rm -rf build" >> notes.md'],
    ["git commit -m 'rm -rf build をやめた'"],
    // 引用符の中の `\"` を閉じと数えると、中身が空白で割れて `rm` が外の語に
    // なる。node は PRINTS に無いが、正しく読めば 1 引数のままである。
    [`node -e "console.log(${BS}"rm -rf build${BS}")"`],
    // バックスラッシュが奇数個並ぶと引用符はただの文字になり、そこから先は
    // 閉じていない引用符の中身である。bash では閉じない引用符は構文エラーで、
    // 命令が走らない。
    [`echo "a${BS}${BS}${BS}" rm -rf build`],
  ])('%s', allows);

  // ヒアドキュメントの中身も書き込む文章であって命令ではない。向き先は区切り語
  // の前にも後にも書ける。
  test.each([
    [["cat > notes.md <<'EOF'", '後始末は rm -rf build ではない', 'EOF']],
    [["cat <<'EOF' > notes.md", '後始末は rm -rf build ではない', 'EOF']],
    // 区切り語が二つ。閉じた行を数え違えると、二つめの中身が命令として戻る。
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

  // この木の外はフックの持ち場ではない。
  test.each([
    ['rm -rf /c/temp/scratch'],
    [`rm -rf ${OUTSIDE}/build`],
    ['rm -rf /tmp/claude/scratch'],
    [`cd ${AWAY} && rm -rf build`],
    // 括弧を付けても答えは変わらない。
    [`(cd ${AWAY} && rm -rf build)`],
    [`cd ${AWAY} && git clean -xdf`],
    [`rm -rf ${PARENT}/other*`],
    // 隣に置いた worktree の後始末。木の上へ出て別の枝へ降りるので、`..` に
    // 潰して全部に当てると誤って止める。
    [`rm -rf ../${NAME}-worktree`],
    [`rm -rf ${PARENT}/${NAME}-worktree`],
  ])('%s', allows);
});

describe('木の名前に括弧があっても効く', () => {
  /* glob の字の組として読むと `[wip]` は自分自身に当たらず、underRoot が
   * 全部 null を返してフックが丸ごと効かなくなっていた。 */
  const BRACKET = join(mkdtempSync(join(tmpdir(), 'guard-')), '[wip]', 'repo')
    .split(BS)
    .join('/');
  beforeAll(() => {
    for (const dir of ['build/pbf', 'web/data']) {
      mkdirSync(join(BRACKET, dir), { recursive: true });
    }
  });
  afterAll(() =>
    rmSync(dirname(dirname(BRACKET)), { recursive: true, force: true }),
  );

  test.each([['rm -rf build'], ['rm -rf web/data'], ['rm -rf .']])(
    '%s',
    (command) => {
      expect(
        decide({ command, toolName: 'Bash', root: BRACKET }),
      ).not.toBeNull();
    },
  );
});

describe('PowerShell の二重引用符でバックスラッシュはエスケープにならない', () => {
  // テスト名の「綴り」は、二重引用符の中でバックスラッシュが文字を逃がすか
  // の規則を指す。bash の規則をそのまま当てると、閉じたはずの引用符が開いた
  // ままになり、後ろの命令が引用符の中身になる。
  test('PowerShell を名指しした呼び出しではバックスラッシュが引用符を閉じさせる', () => {
    expect(
      askPowerShell(
        `Remove-Item -Recurse "C:${BS}somewhere${BS}" ; Remove-Item -Recurse -Force build`,
      ),
    ).not.toBeNull();
  });

  // 規則が変わっても、木ごと消す形はそのまま止まる。
  test('PowerShell の普通の再帰削除は変わらず止まる', () => {
    expect(askPowerShell('Remove-Item -Recurse -Force build')).not.toBeNull();
  });

  // 安全な命令まで止めない。
  test('末尾がバックスラッシュのパスだけなら通す', () => {
    expect(askPowerShell(`Get-ChildItem "C:${BS}temp${BS}"`)).toBeNull();
  });

  // Bash から PowerShell を呼んだ命令の中身は、PowerShell の規則で読む。
  test('Bash から呼んだ powershell -Command の中身は PowerShell の綴りで読む', () => {
    expect(
      ask(
        `powershell -Command "Remove-Item -Recurse ${BS}"C:${BS}x${BS}" ; Remove-Item -Recurse -Force build"`,
      ),
    ).not.toBeNull();
  });
});

/* ------------------------------------------------------------- 取り決め --- */
/* ここから下だけが子プロセスを起こす。判定の運ばれ方(stdin の読み方、deny の
 * JSON の形、settings.json が使う node で同じ答えが返ること)はプロセスを
 * 跨がないと検査できない。 */

describe('読めない入力で作業を止めない', () => {
  // フックが落ちて命令まで通らなくなるのは行き過ぎである。通して構わない。
  test.each([[''], ['{'], ['{"tool_input":{}}'], ['null']])('%p', (payload) => {
    const out = execFileSync(NODE, [HOOK], {
      input: payload,
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });
});

describe('deny は PreToolUse の取り決めどおりに返る', () => {
  test('止めるときは deny の JSON を書く', () => {
    const { hookSpecificOutput } = JSON.parse(askViaProcess('rm -rf build'));
    expect(hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(hookSpecificOutput.permissionDecision).toBe('deny');
    expect(hookSpecificOutput.permissionDecisionReason).toContain('build');
  });

  test('通すときは何も書かない', () => {
    expect(askViaProcess('rm build/social.png')).toBe('');
  });
});

describe('node で起動しても同じ答えを返す', () => {
  /* 上の 250 例は bun の中で decide() を呼ぶが、本番は node が起動する。判定は
   * 文字列と正規表現しか使わないので処理系で変わらないはずだが、その「はず」を
   * 検査にする。代表を両方の道で通し、答えが一致することだけを見る。 */
  test.each([
    ['rm -rf build'],
    ['rm -rf web/data'],
    ['git clean -xdf'],
    ['rm build/social.png'],
    ['rm -rf build/brand'],
    [`rm -rf ${AWAY}`],
  ])('%s', (command) => {
    const viaProcess = askViaProcess(command);
    const inProcess = ask(command);
    expect(
      viaProcess === ''
        ? null
        : JSON.parse(viaProcess).hookSpecificOutput.permissionDecisionReason,
    ).toBe(inProcess);
  });
});
