// T17 HTTP wiring of listSessions, revokeSession, listTenantSupportSessions, approveSupportSession, denySupportSession, revokeSupportSession, listAdminNotices, dismissAdminNotice (02-TRD s5; contracts/openapi/identity.yaml).
// The tenant-access SERVICE is mocked (behaviour is in tenant-access.service.test.ts): these tests fix req -> service input mapping, status codes, ETag / If-Match, mass-assignment stripping, fail-closed
// behaviour and the contract facts the pipeline enforces (x-permission, tenant context, idempotency, tiers, error codes, privileged permissions). Seams: tenant-access.helpers.ts.
// Expected now: fail (the eight handlers are common.internal stubs; service/tenant-access.service.ts does not exist).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { TENANT_A, TENANT_B, idN, rejection } from './tenant-access.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listSessions', 'revokeSession', 'listTenantSupportSessions', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession', 'listAdminNotices', 'dismissAdminNotice'] as const;
const NO_CONTENT = ['revokeSession', 'dismissAdminNotice'];
vi.mock('../tenant-access.service.js', () => ({ createTenantAccessService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const USER = idN(0xd1), MEM = idN(0xd2), SESS = idN(0xd3), SID = idN(0x44), NID = idN(0x55);
const hctx = (operationId: string, c: Record<string, unknown> = {}) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEM },
  sessionId: SESS, aal: 'aal2', requestId: idN(0xe1), tx: { __tx: 1 }, now: () => new Date(), commitOnError() {}, audit: { access: async () => undefined }, ...c });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => {
  for (const op of OPS) svc[op] = vi.fn(async () => (NO_CONTENT.includes(op) ? { status: 204 } : { status: 200, body: { ok: op }, version: 3 }));
});

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s: no context -> auth.unauthenticated (the stub answers common.internal); service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } })); expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('revokeSession: a context without the caller\'s current session id -> auth.unauthenticated (the self-revoke guard must never guess "current")', async () => {
    const e = await rejection(h('revokeSession')(req({ params: { session_id: SID } }), hctx('revokeSession', { sessionId: undefined }))); expect(e?.code).toBe('auth.unauthenticated'); expect(svc['revokeSession']).not.toHaveBeenCalled();
  });
  it.each(OPS)('%s: actor types patient / device / system / partner never reach the service', async (op) => {
    for (const type of ['patient', 'device', 'system', 'partner', 'portal']) {
      svc[op]!.mockClear(); const e = await rejection(h(op)(req({ params: { session_id: SID, support_session_id: SID, notice_id: NID } }), hctx(op, { actor: { type, id: USER, membershipId: MEM } })));
      expect(['auth.unauthenticated', 'auth.forbidden'], `${op}/${type}`).toContain(e.code); expect(svc[op]).not.toHaveBeenCalled();
    }
  });
  it('a failed call echoes no request input in code/message/detail; service errors propagate unchanged', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['approveSupportSession']!.mockRejectedValueOnce(new LimsError('common.version_conflict'));
    const e = await rejection(h('approveSupportSession')(req({ params: { support_session_id: planted }, headers: { authorization: planted, 'if-match': '"1"' } }), hctx('approveSupportSession')));
    expect(e.code).toBe('common.version_conflict'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
});

describe('request -> service mapping and responses', () => {
  it('the context given to the service is the pipeline\'s (tenant, caller, current session), never one from params/query/body/headers', async () => {
    await h('listSessions')(req({ query: { tenant_id: TENANT_B, user_id: idN(9) }, headers: { 'x-tenant-id': TENANT_B } }), hctx('listSessions'));
    const c = svc['listSessions']!.mock.calls[0]![0]; expect(c.tenantId).toBe(TENANT_A); expect(c.actor.id).toBe(USER); expect(c.sessionId).toBe(SESS);
  });
  it.each([
    [{ membership_id: idN(7), state: 'active', cursor: 'abc', limit: 25 }, { membershipId: idN(7), state: 'active', cursor: 'abc', limit: 25 }], [{ limit: 5 }, { limit: 5 }], [{ state: 'revoked' }, { state: 'revoked' }], [{}, {}],
  ])('listSessions query %j -> %j; unknown keys dropped, absent keys absent', async (query, input) => {
    const r = await h('listSessions')(req({ query: { ...query, tenant_id: TENANT_B, user_id: idN(9) } }), hctx('listSessions')); expect(svc['listSessions']!.mock.calls[0]![1]).toEqual(input); expect(r.status).toBe(200); expect(r.body).toEqual({ ok: 'listSessions' });
  });
  it('revokeSession: path session_id -> sessionId; 204 without body; body/query ignored', async () => {
    const r = await h('revokeSession')(req({ params: { session_id: SID }, body: { user_id: idN(9), reason: 'lock' }, query: { tenant_id: TENANT_B } }), hctx('revokeSession'));
    expect(svc['revokeSession']).toHaveBeenCalledWith(expect.anything(), { sessionId: SID }); expect(r.status).toBe(204); expect(r.body).toBeUndefined();
  });
  it('listTenantSupportSessions: query status -> status (only); 200 passthrough', async () => {
    const r = await h('listTenantSupportSessions')(req({ query: { status: 'requested', tenant_id: TENANT_B } }), hctx('listTenantSupportSessions')); expect(svc['listTenantSupportSessions']).toHaveBeenCalledWith(expect.anything(), { status: 'requested' }); expect(r.status).toBe(200);
    svc['listTenantSupportSessions']!.mockClear(); await h('listTenantSupportSessions')(req(), hctx('listTenantSupportSessions')); expect(svc['listTenantSupportSessions']).toHaveBeenCalledWith(expect.anything(), {});
  });
  it('approveSupportSession: path id + If-Match -> {supportSessionId, expectedVersion}; 200 + ETag "<version>"; body / query ignored', async () => {
    const r = await h('approveSupportSession')(req({ params: { support_session_id: SID }, headers: { 'if-match': '"2"' }, body: { status: 'active', tenant_id: TENANT_B }, query: { tenant_id: TENANT_B } }), hctx('approveSupportSession'));
    const input = svc['approveSupportSession']!.mock.calls[0]![1]; expect(input).toEqual({ supportSessionId: SID, expectedVersion: 2 }); expect(Object.keys(input).sort()).toEqual(['expectedVersion', 'supportSessionId']);
    expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"'); expect(r.body).toEqual({ ok: 'approveSupportSession' });
  });
  it('approveSupportSession: If-Match absent -> expectedVersion undefined (the service answers 428); malformed -> 0 or undefined, never a crash', async () => {
    await h('approveSupportSession')(req({ params: { support_session_id: SID } }), hctx('approveSupportSession')); expect(svc['approveSupportSession']!.mock.calls[0]![1].expectedVersion).toBeUndefined();
    for (const bad of ['1', 'W/"1"', '"0"', '"-1"', '"1.5"', '"99999999999"', '*', '']) {
      svc['approveSupportSession']!.mockClear(); await h('approveSupportSession')(req({ params: { support_session_id: SID }, headers: { 'if-match': bad } }), hctx('approveSupportSession'));
      expect([0, undefined], bad).toContain(svc['approveSupportSession']!.mock.calls[0]![1].expectedVersion);
    }
  });
  it('denySupportSession: path id + body.reason_text -> {supportSessionId, reasonText} ONLY (mass assignment); If-Match is not read; 200 + ETag', async () => {
    const r = await h('denySupportSession')(req({ params: { support_session_id: SID }, headers: { 'if-match': '"9"' }, body: { reason_text: 'Not needed, synthetic', status: 'approved', tenant_id: TENANT_B, decision_note: 'x' } }), hctx('denySupportSession'));
    const input = svc['denySupportSession']!.mock.calls[0]![1]; expect(input).toEqual({ supportSessionId: SID, reasonText: 'Not needed, synthetic' }); expect(Object.keys(input).sort()).toEqual(['reasonText', 'supportSessionId']);
    expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('denySupportSession: a missing / non-object body reaches the service as reasonText undefined (the service answers 400), never a crash', async () => {
    for (const body of [undefined, null, 'x', 7, []]) { svc['denySupportSession']!.mockClear(); await h('denySupportSession')(req({ params: { support_session_id: SID }, body }), hctx('denySupportSession')); expect(svc['denySupportSession']!.mock.calls[0]![1].reasonText).toBeUndefined(); }
  });
  it('revokeSupportSession: path id -> {supportSessionId} only; 200 + ETag', async () => {
    const r = await h('revokeSupportSession')(req({ params: { support_session_id: SID }, body: { status: 'revoked' }, headers: { 'if-match': '"1"' } }), hctx('revokeSupportSession'));
    expect(svc['revokeSupportSession']).toHaveBeenCalledWith(expect.anything(), { supportSessionId: SID }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('listAdminNotices: 200 passthrough with {}; dismissAdminNotice: path notice_id -> noticeId; 204 without body', async () => {
    const a = await h('listAdminNotices')(req({ query: { tenant_id: TENANT_B } }), hctx('listAdminNotices')); expect(svc['listAdminNotices']).toHaveBeenCalledWith(expect.anything(), {}); expect(a.status).toBe(200);
    const b = await h('dismissAdminNotice')(req({ params: { notice_id: NID }, body: { membership_id: idN(1) } }), hctx('dismissAdminNotice')); expect(svc['dismissAdminNotice']).toHaveBeenCalledWith(expect.anything(), { noticeId: NID }); expect(b.status).toBe(204); expect(b.body).toBeUndefined();
  });
  it('list responses carry no ETag', async () => {
    for (const op of ['listSessions', 'listTenantSupportSessions', 'listAdminNotices']) { const r = await h(op)(req(), hctx(op)); expect(r.headers?.etag, op).toBeUndefined(); }
  });
});

describe('contract (contracts/openapi/identity.yaml, contracts/permissions.yaml, contracts/errors.yaml)', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'post', 'put', 'delete', 'patch']) if (item[m]?.operationId) ops[item[m].operationId] = item[m];
  it.each([
    ['listSessions', 'identity.session.revoke', 'none', []], ['revokeSession', 'identity.session.revoke', 'optional', ['identity.self_action_forbidden']],
    ['listTenantSupportSessions', 'audit.log.read', 'none', []], ['approveSupportSession', 'identity.settings.manage', 'optional', ['common.version_conflict', 'common.precondition_required']],
    ['denySupportSession', 'identity.settings.manage', 'optional', []], ['revokeSupportSession', 'identity.settings.manage', 'optional', []],
    ['listAdminNotices', 'identity.user.read', 'none', []], ['dismissAdminNotice', 'identity.user.read', 'optional', []],
  ])('%s: bearerJwt, tenant context, x-permission %s, idempotency %s, tier general, error codes %j', (op, perm, idem, codes) => {
    expect(ops[op].security).toEqual([{ bearerJwt: [] }]); expect(ops[op]['x-context']).toBe('tenant'); expect(ops[op]['x-permission']).toBe(perm);
    expect(ops[op]['x-idempotency']).toBe(idem); expect(ops[op]['x-rate-limit-tier']).toBe('general'); expect(ops[op]['x-error-codes']).toEqual(codes);
  });
  it('response codes: the 204 ops answer 204; every id operation declares 404; approve declares 409 + 428; revokeSession declares 409', () => {
    for (const op of NO_CONTENT) expect(Object.keys(ops[op].responses)).toContain('204');
    for (const op of ['revokeSession', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession', 'dismissAdminNotice']) expect(Object.keys(ops[op].responses), op).toContain('404');
    expect(Object.keys(ops['approveSupportSession'].responses)).toEqual(expect.arrayContaining(['409', '428'])); expect(Object.keys(ops['revokeSession'].responses)).toContain('409');
    for (const op of ['approveSupportSession', 'denySupportSession', 'revokeSupportSession']) expect(Object.keys(ops[op].responses), op).toContain('200');
  });
  it('approve takes an If-Match header; deny takes a ReasonTextRequest body (reason_text <= 500) and no If-Match; revoke takes neither', () => {
    expect(JSON.stringify(ops['approveSupportSession'].parameters)).toContain('IfMatch'); expect(JSON.stringify(ops['denySupportSession'].parameters)).not.toContain('IfMatch');
    expect(JSON.stringify(ops['denySupportSession'].requestBody)).toContain('ReasonTextRequest'); expect(spec.components.schemas.ReasonTextRequest.properties.reason_text.maxLength).toBe(500);
    expect(ops['revokeSupportSession'].requestBody).toBeUndefined(); expect(JSON.stringify(ops['revokeSupportSession'].parameters)).not.toContain('IfMatch');
  });
  it('the privileged permissions behind these operations require MFA (aal2 via the pipeline) and belong to tenant_admin only; a platform role holds none of them (E-3, E-5)', () => {
    const perms: Array<{ code: string; privileged: boolean; roles: string[] }> = parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8')).permissions;
    for (const code of ['identity.session.revoke', 'identity.settings.manage', 'audit.log.read']) { const p = perms.find((x) => x.code === code); expect(p, code).toBeDefined(); expect(p!.privileged, code).toBe(true); expect(p!.roles, code).toEqual(['tenant_admin']); }
    const read = perms.find((x) => x.code === 'identity.user.read'); expect(read?.roles).toEqual(['tenant_admin']);
  });
  it('error codes the tests rely on exist in contracts/errors.yaml with the expected status', () => {
    const by = new Map((parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Array<{ code: string; http: number }>).map((c) => [c.code, c.http]));
    expect([by.get('identity.self_action_forbidden'), by.get('common.version_conflict'), by.get('common.precondition_required'), by.get('common.not_found'), by.get('common.validation_failed'), by.get('auth.forbidden')]).toEqual([409, 409, 428, 404, 400, 403]);
  });
});
