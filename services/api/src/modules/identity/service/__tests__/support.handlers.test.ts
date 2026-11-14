// T21 HTTP wiring of openSupportSession, activateSupportSession, endSupportSession, listPlatformSupportSessions (02-TRD s5.10; contracts/openapi/identity.yaml).
// The SERVICE is mocked (behaviour: support.service.test.ts): these tests fix req -> service input mapping, status codes, ETag / If-Match, mass-assignment and fail-closed behaviour.
// Platform authz is the service's (it runs PlatformAuthz itself); the handlers only refuse a context with no authenticated platform request.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { PSESSION, REQ_ID, STAFF_ID, STAFF_USER, TENANT_A, TENANT_B, idN, rejection } from './support.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['openSupportSession', 'activateSupportSession', 'endSupportSession', 'listPlatformSupportSessions'];
vi.mock('../support.service.js', () => ({ createSupportService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const SID = idN(0x701);
const noop = { info() {}, warn() {}, error() {} };
const hctx = (operationId: string, o: Record<string, unknown> = {}) => ({
  operationId, clientIp: '203.0.113.9', log: noop, actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_support', platformStaffId: STAFF_ID, platformSessionId: PSESSION,
  aal: 'aal2', requestId: REQ_ID, tx: { __tx: 1 }, ...o,
});
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: op === 'openSupportSession' ? 201 : 200, body: { ok: op }, version: 3 })); });

describe('no longer stubs; fail closed without an authenticated platform request context', () => {
  it.each(OPS)('%s: no actor/tx -> auth.unauthenticated (the stub answers common.internal); service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('service errors propagate unchanged and echo no request input', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['activateSupportSession']!.mockRejectedValueOnce(new LimsError('common.version_conflict'));
    const e = await rejection(h('activateSupportSession')(req({ params: { support_session_id: planted }, headers: { authorization: planted, 'if-match': '"1"' } }), hctx('activateSupportSession')));
    expect(e.code).toBe('common.version_conflict'); expect(JSON.stringify({ c: e.code, m: e.message, d: e.detail })).not.toContain(planted);
  });
});

describe('openSupportSession', () => {
  const body = { tenant_id: TENANT_A, scope: 'read_only', reason_text: 'Investigating a synthetic ticket', ticket_ref: 'SUP-1001', duration_minutes: 30 };
  it('POST body (snake) -> service input (camel); 201 + ETag "<version>"; the platform ctx is passed through untouched', async () => {
    const c = hctx('openSupportSession'); const r = await h('openSupportSession')(req({ body }), c);
    expect(svc['openSupportSession']).toHaveBeenCalledTimes(1);
    expect(svc['openSupportSession']!.mock.calls[0]![0]).toMatchObject({ platformRole: 'platform_support', platformStaffId: STAFF_ID, platformSessionId: PSESSION, actor: { id: STAFF_USER } });
    expect(svc['openSupportSession']!.mock.calls[0]![1]).toEqual({ tenantId: TENANT_A, scope: 'read_only', reasonText: 'Investigating a synthetic ticket', ticketRef: 'SUP-1001', durationMinutes: 30 });
    expect(r.status).toBe(201); expect(r.body).toEqual({ ok: 'openSupportSession' }); expect(r.headers?.etag).toBe('"3"');
  });
  it('mass assignment: only the five SupportSessionOpenRequest fields reach the service (no staff id, status, expires_at, platform_session_id)', async () => {
    await h('openSupportSession')(req({ body: { ...body, platform_staff_id: TENANT_B, status: 'active', expires_at: '2099-01-01T00:00:00Z', platform_session_id: 'x', actor_id: 'x', version: 9 }, query: { tenant_id: TENANT_B } }), hctx('openSupportSession'));
    expect(Object.keys(svc['openSupportSession']!.mock.calls[0]![1]).sort()).toEqual(['durationMinutes', 'reasonText', 'scope', 'tenantId', 'ticketRef']);
    expect(svc['openSupportSession']!.mock.calls[0]![1].tenantId).toBe(TENANT_A);
  });
  it('a missing / non-object body reaches the service as undefined fields (service answers 400), never a crash', async () => {
    for (const b of [undefined, null, 'x', 5, []]) { svc['openSupportSession']!.mockClear(); await h('openSupportSession')(req({ body: b }), hctx('openSupportSession')); expect(svc['openSupportSession']!.mock.calls[0]![1].tenantId).toBeUndefined(); }
  });
});

describe('activateSupportSession', () => {
  it('path id + If-Match -> service input; 200 + new ETag', async () => {
    const r = await h('activateSupportSession')(req({ params: { support_session_id: SID }, headers: { 'if-match': '"1"' } }), hctx('activateSupportSession'));
    expect(svc['activateSupportSession']!.mock.calls[0]![1]).toEqual({ supportSessionId: SID, expectedVersion: 1 }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('If-Match absent -> expectedVersion undefined (428 from the service); malformed -> 0 or undefined, never a crash', async () => {
    await h('activateSupportSession')(req({ params: { support_session_id: SID } }), hctx('activateSupportSession')); expect(svc['activateSupportSession']!.mock.calls[0]![1].expectedVersion).toBeUndefined();
    for (const bad of ['1', 'W/"1"', '"0"', '"-1"', '"1.5"', '"abc"', '"99999999999"', '*', '']) {
      svc['activateSupportSession']!.mockClear(); await h('activateSupportSession')(req({ params: { support_session_id: SID }, headers: { 'if-match': bad } }), hctx('activateSupportSession'));
      expect([0, undefined]).toContain(svc['activateSupportSession']!.mock.calls[0]![1].expectedVersion);
    }
  });
  it('body and query are ignored (nothing but the path id and If-Match is forwarded)', async () => {
    await h('activateSupportSession')(req({ params: { support_session_id: SID }, headers: { 'if-match': '"1"' }, body: { status: 'active', tenant_id: TENANT_B }, query: { tenant_id: TENANT_B } }), hctx('activateSupportSession'));
    expect(Object.keys(svc['activateSupportSession']!.mock.calls[0]![1]).sort()).toEqual(['expectedVersion', 'supportSessionId']);
  });
});

describe('endSupportSession', () => {
  it('path id only -> service; 200; no If-Match needed (contract has none)', async () => {
    const r = await h('endSupportSession')(req({ params: { support_session_id: SID }, body: { end_reason: 'revoked_by_tenant' } }), hctx('endSupportSession'));
    expect(svc['endSupportSession']!.mock.calls[0]![1]).toEqual({ supportSessionId: SID }); expect(r.status).toBe(200);
  });
});

describe('listPlatformSupportSessions', () => {
  it('query (snake) -> filters (camel); 200 page passthrough, no ETag', async () => {
    const r = await h('listPlatformSupportSessions')(req({ query: { tenant_id: TENANT_B, status: 'active', platform_staff_id: STAFF_ID, cursor: 'c1', limit: '25' } }), hctx('listPlatformSupportSessions'));
    const i = svc['listPlatformSupportSessions']!.mock.calls[0]![1];
    expect(i).toMatchObject({ tenantId: TENANT_B, status: 'active', platformStaffId: STAFF_ID, cursor: 'c1' }); expect(Number(i.limit)).toBe(25);
    expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('no filters -> empty filter object (no undefined-vs-missing surprises); unknown query keys are dropped', async () => {
    await h('listPlatformSupportSessions')(req({ query: { evil: '1', tenant_id: undefined } }), hctx('listPlatformSupportSessions'));
    const i = svc['listPlatformSupportSessions']!.mock.calls[0]![1]; expect(Object.keys(i).filter((k) => i[k] !== undefined)).toEqual([]);
  });
});

describe('contract + registration', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops = new Map<string, any>();
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const [m, op] of Object.entries<any>(item)) if (op?.operationId) ops.set(op.operationId, { path, m, ...op });
  it.each([['openSupportSession', 'platform.support_session.open', 'required'], ['activateSupportSession', 'platform.support_session.open', 'optional'],
    ['endSupportSession', 'platform.support_session.open', 'optional'], ['listPlatformSupportSessions', 'platform.tenant.read', 'none']])(
    '%s: x-context platform, x-permission %s, x-idempotency %s (the guard the handler relies on)', (op, perm, idem) => {
      expect(ops.get(op)).toMatchObject({ 'x-context': 'platform', 'x-permission': perm, 'x-idempotency': idem });
    });
  it('inviteUser needs identity.user.manage (the permission the E4.2 integration test asserts a read_only support session lacks)', () => {
    expect(ops.get('inviteUser')?.['x-permission']).toBe('identity.user.manage');
  });
  it.each(OPS)('%s is registered in the identity manifest', (op) => { expect(typeof h(op)).toBe('function'); });
});
