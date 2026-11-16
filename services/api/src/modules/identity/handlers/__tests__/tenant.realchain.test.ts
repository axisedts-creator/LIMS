// T0B-PROVFIX-2: the REAL chain of inviteTenantAdmin and provisionTenant (live fault, staging 2026-11-16 22:19 NPT: 500 common.internal, err_name TypeError,
// after GoTrue created the user). LD-295. No fake repository, no hand built ctx: createPipeline builds the ctx like the router, the real handler,
// bindTenant, service, repos and core/audit/access run on a recording pg-shaped pool (see tenant.realchain.helpers.ts).
// Root cause the first test pins: ctx.now() is an ISO STRING at runtime (core/pipeline/index.ts buildCtx), the service read it as a Date (s.now.getTime()).
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformAuthz } from '../../platform/authz.js';
import { loadRolePacks } from '../../role-packs/loader.js';
import { createTenantService } from '../../service/tenant.service.js';
import { NOW, ROLE_CODES, TENANT_A, makeCtx, makeGotrue, makeRepo, nextId, rejection } from '../../service/__tests__/tenant.helpers.js';
import { inviteTenantAdmin } from '../inviteTenantAdmin.js';
import { provisionTenant } from '../provisionTenant.js';
import {
  GOTRUE_USER, HMAC_KEY, INVITE_BODY, INVITE_TTL_MS, PLATFORM_CLAIMS, PROVISION_BODY, REQ_ID, STAFF_USER, SYS, TENANT, TX_START, makeChain, type Stmt,
} from './tenant.realchain.helpers.js';

const gt = vi.hoisted(() => ({ calls: [] as Array<{ email: string; emailConfirm: boolean }>, result: undefined as unknown }));
// The real gateway returns { userId } or { exists: true, userId } (gateway.http.ts adminCreateUser); only the network call is replaced.
vi.mock('../../gotrue/gateway.http.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  gotrueGatewayFromEnv: () => ({ adminCreateUser: async (i: { email: string; emailConfirm: boolean }) => { gt.calls.push(i); return gt.result; } }),
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVITE_ROUTE = '/v1/identity/platform/tenants/{tenant_id}/admin-invitations';
const PROVISION_ROUTE = '/v1/identity/platform/tenants';
const EXPIRES = new Date(TX_START.getTime() + INVITE_TTL_MS).toISOString();
const EMAIL = 'new.admin@synthetic.example.test';

let savedKey: string | undefined;
beforeAll(() => { savedKey = process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY']; process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'] = HMAC_KEY; });
afterAll(() => { if (savedKey === undefined) delete process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY']; else process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'] = savedKey; });
beforeEach(() => { gt.calls.length = 0; gt.result = { userId: GOTRUE_USER }; });

/** Table / function a statement touches; null for transaction control and claims statements. */
function label(s: Stmt): string | null {
  const t = s.text;
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(t) || /set_config\(/i.test(t)) return null;
  const ins = /^INSERT INTO ([\w.]+)/i.exec(t); if (ins) return ins[1]!;
  if (/app\.enqueue_job/i.test(t)) return 'app.enqueue_job';
  if (/FROM core\.tenants/i.test(t)) return 'SELECT core.tenants';
  return t.slice(0, 40);
}
const labelled = (log: readonly Stmt[]) => log.map((s) => ({ s, l: label(s) })).filter((x) => x.l !== null) as Array<{ s: Stmt; l: string }>;
const inviteCall = (o: Record<string, unknown> = {}) => ({ operationId: 'inviteTenantAdmin', routeTemplate: INVITE_ROUTE, params: { tenant_id: TENANT }, body: INVITE_BODY, ...o });
const provisionCall = (o: Record<string, unknown> = {}) => ({ operationId: 'provisionTenant', routeTemplate: PROVISION_ROUTE, body: PROVISION_BODY, ...o });
const endOf = (texts: string[]) => [...texts].reverse().find((t) => /^(COMMIT|ROLLBACK)$/i.test(t))?.toUpperCase();
// The default pack as data (role-packs.data.yaml via the service's own loader), never a hard-coded count.
const PACK = loadRolePacks().packs.find((p) => p.code === 'elabcorp_default')!;
const PACK_SELECT = 'SELECT r.id, r.role_code AS code, r.is_s';   // label() of role-pack.service listRoles (first 40 chars)
const SCOPE_ACTOR = (t: string) => ({ sub: SYS, actor_type: 'system', tenant_id: t });

describe('premise: the ctx the router builds for a platform handler (core/pipeline buildCtx)', () => {
  it('ctx.now() is an ISO string (not a Date), requestId a string, actor frozen with type user, platform keys from claims, db.withTenantScope present', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    let seen: any;
    await c.run(async (_req: unknown, ctx: any) => { seen = ctx; PlatformAuthz.assertPlatform(ctx, 'platform.tenant.manage'); return { status: 200, body: {} }; }, inviteCall());
    expect(typeof seen.now).toBe('function');
    expect(seen.now()).toBe(TX_START.toISOString());
    expect(typeof seen.now()).toBe('string');
    expect(seen.requestId).toBe(REQ_ID);
    expect(seen.actor).toEqual({ type: 'user', id: STAFF_USER }); expect(Object.isFrozen(seen.actor)).toBe(true);
    expect(seen).toMatchObject({ platformRole: 'platform_superadmin', aal: 'aal2', platformStaffId: PLATFORM_CLAIMS.platform_staff_id });
    expect(typeof seen.db.withTenantScope).toBe('function');
    expect(seen.tenantId).toBeUndefined();
  });
});

describe('inviteTenantAdmin through the real chain (live evidence: Invite administrator on tenant_a -> 500 TypeError after GoTrue)', () => {
  it('answers 201 {membership_id, invitation{status pending, expires_at = tx start + 72 h}} and COMMITs; it never throws a TypeError', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    const r = await c.run(inviteTenantAdmin, inviteCall());
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ membership_id: expect.stringMatching(UUID), invitation: { status: 'pending', expires_at: EXPIRES } });
    expect(endOf(c.rig.texts())).toBe('COMMIT');
    expect(c.rig.texts().some((t) => /^ROLLBACK$/i.test(t))).toBe(false);
  });

  it('GoTrue is called once with the normalised e-mail and emailConfirm false; the identity user exists before the scoped writes, and every scoped write follows it', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    await c.run(inviteTenantAdmin, inviteCall());
    expect(gt.calls).toEqual([{ email: EMAIL, emailConfirm: false }]);
    expect(labelled(c.rig.log).map((x) => x.l)).toEqual(['SELECT core.tenants', 'core.users', 'core.memberships', 'core.membership_roles', 'identity.invitations', 'app.enqueue_job', 'audit.access_log']);
  });

  it('every statement of the scoped block runs under the system actor claims of THIS tenant; the tenant lookup and the claims after the scope are the platform staff claims', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    await c.run(inviteTenantAdmin, inviteCall());
    const stmts = labelled(c.rig.log);
    expect(stmts[0]!.s.claims).toEqual(PLATFORM_CLAIMS);
    for (const x of stmts.slice(1)) expect(x.s.claims, x.l).toEqual(SCOPE_ACTOR(TENANT));
    const restores = c.rig.find(/^SELECT set_config\('request\.jwt\.claims'/).filter((s) => !/tx_started_at/.test(s.text));
    expect(JSON.parse(String(restores[restores.length - 1]!.values[0]))).toEqual(PLATFORM_CLAIMS);
  });

  it('statement parameters are what pg binds: HMAC Buffer of the e-mail, a Date expiry, the membership id of the body, job key invite:<id>:1, access-log row of the contract', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    const r = await c.run(inviteTenantAdmin, inviteCall());
    const mid = r.body.membership_id as string;
    const user = c.rig.one(/^INSERT INTO core\.users/);
    expect(user.values.slice(0, 4)).toEqual([TENANT, GOTRUE_USER, 'Synthetic Admin', EMAIL]);
    expect(Buffer.isBuffer(user.values[4])).toBe(true);
    expect((user.values[4] as Buffer).equals(createHmac('sha256', HMAC_KEY).update(EMAIL).digest())).toBe(true);
    expect(user.values[5]).toBe(STAFF_USER);
    expect(c.rig.one(/^INSERT INTO core\.memberships/).values).toEqual([TENANT, mid, GOTRUE_USER, STAFF_USER]);
    expect(c.rig.one(/^INSERT INTO core\.membership_roles/).values).toEqual([TENANT, mid, STAFF_USER]);
    const inv = c.rig.one(/^INSERT INTO identity\.invitations/).values;
    expect(inv[0]).toBe(TENANT); expect(inv[1]).toMatch(UUID); expect(inv.slice(2, 5)).toEqual([GOTRUE_USER, mid, EMAIL]);
    expect(inv[5]).toBeInstanceOf(Date); expect((inv[5] as Date).toISOString()).toBe(EXPIRES); expect(inv[6]).toBe(STAFF_USER);
    const job = c.rig.one(/app\.enqueue_job/).values;
    expect(job[0]).toBe('identity.send_invitation'); expect(JSON.parse(String(job[1]))).toEqual({ tenant_id: TENANT, invitation_id: inv[1] }); expect(job[2]).toBe(`invite:${String(inv[1])}:1`);
    const log = c.rig.one(/^INSERT INTO audit\.access_log/).values;
    expect(log.slice(1)).toEqual([TENANT, null, STAFF_USER, 'user', null, null, 'tenant.lifecycle_change', 'tenant', TENANT, null, 'allowed', { admin_invited: true }, REQ_ID]);
  });

  it('stage 10 can store the answer: the idempotency store gets a JSON serialisable { status 201, body } (a Date in the body would break the replay)', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    const r = await c.run(inviteTenantAdmin, inviteCall());
    expect(c.finished).toEqual([{ status: 201, body: r.body }]);
  });

  it('a concurrent invite of the same person (23505 on core.users) is 409 identity.user_exists: rolled back, no invitation, no job, no access-log row', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    c.rig.inject(/^INSERT INTO core\.users/, () => Object.assign(new Error('duplicate key value'), { code: '23505', constraint: 'users__email_hmac__uq' }));
    const e = await rejection(c.run(inviteTenantAdmin, inviteCall()));
    expect(e.code).toBe('identity.user_exists'); expect(e.statusCode).toBe(409);
    expect(endOf(c.rig.texts())).toBe('ROLLBACK');
    expect(c.rig.find(/identity\.invitations|app\.enqueue_job|audit\.access_log/)).toHaveLength(0);
  });

  it('an offboarded tenant is 409 and an unknown tenant 404, both BEFORE GoTrue is called and with no write', async () => {
    const off = makeChain({ tenantStatus: 'offboarded' });
    expect((await rejection(off.run(inviteTenantAdmin, inviteCall()))).code).toBe('common.version_conflict');
    const none = makeChain({ tenantExists: false });
    expect((await rejection(none.run(inviteTenantAdmin, inviteCall()))).code).toBe('common.not_found');
    expect(gt.calls).toHaveLength(0);
    for (const c of [off, none]) expect(labelled(c.rig.log).map((x) => x.l)).toEqual(['SELECT core.tenants']);
  });

  it('SECURITY: a tenant session (no platform role) is refused auth.forbidden before GoTrue and before any statement of the operation', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    const tenantClaims = { sub: STAFF_USER, actor_type: 'user', scope: 'tenant', tenant_id: TENANT, aal: 'aal2' };
    const e = await rejection(c.run(inviteTenantAdmin, inviteCall({ claims: tenantClaims })));
    expect(e.code).toBe('auth.forbidden');
    expect(gt.calls).toHaveLength(0);
    expect(labelled(c.rig.log)).toHaveLength(0);
  });

  it('SECURITY: the e-mail HMAC key is read at call time; an unset key fails closed common.internal with a rollback, never a 201', async () => {
    const c = makeChain({ tenantStatus: 'active' });
    const key = process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'];
    delete process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'];
    try {
      const e = await rejection(c.run(inviteTenantAdmin, inviteCall()));
      expect(e.code).toBe('common.internal');
      expect(endOf(c.rig.texts())).toBe('ROLLBACK');
    } finally { process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'] = key; }
  });
});

describe('provisionTenant through the real chain: every statement of the scoped block (same service code as the invite, LD-295)', () => {
  const tenantIdOf = (c: ReturnType<typeof makeChain>) => String(c.rig.one(/^INSERT INTO core\.tenants/).values[0]);

  it('answers 201 with the Tenant body and ETag "1", COMMITs, and stage 10 can store it', async () => {
    const c = makeChain();
    const r = await c.run(provisionTenant, provisionCall());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ tenant_id: tenantIdOf(c), code: 'synthetic_gamma', status: 'provisioning', timezone: 'Asia/Kathmandu', version: 1 });
    expect(r.headers).toEqual({ etag: '"1"' });
    expect(endOf(c.rig.texts())).toBe('COMMIT');
    expect(c.finished).toHaveLength(1);
  });

  it('runs exactly these statements in this order (no ird_annex_records insert: LD-295): lookup, tenant insert, then branch, centre, roles + grants, settings, flags, 2 acceptances, admin (user, membership, role), invitation, job, access-log', async () => {
    const c = makeChain();
    await c.run(provisionTenant, provisionCall());
    expect(labelled(c.rig.log).map((x) => x.l)).toEqual([
      'SELECT core.tenants', 'core.tenants',
      'core.branches', 'core.collection_centres', ...ROLE_CODES.flatMap(() => ['core.roles', 'core.role_permissions']),
      'identity.tenant_settings', 'identity.feature_flags', 'identity.tenant_contract_acceptances', 'identity.tenant_contract_acceptances',
      'core.users', 'core.memberships', 'core.membership_roles', 'identity.invitations', 'app.enqueue_job',
      // T0B-PROVPACK-1 (LD-301; 11-ROLE-MATRIX R6): the default pack is applied through role-pack.service, as it emits: 2 role SELECTs, then per pack role.
      PACK_SELECT, PACK_SELECT, ...PACK.roles.flatMap(() => ['core.roles', 'core.role_permissions', 'audit.access_log']),
      'audit.access_log',
    ]);
  });

  it('the tenant row is written under the platform staff claims; every tenant scoped write under the system actor claims of the NEW tenant; claims restored before COMMIT', async () => {
    const c = makeChain();
    await c.run(provisionTenant, provisionCall());
    const id = tenantIdOf(c);
    const [lookup, insert, ...scoped] = labelled(c.rig.log);
    expect(lookup!.s.claims).toEqual(PLATFORM_CLAIMS); expect(insert!.s.claims).toEqual(PLATFORM_CLAIMS);
    expect(scoped.length).toBeGreaterThan(10);
    for (const x of scoped) expect(x.s.claims, x.l).toEqual(SCOPE_ACTOR(id));
    const sets = c.rig.find(/^SELECT set_config\('request\.jwt\.claims'/).filter((s) => !/tx_started_at/.test(s.text));
    expect(JSON.parse(String(sets[sets.length - 1]!.values[0]))).toEqual(PLATFORM_CLAIMS);
  });

  it('statement parameters: settings, the two acceptances (ToS 2026-11, DPA 2026-10), the admin, the invitation expiry and the access-log row of the new tenant', async () => {
    const c = makeChain();
    await c.run(provisionTenant, provisionCall());
    const id = tenantIdOf(c);
    expect(gt.calls).toEqual([{ email: 'admin@gamma.example.test', emailConfirm: false }]);
    expect(c.rig.one(/^INSERT INTO core\.tenants/).values).toEqual([id, 'synthetic_gamma', 'Synthetic Gamma Lab Pvt. Ltd.', 'Synthetic Gamma', 'Asia/Kathmandu', STAFF_USER]);
    expect(c.rig.one(/^INSERT INTO identity\.tenant_settings/).values).toEqual([id, 'Asia/Kathmandu', 'AD_BS', null, 'Synthetic Gamma Lab Pvt. Ltd.', 'Synthetic Gamma', false, STAFF_USER]);
    const acc = c.rig.find(/^INSERT INTO identity\.tenant_contract_acceptances/).map((s) => s.values.slice(1));
    expect(acc).toEqual([
      [id, 'tos', '2026-11', 'Demo Owner', 'Managing Director', '2026-11-10T09:00:00.000Z', STAFF_USER],
      [id, 'dpa', '2026-10', 'Demo Owner', 'Managing Director', '2026-11-10T09:00:00.000Z', STAFF_USER],
    ]);
    expect(c.rig.one(/^INSERT INTO core\.users/).values.slice(0, 4)).toEqual([id, GOTRUE_USER, 'Gamma Admin', 'admin@gamma.example.test']);
    const inv = c.rig.one(/^INSERT INTO identity\.invitations/).values;
    expect(inv[5]).toBeInstanceOf(Date); expect((inv[5] as Date).toISOString()).toBe(EXPIRES);
    expect(c.rig.find(/^INSERT INTO core\.roles/)).toHaveLength(ROLE_CODES.length + PACK.roles.length);
    const logs = c.rig.find(/^INSERT INTO audit\.access_log/);
    const lifecycle = logs.filter((s) => s.values[7] === 'tenant.lifecycle_change');
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]!.values.slice(1)).toEqual([id, null, STAFF_USER, 'user', null, null, 'tenant.lifecycle_change', 'tenant', id, null, 'allowed', { to_status: 'provisioning' }, REQ_ID]);
    expect(logs.filter((s) => s.values[7] === 'role.change')).toHaveLength(PACK.roles.length);
  });

  it('a failure in the scoped block (pg error on the invitation insert) rolls the whole bundle back: no COMMIT, no job, no access-log row', async () => {
    const c = makeChain();
    c.rig.inject(/^INSERT INTO identity\.invitations/, () => Object.assign(new Error('boom'), { code: '23503' }));
    await rejection(c.run(provisionTenant, provisionCall()));
    expect(endOf(c.rig.texts())).toBe('ROLLBACK');
    expect(c.rig.texts().some((t) => /^COMMIT$/i.test(t))).toBe(false);
    expect(c.rig.find(/app\.enqueue_job|audit\.access_log/)).toHaveLength(0);
  });
});

describe('ctx.now at the service seam: whatever the pipeline or a module hands over (ISO string at runtime, Date, absent), the service computes with a Date', () => {
  const variants: Array<[string, Record<string, unknown>, (d: number) => boolean]> = [
    ['ISO string (the real pipeline)', { now: () => NOW.toISOString() }, (d) => d === NOW.getTime() + INVITE_TTL_MS],
    ['Date', { now: () => NOW }, (d) => d === NOW.getTime() + INVITE_TTL_MS],
    ['absent', { now: undefined }, (d) => Math.abs(d - (Date.now() + INVITE_TTL_MS)) < 10_000],
  ];
  const world = () => {
    const f = makeRepo(); const gotrue = makeGotrue(f);
    const svc = createTenantService({ repo: f.repo, gotrue, emailHmac: (e: string) => Buffer.from(e), userExists: async () => false, newId: nextId } as never) as any;
    return { f, svc };
  };
  it.each(variants)('inviteTenantAdmin with ctx.now = %s: 201, expires_at and the repo expiresAt (a Date) are tx start + 72 h', async (_n, over, ok) => {
    const { f, svc } = world(); const c = makeCtx(f, over);
    const r = await svc.inviteTenantAdmin(c.ctx, { tenantId: TENANT_A, email: 'a@b.example.test', displayName: 'X' });
    expect(r.status).toBe(201);
    const at = f.by('insertInvitation')[0]!.args[1] as { expiresAt: Date };
    expect(at.expiresAt).toBeInstanceOf(Date); expect(ok(at.expiresAt.getTime())).toBe(true);
    expect(r.body.invitation.expires_at).toBe(at.expiresAt.toISOString());
  });
  it('suspendTenant with an ISO string ctx.now hands the repository a Date (TenantRepo.setStatus at: Date)', async () => {
    const { f, svc } = world(); const c = makeCtx(f, { now: () => NOW.toISOString() });
    await svc.suspendTenant(c.ctx, { tenantId: TENANT_A, expectedVersion: 3, reasonText: 'synthetic reason' });
    const p = f.by('setStatus')[0]!.args[2] as { at: unknown };
    expect(p.at).toBeInstanceOf(Date); expect((p.at as Date).getTime()).toBe(NOW.getTime());
  });
});
