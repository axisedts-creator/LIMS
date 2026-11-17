// T8 resolveSession (02-TRD s5.1, s4 items 5-8; 03-APP-FLOW s3.5, SS9/SS10; 01-PRD AC-A4.1-3; 07-SECURITY AU-T7, AU-T13, AU-T18, P-42).
// done_when: refresh serialised by row lock; touch <= 1/min.   Seams: session.helpers.ts header.
// Expected now: all fail (handlers/resolveSession.ts does not exist - the manifest still holds the common.internal stub).
import { describe, expect, it } from 'vitest';
import { createResolveSession } from '../resolveSession.js';
import { CLIENT_IP, HOUR, MIN, OLD_ACCESS, OLD_REFRESH, REQ_ID, SYSTEM_ACTOR, TENANT_A, MEMB_A, STAFF_ID, idN, makeSessionWorld, otherWrites, rejection, sha256, sinks, tokenN, type Kind, type SessionWorld } from './session.helpers.js';

const START_MS = new Date('2026-11-11T04:00:00.000Z').getTime();
const iso = (d: Date | number) => new Date(d).toISOString();
async function resolve(w: SessionWorld, a: { token?: string; body?: unknown; key?: string | null; deps?: any; ctx?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
  const { hctx, commitOnError } = w.makeHctx({ ...(a.key === null ? { bffKey: undefined } : a.key ? { bffKey: a.key } : {}), ...(a.ctx ?? {}) });
  const handler = createResolveSession(a.deps ?? w.deps);
  const run = () => handler(w.req({ ...(a.token ? { token: a.token } : {}), body: 'body' in a ? a.body : { touch: false }, ...(a.headers ? { headers: a.headers } : {}) }) as any, hctx);
  return { run, commitOnError, hctx };
}
const ok = async (w: SessionWorld, a: Parameters<typeof resolve>[1] = {}) => { const r = await (await resolve(w, a)).run() as any; expect(r.status).toBe(200); return r.body; };
const fail = async (w: SessionWorld, a: Parameters<typeof resolve>[1] = {}) => rejection((await resolve(w, a)).run());
const touches = (w: SessionWorld) => w.store.committed('touchSession');

describe('resolveSession: happy path and shape', () => {
  it('active tenant_staff session: 200 ResolvedSession with the stored access JWT, ONE identityAuthTx, bindTenant once from the session row, no write, no GoTrue call', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession();
    const b = await ok(w, { token, body: { touch: false } });
    expect(b).toEqual({ access_token: OLD_ACCESS, access_expires_at: iso(row.accessExpiresAt), session: { session_id: row.sessionId, kind: 'tenant_staff', state: 'active', aal: 'aal2',
      idle_expires_at: iso(row.idleExpiresAt), absolute_expires_at: iso(row.absoluteExpiresAt), ...(b.session.actor ? { actor: b.session.actor } : {}) } });   // actor has no source yet (.orchestra/cr/T6.md): allowed, not required
    expect(w.txCalls).toHaveLength(1);
    expect(w.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'resolveSession', context: 'identity_auth' }, requestId: REQ_ID, clientIp: CLIENT_IP });
    const o = w.store.order; expect(o.filter((x) => x.startsWith('bindTenant'))).toEqual([`bindTenant:${TENANT_A}`]);
    expect(o.indexOf('sessionByToken')).toBeLessThan(o.indexOf(`bindTenant:${TENANT_A}`)); expect(o.indexOf(`bindTenant:${TENANT_A}`)).toBeLessThan(o.indexOf('loadSession'));
    expect(w.gw.calls).toHaveLength(0); expect(w.store.committed()).toHaveLength(0);
  });
  it('platform session: staff_web key, NO bindTenant, 200', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ kind: 'platform' });
    const b = await ok(w, { token }); expect(b.session.kind).toBe('platform'); expect(w.store.order.some((x) => x.startsWith('bindTenant'))).toBe(false);
  });
  it('partner session with the partner key: 200', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ kind: 'partner' });
    expect((await ok(w, { token, key: 'partner' })).session.kind).toBe('partner');
  });
  it('the tenant comes from the session row, never from the request: a forged x-tenant-id header / cookie is ignored (D-212)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession();
    await ok(w, { token, headers: { 'x-tenant-id': idN(0x9999), 'x-lims-tenant': idN(0x9999) } });
    expect(w.store.order.filter((x) => x.startsWith('bindTenant'))).toEqual([`bindTenant:${TENANT_A}`]);
  });
  it('client IP is ctx.clientIp, never a header (P-61)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ idleExpiresAt: new Date(START_MS - 1) });
    await fail(w, { token, headers: { 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '10.8.8.8' } });
    expect(w.store.eventsOf('session_expired_idle')[0].clientIp).toBe(CLIENT_IP); expect(JSON.stringify(w.txCalls)).not.toMatch(/10\.(9|8)\.\d\.\d/);
  });
  it('logs, events and the response never carry the refresh token or the cookie token; the refresh token is not in the response at all', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ accessExpiresAt: new Date(w.clock.ms + 30_000) });
    const b = await ok(w, { token });
    expect(JSON.stringify(b)).not.toMatch(/refresh/i); expect(JSON.stringify(b)).not.toContain(OLD_REFRESH); expect(JSON.stringify(b)).not.toContain('REFRESH-NEW');
    const s = sinks(w); for (const secret of [token, OLD_REFRESH, 'REFRESH-NEW-1', OLD_ACCESS]) expect(s).not.toContain(secret);
  });
});
describe('resolveSession: request validation and unknown sessions (E-9: all 401s look identical)', () => {
  it.each([[undefined], [{}], [{ touch: 'yes' }], [{ touch: 1 }], [{ touch: null }], [{ touch: true, tenant_id: 'x' }], [[]], [null]])('body %j -> 400 common.validation_failed BEFORE any identityAuthTx', async (body) => {
    const w = await makeSessionWorld(); const { token } = w.addSession();
    const e = await fail(w, { token, body }); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls).toHaveLength(0);
  });
  it.each([['no cookie', undefined], ['malformed token', 'short'], ['non-base64url token', `${'!'.repeat(43)}`]])('%s -> 401 auth.session_expired, no identityAuthTx, no write', async (_n, token) => {
    const w = await makeSessionWorld(); w.addSession();
    const e = await fail(w, { ...(token ? { token } : {}) }); expect(e.code).toBe('auth.session_expired'); expect(w.txCalls).toHaveLength(0); expect(w.store.committed()).toHaveLength(0);
  });
  it('well-formed but unknown token -> 401 auth.session_expired; the DEFINER lookup is the only access: no bindTenant, no write, no commitOnError', async () => {
    const w = await makeSessionWorld(); w.addSession(); const r = await resolve(w, { token: tokenN(0x777) }); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired'); expect(w.store.order).toEqual(['sessionByToken']); expect(w.store.committed()).toHaveLength(0); expect(r.commitOnError).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'expired'])('a %s session (the DEFINER still returns the row) -> 401, no refresh, no write, no second expiry event', async (state) => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ state, accessExpiresAt: new Date(w.clock.ms + 10_000) });
    const r = await resolve(w, { token, body: { touch: true } }); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired'); expect(w.gw.calls).toHaveLength(0); expect(w.store.committed()).toHaveLength(0); expect(r.commitOnError).not.toHaveBeenCalled();
  });
  it('a session whose loadSession row vanished under the lock (race with purge) -> 401', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); const d = { ...w.deps, repo: { ...w.deps.repo, loadSession: async () => undefined } };
    expect((await fail(w, { token, deps: d })).code).toBe('auth.session_expired'); expect(row.state).toBe('active');
  });
  it('no system actor on the context -> common.internal (every write is created_by the identity system actor)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession();
    expect((await fail(w, { token, ctx: { actor: undefined } })).code).toBe('common.internal');
  });
});

describe('resolveSession: kind x BFF key binding (AU-T13)', () => {
  const cases: Array<[Kind, string | null]> = [['tenant_staff', 'partner'], ['tenant_staff', null], ['platform', 'partner'], ['partner', 'staff_web'], ['partner', null], ['patient', 'staff_web'], ['patient', 'partner'],
    ['staff_mobile', 'staff_web'], ['staff_mobile', 'partner'], ['tenant_staff', 'patient'], ['tenant_staff', 'unknown_bff']];
  it.each(cases)('session kind %s presented with BFF key %s -> 401 auth.session_expired, nothing written, nothing refreshed', async (kind, key) => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ kind, accessExpiresAt: new Date(w.clock.ms + 10_000) });
    const r = await resolve(w, { token, key, body: { touch: true } }); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired'); expect(w.store.committed()).toHaveLength(0); expect(w.gw.calls).toHaveLength(0); expect(row.state).toBe('active');
  });
});

describe('resolveSession: lock and tenant status (AU-T18; x-error-codes)', () => {
  it('membership locked_at set -> 403 auth.account_locked, no refresh', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ membershipLocked: true, accessExpiresAt: new Date(w.clock.ms + 10_000) });
    expect((await fail(w, { token })).code).toBe('auth.account_locked'); expect(w.gw.calls).toHaveLength(0);
  });
  it.each(['suspended', 'offboarded'])('tenant status %s -> 403 identity.tenant_suspended, no refresh, no touch', async (st) => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ tenantStatus: st, accessExpiresAt: new Date(w.clock.ms + 10_000) }); w.advance(2 * MIN);
    expect((await fail(w, { token, body: { touch: true } })).code).toBe('identity.tenant_suspended'); expect(w.gw.calls).toHaveLength(0); expect(touches(w)).toHaveLength(0);
  });
});

describe('resolveSession: touch <= 1/min (done_when; 03-APP-FLOW s3.5 rule 1)', () => {
  it('touch=true and last_seen_at 60 s old (boundary, >=) -> last_seen_at = now, idle_expires_at = now + idle_timeout_minutes; the response shows the new idle', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ idleTimeoutMinutes: 30, idleExpiresAt: new Date(w.clock.ms + 30 * MIN) }); w.advance(60_000);
    const b = await ok(w, { token, body: { touch: true } });
    expect(touches(w)).toHaveLength(1); expect(touches(w)[0]!.arg).toMatchObject({ ref: { sessionId: row.sessionId }, actorId: SYSTEM_ACTOR });
    expect(touches(w)[0]!.arg.lastSeenAt).toEqual(new Date(w.clock.ms)); expect(touches(w)[0]!.arg.idleExpiresAt).toEqual(new Date(w.clock.ms + 30 * MIN));
    expect(b.session.idle_expires_at).toBe(iso(w.clock.ms + 30 * MIN)); expect(row.lastSeenAt).toEqual(new Date(w.clock.ms));
  });
  it('touch=true but last_seen_at only 59.999 s old -> no write, idle unchanged', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); const idle0 = row.idleExpiresAt; w.advance(59_999);
    const b = await ok(w, { token, body: { touch: true } }); expect(touches(w)).toHaveLength(0); expect(b.session.idle_expires_at).toBe(iso(idle0));
  });
  it('a user clicking every second for 130 s writes at most once per 60 s (2 touches), and consecutive touches are >= 60 s apart', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession();
    for (let i = 0; i < 130; i++) { w.advance(1000); await ok(w, { token, body: { touch: true } }); }
    const t = touches(w).map((x) => (x.arg.lastSeenAt as Date).getTime()); expect(t).toHaveLength(2); expect(t[1]! - t[0]!).toBeGreaterThanOrEqual(60_000);
  });
  it('2 h of clicks every 30 s keeps the session alive with touches >= 60 s apart (idle never fires for an active user)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession();
    for (let i = 0; i < 240; i++) { w.advance(30_000); const b = await ok(w, { token, body: { touch: true } }); expect(b.session.state).toBe('active'); }
    const t = touches(w).map((x) => (x.arg.lastSeenAt as Date).getTime()); expect(t.length).toBeGreaterThan(100); for (let i = 1; i < t.length; i++) expect(t[i]! - t[i - 1]!).toBeGreaterThanOrEqual(60_000);
  });
  it('2 parallel touch=true resolves with a touch due -> ONE touch write (the row lock makes the second see the new last_seen_at)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); w.advance(2 * MIN);
    await Promise.all([ok(w, { token, body: { touch: true } }), ok(w, { token, body: { touch: true } })]); expect(touches(w)).toHaveLength(1);
  });
  it('the X-Lims-Background header is the BFF\'s business: the API reads only body.touch (header ignored)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); w.advance(2 * MIN);
    await ok(w, { token, body: { touch: true }, headers: { 'x-lims-background': '1' } }); expect(touches(w)).toHaveLength(1);
    w.advance(2 * MIN); await ok(w, { token, body: { touch: false }, headers: { 'x-lims-background': '0' } }); expect(touches(w)).toHaveLength(1);
  });
});

describe('resolveSession: background polling does not extend idle (AC-A4.2, AU-T7)', () => {
  it('a status board polling every 30 s with touch=false for 14.5 min never writes a touch; at 15 min the session is expired (401) although polled all along', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); let last: any;
    for (let i = 0; i < 29; i++) { w.advance(30_000); last = await ok(w, { token, body: { touch: false } }); }
    expect(touches(w)).toHaveLength(0); expect(last.session.idle_expires_at).toBe(iso(START_MS + 15 * MIN));
    w.advance(30_000);   // t = 15 min exactly
    const r = await resolve(w, { token, body: { touch: false } }); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired'); expect(row.state).toBe('expired');
  });
});

describe('resolveSession: idle expiry with an injected clock (AC-A4.1; SS10 lazy + idempotent)', () => {
  it('idle_expires_at - 1 ms -> 200; at idle_expires_at -> 401 auth.session_expired', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); w.advance(15 * MIN - 1); await ok(w, { token, body: { touch: false } });
    w.advance(1); expect((await fail(w, { token })).code).toBe('auth.session_expired');
  });
  it('after a touch at +61 s the idle window moves (+61 s + 15 min); the session survives the OLD deadline and dies at the new one', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); w.advance(61_000); await ok(w, { token, body: { touch: true } });
    w.advance(15 * MIN - 61_000 + 1000); await ok(w, { token, body: { touch: false } });      // t = 15 min + 1 s: past the ORIGINAL deadline, inside the new one
    w.advance(60_000);                                                                          // -> exactly the new idle_expires_at (61 s + 15 min)
    expect(w.clock.ms).toBe(START_MS + 61_000 + 15 * MIN); expect((await fail(w, { token })).code).toBe('auth.session_expired');
  });
  it('first detection writes SS10 and survives the 401: expireSession + session_expired_idle committed (commitOnError once), no other write, no sign-out job', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); w.advance(16 * MIN);
    const r = await resolve(w, { token, body: { touch: true } }); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired'); expect(r.commitOnError).toHaveBeenCalledTimes(1);
    expect(w.store.committed('expireSession')).toHaveLength(1); expect(w.store.committed('expireSession')[0]!.arg).toMatchObject({ reason: 'idle', actorId: SYSTEM_ACTOR, ref: { sessionId: row.sessionId } });
    expect(row.state).toBe('expired'); expect(otherWrites(w.store, ['expireSession', 'recordTenant'])).toEqual([]);
    const ev = w.store.eventsOf('session_expired_idle'); expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ sessionId: row.sessionId, userId: row.userId, tenantId: TENANT_A, membershipId: MEMB_A, clientIp: CLIENT_IP, requestId: REQ_ID });
    expect(touches(w)).toHaveLength(0); expect(w.gw.calls).toHaveLength(0);
  });
  it('idempotent: a second resolve of the expired session writes nothing more; 2 PARALLEL resolves of a lapsed session write ONE expiry + ONE event', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); w.advance(20 * MIN);
    const rs = await Promise.allSettled([resolve(w, { token }).then((r) => r.run()), resolve(w, { token }).then((r) => r.run())]);
    expect(rs.every((x) => x.status === 'rejected' && (x.reason as any).code === 'auth.session_expired')).toBe(true);
    expect(w.store.committed('expireSession')).toHaveLength(1); expect(w.store.eventsOf('session_expired_idle')).toHaveLength(1);
    expect((await fail(w, { token })).code).toBe('auth.session_expired'); expect(w.store.committed('expireSession')).toHaveLength(1); expect(w.store.eventsOf('session_expired_idle')).toHaveLength(1);
  });
  it('platform session: expiry goes through recordTenantless, no bindTenant', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ kind: 'platform' }); w.advance(16 * MIN); await fail(w, { token });
    expect(w.store.committed('recordTenantless').filter((x) => x.arg.eventType === 'session_expired_idle')).toHaveLength(1); expect(w.store.committed('recordTenant')).toHaveLength(0);
    expect(w.store.order.some((x) => x.startsWith('bindTenant'))).toBe(false);
  });
});

describe('resolveSession: absolute expiry with an injected clock (AC-A4.3)', () => {
  it('a user active every 10 min for 12 h: alive at 11 h 50 min, dead at 12 h regardless of activity (session_expired_absolute)', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession();
    for (let i = 1; i < 72; i++) { w.advance(10 * MIN); const b = await ok(w, { token, body: { touch: true } }); expect(b.session.state).toBe('active'); }
    expect(w.clock.ms).toBe(START_MS + 12 * HOUR - 10 * MIN); w.advance(10 * MIN);
    const r = await resolve(w, { token, body: { touch: true } }); const e = await rejection(r.run());
    expect(e.code).toBe('auth.session_expired'); expect(row.state).toBe('expired'); expect(row.expiredReason).toBe('absolute'); expect(w.store.eventsOf('session_expired_absolute')).toHaveLength(1); expect(w.store.eventsOf('session_expired_idle')).toHaveLength(0);
    expect(r.commitOnError).toHaveBeenCalledTimes(1);
  });
  it('absolute_expires_at - 1 ms -> 200 even with a fresh touch; a touch never moves absolute_expires_at', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ absoluteExpiresAt: new Date(START_MS + 2 * MIN), idleExpiresAt: new Date(START_MS + 15 * MIN) }); w.advance(2 * MIN - 1);
    const b = await ok(w, { token, body: { touch: true } }); expect(b.session.absolute_expires_at).toBe(iso(START_MS + 2 * MIN)); expect(row.absoluteExpiresAt).toEqual(new Date(START_MS + 2 * MIN));
  });
});

describe('resolveSession: access JWT refresh (done_when: serialised by the row lock; 02-TRD s4 item 7)', () => {
  const near = (w: SessionWorld, s = 100) => ({ accessExpiresAt: new Date(w.clock.ms + s * 1000) });
  it('access JWT expiring in <= 120 s (boundary) -> ONE GoTrue refresh with the stored refresh token (raw), tokens stored in the SAME tx as a pair, response carries the new access JWT', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(near(w, 120));
    const b = await ok(w, { token });
    expect(w.gw.calls).toEqual([OLD_REFRESH]); expect(b.access_token).toBe('ACCESS-NEW-1'); expect(b.access_expires_at).toBe(iso(START_MS + 3600_000));
    const u = w.store.committed('updateSession'); expect(u).toHaveLength(1);
    expect(u[0]!.arg.patch).toMatchObject({ accessToken: 'ACCESS-NEW-1', refreshToken: 'REFRESH-NEW-1', accessExpiresAt: new Date(START_MS + 3600_000), actorId: SYSTEM_ACTOR }); expect(u[0]!.arg.patch.state).toBeUndefined();
    expect(row.refreshToken).toBe('REFRESH-NEW-1'); expect(row.state).toBe('active');
  });
  it('access JWT with 121 s left -> no refresh', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(near(w, 121)); const b = await ok(w, { token });
    expect(w.gw.calls).toHaveLength(0); expect(b.access_token).toBe(OLD_ACCESS);
  });
  it('the refresh decision is taken on the row loaded UNDER the lock: loadSession precedes the GoTrue call', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(near(w, 30));
    const d = { ...w.deps, gotrue: { refresh: (t: string) => { w.store.order.push('gotrue.refresh'); return w.deps.gotrue.refresh(t); } } }; await ok(w, { token, deps: d });
    const o = w.store.order; expect(o.indexOf('loadSession')).toBeGreaterThan(-1); expect(o.indexOf('loadSession')).toBeLessThan(o.indexOf('gotrue.refresh'));
  });
  it('2 PARALLEL resolves of the same near-expiry session -> exactly ONE refresh; both answer with the new token; nothing revoked', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(near(w, 30));
    const [a, b] = await Promise.all([ok(w, { token }), ok(w, { token })]);
    expect(w.gw.calls).toEqual([OLD_REFRESH]); expect(a.access_token).toBe('ACCESS-NEW-1'); expect(b.access_token).toBe('ACCESS-NEW-1');
    expect(w.store.committed('updateSession')).toHaveLength(1); expect(row.state).toBe('active'); expect(w.store.eventsOf('refresh_failed')).toHaveLength(0);
  });
  it('8 parallel resolves (mixed touch) -> still one refresh and at most one touch', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(near(w, 10)); w.advance(2 * MIN); row.accessExpiresAt = new Date(w.clock.ms + 10_000);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => ok(w, { token, body: { touch: i % 2 === 0 } })));
    expect(w.gw.calls).toHaveLength(1); expect(new Set(rs.map((r) => r.access_token))).toEqual(new Set(['ACCESS-NEW-1'])); expect(touches(w).length).toBeLessThanOrEqual(1); expect(row.state).toBe('active');
  });
  it('the rotated token is used on the NEXT refresh (chain over 3 hours): every refresh uses the token the previous one stored, never a stale one', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession();
    for (let i = 0; i < 18; i++) { w.advance(10 * MIN); await ok(w, { token, body: { touch: true } }); }
    expect(w.gw.calls.length).toBeGreaterThanOrEqual(3); expect(w.gw.calls[0]).toBe(OLD_REFRESH); for (let i = 1; i < w.gw.calls.length; i++) expect(w.gw.calls[i]).toBe(`REFRESH-NEW-${i}`);
    expect(w.store.eventsOf('refresh_failed')).toHaveLength(0);
  });
  it('refresh and touch due together: both land in one transaction', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); w.advance(59 * MIN); row.accessExpiresAt = new Date(w.clock.ms + 60_000); row.idleExpiresAt = new Date(w.clock.ms + MIN);
    await ok(w, { token, body: { touch: true } }); expect(w.store.committed('updateSession')).toHaveLength(1); expect(touches(w)).toHaveLength(1);
  });
  it('platform session refresh: same path, no bindTenant', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ kind: 'platform', ...near(w, 30) }); const b = await ok(w, { token });
    expect(b.access_token).toBe('ACCESS-NEW-1'); expect(w.store.order.some((x) => x.startsWith('bindTenant'))).toBe(false);
  });

  describe.each(['revoked', 'reused', 'invalid'] as const)('GoTrue refresh failure "%s" (SS9 refresh_failed)', (mode) => {
    it('session revoked with reason refresh_failed + refresh_failed event + sign-out job, all KEPT through the 401 (commitOnError once, nothing else written)', async () => {
      const w = await makeSessionWorld(); const { token, row } = w.addSession(near(w, 30)); w.gw.st.mode = mode;
      const r = await resolve(w, { token }); const e = await rejection(r.run());
      expect(e.code).toBe('auth.session_expired'); expect(r.commitOnError).toHaveBeenCalledTimes(1);
      expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('refresh_failed');
      expect(w.store.committed('updateSession')[0]!.arg.patch.revoked).toEqual({ reason: 'refresh_failed' });
      const ev = w.store.eventsOf('refresh_failed'); expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ sessionId: row.sessionId, userId: row.userId, tenantId: TENANT_A, clientIp: CLIENT_IP, requestId: REQ_ID });
      const job = w.store.committed('enqueue'); expect(job).toHaveLength(1); expect(job[0]!.arg.identifier).toBe('identity.gotrue_signout'); expect(job[0]!.arg.jobKey).toMatch(/^signout:.+:refresh_failed$/); expect(job[0]!.arg.payload.user_id).toBe(row.userId);
      expect(otherWrites(w.store, ['updateSession', 'recordTenant', 'enqueue'])).toEqual([]);
      expect(sinks(w)).not.toContain(OLD_REFRESH);
    });
    it('afterwards the cookie is dead: 401 without another GoTrue call or write', async () => {
      const w = await makeSessionWorld(); const { token } = w.addSession(near(w, 30)); w.gw.st.mode = mode; await fail(w, { token });
      const n = w.store.committed().length; const g = w.gw.calls.length; expect((await fail(w, { token })).code).toBe('auth.session_expired'); expect(w.store.committed()).toHaveLength(n); expect(w.gw.calls).toHaveLength(g);
    });
  });
  it('platform kind refresh failure: the sign-out job payload is { user_id } only (a worker cannot read platform rows) and the event is tenantless', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ kind: 'platform', ...near(w, 30) }); w.gw.st.mode = 'revoked'; await fail(w, { token });
    expect(w.store.committed('enqueue')[0]!.arg.payload).toEqual({ user_id: row.userId }); expect(w.store.committed('recordTenantless').filter((x) => x.arg.eventType === 'refresh_failed')).toHaveLength(1);
  });
  it('GoTrue unreachable while the access JWT is still valid -> 200 with the CURRENT token, session untouched (no revoke, no event)', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(near(w, 60)); w.gw.st.mode = 'down';
    const b = await ok(w, { token }); expect(b.access_token).toBe(OLD_ACCESS); expect(row.state).toBe('active'); expect(w.store.committed('updateSession')).toHaveLength(0); expect(w.store.eventsOf('refresh_failed')).toHaveLength(0);
  });
  it('GoTrue unreachable and the access JWT already expired -> 503 common.dependency_unavailable (NOT a logout): session stays active, nothing revoked or expired', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(near(w, -5)); w.gw.st.mode = 'down';
    const e = await fail(w, { token }); expect(e.code).toBe('common.dependency_unavailable'); expect(row.state).toBe('active');
    expect(w.store.committed('expireSession')).toHaveLength(0); expect(w.store.eventsOf('refresh_failed')).toHaveLength(0); expect(w.store.committed().filter((x) => x.m === 'updateSession' && x.arg.patch.revoked)).toHaveLength(0);
  });
  it('after the outage the next resolve refreshes normally', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(near(w, 60)); w.gw.st.mode = 'down'; await ok(w, { token }); w.gw.st.mode = 'ok';
    expect((await ok(w, { token })).access_token).toBe('ACCESS-NEW-1');
  });
  it('an idle-expired session is NOT refreshed (expiry check first: no GoTrue call for a dead session)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(near(w, 30)); w.advance(16 * MIN); await fail(w, { token }); expect(w.gw.calls).toHaveLength(0);
  });
});

describe('resolveSession: SessionState for non-active states', () => {
  it.each(['mfa_pending', 'mfa_enrolment_required', 'password_setup'])('state %s is reported as such (the claims resolver, not this handler, refuses API access: 403)', async (state) => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ state, aal: 'aal1' }); const r = await resolve(w, { token }); const out: any = await r.run().catch((e: any) => e);
    if (out?.status === 200) { expect(out.body.session.state).toBe(state); expect(out.body.session.aal).toBe('aal1'); } else { expect(out.code).toBe('auth.session_expired'); }   // SPEC GAP: either is defensible; never a 500 / never aal2
  });
});

void [STAFF_ID, sha256, OLD_REFRESH];
