// VERIFY-GREEN-5 (C1; LD-268, LD-256 backlog list, LD-250): `tsc -p apps/web/tsconfig.json` must report no error outside test files.
// RED now: 9 non-test errors, all in apps/portal/src/app/r/[token]/{page,report/page}.tsx, which the web program pulls in via the web tests, so `@/` resolves to apps/web/src:
//   TS2307 x7 (@/features/portal/{actions,notices,Notice,HealthSummary}, @/server/{api,session}) + TS7006 x2 (report/page.tsx:30 `g`, :68 `n`, consequences of the unresolved modules).
// The modules EXIST in apps/portal/src (features/portal/*, server/*): the alias/specifier is wrong, not the feature missing -> fix the import (e.g. relative specifier), NO stub (LD-250).
// Errors in __tests__ / *.test.* / *.spec.* files are out of scope (test edits forbidden). A non-test error is tolerated only when it is a genuine runtime question listed as `file:line`
// in .orchestra/notes/VERIFY-GREEN-5.md AND a nonblocking CR .orchestra/cr/VERIFY-GREEN-5*.md exists (the lead decides); a TS2307 for a module that exists in apps/portal/src is never tolerated.
// Behaviour is pinned by the existing suites run in VERIFY-GREEN-5-verify.cmd (rs-c6 portal tests, web build guards), which must stay green unchanged.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..'); // apps/web
const repo = resolve(webRoot, '../..');
const portalSrc = resolve(repo, 'apps/portal/src');
const tsc = resolve(dirname(createRequire(resolve(webRoot, 'package.json')).resolve('typescript/package.json')), 'bin/tsc');
const read = (p: string) => readFileSync(resolve(repo, p), 'utf8');

const isTestFile = (f: string) => /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(f);
type Err = { file: string; line: number; code: string; msg: string };
const errorsOf = (cwd: string): Err[] => {
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  expect(r.error).toBeUndefined();
  const out: Err[] = [];
  for (const l of `${r.stdout}${r.stderr}`.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(l);
    if (m) out.push({ file: resolve(cwd, m[1]!).replace(/\\/g, '/').replace(`${repo.replace(/\\/g, '/')}/`, ''), line: Number(m[2]), code: m[3]!, msg: m[4]! });
  }
  return out;
};
const existsInPortal = (spec: string) => /^@\/(features\/portal|server)\//.test(spec) && ['.ts', '.tsx', '/index.ts', '/index.tsx'].some((x) => existsSync(resolve(portalSrc, spec.slice(2) + x)));

describe('VERIFY-GREEN-5: web typecheck, no error outside test files', () => {
  it('tsc -p apps/web/tsconfig.json: every non-test error is gone (TS2307 x7 portal specifiers, TS7006 x2), or listed in notes + nonblocking CR as a runtime question', { timeout: 290_000 }, () => {
    const notes = existsSync(resolve(repo, '.orchestra/notes/VERIFY-GREEN-5.md')) ? read('.orchestra/notes/VERIFY-GREEN-5.md') : '';
    const crDir = resolve(repo, '.orchestra/cr');
    const hasCr = existsSync(crDir) && readdirSync(crDir).some((f) => /^VERIFY-GREEN-5.*\.md$/.test(f));
    const left = errorsOf(webRoot)
      .filter((e) => !isTestFile(e.file))
      .filter((e) => {
        const spec = /Cannot find module '([^']+)'/.exec(e.msg)?.[1];
        if (e.code === 'TS2307' && spec && existsInPortal(spec)) return true; // module exists: wrong specifier, never tolerated (LD-250: no stub, fix the import)
        return !(hasCr && notes.includes(`${e.file}:${e.line}`));
      })
      .map((e) => `${e.file}(${e.line}): ${e.code} ${e.msg}`.slice(0, 200));
    expect(left).toEqual([]);
  });

  it('portal package typecheck stays green (own tsconfig, its `@/` is apps/portal/src): 0 errors', { timeout: 290_000 }, () => {
    expect(errorsOf(resolve(repo, 'apps/portal')).map((e) => `${e.file}(${e.line}): ${e.code}`)).toEqual([]);
  });
});

const PAGES = ['apps/portal/src/app/r/[token]/page.tsx', 'apps/portal/src/app/r/[token]/report/page.tsx'];
const MODULES = ['actions', 'notices', 'Notice', 'HealthSummary', 'api', 'session'];
const PORTAL_FILES = ['features/portal/actions.ts', 'features/portal/notices.tsx', 'features/portal/Notice.tsx', 'features/portal/HealthSummary.tsx', 'server/api.ts', 'server/session.ts'];

describe('VERIFY-GREEN-5: LD-250 no stub, specifiers/types only, no hiding device', () => {
  it('the portal modules still exist and are not emptied; web gets no features/portal or server directory (no stub / empty module)', () => {
    for (const f of PORTAL_FILES) expect(read(`apps/portal/src/${f}`).trim().length, f).toBeGreaterThan(40);
    expect(existsSync(resolve(webRoot, 'src/features/portal'))).toBe(false);
    expect(existsSync(resolve(webRoot, 'src/server'))).toBe(false);
  });

  it.each([[PAGES[0]!, 2], [PAGES[1]!, 5]] as const)('%s: still imports the same %i portal modules (only the specifier may change)', (p, n) => {
    const imported = [...read(p).matchAll(/from '([^']+)'/g)].map((m) => m[1]!).filter((s) => MODULES.some((m) => s.endsWith(`/${m}`)));
    expect(imported.length).toBe(n);
  });

  it('report/page.tsx keeps using the imported names (no behaviour change)', () => {
    const src = read(PAGES[1]!);
    for (const name of ['Notice', 'HealthSummary', 'ErrorNotice', 'RateNotice', 'fmtDate', 'callApi', 'GATEWAY_LABEL', 'retryMinutes', 'token22', 'getSession']) expect(src, name).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each([...PAGES, ...PORTAL_FILES.map((f) => `apps/portal/src/${f}`), 'apps/web/tsconfig.json', 'apps/portal/tsconfig.json'])('%s: no @ts-ignore / @ts-expect-error / @ts-nocheck, no `as any`, no skipLibCheck', (f) => {
    const src = read(f);
    expect(src).not.toMatch(/@ts-(ignore|expect-error|nocheck)/);
    expect(src).not.toMatch(/\bas any\b/);
    expect(src).not.toMatch(/skipLibCheck/);
  });

  it('web tsconfig keeps strict + exactOptionalPropertyTypes (inherited), and does not add the portal tree to `exclude` to dodge the errors', () => {
    const web = read('apps/web/tsconfig.json');
    expect(web).toMatch(/"extends"\s*:\s*"\.\.\/\.\.\/tsconfig\.base\.json"/);
    expect(web).not.toMatch(/"exclude"\s*:\s*\[[^\]]*portal/);
    const base = read('tsconfig.base.json');
    expect(base).toMatch(/"strict"\s*:\s*true/); expect(base).toMatch(/"exactOptionalPropertyTypes"\s*:\s*true/);
    expect(base.match(/skipLibCheck/g)?.length).toBe(1);
  });
});
