/* 生成物を守る番人 (.claude/hooks/guard-data-dirs.mjs) の判定。
 *
 * 番人は shell の命令文字列を読んで、build/ や web/data/ を木ごと消す形だけを
 * 止める。命令を正しく解釈するには shell を実装することになるので、実際には
 * 「消す形か」「消す先か」を近似して見ている。近似は、通しすぎても止めすぎても
 * 役に立たない——通せば取り直しに何時間もかかる物が消え、止めれば迂回される。
 *
 * だからここで検査するのは境目である。番人そのものを子プロセスとして起動して、
 * 本物の判定を通す。判定の写しを検査しても検証にはならない。
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, '.claude', 'hooks', 'guard-data-dirs.mjs');

/** 番人に命令を渡し、止めたなら理由を、通したなら null を返す。 */
function ask(command) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT.replace(/\\/g, '/') },
    encoding: 'utf8',
  });
  if (!out.trim()) return null;
  const { hookSpecificOutput } = JSON.parse(out);
  expect(hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(hookSpecificOutput.permissionDecision).toBe('deny');
  return hookSpecificOutput.permissionDecisionReason;
}

const REPO = ROOT.replace(/\\/g, '/');

describe('木ごと消す形を止める', () => {
  // 2026-08-27 に実際に打たれ、build/ を全部消した命令がこれ。
  test.each([
    ['rm -rf build'],
    [`cd ${REPO} && rm -rf build`],
    ['rm -rf build/'],
    ['rm -rf ./build'],
    ['rm -rf build/*'],
    [`rm -rf ${REPO}/build`],
    ['ls && rm -rf build && echo done'],
    ['rm -rf .'],
  ])('%s', (command) => {
    expect(ask(command)).toContain('巻き込みます');
  });

  // 旗は一続きとは限らない。--force に r が入っているので、長い旗を短い旗と
  // 同じ形で見ると `rm --force x` まで再帰扱いになる。
  test.each([['rm -f -r build'], ['rm -r -f build'], ['rm --recursive build']])(
    '%s',
    (command) => {
      expect(ask(command)).toContain('巻き込みます');
    },
  );

  // build/ の下も、消えれば取り直しになるものは同じく止める。
  test.each([
    ['rm -rf build/pbf'],
    ['rm -rf build/cache'],
    ['rm -rf build/n03'],
    ['rm -rf build/overpass-baseline'],
    ['rm -rf web/data'],
  ])('%s', (command) => {
    expect(ask(command)).toContain('巻き込みます');
  });

  // PowerShell と cmd の言い方でも同じ物が消える。
  test.each([
    ['Remove-Item -Recurse -Force build'],
    ['Remove-Item -Force -Recurse build'],
    ['rmdir /s /q build'],
  ])('%s', (command) => {
    expect(ask(command)).toContain('巻き込みます');
  });

  // 名指ししていなくても、無視されているファイルを消せば build/ が対象に入る。
  test.each([
    ['git clean -xdf'],
    ['git clean -fdx'],
    [`cd ${REPO} && git clean -xdf`],
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
    ['git clean -fd'],
  ])('%s', (command) => {
    expect(ask(command)).toBeNull();
  });

  // 消す命令ではない。cd の引数を rm の消す先と取り違えない。
  test.each([
    [`cd ${REPO} && rm -rf node_modules`],
    [`cd ${REPO} && rm build/social.png`],
    [`cd ${REPO} && bun run test`],
    ['ls -la build'],
    ['git status'],
    ['mise run pack'],
    ['node scripts/make_brand.mjs --card 1280x640 --out build/social.png'],
    ['grep -rn "rm -rf build" docs/'],
  ])('%s', (command) => {
    expect(ask(command)).toBeNull();
  });

  // この木の外は番人の持ち場ではない。
  test('リポジトリの外は見ない', () => {
    expect(ask('rm -rf /c/temp/scratch')).toBeNull();
  });
});

describe('読めない入力で作業を止めない', () => {
  // 番人が落ちて命令まで通らなくなるのは行き過ぎである。通して構わない。
  test.each([[''], ['{'], ['{"tool_input":{}}'], ['null']])('%p', (payload) => {
    const out = execFileSync(process.execPath, [HOOK], {
      input: payload,
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });
});
