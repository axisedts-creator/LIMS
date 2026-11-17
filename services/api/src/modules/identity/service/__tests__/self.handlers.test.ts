// T10 HTTP wiring of getMe, changeOwnPassword, listOwnSessions, revokeOwnSession, listOwnMfaFactors, removeOwnMfaFactor (02-TRD s5.2; contracts/openapi/identity.yaml).
// The self SERVICE is mocked (behaviour is in self.service.test.ts): these tests fix req -> service input mapping, status codes, mass-assignment stripping, fail-closed behaviour and
// the contract facts the pipeline enforces (x-permission identity.self.manage, bearerJwt, tenant context, tiers, idempotency, error codes). Seams: self.helpers.ts.
// Expected now: fail (the six handlers are common.internal stubs; service/self.service.ts does not exist).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { TENANT_A, TENANT_B, idN, rejection } from './self.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['getMe', 'changeOwnPassword', 'listOwnSessions', 'revokeOwnSession', 'listOwnMfaFactors', 'removeOwnMfaFactor'] as const;
vi.mock('../self.service.js', () => ({ createSelfService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const USER = idN(0xd1), MEM = idN(0xd2), SESS = idN(0xd3);
const hctx = (operationId: string, c: Record<string, unknown> = {}) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEM },
  sessionId: SESS, aal: 'aal2', requestId: idN(0xe1), tx: { __tx: 1 }, now: () => new Date(), commitOnError() {}, audit: { access: async () => undefined }, ...c });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => {
  for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op } }));
  for (const op of ['changeOwnPassword', 'revokeOwnSession', 'removeOwnMfaFactor']) svc[op] = vi.fn(async () => ({ status: 204 }));
});

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s: no context -> auth.unauthenticated (the stub answers common.internal); service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it.each(OPS)('%s: a context without the caller\'s current session id -> auth.unauthenticated (never guess "current")', async (op) => {
    const e = await rejection(h(op)(req(), hctx(op, { sessionId: undefined }))); expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input in code/message/detail', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['revokeOwnSession']!.mockRejectedValueOnce(new LimsError('common.not_found'));
    const e = await rejection(h('revokeOwnSession')(req({ params: { session_id: planted }, headers: { authorization: planted } }), hctx('revokeOwnSession')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
  it('service errors propagate unchanged (the core renders them)', async () => {
    svc['changeOwnPassword']!.mockRejectedValueOnce(new LimsError('auth.login_failed'));
    expect((await rejection(h('changeOwnPassword')(req({ body: { current_password: 'x', new_password: 'y' } }), hctx('changeOwnPassword')))).code).toBe('auth.login_failed');
  });
});

describe('request -> service mapping and responses', () => {
  it('getMe: 200 body passthrough, service gets ctx and {}', async () => {
    const r = await h('getMe')(req(), hctx('getMe')); expect(r.status).toBe(200); expect(r.body).toEqual({ ok: 'getMe' }); expect(svc['getMe']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A, sessionId: SESS }), {});
  });
  it('changeOwnPassword: snake_case body -> camelCase; ONLY current_password / new_password forwarded (mass assignment); 204 without body', async () => {
    const r = await h('changeOwnPassword')(req({ body: { current_password: 'c-pw', new_password: 'n-pw', user_id: idN(1), tenant_id: TENANT_B, membership_id: idN(2), session_id: idN(3), skip_revoke: true } }), hctx('changeOwnPassword'));
    const input = svc['changeOwnPassword']!.mock.calls[0]![1]; expect(input).toEqual({ currentPassword: 'c-pw', newPassword: 'n-pw' }); expect(Object.keys(input).sort()).toEqual(['currentPassword', 'newPassword']);
    expect(r.status).toBe(204); expect(r.body).toBeUndefined();
  });
  it('the context given to the service is the pipeline\'s (tenant, user, current session), never one from params/query/body/headers', async () => {
    await h('listOwnSessions')(req({ query: { tenant_id: TENANT_B, user_id: idN(9) }, headers: { 'x-tenant-id': TENANT_B } }), hctx('listOwnSessions'));
    const c = svc['listOwnSessions']!.mock.calls[0]![0]; expect(c.tenantId).toBe(TENANT_A); expect(c.actor.id).toBe(USER); expect(c.sessionId).toBe(SESS);
  });
  it.each([[{ limit: 25 }, { limit: 25 }], [{ cursor: 'abc', limit: 2 }, { cursor: 'abc', limit: 2 }], [{}, {}]])('listOwnSessions query %j -> %j; unknown query keys dropped', async (query, input) => {
    await h('listOwnSessions')(req({ query: { ...query, user_id: idN(9), tenant_id: TENANT_B } }), hctx('listOwnSessions')); expect(svc['listOwnSessions']!.mock.calls[0]![1]).toEqual(input);
  });
  it('revokeOwnSession: path session_id -> sessionId; 204', async () => {
    const r = await h('revokeOwnSession')(req({ params: { session_id: idN(0x44) }, body: { user_id: idN(9) } }), hctx('revokeOwnSession'));
    expect(svc['revokeOwnSession']).toHaveBeenCalledWith(expect.anything(), { sessionId: idN(0x44) }); expect(r.status).toBe(204); expect(r.body).toBeUndefined();
  });
  it('listOwnMfaFactors: 200 passthrough; removeOwnMfaFactor: path factor_id -> factorId, 204', async () => {
    const a = await h('listOwnMfaFactors')(req(), hctx('listOwnMfaFactors')); expect(a.status).toBe(200); expect(svc['listOwnMfaFactors']).toHaveBeenCalledWith(expect.anything(), {});
    const b = await h('removeOwnMfaFactor')(req({ params: { factor_id: idN(0x55) } }), hctx('removeOwnMfaFactor')); expect(svc['removeOwnMfaFactor']).toHaveBeenCalledWith(expect.anything(), { factorId: idN(0x55) }); expect(b.status).toBe(204);
  });
  it('a partner context (actor.type partner, partnerRole) is passed through unchanged: the six operations serve both kinds (08 A19 D-101)', async () => {
    const c = hctx('getMe', { actor: { type: 'partner', id: USER, membershipId: MEM }, partnerRole: 'partner_member' }); await h('getMe')(req(), c);
    expect(svc['getMe']!.mock.calls[0]![0]).toMatchObject({ actor: { type: 'partner' }, partnerRole: 'partner_member' });
  });
  it('other actor types (patient / device / system) never reach the service: auth.unauthenticated or auth.forbidden', async () => {
    for (const type of ['patient', 'device', 'system', 'portal']) {
      svc['getMe']!.mockClear(); const e = await rejection(h('getMe')(req(), hctx('getMe', { actor: { type, id: USER, membershipId: MEM } })));
      expect(['auth.unauthenticated', 'auth.forbidden']).toContain(e.code); expect(svc['getMe']).not.toHaveBeenCalled();
    }
  });
});

describe('contract (contracts/openapi/identity.yaml, contracts/errors.yaml)', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'post', 'put', 'delete', 'patch']) if (item[m]?.operationId) ops[item[m].operationId] = item[m];
  it.each([
    ['getMe', 'none', 'general', []], ['changeOwnPassword', 'none', 'login', ['auth.login_failed', 'auth.password_policy_violation', 'auth.password_breached']],
    ['listOwnSessions', 'none', 'general', []], ['revokeOwnSession', 'optional', 'general', ['identity.self_action_forbidden']],
    ['listOwnMfaFactors', 'none', 'general', []], ['removeOwnMfaFactor', 'optional', 'general', ['identity.self_action_forbidden']],
  ])('%s: bearerJwt, tenant context, x-permission identity.self.manage, idempotency %s, tier %s, error codes %j', (op, idem, tier, codes) => {
    expect(ops[op].security).toEqual([{ bearerJwt: [] }]); expect(ops[op]['x-context']).toBe('tenant'); expect(ops[op]['x-permission']).toBe('identity.self.manage');
    expect(ops[op]['x-idempotency']).toBe(idem); expect(ops[op]['x-rate-limit-tier']).toBe(tier); expect(ops[op]['x-error-codes']).toEqual(codes);
  });
  it('the 204 operations answer 204 and the two path-id operations declare 404 (another member\'s id is a not_found, AU-T20)', () => {
    for (const op of ['changeOwnPassword', 'revokeOwnSession', 'removeOwnMfaFactor']) expect(Object.keys(ops[op].responses)).toContain('204');
    for (const op of ['revokeOwnSession', 'removeOwnMfaFactor']) expect(Object.keys(ops[op].responses)).toContain('404');
  });
  it('error codes the tests rely on exist in contracts/errors.yaml with the expected status', () => {
    const by = new Map((parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Array<{ code: string; http: number }>).map((c) => [c.code, c.http]));
    expect([by.get('auth.login_failed'), by.get('auth.password_policy_violation'), by.get('auth.password_breached'), by.get('identity.self_action_forbidden'), by.get('common.not_found'), by.get('common.validation_failed')]).toEqual([401, 422, 422, 409, 404, 400]);
  });
});
