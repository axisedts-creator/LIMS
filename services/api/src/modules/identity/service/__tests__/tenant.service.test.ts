// T22 tenant.service: provisioning bundle (AC-E1.1/1.2, LD-26, LD-29), lifecycle (AC-E1.3, US-E2, 07-SECURITY D-T13, 08 A8.3/A9.5), platform settings/flags (AC-C5.3, D-T21),
// inviteTenantAdmin, D-214 scope rules. Behaviour against the injected fake repo (tenant.helpers.ts documents every seam). Expected now: fails to load (../tenant.service.js missing).
import { describe, expect, it } from 'vitest';
import { createTenantService } from '../tenant.service.js';
import {
  FLAG_FOUNDER, FLAG_PLAIN, NOW, PROVISION, ROLE_CODES, STAFF_USER, SYS, TENANT_A, TENANT_B, acc, idN, makeCtx, makeGotrue, makeRepo, nextId, rejection, seedA, seedB, writes, type Status,
} from './tenant.helpers.js';

const HMAC = (e: string) => Buffer.from(`hmac:${e}`);
function setup(status: Status = 'active', ctxOver: Record<string, unknown> = {}, existing: Record<string, string> = {}, readiness?: Parameters<typeof makeRepo>[0]['readiness']) {
  const f = makeRepo({ tenants: [seedA(status), seedB()], ...(readiness ? { readiness } : {}) }); const c = makeCtx(f, ctxOver); const gotrue = makeGotrue(f, existing);
  const svc = createTenantService({ repo: f.repo, gotrue, emailHmac: HMAC, userExists: async () => false, newId: nextId } as never) as any;
  return { f, gotrue, svc, ...c };
}
const code = async (p: unknown) => (await rejection(p)).code;
const paths = (e: any) => (e.errors ?? []).map((x: any) => x.path);
const hasNull = (v: unknown): boolean => v === null || (typeof v === 'object' && v !== null && Object.values(v).some(hasNull));
const TENANT_KEYS = ['tenant_id', 'code', 'legal_name', 'display_name', 'status', 'timezone', 'status_reason', 'activated_at', 'suspended_at', 'offboarded_at', 'billing_live_on', 'created_at', 'version'];

describe('provisionTenant - the bundle (AC-E1.1, 03-APP-FLOW s9.1)', () => {
  it('201 Tenant status provisioning, version 1, schema keys only, no nulls; code/legal/display echoed', async () => {
    const { svc, ctx } = setup(); const r = await svc.provisionTenant(ctx, PROVISION);
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ code: 'synthetic_gamma', legal_name: PROVISION.legalName, display_name: 'Synthetic Gamma', status: 'provisioning', timezone: 'Asia/Kathmandu', version: 1 });
    for (const k of Object.keys(r.body)) expect(TENANT_KEYS).toContain(k); expect(hasNull(r.body)).toBe(false); expect(r.body.tenant_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('everything in ONE transaction: every repo call gets the request tx; core.tenants row first under platform claims, the rest in exactly ONE withTenantScope(newTenant) window', async () => {
    const { svc, ctx, f, tx, scopes } = setup(); const r = await svc.provisionTenant(ctx, PROVISION); const id = r.body.tenant_id;
    for (const c of f.calls) expect(c.tx).toBe(tx);
    expect(scopes).toEqual([id]); expect(f.by('insert')).toHaveLength(1); expect(f.by('insert')[0]!.scope).toBeNull();
    for (const m of ['insertBranch', 'insertCentre', 'seedRoles', 'insertSettings', 'seedFlags', 'seedIrdAnnexes', 'insertAcceptances', 'insertAdmin', 'insertInvitation', 'accessLog'])
      { expect(f.by(m), m).toHaveLength(1); expect(f.by(m)[0]!.scope, m).toBe(id); expect(f.by(m)[0]!.args[0], m).toBe(id); }
    expect(f.order.indexOf('insert')).toBeLessThan(f.order.indexOf(`scope:${id}`));
  });
  it('seeds the default roles of contracts/permissions.yaml roles: (10), settings defaults + body values, flag registry defaults, annex_2/3/7 not_started', async () => {
    const { svc, ctx, f } = setup(); const id = (await svc.provisionTenant(ctx, { ...PROVISION, pan: '123456789' })).body.tenant_id;
    expect(ROLE_CODES).toHaveLength(10); expect([...f.by('seedRoles')[0]!.args[1] as string[]].sort()).toEqual([...ROLE_CODES].sort());
    expect(f.by('insertSettings')[0]!.args[1]).toMatchObject({ timezone: 'Asia/Kathmandu', calendarDisplay: 'AD_BS', pan: '123456789', legalName: PROVISION.legalName, displayName: 'Synthetic Gamma', trainingMode: false });
    expect([...f.by('seedIrdAnnexes')[0]!.args[1] as string[]].sort()).toEqual(['annex_2', 'annex_3', 'annex_7']);
    expect(f.data(id).annexes.map((a) => a.status)).toEqual(['not_started', 'not_started', 'not_started']); expect(f.data(id).flags.length).toBeGreaterThan(0);
  });
  it('first branch + first centre (centre linked to the branch) and the first admin: invited, tenant_admin, email normalised (trim+lower), HMAC, invitation + identity.send_invitation job; GoTrue user created BEFORE the tx writes', async () => {
    const { svc, ctx, f, gotrue } = setup(); const id = (await svc.provisionTenant(ctx, PROVISION)).body.tenant_id;
    expect(f.by('insertBranch')[0]!.args[1]).toMatchObject({ code: 'KTM-01', name: 'Gamma main branch', addressText: 'Synthetic Road 1' });
    expect(f.by('insertCentre')[0]!.args[1]).toMatchObject({ code: 'C000000010', kind: 'own', branchId: (f.by('insertBranch')[0]!.args[1] as any).id });
    expect(gotrue.calls).toEqual([{ email: 'admin@gamma.example.test', emailConfirm: false }]); expect(f.order.indexOf('gotrue')).toBeLessThan(f.order.indexOf('insert'));
    const a: any = f.by('insertAdmin')[0]!.args[1]; expect(a).toMatchObject({ emailNormalized: 'admin@gamma.example.test', displayName: 'Gamma Admin' }); expect(a.emailHmac).toEqual(HMAC('admin@gamma.example.test'));
    expect(f.data(id).members).toHaveLength(1); expect(f.data(id).members[0]).toMatchObject({ status: 'invited', roles: expect.anything() });
    const inv: any = f.by('insertInvitation')[0]!.args[1]; expect(inv).toMatchObject({ membershipId: a.membershipId, userId: a.userId, email: 'admin@gamma.example.test' });
    expect(f.jobs).toEqual([{ identifier: 'identity.send_invitation', payload: { tenant_id: id, invitation_id: inv.id }, jobKey: `invite:${inv.id}:1` }]);
  });
  it('access log tenant.lifecycle_change (entity tenant, the new tenant id) is written INSIDE the new tenant scope', async () => {
    const { svc, ctx, f } = setup(); const id = (await svc.provisionTenant(ctx, PROVISION)).body.tenant_id; const e: any = f.by('accessLog')[0]!.args[1];
    expect(e).toMatchObject({ action: 'tenant.lifecycle_change', entityType: 'tenant', entityId: id, outcome: 'allowed' }); expect(f.by('accessLog')[0]!.scope).toBe(id);
  });
  it('an orphan GoTrue user of a rolled-back attempt (exists, no core.users row) is reused; an existing core user -> 409 identity.user_exists with nothing written', async () => {
    const f1 = setup('active', {}, { 'admin@gamma.example.test': idN(0x7001) }); const r = await f1.svc.provisionTenant(f1.ctx, PROVISION); expect(r.status).toBe(201);
    expect((f1.f.by('insertAdmin')[0]!.args[1] as any).userId).toBe(idN(0x7001));
    const f = makeRepo(); const c = makeCtx(f); const svc = createTenantService({ repo: f.repo, gotrue: makeGotrue(f, { 'admin@gamma.example.test': idN(0x7002) }), emailHmac: HMAC, userExists: async () => true, newId: nextId } as never) as any;
    expect(await code(svc.provisionTenant(c.ctx, PROVISION))).toBe('identity.user_exists'); expect(writes(f)).toHaveLength(0);
  });
  it('a failure part-way (admin insert) propagates untouched (the core pipeline rolls the single tx back); the scope window is closed; nothing is retried or swallowed', async () => {
    const { svc, ctx, f } = setup(); f.state.fail['insertAdmin'] = new Error('boom'); const e = await rejection(svc.provisionTenant(ctx, PROVISION));
    expect(e.message).toBe('boom'); expect(f.state.scope).toBeNull(); expect(f.by('insertAdmin')).toHaveLength(1); expect(f.by('enqueue')).toHaveLength(0);
  });
});

describe('provisionTenant - AC-E1.2 duplicate code, validation, mass assignment', () => {
  it('duplicate code -> 409 identity.code_duplicate; nothing written; GoTrue not called', async () => {
    const { svc, ctx, f, gotrue } = setup(); const e = await rejection(svc.provisionTenant(ctx, { ...PROVISION, code: 'synthetic_alpha' }));
    expect(e.code).toBe('identity.code_duplicate'); expect(e.statusCode).toBe(409); expect(writes(f)).toHaveLength(0); expect(gotrue.adminCreateUser).not.toHaveBeenCalled();
  });
  it('a race on the unique index (23505 at insert) is the same 409 identity.code_duplicate, not a 500', async () => {
    const { svc, ctx, f } = setup(); f.state.fail['insert'] = Object.assign(new Error('dup'), { code: '23505' });
    expect(await code(svc.provisionTenant(ctx, PROVISION))).toBe('identity.code_duplicate');
  });
  it.each([
    ['code', { code: 'Bad-Code' }, '/code'], ['code too short', { code: 'ab' }, '/code'], ['code with a leading digit', { code: '1abc' }, '/code'], ['legalName empty', { legalName: '' }, '/legal_name'],
    ['displayName 121', { displayName: 'x'.repeat(121) }, '/display_name'], ['pan', { pan: '12345' }, '/pan'], ['calendarDisplay', { calendarDisplay: 'JULIAN' }, '/calendar_display'],
    ['branch code', { firstBranch: { ...PROVISION.firstBranch, code: 'bad code!' } }, '/first_branch/code'], ['centre kind', { firstCentre: { ...PROVISION.firstCentre, kind: 'kiosk' } }, '/first_centre/kind'],
    ['admin email', { firstAdmin: { ...PROVISION.firstAdmin, email: 'not-an-email' } }, '/first_admin/email'], ['admin name', { firstAdmin: { ...PROVISION.firstAdmin, displayName: '' } }, '/first_admin/display_name'],
    ['missing first_centre', { firstCentre: undefined }, '/first_centre'], ['trainingMode not boolean', { trainingMode: 'yes' }, '/training_mode'],
  ])('400 common.validation_failed at the field pointer: %s; nothing written', async (_n, patch, path) => {
    const { svc, ctx, f } = setup(); const e = await rejection(svc.provisionTenant(ctx, { ...PROVISION, ...patch }));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(paths(e)).toContain(path); expect(writes(f)).toHaveLength(0);
  });
  it.each(['Asia/Kolkata', 'UTC', ''])('timezone %j -> 422 identity.setting_out_of_range at /timezone (P-15, D-T21); omitted -> default Asia/Kathmandu', async (tz) => {
    const { svc, ctx, f } = setup(); const e = await rejection(svc.provisionTenant(ctx, { ...PROVISION, timezone: tz }));
    expect(e.code).toBe('identity.setting_out_of_range'); expect(e.statusCode).toBe(422); expect(paths(e)).toEqual(['/timezone']); expect(writes(f)).toHaveLength(0);
    const o = setup(); const { timezone: _t, ...rest } = PROVISION; expect((await o.svc.provisionTenant(o.ctx, rest)).body.timezone).toBe('Asia/Kathmandu');
  });
  it('mass assignment: status/id/version/createdBy/activatedAt/actorId in the input never reach the repo; the row is status provisioning created by the ctx actor', async () => {
    const { svc, ctx, f } = setup(); const r = await svc.provisionTenant(ctx, { ...PROVISION, status: 'active', id: TENANT_A, tenantId: TENANT_A, version: 9, activatedAt: 'x', actorId: 'evil', trainingModeX: 1 });
    expect(r.body.status).toBe('provisioning'); expect(r.body.tenant_id).not.toBe(TENANT_A); const a: any = f.by('insert')[0]!.args[0];
    expect(a.actorId).toBe(STAFF_USER); for (const k of Object.keys(a)) expect(['actorId', 'code', 'displayName', 'id', 'legalName', 'pan', 'timezone']).toContain(k); expect(a.id).not.toBe(TENANT_A);
    expect(f.data(TENANT_A).members).toHaveLength(3);
  });
});

describe('LD-26 training tenant: trainingMode set at provisioning only (A33-3)', () => {
  it('trainingMode true -> insertSettings trainingMode true; omitted/false -> false', async () => {
    const t = setup(); await t.svc.provisionTenant(t.ctx, { ...PROVISION, trainingMode: true }); expect(t.f.by('insertSettings')[0]!.args[1]).toMatchObject({ trainingMode: true });
    const u = setup(); await u.svc.provisionTenant(u.ctx, PROVISION); expect(u.f.by('insertSettings')[0]!.args[1]).toMatchObject({ trainingMode: false });
  });
  it('immutable after provisioning: updateTenantSettingsAsPlatform with training_mode (either value) -> 400 at /training_mode, nothing written', async () => {
    for (const v of [true, false]) {
      const { svc, ctx, f } = setup(); const e = await rejection(svc.updateTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A, expectedVersion: 2, patch: { training_mode: v } }));
      expect(e.code).toBe('common.validation_failed'); expect(paths(e)).toEqual(['/training_mode']); expect(writes(f)).toHaveLength(0);
    }
  });
  it('platform settings read exposes training_mode (consumers read it through the C2 settings port; CR-C2-T16 column)', async () => {
    const { svc, ctx, f } = setup(); f.data(TENANT_A).settings!['training_mode'] = true; expect((await svc.getTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A })).body).toMatchObject({ training_mode: true });
  });
});

describe('LD-29 contract acceptance recorded at provisioning (A33-6)', () => {
  it('both tos and dpa rows are inserted in the new tenant scope with version, accepted_by name/title and accepted_at', async () => {
    const { svc, ctx, f } = setup(); const id = (await svc.provisionTenant(ctx, PROVISION)).body.tenant_id; const rows: any[] = f.by('insertAcceptances')[0]!.args[1] as any[];
    expect(f.by('insertAcceptances')[0]!.scope).toBe(id); expect(rows.map((r) => r.document).sort()).toEqual(['dpa', 'tos']);
    expect(rows.find((r) => r.document === 'tos')).toMatchObject({ version: '2026-11', acceptedByName: 'Demo Owner', acceptedByTitle: 'Managing Director', acceptedAt: '2026-11-10T09:00:00.000Z' });
    expect(rows.find((r) => r.document === 'dpa')).toMatchObject({ version: '2026-10' });
  });
  it.each([
    ['tos missing', { contractAcceptance: { dpa: acc() } }, '/contract_acceptance/tos'], ['dpa missing', { contractAcceptance: { tos: acc() } }, '/contract_acceptance/dpa'],
    ['both missing', { contractAcceptance: undefined }, '/contract_acceptance'], ['empty object', { contractAcceptance: {} }, '/contract_acceptance/tos'],
    ['version > 32 chars', { contractAcceptance: { tos: acc('v'.repeat(33)), dpa: acc() } }, '/contract_acceptance/tos/version'], ['empty version', { contractAcceptance: { tos: acc(''), dpa: acc() } }, '/contract_acceptance/tos/version'],
    ['no name', { contractAcceptance: { tos: { ...acc(), acceptedByName: '' }, dpa: acc() } }, '/contract_acceptance/tos/accepted_by_name'],
    ['no title', { contractAcceptance: { tos: acc(), dpa: { ...acc(), acceptedByTitle: '' } } }, '/contract_acceptance/dpa/accepted_by_title'],
    ['bad accepted_at', { contractAcceptance: { tos: { ...acc(), acceptedAt: 'yesterday' }, dpa: acc() } }, '/contract_acceptance/tos/accepted_at'],
  ])('provisioning FAILS without both valid acceptances (%s): 400 at %s, not a single write, GoTrue untouched', async (_n, patch, path) => {
    const { svc, ctx, f, gotrue } = setup(); const e = await rejection(svc.provisionTenant(ctx, { ...PROVISION, ...patch }));
    expect(e.code).toBe('common.validation_failed'); expect(paths(e)).toContain(path); expect(writes(f)).toHaveLength(0); expect(gotrue.adminCreateUser).not.toHaveBeenCalled();
  });
  it('version exactly 32 chars is accepted', async () => {
    const { svc, ctx } = setup(); expect((await svc.provisionTenant(ctx, { ...PROVISION, contractAcceptance: { tos: acc('v'.repeat(32)), dpa: acc() } })).status).toBe(201);
  });
});

describe('isolation: provision then probe new tenant vs tenant_a (07-SECURITY; plan row T22)', () => {
  it('tenant_a data is byte-identical after provisioning; the new tenant sees none of A\'s rows and A sees none of the new tenant\'s (rows are keyed by the NEW id only)', async () => {
    const { svc, ctx, f } = setup(); const beforeA = f.snapshot(TENANT_A), beforeB = f.snapshot(TENANT_B); const id = (await svc.provisionTenant(ctx, PROVISION)).body.tenant_id;
    expect(f.snapshot(TENANT_A)).toBe(beforeA); expect(f.snapshot(TENANT_B)).toBe(beforeB);
    const mine = f.visibleTo(id), a = f.visibleTo(TENANT_A); const ids = (v: any) => JSON.stringify(v);
    for (const row of [...a.members, ...a.branches, ...a.centres, ...a.sessions]) expect(ids(mine)).not.toContain(row.id);
    expect(mine.branches).toHaveLength(1); expect(mine.centres).toHaveLength(1); expect(mine.members).toHaveLength(1); expect(ids(a)).not.toContain('KTM-01-NEW');
    for (const c of f.calls.filter((x) => x.scope !== null)) expect(c.scope).toBe(id);                  // no write ever ran under tenant A's scope
  });
});

describe('listTenants / getTenant / updateTenant (R10.4: NO withTenantScope - these are not on the D-214 list)', () => {
  it('listTenants: platform.tenant.read (support allowed); filters + page body; no scope window; no write', async () => {
    const { svc, ctx, f, scopes } = setup('active', { platformRole: 'platform_support' }); const r = await svc.listTenants(ctx, { status: 'active', sort: '-created_at', limit: 25 });
    expect(r.status).toBe(200); expect(Array.isArray(r.body.data)).toBe(true); expect(r.body.page).toBeDefined(); expect(f.by('list')[0]!.args[0]).toMatchObject({ status: 'active', sort: '-created_at' });
    expect(scopes).toEqual([]); expect(writes(f)).toHaveLength(0); expect(r.body.data.every((t: any) => Object.keys(t).every((k) => TENANT_KEYS.includes(k)))).toBe(true);
  });
  it.each([[{ status: 'deleted' }, '/status'], [{ sort: 'legal_name' }, '/sort']])('listTenants %j -> 400 at %s', async (input, path) => {
    const { svc, ctx } = setup(); expect(paths(await rejection(svc.listTenants(ctx, input)))).toEqual([path]);
  });
  it('getTenant: TenantDetail (counts, status_history, annex_readiness); unknown/garbage id -> 404; no scope window', async () => {
    const { svc, ctx, scopes } = setup(); const r = await svc.getTenant(ctx, { tenantId: TENANT_A });
    expect(r.status).toBe(200); expect(r.version).toBe(3); expect(r.body).toMatchObject({ tenant_id: TENANT_A, counts: { users: 3, branches: 1, centres: 1 }, annex_readiness: 'incomplete' }); expect(r.body.status_history.length).toBeGreaterThan(0);
    for (const id of [idN(0xdead), 'nope', undefined]) expect(await code(svc.getTenant(ctx, { tenantId: id }))).toBe('common.not_found'); expect(scopes).toEqual([]);
  });
  it('updateTenant: legal/display/billing_live_on with If-Match; version bumps; code is immutable (400 /code); unset billing_live_on; stale -> 409; missing -> 428', async () => {
    const { svc, ctx, f, scopes } = setup(); const r = await svc.updateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 3, legalName: 'Renamed Lab', billingLiveOn: '2026-12-01' });
    expect(r.status).toBe(200); expect(r.version).toBe(4); expect(r.body).toMatchObject({ legal_name: 'Renamed Lab', billing_live_on: '2026-12-01' }); expect(scopes).toEqual([]);
    expect(paths(await rejection(svc.updateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 4, code: 'other_code' })))).toEqual(['/code']);
    const u = await svc.updateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 4, unset: ['billing_live_on'] }); expect(u.body).not.toHaveProperty('billing_live_on');
    expect(await code(svc.updateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 1, legalName: 'X' }))).toBe('common.version_conflict');
    expect(await code(svc.updateTenant(ctx, { tenantId: TENANT_A, expectedVersion: undefined, legalName: 'X' }))).toBe('common.precondition_required');
    expect(f.tenant(TENANT_A)!.legal_name).toBe('Renamed Lab');
  });
  it('updateTenant mass assignment: only legalName/displayName/billingLiveOn reach the repo (no status, version, offboardedAt)', async () => {
    const { svc, ctx, f } = setup(); await svc.updateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 3, legalName: 'N', status: 'offboarded', offboardedAt: 'x', actorId: 'evil' });
    const p: any = f.by('update')[0]!.args[2]; expect(Object.keys(p).sort()).toEqual(['actorId', 'legalName']); expect(p.actorId).toBe(STAFF_USER); expect(f.tenant(TENANT_A)!.status).toBe('active');
  });
  it('updateTenant with an unknown tenant -> 404', async () => { const { svc, ctx } = setup(); expect(await code(svc.updateTenant(ctx, { tenantId: idN(0xdead), expectedVersion: 1, legalName: 'X' }))).toBe('common.not_found'); });
});

describe('activateTenant - AC-E1.3 (T2)', () => {
  it('ready (accepted admin + active branch + active centre): provisioning -> active, activated_at now, version+1, access log tenant.lifecycle_change in the tenant scope', async () => {
    const { svc, ctx, f, scopes } = setup('provisioning'); const r = await svc.activateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 3 });
    expect(r.status).toBe(200); expect(r.version).toBe(4); expect(r.body).toMatchObject({ status: 'active', activated_at: NOW.toISOString() }); expect(f.tenant(TENANT_A)!.status).toBe('active');
    expect(scopes).toEqual([TENANT_A]); expect(f.by('accessLog')[0]!.args[1]).toMatchObject({ action: 'tenant.lifecycle_change', entityType: 'tenant', entityId: TENANT_A });
  });
  it.each([['no accepted admin', { acceptedAdmins: 0 }], ['no active branch', { activeBranches: 0 }], ['no active centre', { activeCentres: 0 }]])(
    '%s -> 409 identity.tenant_not_ready; status unchanged; nothing written', async (_n, readiness) => {
      const { svc, ctx, f } = setup('provisioning', {}, {}, readiness); const e = await rejection(svc.activateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 3 }));
      expect(e.code).toBe('identity.tenant_not_ready'); expect(e.statusCode).toBe(409); expect(f.tenant(TENANT_A)!.status).toBe('provisioning'); expect(writes(f)).toHaveLength(0);
    });
  it('an INVITED-but-not-accepted admin does not count (a freshly provisioned tenant is not activatable)', async () => {
    const t = setup(); const id = (await t.svc.provisionTenant(t.ctx, PROVISION)).body.tenant_id; const c2 = makeCtx(t.f);
    expect(await code(t.svc.activateTenant(c2.ctx, { tenantId: id, expectedVersion: 1 }))).toBe('identity.tenant_not_ready');
  });
  it.each(['active', 'suspended', 'offboarded'] as const)('activating a %s tenant -> 409 common.version_conflict (only provisioning -> active, T2); nothing written', async (st) => {
    const { svc, ctx, f } = setup(st); expect(await code(svc.activateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 3 }))).toBe('common.version_conflict'); expect(writes(f)).toHaveLength(0);
  });
});

describe('suspendTenant - US-E2 (T3): sessions fail on the next request, logins refused', () => {
  const REASON = 'Synthetic non-payment of the platform fee';
  it('active -> suspended: status_reason = reason_text, suspended_at now; every ACTIVE tenant session revoked (reason tenant_suspended) in the same tx and scope', async () => {
    const { svc, ctx, f, scopes } = setup(); const r = await svc.suspendTenant(ctx, { tenantId: TENANT_A, reasonText: REASON, expectedVersion: 3 });
    expect(r.status).toBe(200); expect(r.version).toBe(4); expect(r.body).toMatchObject({ status: 'suspended', status_reason: REASON, suspended_at: NOW.toISOString() });
    expect(f.tenant(TENANT_A)!.status_reason).toBe(REASON); expect(f.data(TENANT_A).sessions.every((s) => s.state === 'revoked' && s.revoke_reason === 'tenant_suspended')).toBe(true);
    expect(f.by('revokeTenantSessions')[0]!.scope).toBe(TENANT_A); expect(scopes).toEqual([TENANT_A]);
    expect(f.data(TENANT_B).sessions.every((s) => s.state === 'active')).toBe(true);
  });
  it('sign-out fan-out: job identity.gotrue_signout per user batch of 200 (450 users -> 200/200/50), unique job keys, committed with the status change', async () => {
    const { svc, ctx, f } = setup(); const users = Array.from({ length: 450 }, (_, i) => idN(0x90000 + i)); f.repo.revokeTenantSessions = async (tx, t) => { f.calls.push({ m: 'revokeTenantSessions', tx, args: [t], scope: f.state.scope }); return users; };
    await svc.suspendTenant(ctx, { tenantId: TENANT_A, reasonText: REASON, expectedVersion: 3 });
    const j = f.jobs.filter((x) => x.identifier === 'identity.gotrue_signout'); expect(j.map((x) => x.payload.user_ids.length)).toEqual([200, 200, 50]); expect(new Set(j.map((x) => x.jobKey)).size).toBe(3);
    expect(j.every((x) => x.payload.tenant_id === TENANT_A)).toBe(true); expect(j.flatMap((x) => x.payload.user_ids).sort()).toEqual([...users].sort());
    expect(j.every((x) => x.payload.reason === 'tenant_suspended')).toBe(true);
  });
  it('access log tenant.lifecycle_change inside the scope; reason text is NOT in the log detail or any logger', async () => {
    const { svc, ctx, f, log } = setup(); await svc.suspendTenant(ctx, { tenantId: TENANT_A, reasonText: REASON, expectedVersion: 3 });
    expect(f.by('accessLog')[0]!.args[1]).toMatchObject({ action: 'tenant.lifecycle_change', entityType: 'tenant', entityId: TENANT_A }); expect(JSON.stringify(f.by('accessLog')[0]!.args[1])).not.toContain(REASON);
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain(REASON);
  });
  it.each([[{ reasonText: '' }], [{ reasonText: 'x'.repeat(501) }], [{ reasonText: undefined }], [{ reasonText: 5 }]])('invalid reason_text %j -> 400 at /reason_text; nothing written', async (patch) => {
    const { svc, ctx, f } = setup(); const e = await rejection(svc.suspendTenant(ctx, { tenantId: TENANT_A, expectedVersion: 3, ...patch })); expect(e.code).toBe('common.validation_failed'); expect(paths(e)).toEqual(['/reason_text']); expect(writes(f)).toHaveLength(0);
  });
  it.each(['provisioning', 'suspended', 'offboarded'] as const)('suspending a %s tenant -> 409 common.version_conflict; sessions untouched', async (st) => {
    const { svc, ctx, f } = setup(st); expect(await code(svc.suspendTenant(ctx, { tenantId: TENANT_A, reasonText: REASON, expectedVersion: 3 }))).toBe('common.version_conflict'); expect(f.data(TENANT_A).sessions.every((s) => s.state === 'active')).toBe(true);
  });
  it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; both with no write', async () => {
    const { svc, ctx, f } = setup(); expect(await code(svc.suspendTenant(ctx, { tenantId: TENANT_A, reasonText: REASON, expectedVersion: undefined }))).toBe('common.precondition_required');
    expect(await code(svc.suspendTenant(ctx, { tenantId: TENANT_A, reasonText: REASON, expectedVersion: 2 }))).toBe('common.version_conflict'); expect(f.data(TENANT_A).sessions.every((s) => s.state === 'active')).toBe(true);
  });
  it('reactivateTenant (T4): suspended -> active, version+1, scope + access log; any other status -> 409 common.version_conflict', async () => {
    const { svc, ctx, f, scopes } = setup('suspended'); const r = await svc.reactivateTenant(ctx, { tenantId: TENANT_A, expectedVersion: 3 });
    expect(r.body).toMatchObject({ status: 'active' }); expect(r.version).toBe(4); expect(scopes).toEqual([TENANT_A]); expect(f.by('accessLog')[0]!.args[1]).toMatchObject({ action: 'tenant.lifecycle_change' });
    for (const st of ['provisioning', 'active', 'offboarded'] as const) { const o = setup(st); expect(await code(o.svc.reactivateTenant(o.ctx, { tenantId: TENANT_A, expectedVersion: 3 }))).toBe('common.version_conflict'); }
  });
});

describe('terminateTenant - T5, 08 A8.3 / A9.5, 07-SECURITY D-T13', () => {
  const BODY = { tenantId: TENANT_A, confirmCode: 'synthetic_alpha', reasonText: 'Synthetic contract ended', expectedVersion: 3 };
  it.each(['provisioning', 'suspended'] as const)('%s -> offboarded: offboarded_at now, status_reason = reason_text, version+1', async (st) => {
    const { svc, ctx, f } = setup(st); const r = await svc.terminateTenant(ctx, BODY);
    expect(r.status).toBe(200); expect(r.version).toBe(4); expect(r.body).toMatchObject({ status: 'offboarded', offboarded_at: NOW.toISOString(), status_reason: 'Synthetic contract ended' }); expect(f.tenant(TENANT_A)!.status_reason).toBe('Synthetic contract ended');
  });
  it('D-T13: EVERY membership moved to deactivated has status deactivated, deactivated_at = now, deactivated_by = the platform staff USER (ctx.actor.id) != the identity system actor, reason_code other', async () => {
    const { svc, ctx, f } = setup('suspended'); await svc.terminateTenant(ctx, BODY); const moved = f.data(TENANT_A).members.filter((m) => m.id !== idN(0x203));
    expect(moved).toHaveLength(2); for (const m of moved) expect(m).toMatchObject({ status: 'deactivated', deactivated_at: NOW, deactivated_by: STAFF_USER, deactivation_reason_code: 'other' });
    const a: any = f.by('deactivateMemberships')[0]!.args[1]; expect(a).toMatchObject({ by: STAFF_USER, reasonCode: 'other', at: NOW }); expect(a.by).not.toBe(SYS); expect(a.by).not.toBe(ctx.platformStaffId);
    expect(f.by('deactivateMemberships')[0]!.scope).toBe(TENANT_A);
  });
  it('an already-deactivated membership keeps its original deactivated_* columns (history is not overwritten); other tenants\' memberships and sessions are untouched', async () => {
    const { svc, ctx, f } = setup('suspended'); const bBefore = f.snapshot(TENANT_B); await svc.terminateTenant(ctx, BODY);
    expect(f.data(TENANT_A).members.find((m) => m.id === idN(0x203))).toMatchObject({ deactivated_by: idN(0x9001), deactivation_reason_code: 'security_concern' }); expect(f.snapshot(TENANT_B)).toBe(bBefore);
  });
  it('all tenant sessions are revoked and the sign-out job is enqueued (suspended tenant has none active, so a provisioning/active-session case is covered by suspend); the access log is written in scope', async () => {
    const { svc, ctx, f, scopes } = setup('provisioning'); await svc.terminateTenant(ctx, BODY);
    expect(f.data(TENANT_A).sessions.every((s) => s.state === 'revoked')).toBe(true); expect(scopes).toEqual([TENANT_A]); expect(f.by('accessLog')[0]!.args[1]).toMatchObject({ action: 'tenant.lifecycle_change', entityType: 'tenant' });
    expect(f.jobs.some((j) => j.identifier === 'identity.gotrue_signout')).toBe(true);
    expect(f.jobs.filter((j) => j.identifier === 'identity.gotrue_signout').every((j) => j.payload.reason === 'deactivate')).toBe(true);
  });
  it.each([['wrong code', 'synthetic_beta'], ['empty', ''], ['upper-case', 'SYNTHETIC_ALPHA'], ['padded', ' synthetic_alpha']])('confirm_code %s -> 400 at /confirm_code; nothing written, no membership touched', async (_n, confirmCode) => {
    const { svc, ctx, f } = setup('suspended'); const e = await rejection(svc.terminateTenant(ctx, { ...BODY, confirmCode })); expect(e.code).toBe('common.validation_failed'); expect(paths(e)).toEqual(['/confirm_code']);
    expect(writes(f)).toHaveLength(0); expect(f.data(TENANT_A).members.filter((m) => m.status === 'deactivated')).toHaveLength(1);
  });
  it.each([[{ reasonText: '' }], [{ reasonText: 'x'.repeat(501) }], [{ reasonText: undefined }]])('invalid reason_text %j -> 400 at /reason_text', async (patch) => {
    const { svc, ctx } = setup('suspended'); expect(paths(await rejection(svc.terminateTenant(ctx, { ...BODY, ...patch })))).toEqual(['/reason_text']);
  });
  it.each(['active', 'offboarded'] as const)('terminating a %s tenant -> 409 common.version_conflict (T5 only from provisioning/suspended); nothing written', async (st) => {
    const { svc, ctx, f } = setup(st); expect(await code(svc.terminateTenant(ctx, BODY))).toBe('common.version_conflict'); expect(writes(f)).toHaveLength(0);
  });
  it('stale / missing If-Match -> 409 / 428 before any membership is changed', async () => {
    const { svc, ctx, f } = setup('suspended'); expect(await code(svc.terminateTenant(ctx, { ...BODY, expectedVersion: 1 }))).toBe('common.version_conflict');
    expect(await code(svc.terminateTenant(ctx, { ...BODY, expectedVersion: undefined }))).toBe('common.precondition_required'); expect(f.by('deactivateMemberships')).toHaveLength(0);
  });
});

describe('getTenantSettingsAsPlatform / updateTenantSettingsAsPlatform (D-T21, P-15)', () => {
  it('get: platform.tenant.read, 200 + ETag version; unknown tenant -> 404; no scope window', async () => {
    const { svc, ctx, scopes } = setup('active', { platformRole: 'platform_support' }); const r = await svc.getTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(await code(svc.getTenantSettingsAsPlatform(ctx, { tenantId: idN(0xdead) }))).toBe('common.not_found'); expect(scopes).toEqual([]);
  });
  it('update: writes through ONE withTenantScope(target) window, bumps version, platform-only fields (ird_pan) allowed, access log settings.change / tenant_settings', async () => {
    const { svc, ctx, f, scopes } = setup(); const r = await svc.updateTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A, expectedVersion: 2, patch: { idle_timeout_minutes: 25, ird_pan: '123456789' } });
    expect(r.status).toBe(200); expect(r.version).toBe(3); expect(scopes).toEqual([TENANT_A]); expect(f.data(TENANT_A).settings).toMatchObject({ idle_timeout_minutes: 25, ird_pan: '123456789' });
    expect(f.by('accessLog')[0]!.args[1]).toMatchObject({ action: 'settings.change', entityType: 'tenant_settings' });
  });
  it('timezone Asia/Kolkata -> 422 identity.setting_out_of_range at /timezone; nothing written (P-15)', async () => {
    const { svc, ctx, f } = setup(); const e = await rejection(svc.updateTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A, expectedVersion: 2, patch: { timezone: 'Asia/Kolkata' } }));
    expect(e.code).toBe('identity.setting_out_of_range'); expect(paths(e)).toEqual(['/timezone']); expect(writes(f)).toHaveLength(0);
  });
  it('unknown / system columns (tenant_id, version, created_by, id) -> 400 mass assignment; If-Match missing -> 428; stale -> 409', async () => {
    const { svc, ctx, f } = setup(); for (const k of ['tenant_id', 'version', 'created_by', 'id', 'nonsense']) expect((await rejection(svc.updateTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A, expectedVersion: 2, patch: { [k]: 'x' } }))).code).toBe('common.validation_failed');
    expect(await code(svc.updateTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A, expectedVersion: undefined, patch: { idle_timeout_minutes: 25 } }))).toBe('common.precondition_required');
    expect(await code(svc.updateTenantSettingsAsPlatform(ctx, { tenantId: TENANT_A, expectedVersion: 1, patch: { idle_timeout_minutes: 25 } }))).toBe('common.version_conflict'); expect(f.data(TENANT_A).settings!['version']).toBe(2); expect(f.data(TENANT_A).settings).not.toHaveProperty('nonsense');
  });
});

describe('setFeatureFlagAsPlatform - AC-C5.3 (08 A13 P-1)', () => {
  const put = (svc: any, ctx: any, o: Record<string, unknown>) => svc.setFeatureFlagAsPlatform(ctx, { tenantId: TENANT_A, flagCode: FLAG_FOUNDER, isEnabled: true, ...o });
  it('enabling a requires_founder_approval flag WITHOUT approval_ref -> 400 common.validation_failed at /approval_ref; flag unchanged', async () => {
    const { svc, ctx, f } = setup(); const e = await rejection(put(svc, ctx, {})); expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(paths(e)).toEqual(['/approval_ref']);
    expect(f.data(TENANT_A).flags.find((x) => x.code === FLAG_FOUNDER)!.is_enabled).toBe(false); expect(writes(f)).toHaveLength(0);
  });
  it.each(['', '   '])('blank approval_ref %j counts as absent', async (v) => { const { svc, ctx } = setup(); expect(paths(await rejection(put(svc, ctx, { approvalRef: v })))).toEqual(['/approval_ref']); });
  it('with approval_ref (<=200): enabled, ref stored, ONE withTenantScope(target) window, access log feature_flag.change / feature_flag', async () => {
    const { svc, ctx, f, scopes } = setup(); const r = await put(svc, ctx, { approvalRef: 'FOUNDER-APPROVAL-0042' }); expect(r.status).toBe(200);
    expect(f.data(TENANT_A).flags.find((x) => x.code === FLAG_FOUNDER)).toMatchObject({ is_enabled: true, approval_ref: 'FOUNDER-APPROVAL-0042' }); expect(scopes).toEqual([TENANT_A]);
    expect(f.by('accessLog')[0]!.args[1]).toMatchObject({ action: 'feature_flag.change', entityType: 'feature_flag' });
  });
  it('approval_ref of 201 chars -> 400 at /approval_ref; a flag WITHOUT the founder requirement enables without one; DISABLING never needs one', async () => {
    const { svc, ctx, f } = setup(); expect(paths(await rejection(put(svc, ctx, { approvalRef: 'x'.repeat(201) })))).toEqual(['/approval_ref']);
    expect((await put(svc, ctx, { flagCode: FLAG_PLAIN })).status).toBe(200); f.data(TENANT_A).flags.find((x) => x.code === FLAG_FOUNDER)!.is_enabled = true;
    expect((await put(svc, ctx, { isEnabled: false })).status).toBe(200); expect(f.data(TENANT_A).flags.find((x) => x.code === FLAG_FOUNDER)!.is_enabled).toBe(false);
  });
  it.each([[{ isEnabled: 'true' }, '/is_enabled'], [{ isEnabled: undefined }, '/is_enabled'], [{ flagCode: 'Bad Code!' }, '/flag_code']])('invalid input %j -> 400 at %s', async (patch, path) => {
    const { svc, ctx } = setup(); expect(paths(await rejection(put(svc, ctx, { approvalRef: 'A-1', ...patch })))).toEqual([path]);
  });
  it('unknown flag / unknown tenant -> 404 common.not_found', async () => {
    const { svc, ctx } = setup(); expect(await code(put(svc, ctx, { flagCode: 'no_such_flag', approvalRef: 'A-1' }))).toBe('common.not_found'); expect(await code(put(svc, ctx, { tenantId: idN(0xdead), approvalRef: 'A-1' }))).toBe('common.not_found');
  });
});

describe('inviteTenantAdmin (M1)', () => {
  const IN = { tenantId: TENANT_A, email: ' New.Admin@Alpha.Example.test ', displayName: 'New Admin' };
  it('201 TenantAdminInvitation {membership_id, invitation{status, expires_at}}: invited tenant_admin membership, invitation, send_invitation job, access log - all in ONE scope window of the target tenant', async () => {
    const { svc, ctx, f, scopes, gotrue } = setup(); const r = await svc.inviteTenantAdmin(ctx, IN);
    expect(r.status).toBe(201); expect(Object.keys(r.body).sort()).toEqual(['invitation', 'membership_id']); expect(['pending', 'sent']).toContain(r.body.invitation.status); expect(r.body.invitation.expires_at).toMatch(/Z$/); expect(hasNull(r.body)).toBe(false);
    expect(scopes).toEqual([TENANT_A]); expect(gotrue.calls).toEqual([{ email: 'new.admin@alpha.example.test', emailConfirm: false }]); expect(f.by('insertAdmin')[0]!.args[1]).toMatchObject({ emailNormalized: 'new.admin@alpha.example.test', membershipId: r.body.membership_id });
    expect(f.jobs[0]).toMatchObject({ identifier: 'identity.send_invitation' }); expect(f.by('accessLog')[0]!.args[1]).toMatchObject({ action: 'tenant.lifecycle_change', entityType: 'tenant', entityId: TENANT_A });
  });
  it('existing core user -> 409 identity.user_exists, nothing written; invalid email / name -> 400; unknown tenant -> 404', async () => {
    const f = makeRepo(); const c = makeCtx(f); const svc = createTenantService({ repo: f.repo, gotrue: makeGotrue(f, { 'new.admin@alpha.example.test': idN(0x7003) }), emailHmac: HMAC, userExists: async () => true, newId: nextId } as never) as any;
    expect(await code(svc.inviteTenantAdmin(c.ctx, IN))).toBe('identity.user_exists'); expect(writes(f)).toHaveLength(0);
    const o = setup(); expect(paths(await rejection(o.svc.inviteTenantAdmin(o.ctx, { ...IN, email: 'nope' })))).toEqual(['/email']); expect(paths(await rejection(o.svc.inviteTenantAdmin(o.ctx, { ...IN, displayName: '' })))).toEqual(['/display_name']);
    expect(await code(o.svc.inviteTenantAdmin(o.ctx, { ...IN, tenantId: idN(0xdead) }))).toBe('common.not_found'); expect(writes(o.f)).toHaveLength(0);
  });
});

describe('authz: PlatformAuthz.assertPlatform runs FIRST in every op (platform.tenant.read / platform.tenant.manage, aal2)', () => {
  const OPS: Array<[string, Record<string, unknown>, 'read' | 'manage']> = [
    ['listTenants', {}, 'read'], ['getTenant', { tenantId: TENANT_A }, 'read'], ['getTenantSettingsAsPlatform', { tenantId: TENANT_A }, 'read'],
    ['provisionTenant', PROVISION, 'manage'], ['updateTenant', { tenantId: TENANT_A, expectedVersion: 3, legalName: 'X' }, 'manage'], ['activateTenant', { tenantId: TENANT_A, expectedVersion: 3 }, 'manage'],
    ['suspendTenant', { tenantId: TENANT_A, expectedVersion: 3, reasonText: 'r' }, 'manage'], ['reactivateTenant', { tenantId: TENANT_A, expectedVersion: 3 }, 'manage'],
    ['terminateTenant', { tenantId: TENANT_A, expectedVersion: 3, confirmCode: 'synthetic_alpha', reasonText: 'r' }, 'manage'],
    ['updateTenantSettingsAsPlatform', { tenantId: TENANT_A, expectedVersion: 2, patch: { idle_timeout_minutes: 45 } }, 'manage'],
    ['setFeatureFlagAsPlatform', { tenantId: TENANT_A, flagCode: FLAG_PLAIN, isEnabled: true }, 'manage'], ['inviteTenantAdmin', { tenantId: TENANT_A, email: 'a@b.example.test', displayName: 'A' }, 'manage'],
  ];
  it.each(OPS.filter((o) => o[2] === 'manage'))('%s: platform_support -> 403 auth.forbidden, aal1 superadmin -> auth.mfa_required; no repo / GoTrue call', async (op, input) => {
    const s = setup('active', { platformRole: 'platform_support' }); expect(await code(s.svc[op](s.ctx, input))).toBe('auth.forbidden'); expect(s.f.calls).toHaveLength(0); expect(s.gotrue.adminCreateUser).not.toHaveBeenCalled();
    const a = setup('active', { aal: 'aal1' }); expect(await code(a.svc[op](a.ctx, input))).toBe('auth.mfa_required'); expect(a.f.calls).toHaveLength(0);
  });
  it.each(OPS.filter((o) => o[2] === 'read'))('%s: platform_support may read; a non-platform role / no role -> 403 auth.forbidden', async (op, input) => {
    const s = setup('active', { platformRole: 'platform_support' }); await s.svc[op](s.ctx, input);
    for (const role of ['tenant_admin', undefined]) { const o = setup('active', { platformRole: role }); expect(await code(o.svc[op](o.ctx, input))).toBe('auth.forbidden'); expect(o.f.calls).toHaveLength(0); }
  });
});

describe('D-214: withTenantScope is used ONLY by the allowlisted operations', () => {
  it.each([['listTenants', {}], ['getTenant', { tenantId: TENANT_A }], ['updateTenant', { tenantId: TENANT_A, expectedVersion: 3, legalName: 'X' }], ['getTenantSettingsAsPlatform', { tenantId: TENANT_A }]])(
    '%s never opens a tenant scope and never runs a scoped repo method', async (op, input) => {
      const { svc, ctx, f, withTenantScope } = setup(); await svc[op as string](ctx, input); expect(withTenantScope).not.toHaveBeenCalled(); expect(f.calls.every((c) => c.scope === null)).toBe(true);
    });
});
