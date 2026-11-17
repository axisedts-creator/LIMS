// T0B-PROVPACK-1 (LD-301, LD-189 AUTH-SENSITIVE, founder yes 2026-11-16 "admin should get all features"): a newly provisioned lab must come with the default role pack
// and its administrator must hold every tenant scoped permission. Live fault (staging 2026-11-17): Admin > Roles listed only the ten default roles, tenant_admin lacked
// the lab, instruments, inventory, quality, payments, engagement, home collection and partners permissions, so those pages answered "You do not have access".
// REAL chain, like T0B-PROVFIX-2: createPipeline -> provisionTenant / activateTenant handlers -> tenant.service -> tenant repo -> role-pack.service -> self.service getMe
// (real self.repo SQL). Only the database is simulated (tenant.provpack.helpers makeDbSim: unique role code per tenant, role_permissions primary key, BEGIN/ROLLBACK).
// SEAM: the accept step (invitation accepted, membership active) is set on the simulated row (T0B-ACTIVATE-1 tests cover the real accept).
// Oracle: contracts/permissions.yaml read directly (not the generated TS, not the code under test). Expected now: the chain tests FAIL on main (tenant_admin holds a subset,
// no pack role exists); the guards that pass on main (no platform.*, mfa_required, other roles unchanged) pin what the fix must not touch.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRolePacks } from '../../role-packs/loader.js';
import { createSelfRepo } from '../../repository/self.repo.js';
import { createSelfService } from '../../service/self.service.js';
import { activateTenant } from '../activateTenant.js';
import { provisionTenant } from '../provisionTenant.js';
import { GOTRUE_USER, HMAC_KEY, PROVISION_BODY, REQ_ID, makeChain } from './tenant.realchain.helpers.js';
import { CATALOGUE, DEFAULT_ROLE_CODES, DEFAULT_ROLE_MFA, GRANTS_OF, NEVER_FOR_TENANT_ADMIN, TENANT_SCOPED, makeDbSim } from './tenant.provpack.helpers.js';

const gt = vi.hoisted(() => ({ calls: [] as Array<{ email: string; emailConfirm: boolean }> }));
vi.mock('../../gotrue/gateway.http.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  gotrueGatewayFromEnv: () => ({ adminCreateUser: async (i: { email: string; emailConfirm: boolean }) => { gt.calls.push(i); return { userId: GOTRUE_USER }; } }),
}));

let savedKey: string | undefined;
beforeAll(() => { savedKey = process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY']; process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'] = HMAC_KEY; });
afterAll(() => { if (savedKey === undefined) delete process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY']; else process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'] = savedKey; });
beforeEach(() => { gt.calls.length = 0; });

const PACK_CODE = 'elabcorp_default';
const PACK = loadRolePacks().packs.find((p) => p.code === PACK_CODE)!;
const PROVISION_ROUTE = '/v1/identity/platform/tenants';
const ACTIVATE_ROUTE = '/v1/identity/platform/tenants/{tenant_id}/activate';
const sorted = (a: readonly string[]) => [...new Set(a)].sort();
const OTHER_ROLES = DEFAULT_ROLE_CODES.filter((c) => c !== 'tenant_admin');
const MODULE_PREFIXES = ['lab.', 'instruments.', 'inventory.', 'quality.', 'payments.', 'engagement.', 'homecollection.', 'partners.'];
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

function world(code = 'metrolabs_syn') {
  const sim = makeDbSim();
  const c = makeChain({ handle: sim.handle });
  const provision = (body: Record<string, unknown> = {}) => c.run(provisionTenant, { operationId: 'provisionTenant', routeTemplate: PROVISION_ROUTE, body: { ...PROVISION_BODY, code, ...body } });
  const activate = (id: string, version = 1) => c.run(activateTenant, { operationId: 'activateTenant', routeTemplate: ACTIVATE_ROUTE, params: { tenant_id: id }, headers: { 'if-match': `"${version}"` } });
  /** getMe of the first administrator through the real self.service and the real self.repo SQL */
  const getMe = async (id: string) => {
    const m = sim.members(id)[0]!; const tx = await c.rig.pool.connect();
    const out = await createSelfService({ repo: createSelfRepo() }).getMe({
      tenantId: id, actor: { type: 'user', id: m.user_id, membershipId: m.id }, sessionId: REQ_ID, requestId: REQ_ID, clientIp: '203.0.113.9', aal: 'aal2', tx,
      commitOnError() {}, audit: { async access() {} },
    } as never);
    tx.release(); return out.body as { roles: Array<{ code: string }>; permissions: string[] };
  };
  /** provision, accept, activate: returns the tenant id */
  const chain = async () => {
    const p = await provision(); const id = (p.body as { tenant_id: string }).tenant_id;
    sim.accept(id); await activate(id, (p.body as { version: number }).version);
    return id;
  };
  return { sim, c, provision, activate, getMe, chain };
}

describe('AC chain (live fault 2026-11-17): provision -> accept the first administrator -> activate -> getMe lists every tenant scoped permission', () => {
  it('(1)(2)(7) getMe of the new administrator holds EVERY tenant scoped permission of the catalogue, and the lab, instruments, inventory, quality, payments, engagement, home collection and partners ones', async () => {
    const w = world(); const id = await w.chain();
    expect(w.sim.tenant(id)!.status).toBe('active');
    const me = await w.getMe(id);
    expect(me.roles.map((r) => r.code)).toEqual(['tenant_admin']);
    expect(TENANT_SCOPED.length).toBeGreaterThan(150);                                 // oracle sanity: the catalogue is read, not empty
    expect(TENANT_SCOPED.filter((c) => !me.permissions.includes(c))).toEqual([]);      // the missing list is the assertion message of a failure
    for (const p of MODULE_PREFIXES) expect(me.permissions.some((c) => c.startsWith(p)), p).toBe(true);
  });

  it('(2) provisioning itself applies the default role pack elabcorp_default: every pack role exists as a CUSTOM role with the pack permissions and mfa flag (before any activation)', async () => {
    const w = world(); const p = await w.provision(); const id = (p.body as { tenant_id: string }).tenant_id;
    const roles = w.sim.roles(id);
    expect(roles.map((r) => r.role_code).sort()).toEqual([...DEFAULT_ROLE_CODES, ...PACK.roles.map((r) => r.code)].sort());   // ten defaults + the pack, nothing else
    for (const pr of PACK.roles) {
      const r = w.sim.role(id, pr.code)!;
      expect(r, pr.code).toMatchObject({ is_system_default: false, is_active: true, mfa_required: pr.mfa_required });
      expect(w.sim.perms(id, pr.code), pr.code).toEqual(sorted(pr.permissions));
    }
  });

  it('(2) the pack step goes through role-pack.service (insert-only SQL of the apply path): the pack role rows are written by its INSERT INTO core.roles shape, no second copy of the pack logic', async () => {
    const w = world(); const p = await w.provision(); const id = (p.body as { tenant_id: string }).tenant_id;
    const packWrites = w.sim.writes.filter((x) => /^INSERT INTO core\.roles/i.test(x.text) && !/is_system_default/i.test(x.text));
    expect(packWrites.map((x) => x.values[2])).toEqual(PACK.roles.map((r) => r.code));          // [tenant, id, code, name, mfa, actor] in pack order
    for (const x of packWrites) expect(x.values[0]).toBe(id);
  });

  it('(2) the audit trail records the pack roles: one role.change access-log row per created pack role, written under the new tenant', async () => {
    const w = world(); const p = await w.provision(); const id = (p.body as { tenant_id: string }).tenant_id;
    const rows = w.c.rig.find(/^INSERT INTO audit\.access_log/).filter((s) => s.values.includes('role.change'));
    expect(rows).toHaveLength(PACK.roles.length);
    for (const r of rows) expect(r.values).toContain(id);
  });

  it('a pack role holds only assignable permissions: nothing platform.* or actor-only reaches any role of the new lab', async () => {
    const w = world(); const id = await w.chain();
    for (const r of w.sim.roles(id)) for (const c of w.sim.perms(id, r.role_code)) expect(NEVER_FOR_TENANT_ADMIN, `${r.role_code} ${c}`).not.toContain(c);
  });
});

describe('(2)(5) tenant_admin: all tenant scoped permissions, nothing else; no other role changes (AUTH-SENSITIVE, LD-189)', () => {
  it('tenant_admin holds exactly the tenant scoped set (every assignable code of the catalogue) once the lab is provisioned, and still after activation', async () => {
    const w = world(); const p = await w.provision(); const id = (p.body as { tenant_id: string }).tenant_id;
    expect(w.sim.perms(id, 'tenant_admin')).toEqual(TENANT_SCOPED);
    w.sim.accept(id); await w.activate(id, 1);
    expect(w.sim.perms(id, 'tenant_admin')).toEqual(TENANT_SCOPED);
  });

  it('GUARD: tenant_admin never holds a platform.* permission or an actor-only one (the CR names them: contracts mark them never for a tenant administrator)', async () => {
    const w = world(); const id = await w.chain();
    const held = w.sim.perms(id, 'tenant_admin');
    expect(NEVER_FOR_TENANT_ADMIN).toEqual(expect.arrayContaining(CATALOGUE.filter((e) => e.code.startsWith('platform.')).map((e) => e.code)));
    expect(held.filter((c) => NEVER_FOR_TENANT_ADMIN.includes(c))).toEqual([]);
    expect(held.filter((c) => c.startsWith('platform.'))).toEqual([]);
  });

  it('(3) GUARD: mfa_required stays on for tenant_admin; every default role keeps the contract flag and stays a system default', async () => {
    const w = world(); const id = await w.chain();
    expect(w.sim.role(id, 'tenant_admin')).toMatchObject({ mfa_required: true, is_system_default: true, is_active: true });
    for (const code of DEFAULT_ROLE_CODES) expect(w.sim.role(id, code), code).toMatchObject({ mfa_required: DEFAULT_ROLE_MFA[code], is_system_default: true, is_active: true });
  });

  it('(5) the reviewer check: NO other default role gains a permission; each of the nine holds exactly what the catalogue lists for it', async () => {
    const w = world(); const id = await w.chain();
    for (const code of OTHER_ROLES) expect(w.sim.perms(id, code), code).toEqual(GRANTS_OF(code));
  });

  it('(5) the single administrator membership holds exactly one role (tenant_admin); the pack roles are assigned to nobody', async () => {
    const w = world(); const id = await w.chain();
    expect(w.sim.memberRoleCount(id)).toBe(1);
    expect((await w.getMe(id)).roles.map((r) => r.code)).toEqual(['tenant_admin']);
  });

  it('(5) GUARD: every privileged permission tenant_admin holds comes with mfa_required true on its role (AC-B2.1)', async () => {
    const w = world(); const id = await w.chain();
    const privileged = new Set(CATALOGUE.filter((e) => e.privileged).map((e) => e.code));
    expect(w.sim.perms(id, 'tenant_admin').some((c) => privileged.has(c))).toBe(true);
    expect(w.sim.role(id, 'tenant_admin')!.mfa_required).toBe(true);
  });
});

describe('(4) idempotent and retry safe: no duplicate roles or grants, additive only', () => {
  it('provisioning the same lab code twice is refused and creates no second set of roles or grants', async () => {
    const w = world(); const p = await w.provision(); const id = (p.body as { tenant_id: string }).tenant_id;
    const roles = w.sim.roles(id).length, grants = w.sim.grantCount(id);
    expect((await rejection(w.provision())).code).toBe('identity.code_duplicate');
    expect(w.sim.roles(id)).toHaveLength(roles); expect(w.sim.grantCount(id)).toBe(grants);
  });

  it('activating twice: the second activation is refused (409) and changes nothing; roles and grants are exactly those of the first', async () => {
    const w = world(); const p = await w.provision(); const id = (p.body as { tenant_id: string }).tenant_id;
    w.sim.accept(id); await w.activate(id, 1);
    const roles = w.sim.roles(id).length, grants = w.sim.grantCount(id), admin = w.sim.perms(id, 'tenant_admin');
    expect((await rejection(w.activate(id, 2))).code).toBe('common.version_conflict');
    expect(w.sim.roles(id)).toHaveLength(roles); expect(w.sim.grantCount(id)).toBe(grants); expect(w.sim.perms(id, 'tenant_admin')).toEqual(admin);
    expect(new Set(w.sim.roles(id).map((r) => r.role_code)).size).toBe(roles);   // no duplicate role code
  });

  it('a step that fails at activation rolls back with no partial pack, and the retry succeeds with no duplicate roles or grants', async () => {
    const w = world(); const p = await w.provision(); const id = (p.body as { tenant_id: string }).tenant_id;
    w.sim.accept(id);
    const roles = w.sim.roles(id).length, grants = w.sim.grantCount(id);
    w.c.rig.inject(/^INSERT INTO audit\.access_log/, () => Object.assign(new Error('boom'), { code: '53300' }));   // the last statement of activateTenant: everything before it must roll back
    await rejection(w.activate(id, 1));
    expect(w.sim.tenant(id)!.status).toBe('provisioning');
    expect(w.sim.roles(id)).toHaveLength(roles); expect(w.sim.grantCount(id)).toBe(grants);
    expect((await w.activate(id, 1)).status).toBe(200);
    expect(w.sim.tenant(id)!.status).toBe('active');
    expect(w.sim.roles(id)).toHaveLength(roles); expect(w.sim.grantCount(id)).toBe(grants);
    expect(w.sim.perms(id, 'tenant_admin')).toEqual(TENANT_SCOPED);
  });

  it('the pack step never removes or rewrites anything: the whole chain issues no UPDATE or DELETE on roles, role_permissions or membership_roles', async () => {
    const w = world(); await w.chain();
    expect(w.c.rig.find(/^(UPDATE|DELETE)\b[^;]*\bcore\.(roles|role_permissions|membership_roles)\b/i)).toEqual([]);
  });
});

describe('(2) repair of a lab provisioned BEFORE the fix (metrolabs on staging): re-running activation adds the missing grants and the pack, additively', () => {
  // The staging state: ten default roles, tenant_admin with the old narrow grants, no pack, an accepted tenant_admin, status provisioning (activation not yet run).
  const OLD_ADMIN = ['identity.user.read', 'identity.user.manage', 'identity.role.manage', 'identity.centre.manage', 'identity.settings.manage', 'audit.log.read'];
  const LEGACY = { id: '01a1e57f-03a0-790b-bbae-dd98d808d1b7', code: 'metrolabs_legacy', adminUser: '0190a000-0000-7000-8000-00000000a111', adminMembership: '0190a000-0000-7000-8000-00000000a222' };
  const legacy = () => {
    const w = world('unused_code');
    w.sim.seedLegacyLab({ ...LEGACY, oldAdminGrants: OLD_ADMIN, defaultGrants: Object.fromEntries(DEFAULT_ROLE_CODES.map((c) => [c, GRANTS_OF(c)])), defaultMfa: DEFAULT_ROLE_MFA });
    return w;
  };

  it('guard (passes on main): the legacy fixture is what staging shows: ten roles, tenant_admin short of the catalogue, no pack role', () => {
    const w = legacy();
    expect(w.sim.roles(LEGACY.id)).toHaveLength(DEFAULT_ROLE_CODES.length);
    expect(w.sim.perms(LEGACY.id, 'tenant_admin')).toEqual(sorted(OLD_ADMIN));
    expect(PACK.roles.some((r) => w.sim.role(LEGACY.id, r.code))).toBe(false);
  });

  it('activateTenant on the legacy lab gives tenant_admin every tenant scoped permission, applies the pack, and leaves the nine other roles exactly as they were', async () => {
    const w = legacy();
    expect((await w.activate(LEGACY.id, 1)).status).toBe(200);
    expect(w.sim.tenant(LEGACY.id)!.status).toBe('active');
    expect(w.sim.perms(LEGACY.id, 'tenant_admin')).toEqual(TENANT_SCOPED);
    for (const pr of PACK.roles) expect(w.sim.perms(LEGACY.id, pr.code), pr.code).toEqual(sorted(pr.permissions));
    for (const code of OTHER_ROLES) expect(w.sim.perms(LEGACY.id, code), code).toEqual(GRANTS_OF(code));
    expect(w.sim.roles(LEGACY.id)).toHaveLength(DEFAULT_ROLE_CODES.length + PACK.roles.length);
  });

  it('additive only on repair: every grant the legacy tenant_admin held is still held, the role keeps mfa_required true, and no UPDATE or DELETE ran', async () => {
    const w = legacy(); await w.activate(LEGACY.id, 1);
    const held = w.sim.perms(LEGACY.id, 'tenant_admin');
    expect(OLD_ADMIN.filter((c) => !held.includes(c))).toEqual([]);
    expect(w.sim.role(LEGACY.id, 'tenant_admin')).toMatchObject({ mfa_required: true, is_system_default: true });
    expect(w.c.rig.find(/^(UPDATE|DELETE)\b[^;]*\bcore\.(roles|role_permissions|membership_roles)\b/i)).toEqual([]);
  });

  it('a tenant edit wins: a pack role the lab already created and renamed or trimmed is not rewritten by the repair (R6 editable afterwards)', async () => {
    const w = legacy();
    const first = PACK.roles[0]!;
    // the lab already has the pack role code as a custom role holding ONE of the pack permissions (a tenant trimmed it)
    const keep = sorted(first.permissions)[0]!;
    w.sim.seedCustomRole({ tenant: LEGACY.id, id: '0190a000-0000-7000-8000-00000000c001', code: first.code, name: 'Renamed by the lab', mfa: first.mfa_required, perms: [keep] });
    await w.activate(LEGACY.id, 1);
    expect(w.sim.role(LEGACY.id, first.code)).toMatchObject({ display_name: 'Renamed by the lab' });
    expect(w.sim.perms(LEGACY.id, first.code)).toEqual([keep]);
    for (const pr of PACK.roles.slice(1)) expect(w.sim.perms(LEGACY.id, pr.code), pr.code).toEqual(sorted(pr.permissions));
  });

  it('(4) running activation again after the repair (a second, refused call) and the retry-safe step leave roles and grants unchanged', async () => {
    const w = legacy(); await w.activate(LEGACY.id, 1);
    const roles = w.sim.roles(LEGACY.id).length, grants = w.sim.grantCount(LEGACY.id);
    expect((await rejection(w.activate(LEGACY.id, 2))).code).toBe('common.version_conflict');
    expect(w.sim.roles(LEGACY.id)).toHaveLength(roles); expect(w.sim.grantCount(LEGACY.id)).toBe(grants);
  });
});

describe('isolation: the pack and the grants go to the tenant being provisioned only', () => {
  it('two labs provisioned in the same simulated database each get their own roles and grants; the second does not touch the first', async () => {
    const w = world('lab_one_syn'); const a = await w.chain();
    const grantsA = w.sim.grantCount(a), rolesA = w.sim.roles(a).length;
    const p2 = await w.provision({ code: 'lab_two_syn' }); const b = (p2.body as { tenant_id: string }).tenant_id;
    expect(b).not.toBe(a);
    expect(w.sim.roles(a)).toHaveLength(rolesA); expect(w.sim.grantCount(a)).toBe(grantsA);
    expect(w.sim.roles(b)).toHaveLength(DEFAULT_ROLE_CODES.length + PACK.roles.length);
    expect(w.sim.perms(b, 'tenant_admin')).toEqual(TENANT_SCOPED);
    for (const r of w.sim.roles(b)) expect(r.tenant_id).toBe(b);
  });

  it('SECURITY: a tenant administrator session cannot provision or activate (platform operations); no role or grant is written', async () => {
    const w = world();
    const tenantClaims = { sub: GOTRUE_USER, actor_type: 'user', scope: 'tenant', tenant_id: '0190a000-0000-7000-8000-00000000a001', aal: 'aal2' };
    const e = await rejection(w.c.run(provisionTenant, { operationId: 'provisionTenant', routeTemplate: PROVISION_ROUTE, body: PROVISION_BODY, claims: tenantClaims }));
    expect(e.code).toBe('auth.forbidden');
    expect(w.sim.writes).toEqual([]);
  });
});
