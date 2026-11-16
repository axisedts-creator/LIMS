// VERIFY-GREEN-4 (C1; LD-268, LD-256 backlog list): `tsc` of the api package and of the worker package must exit 0 with each package's own tsconfig
// (strict, exactOptionalPropertyTypes). Listed errors: api quality settings.handlers.ts TS2379 x1, observation.service.ts TS2379 x2, chart.service.ts TS2339 x4;
// worker engagement/tasks/purge.ts TS2379 x2, fetch_smart_summary.ts TS18046 x2, reporting/tasks/send_delivery.ts TS2339 x2; shared-ts bsdate/index.ts:2 + formula/index.ts:3 TS5097 x2 (seen by both).
// RED now: api 9 errors, worker 10. GREEN when both are 0 with no hiding device (no @ts-ignore / @ts-expect-error / new `as any` / skipLibCheck) and TS5097 fixed with the
// least loosening (allowImportingTsExtensions only in the api/worker tsconfig, never in tsconfig.base.json or shared-ts; or a specifier change). node --test of shared-ts is run by the verify command.
// Behaviour of the touched lines is pinned by vg4.pins.test.ts here + the existing quality/worker suites, which must stay green unchanged.
// If a line cannot be fixed by types/specifiers alone, the writer lists it in notes/VERIFY-GREEN-4.md + a nonblocking CR and the LEAD decides; this gate then needs the lead's say-so to relax.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '../../../../..');
const repo = resolve(apiRoot, '../..');
const workerRoot = resolve(repo, 'services/worker');
const tsc = resolve(dirname(createRequire(resolve(apiRoot, 'package.json')).resolve('typescript/package.json')), 'bin/tsc');

const errorsOf = (cwd: string): string[] => {
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  expect(r.error).toBeUndefined();
  return `${r.stdout}${r.stderr}`.split(/\r?\n/).filter((l) => /error TS\d+/.test(l)).map((l) => l.replace(/\\/g, '/').slice(0, 220));
};

describe('VERIFY-GREEN-4: api + worker typecheck exit 0', () => {
  it('api: tsc -p services/api/tsconfig.json reports 0 errors (quality TS2379 x3, TS2339 x4; shared-ts TS5097 x2)', { timeout: 290_000 }, () => {
    expect(errorsOf(apiRoot)).toEqual([]);
  });
  it('worker: tsc -p services/worker/tsconfig.json reports 0 errors (engagement purge TS2379 x2, fetch_smart_summary TS18046 x2, send_delivery TS2339 x2, + the api/shared-ts ones it re-reports)', { timeout: 290_000 }, () => {
    expect(errorsOf(workerRoot)).toEqual([]);
  });
});

const TOUCHED: Array<[string, number]> = [   // [repo path, max allowed `as any` = count at the baseline]
  ['services/api/src/modules/quality/handlers/settings.handlers.ts', 8], ['services/api/src/modules/quality/service/observation.service.ts', 0], ['services/api/src/modules/quality/service/chart.service.ts', 0],
  ['services/worker/src/jobs/engagement/tasks/purge.ts', 0], ['services/worker/src/jobs/engagement/tasks/fetch_smart_summary.ts', 1], ['services/worker/src/jobs/reporting/tasks/send_delivery.ts', 2],
  ['packages/shared-ts/src/bsdate/index.ts', 0], ['packages/shared-ts/src/formula/index.ts', 0],
];
const read = (p: string) => readFileSync(resolve(repo, p), 'utf8');

describe('VERIFY-GREEN-4: no hiding device, least loosening for TS5097', () => {
  it.each(TOUCHED)('%s: no @ts-ignore / @ts-expect-error / @ts-nocheck, `as any` not above the baseline', (f, max) => {
    const src = read(f);
    expect(src).not.toMatch(/@ts-(ignore|expect-error|nocheck)/);
    expect((src.match(/\bas any\b/g) ?? []).length).toBeLessThanOrEqual(max);
  });

  it('skipLibCheck stays exactly once (tsconfig.base.json) and never appears in the api / worker / shared-ts tsconfig; strict + exactOptionalPropertyTypes intact', () => {
    const base = read('tsconfig.base.json');
    expect(base.match(/skipLibCheck/g)?.length).toBe(1);
    expect(base).toMatch(/"exactOptionalPropertyTypes"\s*:\s*true/); expect(base).toMatch(/"strict"\s*:\s*true/);
    for (const p of ['services/api/tsconfig.json', 'services/worker/tsconfig.json', 'packages/shared-ts/tsconfig.json']) expect(read(p), p).not.toMatch(/skipLibCheck/);
  });

  it('allowImportingTsExtensions, if used, is only in the api / worker tsconfig and next to noEmit: true (never in tsconfig.base.json or shared-ts, whose build emits)', () => {
    expect(read('tsconfig.base.json')).not.toMatch(/allowImportingTsExtensions/);
    expect(read('packages/shared-ts/tsconfig.json')).not.toMatch(/allowImportingTsExtensions/);
    for (const p of ['services/api/tsconfig.json', 'services/worker/tsconfig.json']) {
      const t = read(p);
      if (/allowImportingTsExtensions/.test(t)) { expect(t, p).toMatch(/"allowImportingTsExtensions"\s*:\s*true/); expect(t, p).toMatch(/"noEmit"\s*:\s*true/); }
    }
  });

  it('shared-ts keeps the specifiers node --test needs: bsdate/index.ts and formula/index.ts still import their siblings, and the .mjs tests that load them exist', () => {
    expect(read('packages/shared-ts/src/bsdate/index.ts')).toMatch(/from '\.\/impl\.[a-z]+'/);
    expect(read('packages/shared-ts/src/formula/index.ts')).toMatch(/from '\.\.\/decimal\/index\.[a-z]+'/);
    expect(read('packages/shared-ts/test/bsdate.test.mjs').length).toBeGreaterThan(0); expect(read('packages/shared-ts/test/formula.test.mjs').length).toBeGreaterThan(0);
  });
});
