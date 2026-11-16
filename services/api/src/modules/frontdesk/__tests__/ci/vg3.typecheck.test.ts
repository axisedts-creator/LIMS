// VERIFY-GREEN-3 (C1; LD-268 founder priority call, LD-256 backlog list): frontdesk registration.service.ts (TS2345 x12), order.service.ts (TS2345 x9),
// billing BillingPort.impl.ts (TS2352 x3), BillingCommandPort.impl.ts (TS2352 x3 + TS2322 x1), invoice.service.ts (TS2322 x1) must typecheck with the package's
// own tsconfig (strict, exactOptionalPropertyTypes). RED now: 29 errors. GREEN when 0 in these five files, with no hiding device (no @ts-ignore /
// @ts-expect-error / new `as any` / skipLibCheck). Money + order code: behaviour is pinned by the existing frontdesk and billing contract/service tests,
// which must stay green unchanged. Errors elsewhere (other VERIFY-GREEN tasks) do not fail this task.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '../../../../..');
const mod = resolve(here, '../../..');
const FILES = ['frontdesk/service/registration.service.ts', 'frontdesk/service/order.service.ts', 'billing/ports/BillingPort.impl.ts', 'billing/ports/BillingCommandPort.impl.ts', 'billing/service/invoice.service.ts'];
const tsc = resolve(dirname(createRequire(resolve(apiRoot, 'package.json')).resolve('typescript/package.json')), 'bin/tsc');

describe('VERIFY-GREEN-3: frontdesk + billing typecheck', () => {
  it('tsc reports no error in the five listed files', { timeout: 280_000 }, () => {
    const r = spawnSync(process.execPath, [tsc, '-p', resolve(here, 'tsconfig.vg3.json'), '--pretty', 'false'], { cwd: apiRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(r.error).toBeUndefined();
    const errs = `${r.stdout}${r.stderr}`.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
    const mine = errs.filter((l) => FILES.some((f) => l.replace(/\\/g, '/').includes(`modules/${f}(`)));
    expect(mine.map((l) => l.replace(/^.*modules\//, 'modules/').slice(0, 200))).toEqual([]);
    expect(errs.filter((l) => /TS(5097|2835|18003|6053|5083)/.test(l)), 'tsconfig fixture itself broken').toEqual([]);
  });

  it('no hiding device was added (rule: no @ts-ignore, @ts-expect-error, new `as any`, skipLibCheck)', () => {
    for (const f of FILES) {
      const src = readFileSync(resolve(mod, f), 'utf8');
      expect(src, f).not.toMatch(/@ts-(ignore|expect-error|nocheck)/);
      // baseline before this task: BillingCommandPort.impl.ts has exactly 2 `as any` (issueOrderInvoice / recordPayment orderId probe), every other file 0
      const max = f.endsWith('BillingCommandPort.impl.ts') ? 2 : 0;
      expect((src.match(/\bas any\b/g) ?? []).length, f).toBeLessThanOrEqual(max);
    }
    for (const f of [resolve(apiRoot, 'tsconfig.json'), resolve(here, 'tsconfig.vg3.json')]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/skipLibCheck/);
    }
    const base = readFileSync(resolve(apiRoot, '../../tsconfig.base.json'), 'utf8');
    expect(base.match(/skipLibCheck/g)?.length).toBe(1);
    expect(base).toMatch(/"exactOptionalPropertyTypes"\s*:\s*true/);
    expect(base).toMatch(/"strict"\s*:\s*true/);
  });
});
