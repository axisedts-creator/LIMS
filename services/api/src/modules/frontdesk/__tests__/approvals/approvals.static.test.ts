// FD-T07 static rules (Docker-free): file layout of the task (06-IMPLEMENTATION-PLAN row FD-T07, 02-TRD §2 layout), real handlers wired, no wall-clock / no unchecked privileged path
// in the service. Fails now: the files do not exist.
// ASSUMED (same pattern as FD-T04..T06): the service asserts permissions itself through IdentityPort.assertRole (the core x-permission check is not in the handler path), and reads
//   time only through ctx.now() so the TTL / expiry boundary is testable with an injected clock.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FD = join(import.meta.dirname, '..', '..');
const OPS = ['requestDiscountApproval', 'listDiscountApprovals', 'getDiscountApproval', 'approveDiscount', 'rejectDiscount'] as const;
const code = (rel: string) => readFileSync(join(FD, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

describe('layout + wiring', () => {
  it('service/discount.service.ts and one handlers/<operationId>.ts per F15-F19 exist', () => {
    expect(existsSync(join(FD, 'service/discount.service.ts'))).toBe(true);
    for (const op of OPS) expect(existsSync(join(FD, `handlers/${op}.ts`)), op).toBe(true);
  });
  it('handlers/index.ts imports every F15-F19 handler (the stub is replaced, not shadowed)', () => {
    const idx = code('handlers/index.ts');
    for (const op of OPS) expect(idx, op).toMatch(new RegExp(`from '\\./${op}\\.js'`));
  });
});

describe('discount.service.ts rules', () => {
  const svc = () => code('service/discount.service.ts');
  it('time comes from ctx.now(): no Date.now() and no argument-less new Date()', () => {
    expect(svc()).not.toMatch(/Date\.now\(\)/);
    expect(svc()).not.toMatch(/new Date\(\s*\)/);
  });
  it('privileged approve/reject go through IdentityPort.assertRole with frontdesk.discount.approve (aal2 re-validation lives there)', () => {
    expect(svc()).toContain('assertRole');
    expect(svc()).toContain('frontdesk.discount.approve');
    expect(svc()).toContain('frontdesk.discount_self_approval_forbidden');
  });
  it('the service never logs approval reasons / notes / discounts (07-SECURITY §6.2: no discount reason text in logs)', () => {
    const s = svc();
    expect(s).not.toMatch(/log\??\.\w+\([^)]*(reason_text|reasonText|note)/);
    expect(s).not.toMatch(/console\./);
  });
});
