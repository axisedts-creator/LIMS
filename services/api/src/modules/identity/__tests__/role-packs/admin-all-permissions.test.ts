// T0B-ADMINPERM-1 (LD-310 blanket authority; founder: "admin should get all features"; LD-189 AUTH-SENSITIVE yes given for this task).
// The administrator pack corp_admin must hold EVERY permission code of contracts/permissions.yaml that a tenant staff actor can hold.
// Only codes of platform staff, system, portal/patient, device and partner actors are excluded, explicitly, each with a reason.
// Reads the pack data file and the registry directly with `yaml`. Fails on main for each staff code missing from corp_admin.
// NOTE: this supersedes ADMINPACK-1 section 3.3 "left out on purpose" for corp_admin (admin-authority.test.ts) and the
// "equals spec data" / 115-count pins in role-packs.data.test.ts; see .orchestra/notes/T0B-ADMINPERM-1-tests.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '../../../../../../..');
type Role = { code: string; mfa_required: boolean; base_default_role: string | null; permissions: string[] };
const packs = (parse(readFileSync(join(import.meta.dirname, '../../role-packs/role-packs.data.yaml'), 'utf8')) as { packs: Array<{ code: string; roles: Role[] }> }).packs;
const admin = packs.flatMap((p) => p.roles).find((r) => r.code === 'corp_admin')!;
type Entry = { code: string; privileged: boolean; roles: string[] };
const registry = (parse(readFileSync(join(ROOT, 'contracts/permissions.yaml'), 'utf8')) as { permissions: Entry[] }).permissions;
const ALL = registry.map((p) => p.code);

// Codes a tenant staff actor can never hold. One line reason each. Everything else in the registry is a staff code.
const EXCLUDED: Record<string, string> = {
  // platform staff: the provider's own identity, acts in a tenant only through a support session (REQ-SEC-063)
  'platform.tenant.read': 'platform staff only',
  'platform.tenant.manage': 'platform staff only',
  'platform.support_session.open': 'platform staff only',
  'platform.dead_letter.manage': 'platform staff only',
  'platform.staff.manage': 'platform staff only',
  // system actor
  'identity.signatory.read': 'system actor of reporting only',
  // portal and patient actors (fixed_actor_permissions.portal / patient / patient_pre_auth)
  'reporting.portal.view': 'portal and patient actors',
  'reporting.portal.download': 'portal and patient actors',
  'reporting.portal.challenge': 'portal actor',
  'engagement.self.read': 'patient actor',
  'engagement.self.manage': 'patient actor',
  'engagement.booking.create': 'patient actor',
  'engagement.link.redeem': 'patient actor',
  'engagement.payment.create': 'patient actor',
  'engagement.enquiry.create': 'patient actor',
  'engagement.auth.challenge': 'patient pre-auth stage only',
  // device actors (fixed_actor_permissions.device)
  'instruments.ingest.submit': 'device actor bridge_agent',
  'instruments.ingest.heartbeat': 'device actor bridge_agent',
  'instruments.ingest.host_query': 'device actor bridge_agent',
  'instruments.ingest.config_read': 'device actor bridge_agent',
  'instruments.ingest.enrol': 'device actor bridge_agent',
  'engagement.queue.board_read': 'device actor queue_display',
  // partner actors (fixed_actor_permissions.partner)
  'partners.order.read': 'partner actor',
  'partners.manifest.submit': 'partner actor',
  'partners.report.read': 'partner actor',
  'partners.statement.read': 'partner actor',
  'partners.price_list.read': 'partner actor',
  'partners.pickup.request': 'partner actor',
  'partners.referrer.read': 'partner actor',
  'partners.referrer.manage': 'partner_admin actor',
  'partners.partner_user.manage': 'partner_admin actor',
};
const STAFF = ALL.filter((c) => !(c in EXCLUDED));

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
    expect(admin.mfa_required).toBe(true);
    expect(admin.base_default_role).toBe('tenant_admin');
  });

  it('privileged codes are held only because mfa_required is yes (R3)', () => {
    expect(admin.permissions.some((c) => registry.find((p) => p.code === c)!.privileged)).toBe(true);
    expect(admin.mfa_required).toBe(true);
  });
});
