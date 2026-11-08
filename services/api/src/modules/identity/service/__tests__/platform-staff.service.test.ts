// T25 platform staff / platform sessions / platform auth events (01-PRD US-E6; 02-TRD s5.10, s10; 07-SECURITY REQ-SEC-063, A-9; 05-SCHEMA s4.10).
// Behaviour of ../platform-staff.service.ts against the in-memory repo of platform-staff.helpers.ts (seams documented in its header). No live DB.
import { describe, expect, it } from 'vitest';
import { createClaimsResolver } from '../../claims/resolver.js';
import { NOW as RNOW, fakeDb, jwt, platformRow, req as rreq } from '../../claims/__tests__/helpers.js';
import { createPlatformStaffService } from '../platform-staff.service.js';
import {
  NOW, PSESSION, SECRET, STAFF_ID, STAFF_USER, SUPPORT, authRow, idN, makeCtx, makeGotrue, makeRepo, meRow, nextId, rejection, sessRow, staffRow, type FakeRepo,
} from './platform-staff.helpers.js';

const TENANT = idN(0xc1);
/** The real T4 resolver fed a platform session row carrying the allowlist the T25 service stored. */
const claimsResolver = async (cidrs: string[], clientIp: string): Promise<any> =>
  createClaimsResolver({ db: fakeDb([platformRow({ platform_role: 'platform_superadmin', platform_allowed_cidrs: cidrs })]).db as never, now: () => RNOW }).resolve(jwt() as never, rreq({ clientIp }) as never);

function setup(seed: Parameters<typeof makeRepo>[0] = {}, ctxOver: Record<string, unknown> = {}, g: Parameters<typeof makeGotrue>[0] = {}) {
  const f = makeRepo(seed); const c = makeCtx(ctxOver); const { gotrue, created } = makeGotrue(g);
  const svc = createPlatformStaffService({ repo: f.repo as any, gotrue: gotrue as any, platformEvents: c.platformEvents, newId: nextId });
  return { svc, f, ...c, gotrue, created };
}
const INVITE = { email: 'New.Support@Example.test', displayName: 'New Support', roleCode: 'platform_support', allowedCidrs: ['10.0.0.0/8'] };
const S2 = staffRow(2), S3 = staffRow(3, { role_code: 'platform_superadmin' });
const noSideEffects = (s: ReturnType<typeof setup>) => {
  expect(s.f.calls.filter((c) => !['listStaff', 'findStaff', 'findStaffByEmail', 'lockActiveSuperadmins', 'findSession', 'listPlatformSessions', 'listAuthEvents'].includes(c.m))).toEqual([]);
  expect(s.events).toEqual([]); expect(s.gotrue.adminCreateUser).not.toHaveBeenCalled();
};

describe('authz: PlatformAuthz inside the service, before any repo / GoTrue call', () => {
  const OPS: Array<[string, (s: ReturnType<typeof setup>) => Promise<unknown>]> = [
    ['listPlatformStaff', (s) => s.svc.listPlatformStaff(s.ctx, {})],
    ['invitePlatformStaff', (s) => s.svc.invitePlatformStaff(s.ctx, INVITE)],
    ['updatePlatformStaff', (s) => s.svc.updatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 1, displayName: 'X' })],
    ['deactivatePlatformStaff', (s) => s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 1 })],
    ['resetPlatformStaffMfa', (s) => s.svc.resetPlatformStaffMfa(s.ctx, { platformStaffId: S2.id })],
    ['listPlatformSessions', (s) => s.svc.listPlatformSessions(s.ctx, {})],
    ['revokePlatformSession', (s) => s.svc.revokePlatformSession(s.ctx, { sessionId: idN(0x7001) })],
  ];
  it.each(OPS)('%s: platform_support -> auth.forbidden, nothing touched (platform.staff.manage is superadmin-only)', async (_n, run) => {
    const s = setup({ staff: [meRow(), S2] }, SUPPORT);
    expect((await rejection(() => run(s))).code).toBe('auth.forbidden');
    expect(s.f.calls).toEqual([]); expect(s.events).toEqual([]); expect(s.gotrue.adminCreateUser).not.toHaveBeenCalled();
  });
  it.each(OPS)('%s: a tenant actor / missing platform role -> auth.forbidden', async (_n, run) => {
    for (const o of [{ actor: { type: 'user', id: STAFF_USER }, platformRole: undefined }, { actor: { type: 'system', id: STAFF_USER } }]) {
      const s = setup({ staff: [meRow(), S2] }, o);
      expect((await rejection(() => run(s))).code).toBe('auth.forbidden'); expect(s.f.calls).toEqual([]);
    }
  });
  it('listPlatformAuthEvents needs only platform.tenant.read: support may read, a role-less actor may not', async () => {
    const q = { occurred_at_from: '2026-11-01T00:00:00.000Z', occurred_at_to: '2026-11-08T00:00:00.000Z' };
    const ok = setup({ auth: [authRow(1)] }, SUPPORT); expect((await ok.svc.listPlatformAuthEvents(ok.ctx, q)).status).toBe(200);
    const no = setup({ auth: [authRow(1)] }, { platformRole: 'tenant_admin' });
    expect((await rejection(() => no.svc.listPlatformAuthEvents(no.ctx, q))).code).toBe('auth.forbidden'); expect(no.f.calls).toEqual([]);
  });
});

describe('listPlatformStaff', () => {
  it('200 { data: PlatformStaff[] }: email masked, no raw email / user_id / audit columns, nulls omitted', async () => {
    const s = setup({ staff: [meRow(), staffRow(2, { email_normalized: 'demo.support@example.test', allowed_cidrs: ['10.0.0.0/8'], last_login_at: NOW, version: 4 })] });
    const r = await s.svc.listPlatformStaff(s.ctx, {});
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
    const two = r.body.data.find((x: any) => x.platform_staff_id === idN(0x5002));
    expect(two).toEqual({ platform_staff_id: idN(0x5002), display_name: 'Demo Staff 2', email_masked: 'd***@e***', role_code: 'platform_support', allowed_cidrs: ['10.0.0.0/8'], is_active: true, last_login_at: NOW.toISOString(), version: 4 });
    const me = r.body.data.find((x: any) => x.platform_staff_id === STAFF_ID); expect(Object.keys(me)).not.toContain('last_login_at');
    const wire = JSON.stringify(r.body);
    for (const leak of ['example.test', idN(0x6002), STAFF_USER, 'email_normalized', 'user_id', 'created_by', 'null']) expect(wire).not.toContain(leak);
  });
});

describe('invitePlatformStaff (US-E6 / REQ-SEC-063)', () => {
  it('201 PlatformStaff v1 active; GoTrue user, staff row, pending invitation, send_invitation job and platform_staff_invited event all on the request tx', async () => {
    const s = setup();
    const r = await s.svc.invitePlatformStaff(s.ctx, INVITE);
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ display_name: 'New Support', role_code: 'platform_support', allowed_cidrs: ['10.0.0.0/8'], is_active: true, version: 1, email_masked: 'n***@e***' });
    expect(JSON.stringify(r.body)).not.toMatch(/example\.test|user_id/);
    expect(s.created).toEqual([expect.objectContaining({ email: 'new.support@example.test' })]);            // normalised: lower(btrim)
    const ins = s.f.by('insertStaff')[0]!; expect(ins.tx).toBe(s.tx);
    expect(ins.args[0]).toMatchObject({ emailNormalized: 'new.support@example.test', roleCode: 'platform_support', allowedCidrs: ['10.0.0.0/8'], actorId: STAFF_USER });
    const staffId = (ins.args[0] as any).id; expect(r.body.platform_staff_id).toBe(staffId);
    expect(s.f.invitations).toEqual([expect.objectContaining({ platformStaffId: staffId, email: 'new.support@example.test', actorId: STAFF_USER })]);
    expect(s.f.invitations[0]!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(s.f.jobs).toEqual([{ identifier: 'identity.send_invitation', payload: expect.objectContaining({ invitation_id: s.f.invitations[0]!.id }), jobKey: `invite:${s.f.invitations[0]!.id}:1` }]);
    expect(s.events).toEqual([expect.objectContaining({ eventType: 'platform_staff_invited', targetType: 'platform_staff', targetId: staffId, targetTenantId: null, actorPlatformStaffId: STAFF_ID, requestId: expect.any(String) })]);
    expect(JSON.stringify(s.events)).not.toMatch(/example\.test/);                                          // no PII in platform_events.detail
  });
  it('allowed_cidrs omitted -> [] (no restriction); a superadmin invite is allowed', async () => {
    const s = setup(); const r = await s.svc.invitePlatformStaff(s.ctx, { ...INVITE, roleCode: 'platform_superadmin', allowedCidrs: undefined });
    expect(r.body).toMatchObject({ role_code: 'platform_superadmin', allowed_cidrs: [] });
  });
  it('an email already on a staff row (any case) -> 409 identity.user_exists; GoTrue and writes untouched', async () => {
    for (const email of ['demo.support@example.test', 'DEMO.Support@EXAMPLE.test']) {
      const s = setup({ staff: [meRow(), staffRow(2, { email_normalized: 'demo.support@example.test' })] });
      const e = await rejection(() => s.svc.invitePlatformStaff(s.ctx, { ...INVITE, email }));
      expect(e.code).toBe('identity.user_exists'); noSideEffects(s);
    }
  });
  it('an email GoTrue already knows (e.g. a tenant user) -> 409 identity.user_exists, no staff row, invitation, job or event', async () => {
    const s = setup({}, {}, { existing: new Set(['new.support@example.test']) });
    expect((await rejection(() => s.svc.invitePlatformStaff(s.ctx, INVITE))).code).toBe('identity.user_exists');
    expect(s.f.by('insertStaff')).toEqual([]); expect(s.f.invitations).toEqual([]); expect(s.f.jobs).toEqual([]); expect(s.events).toEqual([]);
  });
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['email not an email', { email: 'not-an-email' }, '/email'], ['email too long', { email: `${'a'.repeat(250)}@x.test` }, '/email'], ['email missing', { email: undefined }, '/email'],
    ['display_name empty', { displayName: '' }, '/display_name'], ['display_name 121', { displayName: 'x'.repeat(121) }, '/display_name'],
    ['role_code outside enum', { roleCode: 'tenant_admin' }, '/role_code'], ['role_code missing', { roleCode: undefined }, '/role_code'],
    ['21 cidrs', { allowedCidrs: Array.from({ length: 21 }, (_, i) => `10.${i}.0.0/16`) }, '/allowed_cidrs'],
    ['cidr with host bits set (pg cidr would reject)', { allowedCidrs: ['10.0.0.1/8'] }, '/allowed_cidrs'], ['cidr prefix 33', { allowedCidrs: ['10.0.0.0/33'] }, '/allowed_cidrs'],
    ['cidr without prefix', { allowedCidrs: ['10.0.0.0'] }, '/allowed_cidrs'], ['cidr junk', { allowedCidrs: ['abc/8'] }, '/allowed_cidrs'], ['cidr octet 999', { allowedCidrs: ['999.0.0.0/8'] }, '/allowed_cidrs'],
    ['cidr list not an array', { allowedCidrs: '10.0.0.0/8' }, '/allowed_cidrs'], ['cidr item not a string', { allowedCidrs: [10] }, '/allowed_cidrs'],
  ];
  it.each(bad)('400 common.validation_failed: %s -> field %s, no side effects', async (_n, o, path) => {
    const s = setup(); const e = await rejection(() => s.svc.invitePlatformStaff(s.ctx, { ...INVITE, ...o }));
    expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors)).toContain(path); noSideEffects(s);
  });
  it('valid CIDR forms are accepted: v4 /32 and /0-free nets, v6 prefixes', async () => {
    const s = setup(); const cidrs = ['192.0.2.8/32', '198.51.100.0/24', '2001:db8::/32', '::1/128'];
    expect((await s.svc.invitePlatformStaff(s.ctx, { ...INVITE, allowedCidrs: cidrs })).body.allowed_cidrs).toEqual(cidrs);
  });
});

describe('updatePlatformStaff', () => {
  const U = (o: Record<string, unknown> = {}) => ({ platformStaffId: S2.id, expectedVersion: 1, ...o });
  it('200 + new version: display_name, role_code and allowed_cidrs persisted; platform_staff_changed names the changed fields only', async () => {
    const s = setup({ staff: [meRow(), S2] });
    const r = await s.svc.updatePlatformStaff(s.ctx, U({ displayName: 'Renamed', allowedCidrs: ['10.0.0.0/8', '192.0.2.0/24'] }));
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ platform_staff_id: S2.id, display_name: 'Renamed', allowed_cidrs: ['10.0.0.0/8', '192.0.2.0/24'], role_code: 'platform_support', version: 2 });
    expect(s.f.by('updateStaff')[0]!.args[2]).toMatchObject({ displayName: 'Renamed', allowedCidrs: ['10.0.0.0/8', '192.0.2.0/24'], actorId: STAFF_USER });
    expect(s.events).toEqual([expect.objectContaining({ eventType: 'platform_staff_changed', targetId: S2.id, actorPlatformStaffId: STAFF_ID, detail: { changed: expect.arrayContaining(['display_name', 'allowed_cidrs']) } })]);
    expect(s.events[0].detail.changed).not.toContain('role_code'); expect(JSON.stringify(s.events)).not.toContain('10.0.0.0');   // values are not copied into the event
  });
  it('allowed_cidrs [] clears the allowlist; promoting support -> superadmin needs no last-admin check', async () => {
    const s = setup({ staff: [meRow(), staffRow(2, { allowed_cidrs: ['10.0.0.0/8'] })] });
    expect((await s.svc.updatePlatformStaff(s.ctx, U({ allowedCidrs: [] }))).body.allowed_cidrs).toEqual([]);
    expect((await s.svc.updatePlatformStaff(s.ctx, U({ expectedVersion: 2, roleCode: 'platform_superadmin' }))).body.role_code).toBe('platform_superadmin');
  });
  it('If-Match missing -> 428 common.precondition_required; stale -> 409 common.version_conflict (row unchanged, no event); malformed version -> 400', async () => {
    const s = setup({ staff: [meRow(), S2] });
    expect((await rejection(() => s.svc.updatePlatformStaff(s.ctx, U({ expectedVersion: undefined, displayName: 'X' })))).code).toBe('common.precondition_required');
    expect((await rejection(() => s.svc.updatePlatformStaff(s.ctx, U({ expectedVersion: 7, displayName: 'X' })))).code).toBe('common.version_conflict');
    for (const v of [0, -1, 1.5, '1', NaN, 2 ** 31]) expect((await rejection(() => s.svc.updatePlatformStaff(s.ctx, U({ expectedVersion: v, displayName: 'X' })))).code).toBe('common.validation_failed');
    expect(s.f.row(S2.id)).toMatchObject({ display_name: 'Demo Staff 2', version: 1 }); expect(s.events).toEqual([]);
  });
  it('unknown / non-uuid id -> 404 common.not_found; empty patch -> 400; invalid fields -> 400 with the row untouched', async () => {
    const s = setup({ staff: [meRow(), S2] });
    for (const id of [idN(0xdead), 'not-a-uuid', '']) expect((await rejection(() => s.svc.updatePlatformStaff(s.ctx, U({ platformStaffId: id, displayName: 'X' })))).code).toBe('common.not_found');
    for (const patch of [{}, { displayName: '' }, { displayName: 'x'.repeat(121) }, { roleCode: 'root' }, { allowedCidrs: ['10.0.0.1/8'] }, { allowedCidrs: null }])
      expect((await rejection(() => s.svc.updatePlatformStaff(s.ctx, U(patch)))).code).toBe('common.validation_failed');
    expect(s.f.by('updateStaff')).toEqual([]); expect(s.events).toEqual([]);
  });
  it('mass assignment: is_active / version / user_id / email in the input are ignored (deactivation has its own operation)', async () => {
    const s = setup({ staff: [meRow(), S2] });
    await s.svc.updatePlatformStaff(s.ctx, U({ displayName: 'Ok', isActive: false, version: 99, userId: idN(1), emailNormalized: 'evil@example.test', email: 'evil@example.test' }));
    expect(s.f.by('updateStaff')[0]!.args[2]).not.toHaveProperty('isActive'); expect(s.f.row(S2.id)).toMatchObject({ is_active: true, email_normalized: 'staff2@example.test', user_id: idN(0x6002) });
  });
});

describe('last active superadmin is protected (done_when; 02-TRD s5.10 identity.last_admin_protected)', () => {
  it('demoting the only active superadmin (self) -> 409 identity.last_admin_protected, row and events untouched', async () => {
    const s = setup({ staff: [meRow(), S2] });
    const e = await rejection(() => s.svc.updatePlatformStaff(s.ctx, { platformStaffId: STAFF_ID, expectedVersion: 1, roleCode: 'platform_support' }));
    expect(e.code).toBe('identity.last_admin_protected'); expect(s.f.row(STAFF_ID)).toMatchObject({ role_code: 'platform_superadmin', version: 1 });
    expect(s.f.by('updateStaff')).toEqual([]); expect(s.events).toEqual([]);
  });
  it('with a second ACTIVE superadmin the demotion is allowed; an inactive superadmin does not count', async () => {
    const ok = setup({ staff: [meRow(), S3] });
    expect((await ok.svc.updatePlatformStaff(ok.ctx, { platformStaffId: STAFF_ID, expectedVersion: 1, roleCode: 'platform_support' })).status).toBe(200);
    const no = setup({ staff: [meRow(), staffRow(3, { role_code: 'platform_superadmin', is_active: false })] });
    expect((await rejection(() => no.svc.updatePlatformStaff(no.ctx, { platformStaffId: STAFF_ID, expectedVersion: 1, roleCode: 'platform_support' }))).code).toBe('identity.last_admin_protected');
  });
  it('two superadmins: the first demotion succeeds, the second (the new last one) is refused', async () => {
    const s = setup({ staff: [meRow(), S3] });
    await s.svc.updatePlatformStaff(s.ctx, { platformStaffId: S3.id, expectedVersion: 1, roleCode: 'platform_support' });
    expect((await rejection(() => s.svc.updatePlatformStaff(s.ctx, { platformStaffId: STAFF_ID, expectedVersion: 1, roleCode: 'platform_support' }))).code).toBe('identity.last_admin_protected');
  });
  it('deactivating the only active superadmin (stale actor, B already deactivated by A) -> 409 identity.last_admin_protected', async () => {
    const s = setup({ staff: [meRow({ is_active: false }), S3] });                        // ctx = a stale claims set of the already-deactivated me
    const e = await rejection(() => s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S3.id, expectedVersion: 1 }));
    expect(e.code).toBe('identity.last_admin_protected'); expect(s.f.row(S3.id).is_active).toBe(true); expect(s.events).toEqual([]); expect(s.f.jobs).toEqual([]);
  });
  it('race safety: the superadmin set is locked (FOR UPDATE) in the request tx BEFORE the write that could remove one', async () => {
    const s = setup({ staff: [meRow(), S3] });
    await s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S3.id, expectedVersion: 1 });
    expect(s.f.by('lockActiveSuperadmins')[0]!.tx).toBe(s.tx);
    expect(s.f.order.indexOf('lockActiveSuperadmins')).toBeGreaterThanOrEqual(0); expect(s.f.order.indexOf('lockActiveSuperadmins')).toBeLessThan(s.f.order.indexOf('updateStaff'));
    const d = setup({ staff: [meRow(), S3] });
    await d.svc.updatePlatformStaff(d.ctx, { platformStaffId: S3.id, expectedVersion: 1, roleCode: 'platform_support' });
    expect(d.f.order.indexOf('lockActiveSuperadmins')).toBeLessThan(d.f.order.indexOf('updateStaff'));
  });
  it('changes to a non-superadmin never trip the guard', async () => {
    const s = setup({ staff: [meRow(), S2] });
    expect((await s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 1 })).status).toBe(200);
  });
});

describe('deactivatePlatformStaff', () => {
  it('200 is_active=false + new version; platform_staff_deactivated event; gotrue_signout job carries ONLY the user id (platform kind)', async () => {
    const s = setup({ staff: [meRow(), S2] });
    const r = await s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 1 });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ platform_staff_id: S2.id, is_active: false, version: 2 });
    expect(s.f.by('updateStaff')[0]!.args[2]).toMatchObject({ isActive: false, actorId: STAFF_USER });
    expect(s.events).toEqual([expect.objectContaining({ eventType: 'platform_staff_deactivated', targetId: S2.id, actorPlatformStaffId: STAFF_ID })]);
    expect(s.f.jobs).toEqual([{ identifier: 'identity.gotrue_signout', payload: { user_id: S2.user_id }, jobKey: expect.any(String) }]);
  });
  it('own account -> 409 identity.self_action_forbidden even when other superadmins exist; nothing written', async () => {
    const s = setup({ staff: [meRow(), S3] });
    expect((await rejection(() => s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: STAFF_ID, expectedVersion: 1 }))).code).toBe('identity.self_action_forbidden');
    expect(s.f.by('updateStaff')).toEqual([]); expect(s.events).toEqual([]); expect(s.f.jobs).toEqual([]);
  });
  it('If-Match missing -> 428; stale -> 409 common.version_conflict; unknown / non-uuid id -> 404', async () => {
    const s = setup({ staff: [meRow(), S2] });
    expect((await rejection(() => s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: undefined }))).code).toBe('common.precondition_required');
    expect((await rejection(() => s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 5 }))).code).toBe('common.version_conflict');
    for (const id of [idN(0xdead), 'zzz']) expect((await rejection(() => s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: id, expectedVersion: 1 }))).code).toBe('common.not_found');
    expect(s.f.row(S2.id).is_active).toBe(true); expect(s.f.jobs).toEqual([]);
  });
  // review item 1 (03-APP-FLOW s1 SS9): deactivate revokes every non-terminal platform session of the member in the same tx, before the signout job.
  it('revokes every non-terminal platform session of the member (reason deactivate) before the gotrue_signout job; other staff sessions untouched', async () => {
    const s = setup({ staff: [meRow(), S2, staffRow(3)], sessions: [sessRow(2), sessRow(2, { id: idN(0x7102), state: 'revoked' }), sessRow(3)] });
    await s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 1 });
    const c = s.f.by('revokeStaffSessions'); expect(c).toHaveLength(1);
    expect(c[0]!.tx).toBe(s.tx); expect(c[0]!.args[0]).toEqual({ platformStaffId: S2.id, reason: 'deactivate', at: NOW, actorId: STAFF_USER });
    expect(s.f.order.indexOf('revokeStaffSessions')).toBeGreaterThan(s.f.order.indexOf('updateStaff')); expect(s.f.order.indexOf('revokeStaffSessions')).toBeLessThan(s.f.order.indexOf('enqueue'));
    expect(s.f.sessions.find((x) => x.id === idN(0x7002))!.state).toBe('revoked'); expect(s.f.sessions.find((x) => x.id === idN(0x7003))!.state).toBe('active');
  });
  it('no session revoke on the 403 / 409 / 428 / 404 paths', async () => {
    const f = { staff: [meRow(), S2, S3], sessions: [sessRow(2)] };
    const a = setup(f, SUPPORT); await rejection(() => a.svc.deactivatePlatformStaff(a.ctx, { platformStaffId: S2.id, expectedVersion: 1 }));
    const b = setup({ staff: [meRow()], sessions: [sessRow(0)] }); await rejection(() => b.svc.deactivatePlatformStaff(b.ctx, { platformStaffId: STAFF_ID, expectedVersion: 1 }));
    const c = setup({ staff: [meRow({ is_active: false }), S3], sessions: [sessRow(3)] }); await rejection(() => c.svc.deactivatePlatformStaff(c.ctx, { platformStaffId: S3.id, expectedVersion: 1 }));
    const d = setup(f); await rejection(() => d.svc.deactivatePlatformStaff(d.ctx, { platformStaffId: S2.id, expectedVersion: 9 }));
    await rejection(() => d.svc.deactivatePlatformStaff(d.ctx, { platformStaffId: S2.id, expectedVersion: undefined })); await rejection(() => d.svc.deactivatePlatformStaff(d.ctx, { platformStaffId: idN(0xdead), expectedVersion: 1 }));
    for (const x of [a, b, c, d]) expect(x.f.by('revokeStaffSessions')).toEqual([]);
    expect(c.f.sessions[0]!.state).toBe('active');
  });
});

describe('resetPlatformStaffMfa', () => {
  it('200 PlatformStaff; identity.remove_mfa_factors enqueued with job_key mfa_reset:<staff id>:<version>; platform_mfa_reset event', async () => {
    const s = setup({ staff: [meRow(), S2] });
    const r = await s.svc.resetPlatformStaffMfa(s.ctx, { platformStaffId: S2.id });
    expect(r.status).toBe(200); expect(r.body.platform_staff_id).toBe(S2.id);
    expect(s.f.jobs).toEqual([{ identifier: 'identity.remove_mfa_factors', payload: expect.objectContaining({ user_id: S2.user_id }), jobKey: expect.stringMatching(new RegExp(`^mfa_reset:${S2.id}:\\d+$`)) }]);
    expect(s.events).toEqual([expect.objectContaining({ eventType: 'platform_mfa_reset', targetId: S2.id, actorPlatformStaffId: STAFF_ID })]);
  });
  it('two resets give two distinct job keys (the version moves, so the second is not swallowed by job_key dedup)', async () => {
    const s = setup({ staff: [meRow(), S2] });
    await s.svc.resetPlatformStaffMfa(s.ctx, { platformStaffId: S2.id }); await s.svc.resetPlatformStaffMfa(s.ctx, { platformStaffId: S2.id });
    expect(new Set(s.f.jobs.map((j) => j.jobKey)).size).toBe(2);
  });
  it('own account -> 409 identity.self_action_forbidden; unknown / non-uuid id -> 404; no job, no event', async () => {
    const s = setup({ staff: [meRow(), S2] });
    expect((await rejection(() => s.svc.resetPlatformStaffMfa(s.ctx, { platformStaffId: STAFF_ID }))).code).toBe('identity.self_action_forbidden');
    for (const id of [idN(0xdead), 'zzz']) expect((await rejection(() => s.svc.resetPlatformStaffMfa(s.ctx, { platformStaffId: id }))).code).toBe('common.not_found');
    expect(s.f.jobs).toEqual([]); expect(s.events).toEqual([]);
  });
  // review item 2 (03-APP-FLOW s4.5, SS9): the mirror is authoritative - factors go to removed and sessions are revoked immediately, in the same tx, before the job.
  it('marks the mirror factors removed (admin_reset) and revokes the member\'s sessions (reason mfa_reset) in the request tx, before the job and the event', async () => {
    const s = setup({ staff: [meRow(), S2, staffRow(3)], sessions: [sessRow(2), sessRow(3)], mfa: [{ user_id: S2.user_id, status: 'verified' }, { user_id: S2.user_id, status: 'removed' }, { user_id: staffRow(3).user_id, status: 'verified' }] });
    await s.svc.resetPlatformStaffMfa(s.ctx, { platformStaffId: S2.id });
    const m = s.f.by('removeStaffMfaFactors'), r = s.f.by('revokeStaffSessions'); expect(m).toHaveLength(1); expect(r).toHaveLength(1);
    expect(m[0]!.tx).toBe(s.tx); expect(m[0]!.args[0]).toEqual({ userId: S2.user_id, actorId: STAFF_USER });
    expect(r[0]!.tx).toBe(s.tx); expect(r[0]!.args[0]).toEqual({ platformStaffId: S2.id, reason: 'mfa_reset', at: NOW, actorId: STAFF_USER });
    expect(s.f.order.indexOf('removeStaffMfaFactors')).toBeLessThan(s.f.order.indexOf('enqueue')); expect(s.f.order.indexOf('revokeStaffSessions')).toBeLessThan(s.f.order.indexOf('enqueue'));
    expect(s.f.mfa.map((x) => x.status)).toEqual(['removed', 'removed', 'verified']);
    expect(s.f.sessions.map((x) => x.state)).toEqual(['revoked', 'active']);
    expect(s.f.jobs).toHaveLength(1); expect(s.events).toHaveLength(1);
  });
  it('403 / self / unknown id: no mirror change, no session revoke', async () => {
    const seed = { staff: [meRow(), S2], sessions: [sessRow(2), sessRow(0)], mfa: [{ user_id: S2.user_id, status: 'verified' }] };
    const a = setup(seed, SUPPORT); await rejection(() => a.svc.resetPlatformStaffMfa(a.ctx, { platformStaffId: S2.id }));
    const b = setup(seed); await rejection(() => b.svc.resetPlatformStaffMfa(b.ctx, { platformStaffId: STAFF_ID })); await rejection(() => b.svc.resetPlatformStaffMfa(b.ctx, { platformStaffId: idN(0xdead) }));
    for (const x of [a, b]) { expect(x.f.by('removeStaffMfaFactors')).toEqual([]); expect(x.f.by('revokeStaffSessions')).toEqual([]); expect(x.f.mfa[0]!.status).toBe('verified'); }
  });
});

describe('platform sessions', () => {
  it('listPlatformSessions: SessionSummaryList of platform-kind rows only; no token / key / gotrue columns, IP masked, nulls omitted', async () => {
    const s = setup({ sessions: [sessRow(1), sessRow(2, { support_session_id: idN(0x1234) }), sessRow(3, { kind: 'tenant_staff', platform_staff_id: null })] });
    const r = await s.svc.listPlatformSessions(s.ctx, {});
    expect(r.status).toBe(200); expect(r.body.data.map((x: any) => x.session_id).sort()).toEqual([idN(0x7001), idN(0x7002)]);
    expect(r.body.data.find((x: any) => x.session_id === idN(0x7001))).toEqual({
      session_id: idN(0x7001), platform_staff_id: idN(0x5001), display_name: 'Demo Staff 1', state: 'active', aal: 'aal2', created_at: NOW.toISOString(), last_seen_at: NOW.toISOString(),
      idle_expires_at: new Date(NOW.getTime() + 900_000).toISOString(), absolute_expires_at: new Date(NOW.getTime() + 28_800_000).toISOString(),
      client_ip_masked: '203.0.x.x', user_agent_family: 'Firefox', is_support: false });
    expect(r.body.data.find((x: any) => x.session_id === idN(0x7002)).is_support).toBe(true);
    const wire = JSON.stringify(r.body);
    for (const leak of [SECRET, '203.0.113.9', 'token_sha256', 'refresh_token', 'access_token', 'enc_key_id', idN(0x8001), 'null']) expect(wire).not.toContain(leak);
  });
  it('revokePlatformSession: 204 no body; session revoked; gotrue_signout {user_id} enqueued; platform_session_revoked event targets the session', async () => {
    const target = sessRow(1); const s = setup({ sessions: [target] });
    const r = await s.svc.revokePlatformSession(s.ctx, { sessionId: target.id });
    expect(r.status).toBe(204); expect(r.body).toBeUndefined();
    expect(s.f.by('revokeSession')[0]!.args).toEqual([target.id, { at: NOW, actorId: STAFF_USER }]);
    expect(s.f.jobs).toEqual([{ identifier: 'identity.gotrue_signout', payload: { user_id: target.user_id }, jobKey: expect.any(String) }]);
    expect(s.events).toEqual([expect.objectContaining({ eventType: 'platform_session_revoked', targetType: 'session', targetId: target.id, actorPlatformStaffId: STAFF_ID })]);
  });
  it('own current session -> 409 identity.self_action_forbidden (use logout); nothing written', async () => {
    const s = setup({ sessions: [sessRow(1, { id: PSESSION })] });
    expect((await rejection(() => s.svc.revokePlatformSession(s.ctx, { sessionId: PSESSION }))).code).toBe('identity.self_action_forbidden');
    expect(s.f.by('revokeSession')).toEqual([]); expect(s.f.jobs).toEqual([]); expect(s.events).toEqual([]);
  });
  it('unknown / non-uuid id, or a tenant-kind session (platform route must not reach tenant sessions) -> 404 common.not_found', async () => {
    const tenantSess = sessRow(3, { kind: 'tenant_staff', platform_staff_id: null }); const s = setup({ sessions: [tenantSess] });
    for (const id of [idN(0xdead), 'zzz', tenantSess.id]) expect((await rejection(() => s.svc.revokePlatformSession(s.ctx, { sessionId: id }))).code).toBe('common.not_found');
    expect(s.f.by('revokeSession')).toEqual([]); expect(tenantSess.state).toBe('active'); expect(s.f.jobs).toEqual([]);
  });
  it('already revoked / expired -> 204 again, no second signout job, no second event (idempotent)', async () => {
    for (const state of ['revoked', 'expired']) {
      const t = sessRow(1, { state }); const s = setup({ sessions: [t] });
      expect((await s.svc.revokePlatformSession(s.ctx, { sessionId: t.id })).status).toBe(204); expect(s.f.jobs).toEqual([]); expect(s.events).toEqual([]);
    }
  });
});

describe('listPlatformAuthEvents (date rule as s5.9; includes tenant-less events)', () => {
  const Q = { occurred_at_from: '2026-11-01T00:00:00.000Z', occurred_at_to: '2026-11-08T00:00:00.000Z' };
  const rows = [authRow(1, { tenant_id: null, event_type: 'login_blocked_ip', platform_staff_id: idN(0x5001) }), authRow(2, { tenant_id: TENANT, event_type: 'login_succeeded' }),
    authRow(3, { tenant_id: null, event_type: 'login_failed' }), authRow(4, { tenant_id: idN(0xb1), event_type: 'login_succeeded' })];
  it('returns tenant and tenant-less events newest first as AuthEvent (no email_hmac, nulls omitted); login_blocked_ip rows are visible', async () => {
    const s = setup({ auth: rows }); const r = await s.svc.listPlatformAuthEvents(s.ctx, Q);
    expect(r.status).toBe(200); expect(r.body.data.map((x: any) => x.auth_event_id)).toEqual([idN(0x9004), idN(0x9003), idN(0x9002), idN(0x9001)]);
    const blocked = r.body.data.find((x: any) => x.event_type === 'login_blocked_ip');
    expect(blocked).toEqual({ auth_event_id: idN(0x9001), platform_staff_id: idN(0x5001), event_type: 'login_blocked_ip', client_ip: '203.0.113.9', user_agent: 'Firefox', occurred_at: '2026-11-05T04:01:00.000Z' });
    expect(blocked).not.toHaveProperty('tenant_id'); const wire = JSON.stringify(r.body);
    expect(wire).not.toContain(SECRET); expect(wire).not.toContain('email_hmac'); expect(wire).not.toContain('null');
    expect(r.body.page).toEqual({ limit: 50 });
  });
  it('filters tenant_id and event_type reach the repo; nothing is filtered client-side', async () => {
    const s = setup({ auth: rows });
    expect((await s.svc.listPlatformAuthEvents(s.ctx, { ...Q, tenant_id: idN(0xb1) })).body.data.map((x: any) => x.auth_event_id)).toEqual([idN(0x9004)]);
    expect((await s.svc.listPlatformAuthEvents(s.ctx, { ...Q, event_type: 'login_failed' })).body.data).toHaveLength(1);
    expect(s.f.by('listAuthEvents').at(-1)!.args[0]).toMatchObject({ f: { event_type: 'login_failed' } });
  });
  it('keyset paging: limit 2 over 4 rows -> next_cursor, the cursor page continues without overlap or gap; last page has no next_cursor', async () => {
    const s = setup({ auth: rows });
    const p1 = await s.svc.listPlatformAuthEvents(s.ctx, { ...Q, limit: '2' }); expect(p1.body.data).toHaveLength(2); expect(p1.body.page.limit).toBe(2); expect(typeof p1.body.page.next_cursor).toBe('string');
    expect(s.f.by('listAuthEvents')[0]!.args[0]).toMatchObject({ limit: 3 });                              // limit + 1 probe
    const p2 = await s.svc.listPlatformAuthEvents(s.ctx, { ...Q, limit: '2', cursor: p1.body.page.next_cursor });
    expect([...p1.body.data, ...p2.body.data].map((x: any) => x.auth_event_id)).toEqual([idN(0x9004), idN(0x9003), idN(0x9002), idN(0x9001)]);
    expect(p2.body.page.next_cursor).toBeUndefined();
  });
  const badQ: Array<[string, Record<string, unknown>]> = [
    ['from missing', { occurred_at_from: undefined }], ['to missing', { occurred_at_to: undefined }], ['from after to', { occurred_at_from: Q.occurred_at_to, occurred_at_to: Q.occurred_at_from }],
    ['span > 31 days', { occurred_at_from: '2026-09-01T00:00:00.000Z' }], ['not ISO-UTC', { occurred_at_from: '2026-11-01' }], ['bad event_type', { event_type: 'login_hacked' }],
    ['bad tenant_id', { tenant_id: 'x' }], ['limit 0', { limit: '0' }], ['limit 201', { limit: '201' }], ['limit abc', { limit: 'abc' }], ['garbage cursor', { cursor: '!!!' }],
  ];
  it.each(badQ)('400 common.validation_failed: %s; repo not queried', async (_n, o) => {
    const s = setup({ auth: rows }); expect((await rejection(() => s.svc.listPlatformAuthEvents(s.ctx, { ...Q, ...o }))).code).toBe('common.validation_failed');
    expect(s.f.by('listAuthEvents')).toEqual([]);
  });
});

describe('IP allowlist is enforced end to end (US-E6): what updatePlatformStaff stores is what the claims resolver enforces', () => {
  it('after an update to [198.51.100.0/24] a platform request from 203.0.113.7 is rejected with identity.platform_ip_denied, one from 198.51.100.20 resolves', async () => {
    const s = setup({ staff: [meRow(), S2] });
    const stored = (await s.svc.updatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 1, allowedCidrs: ['198.51.100.0/24'] })).body.allowed_cidrs;
    const bad = await claimsResolver(stored, '203.0.113.7'); expect(bad).toEqual({ kind: 'rejected', code: 'identity.platform_ip_denied' });
    expect((await claimsResolver(stored, '198.51.100.20')).kind).toBe('platform');
  });
  it('an invalid list never reaches storage, so the resolver never sees an unparsable entry (host bits set is refused up front)', async () => {
    const s = setup({ staff: [meRow(), S2] });
    await rejection(() => s.svc.updatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 1, allowedCidrs: ['198.51.100.7/24'] }));
    expect(s.f.row(S2.id).allowed_cidrs).toEqual([]);
  });
});

describe('failure of a dependency leaves no half-done state to report as success', () => {
  it('a repo write that throws propagates (core rolls the tx back); no event is written after it', async () => {
    const s = setup({ staff: [meRow(), S2] }); s.f.state.fail['updateStaff'] = new Error('db down');
    await rejection(() => s.svc.deactivatePlatformStaff(s.ctx, { platformStaffId: S2.id, expectedVersion: 1 })); expect(s.events).toEqual([]); expect(s.f.jobs).toEqual([]);
  });
  it('a GoTrue failure on invite propagates and writes no staff row / event', async () => {
    const s = setup(); s.gotrue.adminCreateUser.mockRejectedValueOnce(new Error('gotrue down'));
    await rejection(() => s.svc.invitePlatformStaff(s.ctx, INVITE)); expect(s.f.by('insertStaff')).toEqual([]); expect(s.events).toEqual([]);
  });
  it('errors never echo the request input (email / names)', async () => {
    const s = setup({ staff: [meRow(), staffRow(2, { email_normalized: 'new.support@example.test' })] });
    const e = await rejection(() => s.svc.invitePlatformStaff(s.ctx, INVITE)); expect(JSON.stringify({ c: e.code, m: e.message, d: e.detail })).not.toMatch(/example\.test|New Support/);
  });
});
export type { FakeRepo };
