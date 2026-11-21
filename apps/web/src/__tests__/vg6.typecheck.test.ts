// VERIFY-GREEN-6 (C1; LD-268, LD-256 backlog list, founder 'then fix these failures' 2026-11-16): `tsc -p apps/web/tsconfig.json` must report no error under
// apps/web/src/features/{catalog,frontdesk,billing}/ (TS2722 x35 in catalog web-t32.server.test.ts, TS2353 'onUnhandledRequest' in web-t33/t34/t35 fixtures, TS2345/TS2339/TS2379 in fixtures ...).
// RED now: dozens of errors in those test dirs. Rules: types and specifiers only; ONLY test files / test helpers change, no product file; same tests, same assertions.
// A line that genuinely needs a runtime or shape change is tolerated only when listed as `repo/path:line` in .orchestra/notes/VERIFY-GREEN-6.md AND a nonblocking
// .orchestra/cr/VERIFY-GREEN-6*.md exists (the lead decides). No @ts-ignore / @ts-expect-error / @ts-nocheck, no new `as any`, no skipLibCheck, no skipped tests.
// Errors in OTHER dirs (instruments, inventory, partners, lab, admin, ...) are not this task.
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

const DIRS = ['catalog', 'frontdesk', 'billing'].map((d) => `apps/web/src/features/${d}`);
const inScope = (f: string) => DIRS.some((d) => f.startsWith(`${d}/`));
const isTestFile = (f: string) => /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(f);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p];
  });
const srcFiles = (dir: string) => walk(resolve(repo, dir)).filter((p) => /\.[cm]?[jt]sx?$/.test(p)).map((p) => fwd(p).replace(repoFwd, ''));

type Err = { file: string; line: number; code: string; msg: string };
let all: Err[] = [];
beforeAll(() => {
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], { cwd: webRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  expect(r.error).toBeUndefined();
  for (const l of `${r.stdout}${r.stderr}`.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(l);
    if (m) all.push({ file: fwd(resolve(webRoot, m[1]!)).replace(repoFwd, ''), line: Number(m[2]), code: m[3]!, msg: m[4]! });
  }
}, 290_000);

describe('VERIFY-GREEN-6: web typecheck, catalog + frontdesk + billing test dirs', () => {
  it('tsc reports no error under features/{catalog,frontdesk,billing}, except listed runtime questions (notes file:line + nonblocking CR)', () => {
    const notesPath = resolve(repo, '.orchestra/notes/VERIFY-GREEN-6.md');
    const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';
    const crDir = resolve(repo, '.orchestra/cr');
    const hasCr = existsSync(crDir) && readdirSync(crDir).some((f) => /^VERIFY-GREEN-6.*\.md$/.test(f));
    const left = all
      .filter((e) => inScope(e.file))
      .filter((e) => !(hasCr && notes.includes(`${e.file}:${e.line}`)))
      .map((e) => `${e.file}(${e.line}): ${e.code} ${e.msg}`.slice(0, 180));
    expect(left).toEqual([]);
  });

  it('the TS2722 x35 in catalog web-t32.server.test.ts are fixed by typing, not tolerated via the notes list', () => {
    expect(all.filter((e) => e.file.endsWith('catalog/__tests__/web-t32.server.test.ts') && e.code === 'TS2722').map((e) => e.line)).toEqual([]);
  });
});

describe('VERIFY-GREEN-6: test-only change, same tests, no hiding device (green now, must stay green)', () => {
  const files = DIRS.flatMap(srcFiles);
  const testFiles = files.filter((f) => /\/__tests__\//.test(f) && /\.test\.[cm]?[jt]sx?$/.test(f));

  it('no @ts-ignore / @ts-expect-error / @ts-nocheck / skipLibCheck, no skipped or todo tests, in the three feature dirs', () => {
    const bad = files.filter((f) => /@ts-(ignore|expect-error|nocheck)|skipLibCheck|\b(it|test|describe)\.(skip|todo)\b|\bxit\(|\bxdescribe\(/.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('`as any` is not added: at most the 2 existing uses (catalog web-t34.components:1019, web-t35.flow:34); web tsconfigs add no skipLibCheck', () => {
    const n = files.reduce((s, f) => s + (read(f).match(/\bas any\b/g)?.length ?? 0), 0);
    expect(n).toBeLessThanOrEqual(2);
    expect(read('apps/web/tsconfig.json')).not.toMatch(/skipLibCheck/);
    expect(read('tsconfig.base.json').match(/skipLibCheck/g)?.length).toBe(1);
  });

  it('no test deleted or emptied: it()/test() lines per dir are not below the baseline (catalog 524, frontdesk 241, billing 57)', () => {
    const count = (dir: string) => testFiles.filter((f) => f.startsWith(`${dir}/`)).reduce((s, f) => s + read(f).split(/\r?\n/).filter((l) => /^\s*(it|test)(\.\w+)?(\(|\.each)/.test(l)).length, 0);
    expect(count(DIRS[0]!)).toBeGreaterThanOrEqual(524);
    expect(count(DIRS[1]!)).toBeGreaterThanOrEqual(241);
    expect(count(DIRS[2]!)).toBeGreaterThanOrEqual(57);
  });

  it('assertion density is not reduced: expect( calls per dir not below baseline', () => {
    const base = BASELINE_EXPECTS;
    const count = (dir: string) => testFiles.filter((f) => f.startsWith(`${dir}/`)).reduce((s, f) => s + (read(f).match(/\bexpect\(/g)?.length ?? 0), 0);
    DIRS.forEach((d, i) => expect(count(d), d).toBeGreaterThanOrEqual(base[i]!));
  });

  it('only test files / test helpers changed by writer/debugger commits for this task (no product file under apps/, services/, packages/)', () => {
    const run = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
    const log = run(['log', '--format=@@%s', '--name-only', '--grep=VERIFY-GREEN-6']);
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

// expect( counts per dir (catalog, frontdesk, billing) when the task was written, 2026-11-16
const BASELINE_EXPECTS: number[] = [1629, 687, 145];
