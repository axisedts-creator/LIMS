// T25 HTTP wiring of the eight s5.10 staff / sessions / auth-events operations (02-TRD s5.10; contracts/openapi/identity.yaml).
// The SERVICE is mocked (behaviour: platform-staff.service.test.ts): these tests fix req -> service input mapping, status codes, ETag / If-Match, mass-assignment
// and fail-closed behaviour. Platform authz is the service's; the handlers only refuse a context with no authenticated platform request.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { PSESSION, REQ_ID, STAFF_ID, STAFF_USER, idN, rejection } from './platform-staff.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listPlatformStaff', 'invitePlatformStaff', 'updatePlatformStaff', 'deactivatePlatformStaff', 'resetPlatformStaffMfa', 'listPlatformSessions', 'revokePlatformSession', 'listPlatformAuthEvents'];
vi.mock('../platform-staff.service.js', () => ({ createPlatformStaffService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const SID = idN(0x5002), SESS = idN(0x7001), OTHER = idN(0xb1);
const noop = { info() {}, warn() {}, error() {} };
const hctx = (operationId: string, o: Record<string, unknown> = {}) => ({
  operationId, clientIp: '203.0.113.9', log: noop, actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION,
  aal: 'aal2', requestId: REQ_ID, tx: { __tx: 1 }, ...o,
});
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });
const input = (op: string) => svc[op]!.mock.calls[0]![1];

describe('no longer stubs; fail closed without an authenticated platform request context', () => {
  it.each(OPS)('%s: no actor/tx -> auth.unauthenticated (the stub answers common.internal); service never called', async (op) => {
    const e = await rejection(h(op)(req({ params: { platform_staff_id: SID, session_id: SESS } }), { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('service errors propagate unchanged and echo no request input', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['updatePlatformStaff']!.mockRejectedValueOnce(new LimsError('identity.last_admin_protected'));
    const e = await rejection(h('updatePlatformStaff')(req({ params: { platform_staff_id: SID }, headers: { authorization: planted, 'if-match': '"1"' }, body: { display_name: planted } }), hctx('updatePlatformStaff')));
    expect(e.code).toBe('identity.last_admin_protected'); expect(JSON.stringify({ c: e.code, m: e.message, d: e.detail })).not.toContain(planted);
  });
  it('the platform ctx is passed to the service untouched', async () => {
    await h('listPlatformStaff')(req(), hctx('listPlatformStaff'));
    expect(svc['listPlatformStaff']!.mock.calls[0]![0]).toMatchObject({ platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION, actor: { id: STAFF_USER } });
  });
});

describe('listPlatformStaff / listPlatformSessions', () => {
  it.each(['listPlatformStaff', 'listPlatformSessions'])('%s: no input reaches the service (query / body ignored); 200 body passthrough, no ETag', async (op) => {
    const r = await h(op)(req({ query: { tenant_id: OTHER, platform_staff_id: SID }, body: { role_code: 'x' } }), hctx(op));
    expect(input(op)).toEqual({}); expect(r.status).toBe(200); expect(r.body).toEqual({ ok: op }); expect(r.headers?.etag).toBeUndefined();
  });
});

describe('invitePlatformStaff', () => {
  it('body (snake) -> { email, displayName, roleCode, allowedCidrs } (camel); 201 passthrough', async () => {
    svc['invitePlatformStaff']!.mockResolvedValueOnce({ status: 201, body: { ok: 1 }, version: 1 });
    const r = await h('invitePlatformStaff')(req({ body: { email: 'a@example.test', display_name: 'Demo', role_code: 'platform_support', allowed_cidrs: ['10.0.0.0/8'] } }), hctx('invitePlatformStaff'));
    expect(input('invitePlatformStaff')).toEqual({ email: 'a@example.test', displayName: 'Demo', roleCode: 'platform_support', allowedCidrs: ['10.0.0.0/8'] }); expect(r.status).toBe(201);
  });
  it('mass assignment: is_active, user_id, platform_staff_id, version, created_by, tenant_id in the body never reach the service', async () => {
    await h('invitePlatformStaff')(req({ params: { tenant_id: OTHER }, query: { role_code: 'platform_superadmin' }, headers: { 'x-tenant-id': OTHER },
      body: { email: 'a@example.test', display_name: 'D', role_code: 'platform_support', is_active: false, user_id: OTHER, platform_staff_id: OTHER, version: 9, created_by: OTHER, tenant_id: OTHER } }), hctx('invitePlatformStaff'));
    expect(Object.keys(input('invitePlatformStaff')).sort()).toEqual(['allowedCidrs', 'displayName', 'email', 'roleCode']); expect(input('invitePlatformStaff').roleCode).toBe('platform_support');
  });
  it('missing / non-object body and non-string values are forwarded as undefined / as-is, never coerced (the service answers 400)', async () => {
    for (const b of [undefined, null, 'x', 5, []]) { svc['invitePlatformStaff']!.mockClear(); await h('invitePlatformStaff')(req({ body: b }), hctx('invitePlatformStaff')); expect(input('invitePlatformStaff')).toMatchObject({ email: undefined, roleCode: undefined }); }
    svc['invitePlatformStaff']!.mockClear(); await h('invitePlatformStaff')(req({ body: { email: 5, display_name: ['x'], role_code: null, allowed_cidrs: '10.0.0.0/8' } }), hctx('invitePlatformStaff'));
    const i = input('invitePlatformStaff'); expect(typeof i.email).not.toBe('string'); expect(typeof i.displayName).not.toBe('string'); expect(Array.isArray(i.allowedCidrs)).toBe(false);
  });
});

describe.each(['updatePlatformStaff', 'deactivatePlatformStaff'])('%s (If-Match, ETag)', (op) => {
  it('path id + If-Match "<n>" -> { platformStaffId, expectedVersion: n, ... }; 200 + new ETag', async () => {
    const r = await h(op)(req({ params: { platform_staff_id: SID }, headers: { 'if-match': '"7"' }, body: { display_name: 'N', role_code: 'platform_support', allowed_cidrs: [] } }), hctx(op));
    expect(input(op)).toMatchObject({ platformStaffId: SID, expectedVersion: 7 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('If-Match absent -> expectedVersion undefined (the service answers 428); malformed -> 0 or undefined, never a valid-looking version', async () => {
    await h(op)(req({ params: { platform_staff_id: SID } }), hctx(op)); expect(input(op).expectedVersion).toBeUndefined();
    for (const bad of ['7', 'W/"7"', '"0"', '"-1"', '"1.5"', '"abc"', '"2147483648"', '*', '', '"07"', ['"1"', '"2"']]) {
      svc[op]!.mockClear(); await h(op)(req({ params: { platform_staff_id: SID }, headers: { 'if-match': bad } }), hctx(op));
      expect([0, undefined]).toContain(input(op).expectedVersion);
    }
  });
});
describe('updatePlatformStaff body mapping', () => {
  it('only the keys present are forwarded (PATCH): { displayName } alone does not carry roleCode / allowedCidrs', async () => {
    await h('updatePlatformStaff')(req({ params: { platform_staff_id: SID }, headers: { 'if-match': '"1"' }, body: { display_name: 'Only' } }), hctx('updatePlatformStaff'));
    expect(input('updatePlatformStaff')).toEqual({ platformStaffId: SID, expectedVersion: 1, displayName: 'Only' });
  });
  it('mass assignment: is_active / version / email / user_id / id in the body or query are dropped; an empty body is forwarded as no fields (service: 400)', async () => {
    await h('updatePlatformStaff')(req({ params: { platform_staff_id: SID }, query: { is_active: 'false' }, headers: { 'if-match': '"1"' },
      body: { display_name: 'x', is_active: false, version: 99, email: 'e@example.test', user_id: OTHER, id: OTHER, platform_staff_id: OTHER } }), hctx('updatePlatformStaff'));
    expect(Object.keys(input('updatePlatformStaff')).sort()).toEqual(['displayName', 'expectedVersion', 'platformStaffId']); expect(input('updatePlatformStaff').platformStaffId).toBe(SID);
    svc['updatePlatformStaff']!.mockClear(); await h('updatePlatformStaff')(req({ params: { platform_staff_id: SID }, headers: { 'if-match': '"1"' }, body: null }), hctx('updatePlatformStaff'));
    expect(Object.keys(input('updatePlatformStaff')).sort()).toEqual(['expectedVersion', 'platformStaffId']);
  });
});
describe('deactivatePlatformStaff body', () => {
  it('only the path id and If-Match reach the service', async () => {
    await h('deactivatePlatformStaff')(req({ params: { platform_staff_id: SID }, headers: { 'if-match': '"2"' }, body: { is_active: true, version: 9 } }), hctx('deactivatePlatformStaff'));
    expect(input('deactivatePlatformStaff')).toEqual({ platformStaffId: SID, expectedVersion: 2 });
  });
});

describe('resetPlatformStaffMfa / revokePlatformSession', () => {
  it('resetPlatformStaffMfa: only the path id; 200 passthrough', async () => {
    const r = await h('resetPlatformStaffMfa')(req({ params: { platform_staff_id: SID }, body: { user_id: OTHER }, headers: { 'if-match': '"1"' } }), hctx('resetPlatformStaffMfa'));
    expect(input('resetPlatformStaffMfa')).toEqual({ platformStaffId: SID }); expect(r.status).toBe(200);
  });
  it('revokePlatformSession: only the path id; 204 with no body', async () => {
    svc['revokePlatformSession']!.mockResolvedValueOnce({ status: 204, body: undefined });
    const r = await h('revokePlatformSession')(req({ params: { session_id: SESS }, body: { session_id: OTHER } }), hctx('revokePlatformSession'));
    expect(input('revokePlatformSession')).toEqual({ sessionId: SESS }); expect(r.status).toBe(204); expect(r.body).toBeUndefined();
  });
});

describe('listPlatformAuthEvents', () => {
  const Q = { occurred_at_from: '2026-11-01T00:00:00.000Z', occurred_at_to: '2026-11-08T00:00:00.000Z', tenant_id: OTHER, event_type: 'login_blocked_ip', cursor: 'c1', limit: '10' };
  it('the raw snake_case query is handed to the service as-is (it validates, like listAuthEvents); 200 passthrough, no ETag', async () => {
    const r = await h('listPlatformAuthEvents')(req({ query: Q }), hctx('listPlatformAuthEvents'));
    expect(input('listPlatformAuthEvents')).toEqual(Q); expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('request body and headers never become filters', async () => {
    await h('listPlatformAuthEvents')(req({ query: { occurred_at_from: Q.occurred_at_from }, body: { tenant_id: OTHER }, headers: { 'x-tenant-id': OTHER } }), hctx('listPlatformAuthEvents'));
    expect(input('listPlatformAuthEvents')).toEqual({ occurred_at_from: Q.occurred_at_from });
  });
});

describe('registration + contract', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops = (): Array<[string, string, any]> => Object.entries<any>(spec.paths).flatMap(([p, item]) => Object.entries<any>(item).filter(([, o]) => OPS.includes(o?.operationId)).map(([m, o]) => [p, m, o] as [string, string, any]));
  it('the eight operations exist with x-context platform; staff + sessions need platform.staff.manage, auth events platform.tenant.read; update/deactivate require If-Match', () => {
    expect(ops().map(([, , o]) => o.operationId).sort()).toEqual([...OPS].sort());
    for (const [, , o] of ops()) {
      expect(o['x-context']).toBe('platform');
      expect(o['x-permission']).toBe(o.operationId === 'listPlatformAuthEvents' ? 'platform.tenant.read' : 'platform.staff.manage');
    }
    for (const [, , o] of ops().filter(([, , x]) => ['updatePlatformStaff', 'deactivatePlatformStaff'].includes(x.operationId))) expect(JSON.stringify(o.parameters)).toContain('IfMatch');
    expect(ops().find(([, , o]) => o.operationId === 'invitePlatformStaff')![2]['x-idempotency']).toBe('required');
  });
  it('PlatformStaff has no raw email, user id or audit column and caps allowed_cidrs at 20', () => {
    const s = spec.components.schemas.PlatformStaff; expect(Object.keys(s.properties).join()).not.toMatch(/user_id|email_normalized|created_by/); expect(s.properties.allowed_cidrs.maxItems).toBe(20);
  });
  it.each(OPS)('%s is a real handler (not the common.internal stub)', async (op) => {
    expect(typeof h(op)).toBe('function');
    const e = await rejection(h(op)(req({ params: { platform_staff_id: SID, session_id: SESS } }), hctx(op, { actor: undefined, tx: undefined })));
    expect(e?.code).not.toBe('common.internal');
  });
});
