// T9 confirmEmailToken (03-APP-FLOW s3.7, SS1; 01-PRD AC-A7.2, AC-A8.2; 07-SECURITY AU-T6, AU-T21, REQ-SEC-075/076; 08 A25 D-212, D-219).
// Invalid / used / expired / unknown / wrong-type tokens -> the SAME problem body (recovery: auth.reset_token_invalid, invite: auth.invite_invalid). TTL is GoTrue's: the handler has no clock check.
// Expected now: fail (handlers/confirmEmailToken.ts is a stub; no createConfirmEmailToken).
import { describe, expect, it } from 'vitest';
import { CLIENT_IP, MEMB_A, REQ_ID, TENANT_A, errBody, makeWorld, otherWrites, platformRow, rejection, sha256, tenantRow } from './recovery.helpers.js';
import { LimsError } from '../../../../core/errors.js';
import { createConfirmEmailToken } from '../confirmEmailToken.js';

type W = Awaited<ReturnType<typeof makeWorld>>;
const handler = (w: W) => createConfirmEmailToken(w.deps as any) as any;
const link = async (w: W, type: 'recovery' | 'invite', a: { row?: any } = {}) => {
  const u = await w.addUser(a.row ? { row: a.row } : {});
  if (type === 'recovery') await w.gw.sendRecovery(u.email, '/auth/confirm');
  else { /* invite: the user exists; the fake sends invites only to NEW addresses, so create a fresh invitee and map its context row */
    const email = `inv-${Math.random().toString(36).slice(2, 8)}@lims-test.example`; await w.gw.sendInvite(email, '/auth/confirm'); const f = await w.gw.adminFindUserByEmail(email); w.store.ctxRows.set(f!.userId, a.row ?? tenantRow()); return { ...u, email, userId: f!.userId, hash: w.fake!.mailbox.latestTokenHash(email, 'invite')! };
  }
  return { ...u, hash: w.fake!.mailbox.latestTokenHash(u.email, 'recovery')! };
};
const ALLOWED = ['insertSession', 'recordTenant'];

describe('success path: valid link -> password_setup session (SS1)', () => {
  it('200 { session_token (43 chars), session{ session_id, kind tenant_staff, state password_setup, aal aal1, idle/absolute ISO } }; cookie token never stored raw (sha256 only)', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery'); const r = await w.call(handler(w), { body: { token_hash: l.hash, type: 'recovery' } });
    expect(r.status).toBe(200); expect(r.body.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.session).toMatchObject({ kind: 'tenant_staff', state: 'password_setup', aal: 'aal1' }); expect(r.body.session.session_id).toMatch(/^[0-9a-f-]{36}$/);
    const [ins] = w.store.committed('insertSession').map((x) => x.arg); expect(Buffer.from(ins.tokenSha256).equals(sha256(r.body.session_token))).toBe(true);
    expect(JSON.stringify(ins)).not.toContain(r.body.session_token);
    expect(Date.parse(r.body.session.absolute_expires_at)).not.toBeNaN(); expect(Date.parse(r.body.session.idle_expires_at)).toBeLessThanOrEqual(Date.parse(r.body.session.absolute_expires_at));
  });
  it('SS1: absolute_expires_at = now + 15 min; GoTrue tokens handed to the repo RAW for sealing (access/refresh), state password_setup, aal aal1, tenant+membership from app.identity_login_context(sub) ONLY', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery'); await w.call(handler(w), { body: { token_hash: l.hash, type: 'recovery' } });
    const [s] = w.store.committed('insertSession').map((x) => x.arg);
    expect(s).toMatchObject({ kind: 'tenant_staff', state: 'password_setup', aal: 'aal1', tenantId: TENANT_A, membershipId: MEMB_A, userId: l.userId, clientIp: CLIENT_IP });
    expect(new Date(s.absoluteExpiresAt).getTime()).toBe(w.clock.ms + 15 * 60_000); expect(new Date(s.idleExpiresAt).getTime()).toBeLessThanOrEqual(new Date(s.absoluteExpiresAt).getTime());
    expect(typeof s.accessToken).toBe('string'); expect(typeof s.refreshToken).toBe('string'); expect(s.gotrueSessionId).toBeTruthy();
    expect(w.calls.filter((c) => c.method === 'verifyEmailToken')).toEqual([{ method: 'verifyEmailToken', args: [l.hash, 'recovery'] }]);
  });
  it('D-212 order: loginContext(sub) -> tx.bindTenant(tenant of the DEFINER row) ONCE -> insertSession -> tenant auth event recovery_link_opened (invite: invite_link_opened); nothing else written', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery'); await w.call(handler(w), { body: { token_hash: l.hash, type: 'recovery' } });
    const o = w.store.order; const iCtx = o.indexOf('loginContext'), iBind = o.indexOf(`bindTenant:${TENANT_A}`), iIns = o.indexOf('insertSession');
    expect(iCtx).toBeGreaterThanOrEqual(0); expect(iBind).toBeGreaterThan(iCtx); expect(iIns).toBeGreaterThan(iBind); expect(o.filter((x) => x.startsWith('bindTenant'))).toHaveLength(1);
    expect(w.store.eventsOf('recovery_link_opened')).toHaveLength(1); expect(w.store.eventsOf('recovery_link_opened')[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A, userId: l.userId, requestId: REQ_ID, clientIp: CLIENT_IP });
    expect(otherWrites(w.store, ALLOWED)).toEqual([]); expect(w.txCalls).toHaveLength(1); expect(w.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'confirmEmailToken', context: 'identity_auth' } });
    const w2 = await makeWorld(); const l2 = await link(w2, 'invite'); await w2.call(handler(w2), { body: { token_hash: l2.hash, type: 'invite' } });
    expect(w2.store.eventsOf('invite_link_opened')).toHaveLength(1); expect(w2.store.eventsOf('recovery_link_opened')).toHaveLength(0);
  });
  it('AC-A8.1 (invite link): type=invite -> same session shape; the tenant comes from the DEFINER row of the invitee, never the body', async () => {
    const w = await makeWorld(); const l = await link(w, 'invite'); const r = await w.call(handler(w), { body: { token_hash: l.hash, type: 'invite' } });
    expect(r.status).toBe(200); expect(r.body.session.state).toBe('password_setup'); expect(w.store.committed('insertSession')[0]!.arg.tenantId).toBe(TENANT_A);
  });
  it('platform staff invite/recovery: no bindTenant, insertPlatformSession (state password_setup), tenant-less event', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery', { row: platformRow() }); const r = await w.call(handler(w), { body: { token_hash: l.hash, type: 'recovery' } });
    expect(r.body.session).toMatchObject({ kind: 'platform', state: 'password_setup' }); expect(w.tx.bindTenant).not.toHaveBeenCalled();
    expect(w.store.committed('insertPlatformSession')).toHaveLength(1); expect(w.store.committed('insertSession')).toHaveLength(0); expect(w.store.committed('recordTenant')).toHaveLength(0);
  });
  it('the GoTrue token is single-use through the handler: a second confirm of the same link is rejected, and no second session exists', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery'); const h = handler(w);
    await w.call(h, { body: { token_hash: l.hash, type: 'recovery' } }); const e = await rejection(w.call(h, { body: { token_hash: l.hash, type: 'recovery' } }));
    expect(e.code).toBe('auth.reset_token_invalid'); expect(w.store.committed('insertSession')).toHaveLength(1);
  });
});

describe('AC-A7.2 / AC-A8.2 / AU-T6: invalid links answer identically', () => {
  const bad = async (w: W, kind: 'unknown' | 'used' | 'expired' | 'wrong_type' | 'empty_like', type: 'recovery' | 'invite') => {
    if (kind === 'unknown') return 'x'.repeat(43);
    const l = await link(w, type); const h = handler(w);
    if (kind === 'used') { await w.call(h, { body: { token_hash: l.hash, type } }); return l.hash; }
    if (kind === 'expired') { w.advance(3601 * 1000); return l.hash; }                 // 61 min (AU-T6)
    if (kind === 'wrong_type') return l.hash;                                          // presented with the other type below
    return 'a';
  };
  for (const type of ['recovery', 'invite'] as const) {
    const code = type === 'recovery' ? 'auth.reset_token_invalid' : 'auth.invite_invalid';
    it(`${type}: unknown / used / expired (61 min) / wrong-type tokens -> 400 ${code}, byte-identical problem body, no loginContext, no bindTenant, no session, no event write that differs`, async () => {
      const bodies: string[] = [];
      for (const kind of ['unknown', 'used', 'expired', 'wrong_type'] as const) {
        const w = await makeWorld(); const t = await bad(w, kind, type); const sendType = kind === 'wrong_type' ? (type === 'recovery' ? 'invite' : 'recovery') : type;
        const sendCode = kind === 'wrong_type' ? (sendType === 'recovery' ? 'auth.reset_token_invalid' : 'auth.invite_invalid') : code;
        const s0 = w.store.committed('insertSession').length; const o0 = w.store.order.length;
        const e = await rejection(w.call(handler(w), { body: { token_hash: t, type: sendType } })); expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe(sendCode); expect(e.statusCode).toBe(400);
        expect(w.store.committed('insertSession').length).toBe(s0); expect(w.store.order.slice(o0)).not.toContain('loginContext'); expect(w.tx.bindTenant).not.toHaveBeenCalled();
        if (kind !== 'wrong_type') bodies.push(errBody(e));
      }
      expect(new Set(bodies).size).toBe(1);
    });
  }
  it('59 min 59 s is still valid, 61 min is not (GoTrue TTL 3600 s, no LIMS-side clock: the handler passes the hash to GoTrue and trusts the answer)', async () => {
    const w = await makeWorld(); const a = await link(w, 'recovery'); const b = await link(w, 'recovery'); w.advance(3599 * 1000);
    expect((await w.call(handler(w), { body: { token_hash: a.hash, type: 'recovery' } })).status).toBe(200); w.advance(2 * 1000);
    expect((await rejection(w.call(handler(w), { body: { token_hash: b.hash, type: 'recovery' } }))).code).toBe('auth.reset_token_invalid');
  });
  it('GoTrue fakes a "valid" answer for a user with no membership and no platform row (partner-only / orphan): no session is created, error is the type-specific invalid code', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery', { row: tenantRow({ membership_count: 0, tenant_id: null, tenant_status: null, membership_id: null, membership_status: null, membership_locked: null }) });
    await rejection(w.call(handler(w), { body: { token_hash: l.hash, type: 'recovery' } })); expect(w.store.committed('insertSession')).toHaveLength(0); expect(w.store.committed('insertPlatformSession')).toHaveLength(0);
  });
});

describe('failure, validation and hygiene', () => {
  it('GoTrue outage on verify -> 503 common.dependency_unavailable (NOT the invalid-link body), nothing written', async () => {
    const w = await makeWorld(); const h = createConfirmEmailToken({ ...(w.deps as any), gotrue: { verifyEmailToken: async () => { throw new LimsError('common.dependency_unavailable'); } } })!;
    const e = await rejection((h as any)(w.req({ body: { token_hash: 'abc', type: 'recovery' } }), w.makeHctx().hctx)); expect(e.code).toBe('common.dependency_unavailable'); expect(w.store.committed()).toHaveLength(0);
  });
  it.each([[{}], [{ token_hash: 'x' }], [{ type: 'recovery' }], [{ token_hash: 'x', type: 'magiclink' }], [{ token_hash: 'x'.repeat(257), type: 'recovery' }], [{ token_hash: 5, type: 'recovery' }], [{ token_hash: 'x', type: 'recovery', tenant_id: TENANT_A }], [{ token_hash: 'x', type: 'invite', membership_id: MEMB_A }], [undefined]])(
    'body %j -> 400 common.validation_failed before any identityAuthTx / GoTrue call', async (body) => {
      const w = await makeWorld(); const e = await rejection(w.call(handler(w), { body })); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls).toHaveLength(0); expect(w.calls).toHaveLength(0);
    });
  it('token_hash and the session token never reach logs or auth events; client IP is ctx.clientIp (P-61)', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery'); const r: any = w.req({ body: { token_hash: l.hash, type: 'recovery' } }); r.headers['x-forwarded-for'] = '10.9.9.9';
    const out = await handler(w)(r, w.makeHctx().hctx); const all = JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.store.writes.filter((x) => x.m.startsWith('record') || x.m === 'enqueue')]);
    expect(all).not.toContain(l.hash); expect(all).not.toContain(out.body.session_token); expect(all).not.toContain(l.email); expect(all).not.toMatch(/10\.9\.9\.9/);
    const bad = await rejection(w.call(handler(w), { body: { token_hash: 'zzz-hash-sentinel', type: 'recovery' } })); expect(JSON.stringify([bad.message, bad.detail, w.log.warn.mock.calls])).not.toContain('zzz-hash-sentinel');
  });
});
