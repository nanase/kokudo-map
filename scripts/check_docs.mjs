/* Keep the lists of commands from disagreeing with each other.
 *
 * There are two task runners here, on purpose. mise owns the data pipeline and
 * the server, because those are Python started by uv and take arguments; bun
 * owns the code and the assets, because those are JavaScript. The split is by
 * what the task is made of, not by taste.
 *
 * What goes wrong is not the split but the copies of it. A task's name lives in
 * mise.toml, and again in README's table, and once lived in CLAUDE.md as well;
 * `mise run build` had already fallen out of both tables without anyone
 * noticing, because nothing was reading them. This does.
 *
 * The parsing is deliberately shallow — task headers and table rows, by line.
 * It is checking that two lists of names agree, and a TOML parser would not
 * make that answer any truer.
 *
 * Usage:  node scripts/check_docs.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const all = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const list = (names) => [...names].sort().join(', ') || '(なし)';

const fails = [];
const ok = (cond, msg) => {
  if (cond) console.log(`PASS  ${msg}`);
  else fails.push(`FAIL  ${msg}`);
};

const mise = read('mise.toml');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

const miseTasks = new Set(all(mise, /^\[tasks\.([\w-]+)\]/gm));
const pkgScripts = new Set(Object.keys(pkg.scripts));

/* ---- 1. 同じ名前を二つの runner が持たない ------------------------------- */
const both = [...miseTasks].filter((t) => pkgScripts.has(t));
ok(
  both.length === 0,
  both.length
    ? `mise と bun の両方が定義している: ${list(both)}`
    : 'mise と bun で名前が重なっていない',
);

/* ---- 2. README の表が mise のタスクと一致する ---------------------------- */
const inReadme = new Set(all(readme, /^\| `mise run ([\w-]+)/gm));
const missing = [...miseTasks].filter((t) => !inReadme.has(t));
const extra = [...inReadme].filter((t) => !miseTasks.has(t));
ok(missing.length === 0, `README の表に無い mise タスク: ${list(missing)}`);
ok(extra.length === 0, `mise に無いのに README が挙げている: ${list(extra)}`);

/* ---- 3. README が挙げる bun のコマンドが実在する ------------------------- */
const inReadmeBun = new Set([
  ...all(readme, /^bun run ([\w:-]+)/gm),
  ...all(readme, /^\| `bun run ([\w:-]+)`/gm),
]);
const unknown = [...inReadmeBun].filter((s) => !pkgScripts.has(s));
ok(
  unknown.length === 0,
  `package.json に無いのに README が挙げている: ${list(unknown)}`,
);

/* ---- 4. 黙って半分しか実行されないタスクが無い --------------------------- */
/* mise は Windows では inline の run を `cmd /c` に渡す。複数行を書くと 1 行目
 * しか実行されず、しかも終了コードは 0 になる。`mise run pack` はそれで、タイル
 * を切ったあと PMTiles にも全国検証にも届かないまま成功を名乗っていた。
 *
 * 対処は 1 行にするか、そのタスクに `shell` を明示するかである。どちらでもない
 * 複数行の run をここで止める。プロジェクト設定の
 * `windows_default_inline_shell_args` は mise が安全上の理由で無視するので、
 * 設定ひとつで直すことはできない。 */
const TRIPLE = '"'.repeat(3);
const multiline = [];
for (const m of mise.matchAll(
  /^\[tasks\.([\w:-]+)\]([\s\S]*?)(?=^\[tasks\.|^\[[a-z]|$(?![\s\S]))/gm,
)) {
  const [, name, body] = m;
  const i = body.indexOf(`run = ${TRIPLE}`);
  if (i === -1) continue;
  const rest = body.slice(i + 6 + TRIPLE.length);
  const script = rest.slice(0, rest.indexOf(TRIPLE));
  const lines = script.split('\n').filter((l) => l.trim());
  if (lines.length > 1 && !/^shell = /m.test(body)) multiline.push(name);
}
ok(
  multiline.length === 0,
  `複数行なのに shell を明示していないタスク: ${list(multiline)}`,
);

/* ---- 5. 命令の一覧は 1 か所にしかない ------------------------------------ */
// CLAUDE.md がタスクの表を持っていた頃、README と二重に古くなった。
const claude = read('CLAUDE.md');
ok(!/^\| `mise run /m.test(claude), 'CLAUDE.md がタスクの表を持ち直していない');

console.log(fails.length ? `\n${fails.join('\n')}` : '');
console.log(`\n${fails.length ? '失敗' : '合格'}: ${6 - fails.length}/6`);
process.exit(fails.length ? 1 : 0);
