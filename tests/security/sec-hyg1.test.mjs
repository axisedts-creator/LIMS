// SEC-HYG-1 (LD-240; security audit 2026-11-15 checks 11.1 and 11.3) - repo hygiene half of the task. Tester-owned; node:test, no network, no install.
//   (A) no .tmp/ or test-results/ file is tracked, and both are ignored          -> 11.1
//   (B) docs/stubbed-operations.md is generated, complete per module and goes stale loudly -> 11.3
// The poller half (visibility-aware polling) is apps/web/src/__tests__/sec-hyg1.pollers.test.tsx.
//
// CONTRACT the writer must follow for (B) (a test-owned name; renaming it needs a tester change):
//   script  tools/lint/gen-stubbed-operations.mjs   (run from any cwd; resolves the repo root from its own location)
//     node tools/lint/gen-stubbed-operations.mjs                  write docs/stubbed-operations.md
//     node tools/lint/gen-stubbed-operations.mjs --out <file>     write the generated text to <file> instead (the repo doc is untouched)
//     node tools/lint/gen-stubbed-operations.mjs --check [<file>] exit 0 when <file> (default docs/stubbed-operations.md) equals the generated text byte for byte, else exit 1
//   doc format: one `## <module>` heading per module (directory name under services/api/src/modules) that has at least one stub, in ascending order;
//   under it one bullet per operationId, "- `operationId`", ascending. Modules with no stub may be omitted. The text names the generator and LD-240.
//   "maps to a stub" = the operationId is in the module's operation list but has no real handler (the `stub(op)` / `notImplemented(op)` fallback in the module's handler index).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = join(ROOT, 'tools', 'lint', 'gen-stubbed-operations.mjs');
const DOC = join(ROOT, 'docs', 'stubbed-operations.md');
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const lf = (s) => s.replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- (A) 11.1 untrack .tmp/ and test-results/
test('11.1: no tracked path has a .tmp or test-results directory segment, or ends in .tmp', () => {
  const r = git('ls-files', '-z');
  assert.equal(r.status, 0, r.stderr);
  const bad = r.stdout.split('\0').filter(Boolean).filter((p) => {
    const parts = p.split('/');
    return parts.slice(0, -1).some((s) => s === '.tmp' || s === 'test-results') || /\.tmp$/.test(parts.at(-1));
  });
  assert.deepEqual(bad, [], 'git rm --cached these (keep them on disk)');
});

test('11.1: .tmp/ and test-results/ are ignored at the root and in sub-folders', () => {
  for (const p of ['.tmp/x.json', 'test-results/a/error-context.md', 'test-results/.last-run.json', 'apps/web/.tmp/y', 'apps/web/test-results/b/error-context.md', 'services/api/.tmp/z']) {
    const r = git('check-ignore', '-q', '--no-index', '--', p);
    assert.equal(r.status, 0, `${p} must be ignored by .gitignore`);
  }
});

test('11.1: ignoring them did not hide real sources (a normal file and a .tmpl template stay unignored)', () => {
  for (const p of ['infra/monitoring/alertmanager/templates/lims.tmpl', 'apps/web/src/features/lab/components/StatusBoard.tsx', 'docs/stubbed-operations.md']) {
    assert.equal(git('check-ignore', '-q', '--no-index', '--', p).status, 1, `${p} must not be ignored`);
  }
});

// ---------------------------------------------------------------- (B) 11.3 generated stub list
const run = (...args) => spawnSync(process.execPath, [GEN, ...args], { cwd: tmpdir(), encoding: 'utf8' }); // cwd elsewhere: the script finds the root itself
const parse = (text) => {
  const modules = new Map();
  let cur;
  for (const line of lf(text).split('\n')) {
    const h = /^## (\S+)\s*$/.exec(line);
    if (h) { cur = h[1]; assert.ok(!modules.has(cur), `duplicate heading ## ${cur}`); modules.set(cur, []); continue; }
    const b = /^- `([A-Za-z0-9_]+)`\s*$/.exec(line);
    if (b) { assert.ok(cur, `bullet before any module heading: ${line}`); modules.get(cur).push(b[1]); }
  }
  return modules;
};

test('11.3: generator script exists and the committed doc exists', () => {
  assert.ok(existsSync(GEN), 'tools/lint/gen-stubbed-operations.mjs missing');
  assert.ok(existsSync(DOC), 'docs/stubbed-operations.md missing');
  assert.match(readFileSync(GEN, 'utf8'), /LD-240/, 'generator header cites LD-240');
});

test('11.3: the doc names its generator and LD-240, and has per-module sorted sections', () => {
  const text = readFileSync(DOC, 'utf8');
  assert.match(text, /gen-stubbed-operations\.mjs/, 'doc says which script generates it');
  assert.match(text, /LD-240/);
  const m = parse(text);
  assert.ok(m.size >= 2, 'at least two modules still have stubs (smartreport, identity)');
  const names = [...m.keys()];
  assert.deepEqual(names, [...names].sort(), 'module headings ascending');
  for (const [k, ids] of m) {
    assert.ok(ids.length > 0, `## ${k} has no bullets (omit modules without stubs)`);
    assert.deepEqual(ids, [...ids].sort(), `${k}: operationIds ascending`);
    assert.equal(new Set(ids).size, ids.length, `${k}: duplicate operationId`);
  }
});

test('11.3: every listed operationId is a real operationId in contracts/openapi', () => {
  const dir = join(ROOT, 'contracts', 'openapi');
  const ops = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml'))) for (const x of readFileSync(join(dir, f), 'utf8').matchAll(/^\s*operationId:\s*(\S+)\s*$/gm)) ops.add(x[1]);
  assert.ok(ops.size > 900, 'openapi parse sanity');
  for (const [k, ids] of parse(readFileSync(DOC, 'utf8'))) for (const id of ids) assert.ok(ops.has(id), `${k}: ${id} is not in contracts/openapi`);
});

test('11.3 freshness: --check passes on the committed doc', () => {
  const r = run('--check');
  assert.equal(r.status, 0, `doc is stale or script failed:\n${r.stdout}\n${r.stderr}`);
});

test('11.3 freshness: --out reproduces the committed doc byte for byte, and twice the same (deterministic)', () => {
  const d = mkdtempSync(join(tmpdir(), 'hyg1-'));
  try {
    const a = join(d, 'a.md'); const b = join(d, 'b.md');
    assert.equal(run('--out', a).status, 0);
    assert.equal(run('--out', b).status, 0);
    assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
    assert.equal(lf(readFileSync(a, 'utf8')), lf(readFileSync(DOC, 'utf8')), 'run the generator and commit docs/stubbed-operations.md');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('11.3 freshness: a stale doc fails --check (added id, removed id, emptied, wrong module)', () => {
  const d = mkdtempSync(join(tmpdir(), 'hyg1-'));
  try {
    const good = lf(readFileSync(DOC, 'utf8'));
    const firstBullet = /^- `[A-Za-z0-9_]+`$/m.exec(good)[0];
    const firstHeading = /^## \S+$/m.exec(good)[0];
    const cases = {
      'added id': good.replace(firstHeading, `${firstHeading}\n- \`bogusOperationAddedByHand\``),
      'removed id': good.replace(`${firstBullet}\n`, ''),
      'emptied': good.split('\n').filter((l) => !/^- `/.test(l)).join('\n'),
      'wrong module': good.replace(firstHeading, '## notamodule'),
      'trailing junk': `${good}\nstale\n`,
    };
    for (const [name, text] of Object.entries(cases)) {
      assert.notEqual(text, good, `${name}: mutation did not change the doc (test bug)`);
      const f = join(d, `${name.replace(/\W/g, '_')}.md`);
      writeFileSync(f, text);
      assert.notEqual(run('--check', f).status, 0, `--check must fail for a doc with: ${name}`);
    }
    assert.notEqual(run('--check', join(d, 'does-not-exist.md')).status, 0, 'a missing doc is stale');
    const ok = join(d, 'ok.md'); writeFileSync(ok, good);
    assert.equal(run('--check', ok).status, 0, 'a correct copy passes (LF as committed)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Independent oracle: for modules whose handler index is the plain `OPERATION_IDS` + `const implemented = { shorthandHandler, ... }` shape,
// stubs = OPERATION_IDS minus the implemented keys. Computed here from the source text, not from the generator.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
const staticStubs = (file) => {
  const t = strip(readFileSync(join(ROOT, 'services/api/src/modules', file), 'utf8'));
  const a = t.indexOf('const OPERATION_IDS'); const b = t.indexOf('] as const', a);
  const ids = [...t.slice(a, b).matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const i = t.indexOf('const implemented'); const s = t.indexOf('= {', i) + 3; const e = t.indexOf('\n};', s);
  const keys = t.slice(s, e).split(',').map((x) => x.trim()).filter(Boolean);
  assert.ok(keys.every((k) => /^[A-Za-z_]\w*$/.test(k)), `${file}: oracle needs a plain shorthand list (test bug)`);
  return ids.filter((x) => !keys.includes(x)).sort();
};
const ORACLE = { anatomic: 'anatomic/handlers/index.ts', analytics: 'analytics/handlers/index.ts', homecollection: 'homecollection/index.ts', identity: 'identity/handlers/index.ts', smartreport: 'smartreport/handlers/index.ts' };

test('11.3 completeness: for the modules with a plain handler index the doc lists exactly OPERATION_IDS minus implemented', () => {
  const doc = parse(readFileSync(DOC, 'utf8'));
  const sizes = {};
  for (const [mod, file] of Object.entries(ORACLE)) {
    const want = staticStubs(file);
    sizes[mod] = want.length;
    assert.deepEqual(doc.get(mod) ?? [], want, `${mod}: stub list differs from the source`);
  }
  assert.ok(sizes.smartreport >= 1 && sizes.identity >= 1, `oracle must see real stubs, got ${JSON.stringify(sizes)} (if the stubs were implemented, update this test)`);
});

test('11.3 completeness: generated output (not just the committed doc) matches the oracle', () => {
  const d = mkdtempSync(join(tmpdir(), 'hyg1-'));
  try {
    const f = join(d, 'gen.md');
    assert.equal(run('--out', f).status, 0);
    const gen = parse(readFileSync(f, 'utf8'));
    for (const [mod, file] of Object.entries(ORACLE)) assert.deepEqual(gen.get(mod) ?? [], staticStubs(file), mod);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('11.3: generating does not touch the repo doc when --out is used', () => {
  const before = readFileSync(DOC, 'utf8');
  const d = mkdtempSync(join(tmpdir(), 'hyg1-'));
  try { run('--out', join(d, 'x.md')); } finally { rmSync(d, { recursive: true, force: true }); }
  assert.equal(readFileSync(DOC, 'utf8'), before);
});
