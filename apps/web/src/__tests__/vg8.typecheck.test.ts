// VERIFY-GREEN-8 (C1; LD-268, LD-256 backlog list, founder 'then fix these failures' 2026-11-16): `tsc -p apps/web/tsconfig.json` must report no error under apps/web/src/
// (lab TS2604 x7 + TS2786 x7 'X cannot be used as a JSX component', TS2353 'onUnhandledRequest' in msw setupServer fixtures across admin/analytics/anatomic/homecollection/lab/micro/payments/
// platform/reporting/smartreport/engagement/core, TS2698, TS2375, TS2352, TS2379, TS2345, TS2532, TS4104 ...). RED now: ~287 errors under apps/web/src.
// Rules: types and specifiers only; ONLY test files / test helpers change, no product file; same tests, same assertions.
// A line that genuinely needs a runtime or shape change is tolerated only when listed as `repo/path:line` in .orchestra/notes/VERIFY-GREEN-8.md AND a nonblocking
// .orchestra/cr/VERIFY-GREEN-8*.md exists (the lead decides). No @ts-ignore / @ts-expect-error / @ts-nocheck, no new `as any`, no skipLibCheck, no skipped tests.
// apps/portal non-test errors (TS2307 x7, TS7006 x2) are VERIFY-GREEN-5, not this task.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..'); // apps/web
const repo = resolve(webRoot, '../..');
const fwd = (p: string) => p.replace(/\\/g, '/');
const repoFwd = `${fwd(repo)}/`;
const tsc = resolve(dirname(createRequire(resolve(webRoot, 'package.json')).resolve('typescript/package.json')), 'bin/tsc');
const read = (p: string) => readFileSync(resolve(repo, p), 'utf8');

const SRC = 'apps/web/src';
const isTestFile = (f: string) => /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(f);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' || n === '.next' ? [] : walk(p)) : [p];
  });
const srcFiles = (dir: string) => walk(resolve(repo, dir)).filter((p) => /\.[cm]?[jt]sx?$/.test(p)).map((p) => fwd(p).replace(repoFwd, ''));

type Err = { file: string; line: number; code: string; msg: string };
const all: Err[] = [];
beforeAll(() => {
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], { cwd: webRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  expect(r.error).toBeUndefined();
  for (const l of `${r.stdout}${r.stderr}`.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(l);
    if (m) all.push({ file: fwd(resolve(webRoot, m[1]!)).replace(repoFwd, ''), line: Number(m[2]), code: m[3]!, msg: m[4]! });
  }
}, 290_000);

describe('VERIFY-GREEN-8: web typecheck, lab + every remaining web test file', () => {
  const inScope = (f: string) => f.startsWith(`${SRC}/`);

  it('tsc reports no error under apps/web/src, except listed runtime questions (notes file:line + nonblocking CR)', () => {
    const notesPath = resolve(repo, '.orchestra/notes/VERIFY-GREEN-8.md');
    const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';
    const crDir = resolve(repo, '.orchestra/cr');
    const hasCr = existsSync(crDir) && readdirSync(crDir).some((f) => /^VERIFY-GREEN-8.*\.md$/.test(f));
    const left = all
      .filter((e) => inScope(e.file))
      .filter((e) => !(hasCr && notes.includes(`${e.file}:${e.line}`)))
      .map((e) => `${e.file}(${e.line}): ${e.code} ${e.msg}`.slice(0, 180));
    expect(left).toEqual([]);
  });

  it('the lab JSX-component errors (TS2604 x7, TS2786 x7) and msw TS2353 are fixed by typing, not tolerated via the notes list', () => {
    const typing = all.filter((e) => inScope(e.file) && (e.code === 'TS2604' || e.code === 'TS2786' || (e.code === 'TS2353' && /onUnhandledRequest/.test(e.msg))));
    expect(typing.map((e) => `${e.file}:${e.line} ${e.code}`)).toEqual([]);
  });

  it('no error left in apps/web/src test dirs of the lab feature at all', () => {
    expect(all.filter((e) => e.file.startsWith(`${SRC}/features/lab/`)).map((e) => `${e.file}:${e.line} ${e.code}`)).toEqual([]);
  });
});

describe('VERIFY-GREEN-8: test-only change, same tests, no hiding device (green now, must stay green)', () => {
  const files = srcFiles(SRC);
  const testFiles = files.filter((f) => /\/__tests__\//.test(f) && /\.test\.[cm]?[jt]sx?$/.test(f));

  it('no @ts-ignore / @ts-expect-error / @ts-nocheck / skipLibCheck, no skipped or todo tests, under apps/web/src', () => {
    // existing, unchanged mentions: the vgN guard files and build-config.test.ts quote the tokens in strings/comments; HC-T30.nightly.spec.ts has one env-gated `test.skip(!API ...)` (e2e, not run in unit CI)
    const allowed = /\/(vg\d+\.typecheck\.test\.ts|build-config\.test\.ts|HC-T30\.nightly\.spec\.ts|sec-hyg1\.pollers\.test\.tsx)$/; // sec-hyg1: data-driven `(p.fail ? it : it.skip)` added by SEC-HYG-1 (81acaf606), hides no type error (arbiter ruling)
    const bad = files.filter((f) => !allowed.test(f) && /@ts-(ignore|expect-error|nocheck)|skipLibCheck|\b(it|test|describe)\.(skip|todo)\b|\bxit\(|\bxdescribe\(/.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('`as any` is not added: at most the 90 existing uses under apps/web/src; web tsconfigs add no skipLibCheck', () => {
    const n = files.filter((f) => !/\/vg\d+\.typecheck\.test\.ts$/.test(f)).reduce((s, f) => s + (read(f).match(/\bas any\b/g)?.length ?? 0), 0);
    expect(n).toBeLessThanOrEqual(BASELINE_AS_ANY);
    expect(read('apps/web/tsconfig.json')).not.toMatch(/skipLibCheck/);
    expect(read('tsconfig.base.json').match(/skipLibCheck/g)?.length).toBe(1);
  });

  it('no test deleted or emptied: it()/test() lines in apps/web/src test files not below the baseline (6867)', () => {
    const n = testFiles.reduce((s, f) => s + read(f).split(/\r?\n/).filter((l) => /^\s*(it|test)(\.\w+)?(\(|\.each)/.test(l)).length, 0);
    expect(n).toBeGreaterThanOrEqual(BASELINE_TESTS);
  });

  it('assertion density is not reduced: expect( calls in apps/web/src test files not below baseline (18541)', () => {
    const n = testFiles.reduce((s, f) => s + (read(f).match(/\bexpect\(/g)?.length ?? 0), 0);
    expect(n).toBeGreaterThanOrEqual(BASELINE_EXPECTS);
  });

  it('only test files / test helpers changed by writer/debugger commits for this task (no product file under apps/, services/, packages/)', () => {
    const run = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
    const log = run(['log', '--format=@@%s', '--name-only', '--grep=VERIFY-GREEN-8']);
    const changed = new Set<string>();
    let take = false;
    for (const l of log.split(/\r?\n/)) {
      if (l.startsWith('@@')) take = /^@@\[(writer|debugger)\]/.test(l);
      else if (take && l.trim()) changed.add(l.trim());
    }
    for (const l of run(['status', '--porcelain']).split(/\r?\n/)) if (l.trim()) changed.add(l.slice(3).trim().replace(/^"|"$/g, ''));
    const product = [...changed].filter((f) => !f.startsWith('.orchestra/') && !isTestFile(f) && !/(^|\/)(test-utils|testing|test-helpers|__mocks__|__fixtures__)\//.test(f) && !/(^|\/)vitest\.[\w.-]*config\.[cm]?[jt]s$/.test(f));
    expect(product).toEqual([]);
  });
});

// counts under apps/web/src when the task was written, 2026-11-16 (1724 source files, 337 test files)
const BASELINE_TESTS = 6867;
const BASELINE_EXPECTS = 18541;
const BASELINE_AS_ANY = 90; // occurrences at 818f6275c = HEAD, arbiter 2026-11-19 (66 at f944a2cb3; +24 from other lanes' files), excluding the vgN.typecheck guard files, whose comments mention it
