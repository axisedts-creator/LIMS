// T0B-ADMINPERM-1 (LD-310 blanket authority; founder: "admin should get all features"; LD-189 AUTH-SENSITIVE yes given for this task).
// The administrator pack corp_admin must hold EVERY permission code of contracts/permissions.yaml that a tenant staff actor can hold.
// Only codes of platform staff, system, portal/patient, device and partner actors are excluded, explicitly, each with a reason
// (the exclusion list lives in ./admin-staff-codes.ts, shared with the other corp_admin pins).
// Reads the pack data file and the registry directly with `yaml`. Fails on main for each staff code missing from corp_admin.
// LD-310 supersedes ADMINPACK-1 section 3.3 / 11-ROLE-MATRIX (115 permissions, no decision codes) for corp_admin only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ALL, EXCLUDED, STAFF, registry } from './admin-staff-codes';

type Role = { code: string; mfa_required: boolean; base_default_role: string | null; permissions: string[] };
const packs = (parse(readFileSync(join(import.meta.dirname, '../../role-packs/role-packs.data.yaml'), 'utf8')) as { packs: Array<{ code: string; roles: Role[] }> }).packs;
const admin = packs.flatMap((p) => p.roles).find((r) => r.code === 'corp_admin')!;

describe('T0B-ADMINPERM-1 corp_admin holds every tenant staff permission (LD-310)', () => {
  it('the exclusion list is honest: every excluded code exists and no tenant staff role holds it in the registry', () => {
    for (const c of Object.keys(EXCLUDED)) {
      const e = registry.find((p) => p.code === c);
      expect(e, `${c} in contracts/permissions.yaml`).toBeDefined();
      expect(e!.roles.filter((r) => !r.startsWith('platform_')), `${c} is held by a tenant staff role, so it cannot be excluded`).toEqual([]);
    }
  });

  it('the registry still has the many staff codes this test enumerates (guards an empty or truncated registry read)', () => {
    expect(STAFF.length).toBeGreaterThan(150);
    expect(STAFF).toContain('lab.result.verify');
  });

  // One test per staff code so the failure names every missing code.
  it.each(STAFF)('corp_admin holds %s', (code) => {
    expect(admin.permissions, `corp_admin is missing ${code}`).toContain(code);
  });

  it('corp_admin holds no excluded (platform, system, portal, patient, device, partner) code', () => {
    expect(admin.permissions.filter((c) => c in EXCLUDED)).toEqual([]);
  });

  it('the lab verification page code lab.result.verify (and approve, amend, enter) is held: /lab/verification no longer answers You do not have access', () => {
    for (const c of ['lab.result.read', 'lab.result.enter', 'lab.result.verify', 'lab.result.approve', 'lab.result.amend']) {
      expect(admin.permissions, c).toContain(c);
    }
  });

  it('corp_admin is exactly the staff set: no unknown code, unique, sorted; mfa_required stays yes; base role stays tenant_admin', () => {
    expect(admin.permissions.filter((c) => !ALL.includes(c))).toEqual([]);
    expect(new Set(admin.permissions).size).toBe(admin.permissions.length);
    expect(admin.permissions).toEqual([...admin.permissions].sort());
    expect([...admin.permissions].sort()).toEqual([...STAFF].sort());
    expect(admin.permissions.length).toBe(166); // registry codes minus the 31 excluded; 155 + the 7 billing accounting codes of T0C-ACCT-1 (LD-313 c) + the 2 sales codes of T0C-SALES-1 (LD-321) + the 2 verification policy codes of T0C-VERLEVEL-1 (LD-316)
    expect(admin.mfa_required).toBe(true);
    expect(admin.base_default_role).toBe('tenant_admin');
  });

  it('done_when (3): no code is renamed or removed; the only registry growth is the 7 billing accounting codes of T0C-ACCT-1 (LD-313 c), all held by corp_admin', () => {
    expect(ALL.length).toBe(new Set(ALL).size);
    expect(ALL.length - Object.keys(EXCLUDED).length).toBe(166); // T0C-ACCT-1 (LD-313 c) added 7 codes, T0C-SALES-1 (LD-321) 2 codes and T0C-VERLEVEL-1 (LD-316) 2 codes to the registry; none renamed or removed (contracts/__tests__/registry-equality.test.ts)
  });

  it('privileged codes are held only because mfa_required is yes (R3)', () => {
    expect(admin.permissions.some((c) => registry.find((p) => p.code === c)!.privileged)).toBe(true);
    expect(admin.mfa_required).toBe(true);
  });
});
