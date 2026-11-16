// VERIFY-GREEN-2 (C1; LD-268 founder priority call, LD-256 backlog list): CatalogPort.impl.ts (TS2352 x18, TS2322 x7, TS2375 x1) and
// partners conversion.service.ts (TS2322 x1, TS2375 x1) must typecheck with the package's own tsconfig (strict, exactOptionalPropertyTypes).
// RED now: 26 + 2 errors. GREEN when 0, with no hiding device (no @ts-ignore / @ts-expect-error / `as any` / skipLibCheck added), per the task rules.
// Runs tsc on just these two entry files (tsconfig.vg2.json extends services/api/tsconfig.json); only errors located in modules/catalog or modules/partners count,
// so an unrelated backlog error in a transitive import (other VERIFY-GREEN tasks) does not fail this task.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '../../../../..');
const impl = resolve(here, '../../ports/CatalogPort.impl.ts');
const conv = resolve(here, '../../../partners/service/conversion.service.ts');
const tsc = resolve(dirname(createRequire(resolve(apiRoot, 'package.json')).resolve('typescript/package.json')), 'bin/tsc');

describe('VERIFY-GREEN-2: catalog + partners typecheck', () => {
  it('tsc reports no error in services/api/src/modules/catalog or partners', { timeout: 280_000 }, () => {
    const r = spawnSync(process.execPath, [tsc, '-p', resolve(here, 'tsconfig.vg2.json'), '--pretty', 'false'], { cwd: apiRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(r.error).toBeUndefined();
    const errs = `${r.stdout}${r.stderr}`.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
    const mine = errs.filter((l) => /modules[\\/](catalog|partners)[\\/]/.test(l.replace(/\\/g, '/')));
    expect(mine.map((l) => l.replace(/^.*modules\//, 'modules/').slice(0, 200))).toEqual([]);
    expect(errs.filter((l) => /TS(5097|2835|18003|6053|5083)/.test(l)), 'tsconfig fixture itself broken').toEqual([]);
  });

  it('no hiding device was added to the two files or to the tsconfig chain (rule: no @ts-ignore, @ts-expect-error, `as any`, skipLibCheck)', () => {
    for (const f of [impl, conv]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/@ts-(ignore|expect-error|nocheck)/);
      expect(src, f).not.toMatch(/\bas\s+any\b/);
    }
    // tsconfig.base.json already carries skipLibCheck:true (pre-existing, LD-268 baseline: exactly 1); nothing may add another or loosen the strict flags.
    for (const f of [resolve(apiRoot, 'tsconfig.json'), resolve(here, 'tsconfig.vg2.json')]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/skipLibCheck/);
    }
    const base = readFileSync(resolve(apiRoot, '../../tsconfig.base.json'), 'utf8');
    expect(base.match(/skipLibCheck/g)?.length).toBe(1);
    expect(base).toMatch(/"exactOptionalPropertyTypes"\s*:\s*true/);
    expect(base).toMatch(/"strict"\s*:\s*true/);
  });

  it('suppressions already present before this task did not grow (baseline: 0 `as any`, 0 ts-comments in both files)', () => {
    const all = [impl, conv].map((f) => readFileSync(f, 'utf8')).join('\n');
    expect((all.match(/\bas any\b/g) ?? []).length).toBe(0);
    expect((all.match(/@ts-/g) ?? []).length).toBe(0);
  });
});
