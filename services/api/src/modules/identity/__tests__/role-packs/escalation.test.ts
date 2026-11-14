// RM-T04 escalation + decision-authority tests (11-ROLE-MATRIX §4 item 4; rules R2, R4, R5; LD-141). Data file read directly with `yaml`
// (role-packs.data.yaml = verbatim copy of spec/program/11-ROLE-MATRIX.data.yaml). Per LD-141 a mismatch between the file and the overlay is REPORTED, never
// fixed by widening or narrowing a role here. Seam (same as RM-T03 route-guard): createIdentityPort(...).assertRole(ctx, { permission }) resolves when the
// member holds the permission, else rejects `auth.forbidden`; the core pipeline enforces an operation's x-permission through it (role.handlers.test.ts header).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createIdentityPort } from '../../ports/IdentityPort.impl.js';
import { makeCtx, makeFakeRepo, member } from '../../ports/__tests__/helpers';

const ROOT = join(import.meta.dirname, '../../../../../../..');
type Role = { code: string; name: string; mfa_required: boolean; base_default_role: string | null; permissions: string[] };
const packs = (parse(readFileSync(join(import.meta.dirname, '../../role-packs/role-packs.data.yaml'), 'utf8')) as { packs: Array<{ code: string; roles: Role[] }> }).packs;
const roles = packs.flatMap((p) => p.roles);
const byCode = (c: string): Role => roles.find((r) => r.code === c)!;
const registry = new Set((parse(readFileSync(join(ROOT, 'contracts/permissions.yaml'), 'utf8')).permissions as Array<{ code: string }>).map((p) => p.code));
const identityApi = parse(readFileSync(join(ROOT, 'contracts/openapi/identity.yaml'), 'utf8')) as { paths: Record<string, Record<string, any>> };
const xPermission = (op: string): string => {
  for (const item of Object.values(identityApi.paths)) for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (item[m]?.operationId === op) return item[m]['x-permission'];
  throw new Error(`operation ${op} not in contracts/openapi/identity.yaml`);
};

const ADMINS = ['corp_admin', 'std_admin'];
const PATHOLOGISTS = ['corp_pathologist', 'corp_pathologist_t2', 'corp_pathologist_t3', 'std_consulting_pathologist'];
const SR_LAB = ['corp_sr_lab_user', 'corp_sr_lab_user_t2', 'corp_senior_lab_user'];
const ACCOUNTS = ['corp_accounts', 'std_account'];
const ROLE_MANAGE = 'identity.role.manage';
const USER_MANAGE = 'identity.user.manage';

// R2 overlay (§3.1/§3.2 "Authority overlay" text and the §9 appendix): permission -> the ONLY roles that may hold it.
// Clinical sign-off: pathologists only (verify: also Sr. Lab tiers and, ELabAssist, "Entry and first verification" for Lab technician, D2).
const CLINICAL_ONLY: Record<string, string[]> = {
  'lab.result.approve': PATHOLOGISTS,
  'lab.result.amend': PATHOLOGISTS,
  'reporting.narrative.sign': PATHOLOGISTS,
  'anatomic.case.signout': PATHOLOGISTS,
};
const OVERLAY: Record<string, string[]> = {
  ...CLINICAL_ONLY,
  'lab.result.verify': [...PATHOLOGISTS, ...SR_LAB, 'std_lab_technician'],
  // Accounting authority "is added from the role name" for Accounts (§3.1, D3).
  'billing.refund.approve': ACCOUNTS,
  'billing.payment.reverse': ACCOUNTS,
  'billing.invoice.cancel': ACCOUNTS,
  // D3 default (11-ROLE-MATRIX.md:224, kept by LD-141): Accounts plus Admin, discount approve ONLY (RM-T04-ruling.md). Admin holds it via tenant_admin base (R5).
  'frontdesk.discount.approve': [...ACCOUNTS, ...ADMINS],
};
const holders = (perm: string): string[] => roles.filter((r) => r.permissions.includes(perm)).map((r) => r.code);

const personaOf = (code: string, drop: string[] = []) => `rm04-${code}${drop.length ? '-minus-' + drop.join('+') : ''}`;
function portFor(users: Array<{ code: string; drop?: string[] }>) {
  const members = users.map((u, i) => member('A', personaOf(u.code, u.drop), 0x40 + i, { roleCodes: [u.code], permissions: byCode(u.code).permissions.filter((p) => !(u.drop ?? []).includes(p)) }));
  return createIdentityPort({ repo: makeFakeRepo({ members }).repo as any, systemActorPermissions: () => [] });
}
const outcome = (port: ReturnType<typeof portFor>, code: string, perm: string, drop: string[] = []) =>
  port.assertRole(makeCtx('A', 'user', personaOf(code, drop)), { permission: perm }).then(() => 'allow', (e: any) => String(e.code));

describe('RM-T04 inputs', () => {
  it('both packs loaded; every decision-authority code and the two manage codes exist in contracts/permissions.yaml', () => {
    expect(roles.length).toBe(29);
    for (const p of [...Object.keys(OVERLAY), ROLE_MANAGE, USER_MANAGE]) expect(registry.has(p), p).toBe(true);
  });
  it('the role operations of identity.yaml are guarded by identity.role.manage', () => {
    for (const op of ['createRole', 'updateRole', 'deactivateRole']) expect(xPermission(op), op).toBe(ROLE_MANAGE);
  });
});

describe('R4: a role editor can grant itself anything, so identity.role.manage is the gate (escalation test, §4 item 4)', () => {
  it.each(ADMINS)('%s holds identity.role.manage (control: the full Admin can create and edit a role)', async (admin) => {
    const port = portFor([{ code: admin }]);
    expect(byCode(admin).permissions).toContain(ROLE_MANAGE);
    for (const op of ['createRole', 'updateRole', 'deactivateRole']) expect(await outcome(port, admin, xPermission(op)), `${admin} ${op}`).toBe('allow');
  });

  it.each(ADMINS)('%s minus identity.role.manage cannot create or edit a role: createRole, updateRole, deactivateRole -> auth.forbidden', async (admin) => {
    const port = portFor([{ code: admin, drop: [ROLE_MANAGE] }]);
    for (const op of ['createRole', 'updateRole', 'deactivateRole']) expect(await outcome(port, admin, xPermission(op), [ROLE_MANAGE]), `${admin} minus role.manage, ${op}`).toBe('auth.forbidden');
  });

  it.each(ADMINS)('%s minus identity.role.manage keeps its other privileges (the denial is exactly the one code, not a blanket lockout)', async (admin) => {
    const port = portFor([{ code: admin, drop: [ROLE_MANAGE] }]);
    expect(await outcome(port, admin, USER_MANAGE, [ROLE_MANAGE])).toBe('allow');
    expect(await outcome(port, admin, 'identity.user.read', [ROLE_MANAGE])).toBe('allow');
  });

  it('every one of the 27 non-Admin roles is refused createRole / updateRole / deactivateRole with auth.forbidden', async () => {
    const others = roles.filter((r) => !ADMINS.includes(r.code));
    expect(others.length).toBe(27);
    const port = portFor(others.map((r) => ({ code: r.code })));
    const bad: string[] = [];
    for (const r of others) for (const op of ['createRole', 'updateRole', 'deactivateRole']) {
      const o = await outcome(port, r.code, xPermission(op));
      if (o !== 'auth.forbidden') bad.push(`${r.code} ${op} -> ${o}`);
    }
    expect(bad).toEqual([]);
  });

  it('user.manage alone is not role.manage: a role without identity.role.manage stays refused', async () => {
    const port = portFor([{ code: 'corp_accession_user' }]);
    expect(await outcome(port, 'corp_accession_user', ROLE_MANAGE)).toBe('auth.forbidden');
  });
});

describe('R4: identity.role.manage and identity.user.manage exist only on the pack Admin role', () => {
  it.each([ROLE_MANAGE, USER_MANAGE])('%s is held by corp_admin and std_admin and by no other role of either pack', (perm) => {
    expect(holders(perm).sort()).toEqual([...ADMINS].sort());
  });
  it('the two Admin roles are the pack Admins: base_default_role tenant_admin, MFA required (privileged codes)', () => {
    for (const a of ADMINS) { expect(byCode(a).base_default_role).toBe('tenant_admin'); expect(byCode(a).mfa_required).toBe(true); }
  });
  it('R4 caps were dropped, not moved: Collection Center, Client Operator, Sales Person hold neither manage code', () => {
    for (const c of ['corp_collection_center', 'corp_client_operator', 'corp_sales_person', 'std_collection_center_admin']) {
      expect(byCode(c).permissions, c).not.toContain(ROLE_MANAGE);
      expect(byCode(c).permissions, c).not.toContain(USER_MANAGE);
    }
  });
});

describe('R2: decision authorities exist only on the roles named in the overlay', () => {
  it.each(Object.keys(OVERLAY))('%s is held only by the overlay roles', (perm) => {
    const extra = holders(perm).filter((r) => !OVERLAY[perm]!.includes(r));
    expect(extra, `${perm} held outside the overlay by: ${extra.join(', ')}`).toEqual([]);
  });
  it.each(Object.keys(CLINICAL_ONLY))('%s is held by every pathologist role (the overlay roles actually carry it)', (perm) => {
    for (const r of PATHOLOGISTS) expect(byCode(r).permissions, `${r} ${perm}`).toContain(perm);
  });
  it.each(['billing.refund.approve', 'billing.payment.reverse', 'billing.invoice.cancel', 'frontdesk.discount.approve'])('%s is held by the Accounts roles (corp_accounts, std_account)', (perm) => {
    for (const r of ACCOUNTS) expect(byCode(r).permissions, `${r} ${perm}`).toContain(perm);
  });
  it('result verify is held by the Sr. Lab tiers; the entry-only tiers hold none of verify/approve/amend', () => {
    for (const r of SR_LAB) expect(byCode(r).permissions, r).toContain('lab.result.verify');
    for (const r of ['corp_junior_lab_user', 'corp_laboratory_user', 'corp_laboratory_lab_user'])
      for (const p of ['lab.result.verify', 'lab.result.approve', 'lab.result.amend']) expect(byCode(r).permissions, `${r} ${p}`).not.toContain(p);
  });
  it('Sr. Lab User roles verify but never approve, amend or sign (verification is not sign-off)', () => {
    for (const r of SR_LAB) for (const p of ['lab.result.approve', 'lab.result.amend', 'reporting.narrative.sign', 'anatomic.case.signout']) expect(byCode(r).permissions, `${r} ${p}`).not.toContain(p);
  });
  it('API refuses a decision authority to every role outside the overlay: assertRole -> auth.forbidden', async () => {
    const port = portFor(roles.map((r) => ({ code: r.code })));
    const bad: string[] = [];
    for (const [perm, allowed] of Object.entries(OVERLAY)) for (const r of roles) {
      if (allowed.includes(r.code)) continue;
      const o = await outcome(port, r.code, perm);
      if (o !== 'auth.forbidden') bad.push(`${r.code} ${perm} -> ${o}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('R5: Admin holds no clinical sign-off', () => {
  const CLINICAL = ['lab.result.verify', 'lab.result.approve', 'lab.result.amend', 'reporting.narrative.sign', 'anatomic.case.signout'];
  it.each(ADMINS)('%s holds none of result verify/approve/amend, narrative sign, histopathology sign-out', (admin) => {
    for (const p of CLINICAL) expect(byCode(admin).permissions, `${admin} ${p}`).not.toContain(p);
  });
  it.each(ADMINS)('%s is refused each clinical sign-off by the API (assertRole -> auth.forbidden), MFA enrolled', async (admin) => {
    const port = portFor([{ code: admin }]);
    for (const p of CLINICAL) expect(await outcome(port, admin, p), `${admin} ${p}`).toBe('auth.forbidden');
  });
  it('the Admin roles are full roles (tenant_admin base plus ticked screens), so the denial comes from the data, not an empty role', () => {
    for (const a of ADMINS) expect(byCode(a).permissions.length).toBeGreaterThan(80);
  });
});
