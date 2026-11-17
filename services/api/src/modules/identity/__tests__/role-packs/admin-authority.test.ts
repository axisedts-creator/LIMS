// ADMINPACK-1 (LD-254, 11-ROLE-MATRIX R5a and section 3.3; LD-189 AUTH-SENSITIVE: data lists and tests only). The administrator packs
// corp_admin and std_admin gain read, oversight and configuration permissions, but never decision, bench or money authority and never
// platform permissions. Reads the pack data file and the registry directly with `yaml`. A mismatch is reported, never fixed by widening
// or narrowing a role here (LD-141).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STAFF } from './admin-staff-codes';

const ROOT = join(import.meta.dirname, '../../../../../../..');
type Role = { code: string; mfa_required: boolean; base_default_role: string | null; permissions: string[] };
const packs = (parse(readFileSync(join(import.meta.dirname, '../../role-packs/role-packs.data.yaml'), 'utf8')) as { packs: Array<{ code: string; roles: Role[] }> }).packs;
const roles = packs.flatMap((p) => p.roles);
const byCode = (c: string): Role => roles.find((r) => r.code === c)!;
const registry = (parse(readFileSync(join(ROOT, 'contracts/permissions.yaml'), 'utf8')) as { permissions: Array<{ code: string; privileged: boolean }> }).permissions;
const PERM = new Map(registry.map((p) => [p.code, p.privileged]));
const spec = (parse(readFileSync(join(ROOT, 'spec/program/11-ROLE-MATRIX.data.yaml'), 'utf8')) as { packs: Array<{ roles: Role[] }> }).packs.flatMap((p) => p.roles);

const ADMINS = ['corp_admin', 'std_admin'] as const;

// Section 3.3 "Left out on purpose": explicit codes, then the families the section names.
const LEFT_OUT_CODES = [
  'lab.result.verify', 'lab.result.approve', 'lab.result.amend', 'lab.qc.capture', 'lab.qc_hold.release', 'micro.breakpoint.manage',
  'micro.culture.work', 'anatomic.case.signout', 'anatomic.case.work', 'quality.autoverify.manage', 'quality.qc_run.review',
  'smartreport.template.manage', 'smartreport.summary.approve', 'smartreport.template.approve', 'reporting.narrative.sign',
  'reporting.narrative.write', 'reporting.report.release', 'reporting.report.regenerate', 'reporting.report.bulk_release',
  'inventory.bench.record', 'inventory.po.approve', 'engagement.queue.operate',
];
const leftOut = (code: string): boolean =>
  LEFT_OUT_CODES.includes(code) ||
  /^smartreport\.[a-z_]+\.approve$/.test(code) ||
  /^reporting\.narrative\./.test(code) ||
  /^billing\..*(refund|reverse|cancel)/.test(code) ||
  /^payments\./.test(code) ||
  /^platform\./.test(code);

describe('ADMINPACK-1 administrator packs: authority left out on purpose (section 3.3)', () => {
  it('the left-out list covers real registry codes (a typo in this test would hide a grant)', () => {
    for (const c of LEFT_OUT_CODES) expect(PERM.has(c), `${c} in contracts/permissions.yaml`).toBe(true);
    const families = registry.filter((p) => leftOut(p.code) && !LEFT_OUT_CODES.includes(p.code)).map((p) => p.code);
    for (const must of ['billing.refund.approve', 'billing.payment.reverse', 'billing.invoice.cancel', 'payments.intent.create', 'platform.tenant.read']) {
      expect(families, must).toContain(must);
    }
  });

  // FACT (spec data bc657dab0, unchanged by R5a): these left-out-family codes were already held BEFORE section 3.3, from the tenant_admin
  // default role (merchant configuration, reconciliation read) or from a ticked sheet row (std_admin: Consumption tracking -> inventory.bench.record).
  // Section 3.3 adds none of them and the pack must stay byte-identical to the spec, so they are pinned here as the only holdings; any other
  // left-out code (and any change to this exact set) fails. Reported to the lead in ADMINPACK-1-tests.md.
  const PREEXISTING: Record<(typeof ADMINS)[number], string[]> = {
    corp_admin: ['payments.merchant_config.manage', 'payments.merchant_config.read', 'payments.reconciliation.read'],
    std_admin: ['inventory.bench.record', 'payments.merchant_config.manage', 'payments.merchant_config.read'],
  };

  it('std_admin holds no code of the left-out list (decision, bench, money and platform authority), except the pinned pre-existing holdings', () => {
    expect(byCode('std_admin').permissions.filter(leftOut).sort(), 'std_admin holds left-out codes').toEqual(PREEXISTING.std_admin);
  });

  // LD-310 (T0B-ADMINPERM-1, founder: admin should get all features) overrides section 3.3 for corp_admin ONLY: it holds every
  // left-out code that a tenant staff actor can hold, and still no platform code (those are in the shared EXCLUDED list).
  it('corp_admin (LD-310) holds every left-out code that a tenant staff actor can hold, and no platform code', () => {
    const held = byCode('corp_admin').permissions.filter(leftOut).sort();
    expect(held).toEqual(registry.map((p) => p.code).filter((c) => leftOut(c) && STAFF.includes(c)).sort());
    expect(held.filter((c) => /^platform\./.test(c))).toEqual([]);
    for (const c of ['lab.result.verify', 'billing.refund.approve', 'payments.intent.create', 'reporting.narrative.sign']) expect(held, c).toContain(c);
  });

  it('std_admin: no money authority and no payment intent, refund, reverse or cancel; no result, report or narrative decision; no platform code', () => {
    const admin = 'std_admin';
    const p = byCode(admin).permissions;
    for (const re of [/^payments\.(intent|refund)\./, /^billing\..*(refund|reverse|cancel)/, /^lab\.result\.(verify|approve|amend)$/, /^reporting\.(narrative|report\.(release|regenerate|bulk_release))/, /^platform\./]) {
      expect(p.filter((c) => re.test(c)), `${admin} ${re}`).toEqual([]);
    }
  });

  it.each(ADMINS)('%s still holds the identity and role-management authority of R4/R5 (the additions did not move it)', (admin) => {
    for (const c of ['identity.role.manage', 'identity.user.manage']) expect(byCode(admin).permissions, `${admin} ${c}`).toContain(c);
  });

  it.each(ADMINS)('%s: every code is in contracts/permissions.yaml, the list is unique and sorted', (admin) => {
    const p = byCode(admin).permissions;
    expect(p.filter((c) => !PERM.has(c))).toEqual([]);
    expect(new Set(p).size).toBe(p.length);
    expect(p).toEqual([...p].sort());
  });

  it.each(ADMINS)('%s: a privileged permission keeps the role mfa_required, and the privileged count is the pinned one (R3)', (admin) => {
    const r = byCode(admin);
    const privileged = r.permissions.filter((c) => PERM.get(c) === true);
    // corp_admin: LD-310 (T0B-ADMINPERM-1) 155 permissions, 59 privileged (every staff code of the registry); std_admin unchanged.
    // T0C-ACCT-1 (LD-313 c): +7 accounting codes, 3 of them privileged (account.manage, account_entry.reverse, cash_transfer.decide) -> 162 / 62; T0C-MSGDESK-1 (LD-321): +5 codes (engagement.broadcast.approve privileged) -> 167 / 63.
    // T0C-SALES-1 (LD-321): +2 sales codes, 1 privileged (partners.sales.manage) -> 169 / 64; std_admin unchanged. T0C-SYNC-1 (LD-322): +3 sync codes, 2 privileged (sync.device.manage, sync.conflict.resolve) -> 172 / 66.
    expect(privileged.length, `${admin} privileged`).toBe(admin === 'corp_admin' ? 66 : 35);
    expect(r.permissions.length, `${admin} permissions`).toBe(admin === 'corp_admin' ? 172 : 102);
    expect(r.mfa_required, admin).toBe(true);
    expect(r.base_default_role, admin).toBe('tenant_admin');
  });

  it.each(ADMINS)('%s: every code added beyond the 11-ROLE-MATRIX sheet ticks exists in the registry and every privileged one sits on an mfa_required role', (admin) => {
    const specRole = spec.find((r) => r.code === admin)!;
    const r = byCode(admin);
    for (const c of specRole.permissions) {
      expect(PERM.has(c), `${c} in registry`).toBe(true);
      if (PERM.get(c) === true) expect(r.mfa_required, `${admin} holds privileged ${c}`).toBe(true);
    }
  });

  it('no role other than the two administrators gained a code: every other role equals the spec data (no other count changes)', () => {
    for (const s of spec.filter((r) => !(ADMINS as readonly string[]).includes(r.code))) {
      expect(byCode(s.code).permissions, s.code).toEqual(s.permissions);
    }
  });
});
