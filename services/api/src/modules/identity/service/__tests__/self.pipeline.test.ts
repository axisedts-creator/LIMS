// T0D-ELABMENU-2 (LD-340): getMe, listOwnMfaFactors, listOwnSessions answered 401 on staging for a signed in admin (listRoles 200).
// self.handlers.test.ts hand-builds a HandlerContext WITH sessionId, which the real pipeline never supplied for a tenant session, so that suite
// stayed green while every call failed closed. Here the REAL manifest handlers run behind the REAL pipeline (core rig, same stages 5-11);
// only the self SERVICE is mocked (behaviour: self.service.test.ts). Security rules stay: no session / expired / revoked / wrong kind -> still refused.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { claimsA, makeRig, MEMBERSHIP, SUB, TENANT_A } from '../../../../core/pipeline/__tests__/helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const READS = ['getMe', 'listOwnSessions', 'listOwnMfaFactors'] as const;
vi.mock('../self.service.js', () => ({ createSelfService: () => svc }));
const { manifest } = await import('../../index.js');

const SID = '0190a000-0000-7000-8000-00000000c0d1';
const ROUTE: Record<(typeof READS)[number], string> = { getMe: '/v1/identity/me', listOwnSessions: '/v1/identity/me/sessions', listOwnMfaFactors: '/v1/identity/me/mfa-factors' };
const staff = (over: Record<string, unknown> = {}) => ({ ...claimsA, aal: 'aal2', lims_session_id: SID, session_state: 'active', ...over }) as any;
const partner = (over: Record<string, unknown> = {}) => ({ sub: SUB, tenant_id: TENANT_A, membership_id: MEMBERSHIP, actor_type: 'partner', partner_role: 'referrer', aal: 'aal1', lims_session_id: SID, session_state: 'active', ...over }) as any;

/** Real handler behind the real pipeline. stage 8a would assert the x-permission in enforce mode; the rig wrapper asserts like the central check does. */
async function call(operationId: (typeof READS)[number], claims: any, req: Record<string, unknown> = {}) {
  const rig = makeRig();
  const real = (manifest.handlers as any)[operationId];
  const run = () => rig.run({
    claims, op: { module: 'identity', operationId, method: 'GET', routeTemplate: ROUTE[operationId], context: 'tenant' },
    req: { params: {}, query: {}, headers: {}, body: undefined, ...req },
    handler: async (r: any, c: any) => { await c.ports.IdentityPort.assertRole(c, { permission: 'identity.self.manage' }); return real(r, c); },
  });
  try { return { ok: true as const, r: await run() }; } catch (e) { return { ok: false as const, e: e as LimsError }; }
}

beforeEach(() => { for (const op of READS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op } })); });

describe('a signed in admin (tenant session with its session id claim): the three operations answer 200, not 401', () => {
  it.each(READS)('%s -> 200 and the service gets THIS session as sessionId (from the verified claims) and this user as actor', async (op) => {
    const out = await call(op, staff());
    expect(out.ok, out.ok ? '' : String((out as any).e?.code)).toBe(true);
    expect((out as any).r.status).toBe(200);
    expect(svc[op]).toHaveBeenCalledTimes(1);
    const c = svc[op]!.mock.calls[0]![0];
    expect(c.sessionId).toBe(SID); expect(c.tenantId).toBe(TENANT_A); expect(c.actor).toMatchObject({ type: 'user', id: SUB });
  });
  it.each(READS)('%s works for a partner session as well (actor type partner)', async (op) => {
    const out = await call(op, partner());
    expect(out.ok, out.ok ? '' : String((out as any).e?.code)).toBe(true);
    expect(svc[op]!.mock.calls[0]![0].actor).toMatchObject({ type: 'partner', id: SUB });
  });
  it('listOwnSessions passes only limit / cursor on to the service (no other query key)', async () => {
    await call('listOwnSessions', staff(), { query: { limit: '50', user_id: 'x', session_id: 'y' } });
    expect(svc['listOwnSessions']!.mock.calls[0]![1]).toEqual({ limit: '50' });
  });
});

describe('refusals stay: no session id in the verified claims -> auth.unauthenticated (401), service never called', () => {
  const noSid = () => { const { lims_session_id: _d, ...c } = staff(); return c; };
  it.each(READS)('%s: claims without lims_session_id', async (op) => {
    const out = await call(op, noSid());
    expect(out.ok).toBe(false); expect((out as any).e.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it.each(READS)('%s: claims with a lims_session_id that is not a UUID', async (op) => {
    const out = await call(op, staff({ lims_session_id: 'current' }));
    expect(out.ok).toBe(false); expect((out as any).e.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it.each(READS)('%s: a session id named by the request (query, header, params, body) is never used in place of the claim', async (op) => {
    const evil = { sessionId: SID, session_id: SID, lims_session_id: SID, 'x-session-id': SID };
    const out = await call(op, noSid(), { query: evil, headers: evil, params: evil, body: evil });
    expect(out.ok).toBe(false); expect((out as any).e.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it.each(READS)('%s: a device actor is refused (self service is for user and partner sessions)', async (op) => {
    const out = await call(op, { sub: SUB, tenant_id: TENANT_A, actor_type: 'device', lims_session_id: SID });
    expect(out.ok).toBe(false); expect((out as any).e.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it.each(READS)('%s: a claims set without tenant (platform shape) is refused', async (op) => {
    const { tenant_id: _t, ...noTenant } = staff();
    const out = await call(op, noTenant);
    expect(out.ok).toBe(false); expect((out as any).e.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
});

describe('the service\'s own refusals still reach the caller unchanged (revoked / expired session, wrong state)', () => {
  it.each(READS)('%s: service says auth.unauthenticated (session not live) -> the call fails with it, no body', async (op) => {
    svc[op]!.mockRejectedValueOnce(new LimsError('auth.unauthenticated'));
    const out = await call(op, staff());
    expect(out.ok).toBe(false); expect((out as any).e.code).toBe('auth.unauthenticated');
  });
  it.each(READS)('%s: service says auth.forbidden -> 403 kind, not turned into a success', async (op) => {
    svc[op]!.mockRejectedValueOnce(new LimsError('auth.forbidden'));
    const out = await call(op, staff());
    expect(out.ok).toBe(false); expect((out as any).e.code).toBe('auth.forbidden');
  });
});
