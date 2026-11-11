// T10 self service (/me), service + fake-GoTrue integration level (02-TRD s5.2; 01-PRD AC-A5.2, AC-A5.4, AC-A6.3, AC-A6.4; 07-SECURITY AU-T20, AU-T22; 08 A19 D-101, P-42).
// Real fake GoTrue (passwords / factors), in-memory SelfRepo with a REAL commit/rollback envelope, the REAL claims resolver for AC-A5.2. Seams: self.helpers.ts.
// Expected now: all fail (service/self.service.ts does not exist; handlers/getMe.ts ... removeOwnMfaFactor.ts are common.internal stubs).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaimsResolver } from '../../claims/resolver.js';
import { fakeDb, jwt, partnerRow, req as claimsReq, tenantRow } from '../../claims/__tests__/helpers.js';
import { createSelfService } from '../self.service.js';
import { NEW_PW, NOW, OLD_PW, SECRET, TENANT_A, WRONG_PW, errBody, idN, makeWorld, rejection, sinks, type FactorRow, type SessRow, type Who, type World } from './self.helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

/** world with ME (current session cur + optional others), OTHER, P1, P2, B */
async function setup(o: Parameters<typeof makeWorld>[0] = {}) {
  const w = await makeWorld(o); for (const k of ['ME', 'OTHER', 'P1', 'P2', 'B'] as Who[]) await w.addPerson(k);
  const cur: Record<string, SessRow> = {}; for (const k of ['ME', 'OTHER', 'P1', 'P2', 'B'] as Who[]) cur[k] = w.addSession(k);
  const svc = createSelfService(w.deps);
  const go = <T>(who: Who, fn: (s: ReturnType<typeof createSelfService>, ctx: any) => Promise<T>, c: Record<string, unknown> = {}) => { const r = w.run((ctx) => fn(svc, ctx), who, cur[who]!, c); return r; };
  const ok = async <T>(who: Who, fn: (s: ReturnType<typeof createSelfService>, ctx: any) => Promise<T>, c: Record<string, unknown> = {}) => (await go(who, fn, c)).promise;
  const fail = async (who: Who, fn: (s: ReturnType<typeof createSelfService>, ctx: any) => Promise<unknown>, c: Record<string, unknown> = {}) => { const r = go(who, fn, c); return { e: await rejection(r.promise), commitOnError: r.commitOnError }; };
  return { w, cur, svc, go, ok, fail };
}
const snapshot = (w: World) => JSON.stringify({ s: w.sessions, f: w.factors });
async function withGotrueFactor(w: World, who: Who, a: Partial<FactorRow> = {}) {
  const p = w.people.get(who)!; const t = await w.fake.signInWithPassword(p.email, p.password); if (!t.ok) throw new Error('signin');
  const e = await w.fake.mfaEnrollTotp(t.tokens.accessToken, 'Work phone'); const row = w.addFactor(who, { gotrue_factor_id: e.factorId, ...a }); return { row, access: t.tokens.accessToken };
}

/** the real claims resolver over a session row of the in-memory store (AC-A5.2: "rejected within one request") */
async function resolveRow(s: SessRow, kind: 'tenant_staff' | 'partner' = 'tenant_staff') {
  const row = (kind === 'partner' ? partnerRow : tenantRow)({ session_id: s.id, kind, tenant_id: s.tenant_id, membership_id: s.membership_id, state: s.state, revoked_at: s.state === 'revoked' ? NOW : null,
    idle_expires_at: s.idle_expires_at, absolute_expires_at: s.absolute_expires_at });
  const { db } = fakeDb([row]); return createClaimsResolver({ db, now: () => NOW }).resolve(jwt() as any, claimsReq({ endpointFamily: kind === 'partner' ? 'partner' : 'staff', bffKey: kind === 'partner' ? 'partner' : 'staff_web' }) as any);
}

describe('getMe', () => {
  it('staff: Me body exactly per contract (no user_id / tenant_id / token fields), 200, no write', async () => {
    const { w, ok } = await setup(); const p = w.people.get('ME')!;
    const r: any = await ok('ME', (s, c) => s.getMe(c, {}));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ membership_id: p.membershipId, display_name: 'Demo ME', email: p.email, roles: [{ role_id: expect.any(String), code: 'tenant_admin', name: 'Tenant admin' }], permissions: ['identity.self.manage'],
      centre_scope: { all: true, centre_ids: [] }, mfa: { enrolled: false, level: 'aal2' }, last_login_at: '2026-11-05T04:15:00.000Z' });
    expect(w.committed()).toHaveLength(0); expect(JSON.stringify(r.body)).not.toContain(p.userId);
  });
  it('mfa.enrolled follows a VERIFIED factor (an unverified one does not count); mfa.level is the session aal', async () => {
    const { w, ok } = await setup(); w.addFactor('ME', { status: 'unverified', verified_at: null });
    expect(((await ok('ME', (s, c) => s.getMe(c, {}))) as any).body.mfa).toEqual({ enrolled: false, level: 'aal2' });
    w.addFactor('ME', { status: 'verified' });
    expect(((await ok('ME', (s, c) => s.getMe(c, {}, ), { aal: 'aal1' })) as any).body.mfa).toEqual({ enrolled: true, level: 'aal1' });
  });
  it('last_login_at is OMITTED (never null) when the membership never logged in', async () => {
    const { w, ok } = await setup(); w.profiles.get(w.people.get('ME')!.membershipId)!.lastLoginAt = null;
    const b = ((await ok('ME', (s, c) => s.getMe(c, {}))) as any).body; expect('last_login_at' in b).toBe(false);
  });
  it('who is "me" comes from ctx only: forged userId / membershipId / tenantId in the input are ignored', async () => {
    const { w, ok } = await setup(); const other = w.people.get('OTHER')!;
    const b = ((await ok('ME', (s, c) => s.getMe(c, { userId: other.userId, membershipId: other.membershipId, tenantId: TENANT_A } as any))) as any).body;
    expect(b.membership_id).toBe(w.people.get('ME')!.membershipId); expect(b.email).not.toBe(other.email);
  });
});

describe('getMe: partner session (AU-T20, 08 A19 D-101)', () => {
  it('roles = [<partner role>], centre_scope { all:false, centre_ids:[] } EVEN IF the profile row carries centres, mfa as for staff, last_login_at', async () => {
    const { w, ok } = await setup(); const p1 = w.people.get('P1')!; const prof = w.profiles.get(p1.membershipId)!; prof.allCentres = true; prof.centreIds = [idN(0x9999)];
    const b = ((await ok('P1', (s, c) => s.getMe(c, {}))) as any).body;
    expect(b.roles.map((r: any) => r.code)).toEqual(['partner_admin']); expect(b.centre_scope).toEqual({ all: false, centre_ids: [] }); expect(b.mfa).toEqual({ enrolled: false, level: 'aal2' });
    expect(b.last_login_at).toBe('2026-11-05T04:15:00.000Z'); expect(b.permissions).toContain('identity.self.manage'); expect(b.membership_id).toBe(p1.membershipId);
  });
  it('the partner member role is reported as its own role (partner_member), not partner_admin', async () => {
    const { ok } = await setup(); expect((((await ok('P2', (s, c) => s.getMe(c, {}))) as any).body.roles).map((r: any) => r.code)).toEqual(['partner_member']);
  });
});

describe('changeOwnPassword: success (AC-A6.4)', () => {
  it('204; the new password works and the old one stops; password_changed event; ALL other sessions of the caller revoked (reason password_change) with sign-out jobs; the current session survives', async () => {
    const { w, cur, ok } = await setup(); const me = w.people.get('ME')!; const s2 = w.addSession('ME'), s3 = w.addSession('ME', { aal: 'aal1' });
    const r: any = await ok('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW }));
    expect(r.status).toBe(204); expect(r.body).toBeUndefined();
    expect((await w.fake.signInWithPassword(me.email, NEW_PW)).ok).toBe(true); expect((await w.fake.signInWithPassword(me.email, OLD_PW)).ok).toBe(false);
    expect(cur['ME']!.state).toBe('active'); expect([s2.state, s3.state]).toEqual(['revoked', 'revoked']); expect([s2.revoke_reason, s3.revoke_reason]).toEqual(['password_change', 'password_change']);
    const rv = w.committed('revokeOtherSessions'); expect(rv).toHaveLength(1);
    expect(rv[0]!.arg).toMatchObject({ tenantId: TENANT_A, userId: me.userId, exceptSessionId: cur['ME']!.id, reason: 'password_change', actorId: me.userId });
    const pc = w.eventsOf('password_changed'); expect(pc).toHaveLength(1);
    expect(pc[0]).toMatchObject({ tenantId: TENANT_A, userId: me.userId, membershipId: me.membershipId, sessionId: cur['ME']!.id, actorId: me.userId, requestId: expect.any(String), clientIp: '203.0.113.9' });
    const jobs = w.committed('enqueue').map((x) => x.arg); expect(jobs).toHaveLength(2);
    for (const s of [s2, s3]) expect(jobs).toContainEqual({ identifier: 'identity.gotrue_signout', payload: { user_id: me.userId, tenant_id: TENANT_A, session_id: s.id }, jobKey: `signout:${s.id}:password_change` });
    const rev = w.eventsOf('session_revoked'); expect(rev.map((e) => e.sessionId).sort()).toEqual([s2.id, s3.id].sort()); for (const e of rev) expect(e.reasonCode).toBe('password_change');
    expect(w.otherWrites(['revokeOtherSessions', 'recordTenant', 'enqueue'])).toEqual([]); expect(w.order).not.toContain('commitOnError');
  });
  it('only the CALLER\'s sessions are revoked: another member of the tenant and another tenant keep theirs; extra input fields cannot redirect the change', async () => {
    const { w, cur, ok } = await setup(); const other = w.people.get('OTHER')!;
    await ok('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW, userId: other.userId, tenantId: TENANT_A } as any));
    expect(cur['OTHER']!.state).toBe('active'); expect(cur['B']!.state).toBe('active'); expect((await w.fake.signInWithPassword(other.email, OLD_PW)).ok).toBe(true);
    expect((await w.fake.signInWithPassword(w.people.get('ME')!.email, NEW_PW)).ok).toBe(true);
  });
  it('terminal sessions are not touched again (no second revoke / job for an already revoked or expired session)', async () => {
    const { w, ok } = await setup(); w.addSession('ME', { state: 'revoked' }); w.addSession('ME', { state: 'expired' }); const live = w.addSession('ME');
    await ok('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW }));
    expect(w.committed('enqueue').map((x) => x.arg.payload.session_id)).toEqual([live.id]);
  });
  it('no password / hash ever reaches a log, an event, a job or an access-log entry', async () => {
    const { w, ok } = await setup(); w.addSession('ME');
    await ok('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW }));
    const s = sinks(w); for (const secret of [OLD_PW, NEW_PW]) expect(s).not.toContain(secret);
  });
  it('partner session: the same change works on its own account and leaves the other partner member untouched', async () => {
    const { w, cur, ok } = await setup(); const p1 = w.people.get('P1')!, other = w.addSession('P1');
    expect(((await ok('P1', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW }))) as any).status).toBe(204);
    expect(other.state).toBe('revoked'); expect(cur['P2']!.state).toBe('active'); expect((await w.fake.signInWithPassword(p1.email, NEW_PW)).ok).toBe(true); expect((await w.fake.signInWithPassword(w.people.get('P2')!.email, OLD_PW)).ok).toBe(true);
  });
});

describe('changeOwnPassword: wrong current password (P-42, AU-T22)', () => {
  it('401 auth.login_failed; commitOnError() is called right after the failure event, which is the ONLY write that survives; password and sessions untouched', async () => {
    const { w, cur, fail } = await setup(); const me = w.people.get('ME')!; const s2 = w.addSession('ME');
    const { e, commitOnError } = await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: WRONG_PW, newPassword: NEW_PW }));
    expect(e.code).toBe('auth.login_failed'); expect(e.statusCode).toBe(401);
    expect(commitOnError).toHaveBeenCalledTimes(1);
    const ev = w.eventsOf('login_failed'); expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ tenantId: TENANT_A, userId: me.userId, membershipId: me.membershipId, sessionId: cur['ME']!.id, reasonCode: 'auth.login_failed', clientIp: '203.0.113.9', actorId: me.userId });
    expect(w.committed().map((x) => x.m)).toEqual(['recordTenant']);                                  // "no other write of that request is" (AU-T22)
    expect(w.order.indexOf('recordTenant')).toBeLessThan(w.order.indexOf('commitOnError')); expect(w.order.slice(w.order.indexOf('commitOnError') + 1)).toEqual([]);
    expect((await w.fake.signInWithPassword(me.email, OLD_PW)).ok).toBe(true); expect(cur['ME']!.state).toBe('active'); expect(s2.state).toBe('active');
    expect(w.gcalls.some((c) => c.method === 'adminUpdatePassword' && c.args[1] === NEW_PW)).toBe(false);
  });
  it('every wrong attempt is recorded (a retried wrong password counts again) and the error / sinks carry neither password', async () => {
    const { w, fail } = await setup();
    const a = await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: WRONG_PW, newPassword: NEW_PW })); const b = await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: WRONG_PW, newPassword: NEW_PW }));
    expect(w.eventsOf('login_failed')).toHaveLength(2); expect(errBody(a.e)).toBe(errBody(b.e));
    for (const secret of [WRONG_PW, NEW_PW, OLD_PW]) { expect(errBody(a.e)).not.toContain(secret); expect(sinks(w)).not.toContain(secret); }
  });
  it('a wrong current password is checked before the new one is judged: no breached lookup for a caller who failed the current-password check', async () => {
    const { w, fail } = await setup(); await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: WRONG_PW, newPassword: NEW_PW }));
    expect(w.breached.isBreached).not.toHaveBeenCalled();
  });
});

describe('changeOwnPassword: policy and breached list (AC-A6.1-A6.3)', () => {
  it.each([['11 characters', 'Abcdefgh1!x'], ['73 UTF-8 bytes', 'a'.repeat(73)]])('%s -> 422 auth.password_policy_violation; nothing changed, no write survives', async (_n, pw) => {
    const { w, cur, fail } = await setup(); const me = w.people.get('ME')!; const s2 = w.addSession('ME');
    const { e } = await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: pw }));
    expect(e.code).toBe('auth.password_policy_violation'); expect(e.statusCode).toBe(422);
    expect(w.committed()).toHaveLength(0); expect((await w.fake.signInWithPassword(me.email, OLD_PW)).ok).toBe(true); expect([cur['ME']!.state, s2.state]).toEqual(['active', 'active']);
  });
  it('a password whose SHA-1 is in the local list -> 422 auth.password_breached; the lookup gets the 20-byte SHA-1 of the UTF-8 password; no network call; nothing changed (AC-A6.3, B11)', async () => {
    const { createHash } = await import('node:crypto'); const bad = createHash('sha1').update(NEW_PW, 'utf8').digest();
    const { w, fail } = await setup({ breached: (h) => h.equals(bad) }); const me = w.people.get('ME')!; const s2 = w.addSession('ME'); const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { e } = await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW }));
    expect(e.code).toBe('auth.password_breached'); expect(e.statusCode).toBe(422);
    expect(w.breached.isBreached).toHaveBeenCalledTimes(1); const arg = w.breached.isBreached.mock.calls[0]![1] as Buffer; expect(Buffer.isBuffer(arg) && arg.equals(bad)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled(); expect(w.committed()).toHaveLength(0); expect(s2.state).toBe('active'); expect((await w.fake.signInWithPassword(me.email, OLD_PW)).ok).toBe(true);
  });
  it('a breached-list lookup that ERRORS fails closed: the request fails and the password is NOT changed', async () => {
    const { w } = await setup(); w.breached.isBreached.mockRejectedValueOnce(new Error('db down')); const svc = createSelfService(w.deps); const me = w.people.get('ME')!;
    const r = w.run((ctx) => svc.changeOwnPassword(ctx, { currentPassword: OLD_PW, newPassword: NEW_PW }), 'ME', w.sessions.find((s) => s.user_id === me.userId)!);
    await rejection(r.promise); expect((await w.fake.signInWithPassword(me.email, OLD_PW)).ok).toBe(true); expect(w.committed()).toHaveLength(0);
  });
  it('GoTrue refusing the update fails the request and rolls EVERYTHING back (no session revoked, no event, no job)', async () => {
    const { w, cur } = await setup(); const s2 = w.addSession('ME'); const me = w.people.get('ME')!;
    const svc = createSelfService({ ...w.deps, gotrue: { ...w.deps.gotrue, signInWithPassword: w.gotrue.signInWithPassword.bind(w.gotrue), adminDeleteFactor: w.gotrue.adminDeleteFactor.bind(w.gotrue), adminUpdatePassword: async () => { throw new Error('gotrue down'); } } as any });
    await rejection(w.run((ctx) => svc.changeOwnPassword(ctx, { currentPassword: OLD_PW, newPassword: NEW_PW }), 'ME', cur['ME']!).promise);
    expect(w.committed()).toHaveLength(0); expect([cur['ME']!.state, s2.state]).toEqual(['active', 'active']); expect((await w.fake.signInWithPassword(me.email, OLD_PW)).ok).toBe(true);
  });
});

describe('listOwnSessions', () => {
  it('SessionSummaryPage: own live sessions only (this tenant, this user), contract keys, masked IP, UA family, ISO dates, no token material; default page.limit 50; no write', async () => {
    const { w, cur, ok } = await setup(); const s2 = w.addSession('ME', { user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Chrome/126.0 Safari/537.36' });
    const r: any = await ok('ME', (s, c) => s.listOwnSessions(c, {}));
    expect(r.status).toBe(200); expect(r.body.page).toEqual({ limit: 50 }); expect(r.body.data.map((d: any) => d.session_id).sort()).toEqual([cur['ME']!.id, s2.id].sort());
    const d = r.body.data.find((x: any) => x.session_id === cur['ME']!.id);
    expect(d).toEqual({ session_id: cur['ME']!.id, membership_id: w.people.get('ME')!.membershipId, display_name: 'Demo ME', state: 'active', aal: 'aal2', created_at: NOW.toISOString(), last_seen_at: NOW.toISOString(),
      idle_expires_at: new Date(NOW.getTime() + 900_000).toISOString(), absolute_expires_at: new Date(NOW.getTime() + 28_800_000).toISOString(), client_ip_masked: '203.0.x.x', user_agent_family: 'Firefox', is_support: false });
    expect(JSON.stringify(r.body)).not.toContain(SECRET); expect(JSON.stringify(r.body)).not.toContain('203.0.113.9'); expect(w.committed()).toHaveLength(0);
  });
  it('another member\'s and another tenant\'s sessions never appear; the user comes from ctx, not from the input', async () => {
    const { w, cur, ok } = await setup(); const other = w.people.get('OTHER')!;
    const ids = (((await ok('ME', (s, c) => s.listOwnSessions(c, { userId: other.userId } as any))) as any).body.data as any[]).map((x) => x.session_id);
    expect(ids).toEqual([cur['ME']!.id]); expect(ids).not.toContain(cur['OTHER']!.id); expect(ids).not.toContain(cur['B']!.id);
  });
  it('limit is honoured and echoed in page.limit', async () => {
    const { w, ok } = await setup(); w.addSession('ME'); w.addSession('ME');
    const b = ((await ok('ME', (s, c) => s.listOwnSessions(c, { limit: 2 }))) as any).body; expect(b.data).toHaveLength(2); expect(b.page.limit).toBe(2);
  });
  it('keyset paging: limit 2 over 3 own sessions -> next_cursor; the cursor page continues without overlap or gap; the last page has no next_cursor', async () => {
    const { w, cur, ok } = await setup(); cur['ME']!.last_seen_at = new Date(NOW.getTime() - 1000); const s2 = w.addSession('ME', { last_seen_at: new Date(NOW.getTime() - 2000) }); const s3 = w.addSession('ME', { last_seen_at: new Date(NOW.getTime() - 3000) });
    const p1: any = (await ok('ME', (s, c) => s.listOwnSessions(c, { limit: 2 }))).body; expect(p1.data.map((d: any) => d.session_id)).toEqual([cur['ME']!.id, s2.id]); expect(typeof p1.page.next_cursor).toBe('string');
    const p2: any = (await ok('ME', (s, c) => s.listOwnSessions(c, { limit: 2, cursor: p1.page.next_cursor }))).body; expect(p2.data.map((d: any) => d.session_id)).toEqual([s3.id]); expect(p2.page.next_cursor).toBeUndefined();
  });
  it('a forged / garbage cursor is a client error (400 common.validation_failed), never a 500 and never another user\'s rows', async () => {
    const { fail } = await setup(); const { e } = await fail('ME', (s, c) => s.listOwnSessions(c, { cursor: 'not-a-cursor!!' })); expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
  });
  it('partner: lists its own sessions, never the other partner member\'s (AU-T20)', async () => {
    const { w, cur, ok } = await setup(); const ids = (((await ok('P1', (s, c) => s.listOwnSessions(c, {}))) as any).body.data as any[]).map((x) => x.session_id);
    expect(ids).toEqual([cur['P1']!.id]); expect(ids).not.toContain(cur['P2']!.id);
  });
});

describe('revokeOwnSession (AC-A5.2, AC-A5.4)', () => {
  it('revokes ANOTHER own session: 204; reason self_revoke; session_revoked event; sign-out job; access-log session.revoke; nothing else; the current session stays active', async () => {
    const { w, cur, ok } = await setup(); const me = w.people.get('ME')!; const s2 = w.addSession('ME');
    const r: any = await ok('ME', (s, c) => s.revokeOwnSession(c, { sessionId: s2.id })); expect(r.status).toBe(204); expect(r.body).toBeUndefined();
    expect(s2.state).toBe('revoked'); expect(s2.revoke_reason).toBe('self_revoke'); expect(cur['ME']!.state).toBe('active');
    expect(w.committed('revokeSession')[0]!.arg).toMatchObject({ sessionId: s2.id, reason: 'self_revoke', actorId: me.userId });
    expect(w.eventsOf('session_revoked')).toEqual([expect.objectContaining({ sessionId: s2.id, reasonCode: 'self_revoke', userId: me.userId, membershipId: me.membershipId, tenantId: TENANT_A, actorId: me.userId })]);
    expect(w.committed('enqueue').map((x) => x.arg)).toEqual([{ identifier: 'identity.gotrue_signout', payload: { user_id: me.userId, tenant_id: TENANT_A, session_id: s2.id }, jobKey: `signout:${s2.id}:self_revoke` }]);
    expect(w.audit).toHaveBeenCalledTimes(1); expect(w.audit.mock.calls[0]![0]).toMatchObject({ action: 'session.revoke', entityType: 'session', entityId: s2.id, outcome: 'allowed' });
    expect(w.otherWrites(['revokeSession', 'recordTenant', 'enqueue'])).toEqual([]);
  });
  it('AC-A5.2: the revoked session\'s NEXT request is rejected by the claims resolver (auth.session_expired) with no wait for JWT expiry; the caller\'s own session still resolves', async () => {
    const { w, cur, ok } = await setup(); const s2 = w.addSession('ME');
    expect((await resolveRow(s2)).kind).toBe('tenant'); await ok('ME', (s, c) => s.revokeOwnSession(c, { sessionId: s2.id }));
    expect(await resolveRow(s2)).toEqual({ kind: 'rejected', code: 'auth.session_expired' }); expect((await resolveRow(cur['ME']!)).kind).toBe('tenant');
  });
  it('AC-A5.4: revoking the CURRENT session -> 409 identity.self_action_forbidden (use logout); no write, no job, no access-log row', async () => {
    const { w, cur, fail } = await setup(); const { e } = await fail('ME', (s, c) => s.revokeOwnSession(c, { sessionId: cur['ME']!.id }));
    expect(e.code).toBe('identity.self_action_forbidden'); expect(e.statusCode).toBe(409); expect(cur['ME']!.state).toBe('active'); expect(w.committed()).toHaveLength(0); expect(w.audit).not.toHaveBeenCalled();
  });
  it('the "current session" is the one in ctx.sessionId: from another device of the same user, revoking the first device is allowed and the second is the forbidden one', async () => {
    const { w, cur, go } = await setup(); const s2 = w.addSession('ME');
    await go('ME', (s, c) => s.revokeOwnSession(c, { sessionId: cur['ME']!.id }), { sessionId: s2.id }).promise; expect(cur['ME']!.state).toBe('revoked');
    const e = await rejection(go('ME', (s, c) => s.revokeOwnSession(c, { sessionId: s2.id }), { sessionId: s2.id }).promise); expect(e.code).toBe('identity.self_action_forbidden');
  });
  it('AU-T20: another member\'s / another tenant\'s / an unknown session id -> 404 common.not_found, DB unchanged, no job, no access-log, and the three errors are indistinguishable', async () => {
    const { w, cur, fail } = await setup(); const before = snapshot(w); const bodies: string[] = [];
    for (const id of [cur['OTHER']!.id, cur['B']!.id, idN(0xdead)]) {
      const { e } = await fail('ME', (s, c) => s.revokeOwnSession(c, { sessionId: id })); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); bodies.push(errBody(e));
      expect(e.message ?? '').not.toContain(id);
    }
    expect(new Set(bodies).size).toBe(1); expect(snapshot(w)).toBe(before); expect(w.committed()).toHaveLength(0); expect(w.audit).not.toHaveBeenCalled();
  });
  it('defence in depth: a repo that wrongly hands back someone else\'s row still ends in 404 with no write', async () => {
    const { w, cur } = await setup(); const svc = createSelfService({ ...w.deps, repo: { ...w.repo, findOwnSession: async () => ({ ...cur['OTHER']! }) } as any }); const before = snapshot(w);
    const e = await rejection(w.run((ctx) => svc.revokeOwnSession(ctx, { sessionId: cur['OTHER']!.id }), 'ME', cur['ME']!).promise);
    expect(e.code).toBe('common.not_found'); expect(snapshot(w)).toBe(before); expect(w.committed()).toHaveLength(0);
  });
  it('partner (AU-T20): revokes its own other session; the other partner member\'s session -> 404, unchanged', async () => {
    const { w, cur, ok, fail } = await setup(); const p1b = w.addSession('P1'); const before = JSON.stringify(cur['P2']);
    expect(((await ok('P1', (s, c) => s.revokeOwnSession(c, { sessionId: p1b.id }))) as any).status).toBe(204); expect(p1b.state).toBe('revoked');
    const { e } = await fail('P1', (s, c) => s.revokeOwnSession(c, { sessionId: cur['P2']!.id })); expect(e.code).toBe('common.not_found'); expect(JSON.stringify(cur['P2'])).toBe(before);
    expect(await resolveRow(p1b, 'partner')).toEqual({ kind: 'rejected', code: 'auth.session_expired' });
  });
  it('a dependency failure while writing (job enqueue) rolls the revoke back: the session stays active (no half revoke)', async () => {
    const { w, cur, fail } = await setup(); const s2 = w.addSession('ME'); w.fail.enabled['enqueue'] = new Error('queue down');
    await fail('ME', (s, c) => s.revokeOwnSession(c, { sessionId: s2.id })); expect(s2.state).toBe('active'); expect(w.committed()).toHaveLength(0); expect(cur['ME']!.state).toBe('active');
  });
});

describe('listOwnMfaFactors', () => {
  it('own factors only, contract keys, optional fields omitted (never null), no GoTrue factor id or secret; no write', async () => {
    const { w, ok } = await setup(); const f1 = w.addFactor('ME'); const f2 = w.addFactor('ME', { status: 'unverified', verified_at: null, friendly_name: null }); w.addFactor('OTHER'); w.addFactor('B');
    const r: any = await ok('ME', (s, c) => s.listOwnMfaFactors(c, {}));
    expect(r.status).toBe(200); expect(r.body.data).toHaveLength(2);
    expect(r.body.data).toContainEqual({ factor_id: f1.id, friendly_name: 'Work phone', status: 'verified', verified_at: '2026-11-05T04:15:00.000Z' }); expect(r.body.data).toContainEqual({ factor_id: f2.id, status: 'unverified' });
    expect(JSON.stringify(r.body)).not.toContain(f1.gotrue_factor_id); expect(Object.keys(r.body)).toEqual(['data']); expect(w.committed()).toHaveLength(0);
  });
  it('partner (AU-T20): only its own factors', async () => {
    const { w, ok } = await setup(); const mine = w.addFactor('P1'); w.addFactor('P2'); const ids = (((await ok('P1', (s, c) => s.listOwnMfaFactors(c, {}))) as any).body.data as any[]).map((x) => x.factor_id); expect(ids).toEqual([mine.id]);
  });
});

describe('removeOwnMfaFactor', () => {
  it('removes an own factor: 204; row removed (reason self); the factor is deleted in GoTrue; mfa_factor_removed event; nothing else', async () => {
    const { w, ok } = await setup(); const me = w.people.get('ME')!; const { row, access } = await withGotrueFactor(w, 'ME'); await withGotrueFactor(w, 'ME');   // two verified factors: not the last
    const r: any = await ok('ME', (s, c) => s.removeOwnMfaFactor(c, { factorId: row.id })); expect(r.status).toBe(204); expect(r.body).toBeUndefined();
    expect(row.status).toBe('removed'); expect(row.removal_reason).toBe('self'); expect(w.committed('markFactorRemoved')[0]!.arg).toMatchObject({ factorId: row.id, reason: 'self', actorId: me.userId });
    expect((await w.fake.mfaListFactors(access)).some((f) => f.factorId === row.gotrue_factor_id)).toBe(false);
    expect(w.gcalls.filter((c) => c.method === 'adminDeleteFactor')).toEqual([{ method: 'adminDeleteFactor', args: [me.userId, row.gotrue_factor_id] }]);
    expect(w.eventsOf('mfa_factor_removed')).toEqual([expect.objectContaining({ tenantId: TENANT_A, userId: me.userId, membershipId: me.membershipId, reasonCode: 'self', actorId: me.userId })]);
    expect(w.otherWrites(['markFactorRemoved', 'recordTenant'])).toEqual([]);
  });
  it('self-action guard: the role requires MFA and this is the LAST verified factor -> 409 identity.self_action_forbidden; nothing changes anywhere (DB, GoTrue)', async () => {
    const { w, fail } = await setup(); const me = w.people.get('ME')!; const { row, access } = await withGotrueFactor(w, 'ME'); w.mfaRequired.add(me.membershipId); const before = snapshot(w);
    const { e } = await fail('ME', (s, c) => s.removeOwnMfaFactor(c, { factorId: row.id })); expect(e.code).toBe('identity.self_action_forbidden'); expect(e.statusCode).toBe(409);
    expect(snapshot(w)).toBe(before); expect(w.committed()).toHaveLength(0); expect(w.gcalls.some((c) => c.method === 'adminDeleteFactor')).toBe(false); expect((await w.fake.mfaListFactors(access)).length).toBe(1);
  });
  it('the guard counts VERIFIED factors only: an extra unverified factor does not make the last verified one removable', async () => {
    const { w, fail } = await setup(); const me = w.people.get('ME')!; const { row } = await withGotrueFactor(w, 'ME'); w.addFactor('ME', { status: 'unverified', verified_at: null }); w.mfaRequired.add(me.membershipId);
    expect((await fail('ME', (s, c) => s.removeOwnMfaFactor(c, { factorId: row.id }))).e.code).toBe('identity.self_action_forbidden');
  });
  it.each([
    ['role requires MFA but a second verified factor exists', true, 2, 'verified'],
    ['role does NOT require MFA (last verified factor)', false, 1, 'verified'],
    ['role requires MFA and the factor being removed is UNVERIFIED', true, 1, 'unverified'],
  ] as const)('guard does not fire: %s -> 204', async (_n, required, verifiedCount, targetStatus) => {
    const { w, ok } = await setup(); const me = w.people.get('ME')!; for (let i = 0; i < verifiedCount; i++) await withGotrueFactor(w, 'ME');
    const target = targetStatus === 'verified' ? w.factors.find((f) => f.user_id === me.userId)! : await withGotrueFactor(w, 'ME', { status: 'unverified', verified_at: null }).then((x) => x.row);
    if (required) w.mfaRequired.add(me.membershipId); const r: any = await ok('ME', (s, c) => s.removeOwnMfaFactor(c, { factorId: target.id })); expect(r.status).toBe(204); expect(target.status).toBe('removed');
  });
  it('AU-T20: another member\'s / another tenant\'s / an unknown factor id -> 404 common.not_found, DB and GoTrue unchanged, indistinguishable errors', async () => {
    const { w, fail } = await setup(); const theirs = (await withGotrueFactor(w, 'OTHER')).row, b = w.addFactor('B'); const before = snapshot(w); const bodies: string[] = [];
    for (const id of [theirs.id, b.id, idN(0xbeef)]) { const { e } = await fail('ME', (s, c) => s.removeOwnMfaFactor(c, { factorId: id })); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); bodies.push(errBody(e)); }
    expect(new Set(bodies).size).toBe(1); expect(snapshot(w)).toBe(before); expect(w.committed()).toHaveLength(0); expect(w.gcalls.some((c) => c.method === 'adminDeleteFactor')).toBe(false);
  });
  it('defence in depth: a repo that wrongly hands back someone else\'s factor still ends in 404 with no GoTrue call and no write', async () => {
    const { w, cur } = await setup(); const theirs = w.addFactor('OTHER'); const svc = createSelfService({ ...w.deps, repo: { ...w.repo, findOwnFactor: async () => ({ ...theirs }) } as any });
    const e = await rejection(w.run((ctx) => svc.removeOwnMfaFactor(ctx, { factorId: theirs.id }), 'ME', cur['ME']!).promise); expect(e.code).toBe('common.not_found'); expect(w.committed()).toHaveLength(0); expect(w.gcalls.some((c) => c.method === 'adminDeleteFactor')).toBe(false);
  });
  it('GoTrue failing to delete the factor fails the request and keeps the factor (no half removal)', async () => {
    const { w, cur } = await setup(); const { row } = await withGotrueFactor(w, 'ME'); await withGotrueFactor(w, 'ME');
    const svc = createSelfService({ ...w.deps, gotrue: { ...w.deps.gotrue, signInWithPassword: w.gotrue.signInWithPassword.bind(w.gotrue), adminUpdatePassword: w.gotrue.adminUpdatePassword.bind(w.gotrue), adminDeleteFactor: async () => { throw new Error('gotrue down'); } } as any });
    await rejection(w.run((ctx) => svc.removeOwnMfaFactor(ctx, { factorId: row.id }), 'ME', cur['ME']!).promise); expect(row.status).toBe('verified'); expect(w.committed()).toHaveLength(0);
  });
  it('partner (AU-T20): removes its own factor; the other partner member\'s factor -> 404, unchanged', async () => {
    const { w, ok, fail } = await setup(); const mine = (await withGotrueFactor(w, 'P1')).row; await withGotrueFactor(w, 'P1'); const theirs = w.addFactor('P2'); const before = JSON.stringify(theirs);
    expect(((await ok('P1', (s, c) => s.removeOwnMfaFactor(c, { factorId: mine.id }))) as any).status).toBe(204);
    expect((await fail('P1', (s, c) => s.removeOwnMfaFactor(c, { factorId: theirs.id }))).e.code).toBe('common.not_found'); expect(JSON.stringify(theirs)).toBe(before);
  });
});

describe('AU-T20: a partner session runs every s5.2 operation on its own records; the other member\'s records never change', () => {
  it('getMe / listOwnSessions / listOwnMfaFactors / revokeOwnSession / removeOwnMfaFactor / changeOwnPassword as P1; P2 rows deep-equal before and after', async () => {
    const { w, cur, ok } = await setup(); const f1 = (await withGotrueFactor(w, 'P1')).row, f2 = (await withGotrueFactor(w, 'P1')).row; const p1s = w.addSession('P1'); w.addFactor('P2');
    const p2 = w.people.get('P2')!; const p2Before = JSON.stringify({ s: w.sessions.filter((s) => s.user_id === p2.userId), f: w.factors.filter((f) => f.user_id === p2.userId) });
    expect(((await ok('P1', (s, c) => s.getMe(c, {}))) as any).body.roles[0].code).toBe('partner_admin');
    expect((((await ok('P1', (s, c) => s.listOwnSessions(c, {}))) as any).body.data as any[]).length).toBe(2);
    expect((((await ok('P1', (s, c) => s.listOwnMfaFactors(c, {}))) as any).body.data as any[]).length).toBe(2);
    await ok('P1', (s, c) => s.revokeOwnSession(c, { sessionId: p1s.id })); expect(p1s.state).toBe('revoked');
    await ok('P1', (s, c) => s.removeOwnMfaFactor(c, { factorId: f1.id })); expect(f1.status).toBe('removed');
    await ok('P1', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW })); expect(f2.user_id).toBe(w.people.get('P1')!.userId);
    expect(JSON.stringify({ s: w.sessions.filter((s) => s.user_id === p2.userId), f: w.factors.filter((f) => f.user_id === p2.userId) })).toBe(p2Before); expect(cur['P2']!.state).toBe('active');
  });
  it('the portal BFF key is refused on every identity operation by the claims resolver: 401 auth.unauthenticated (08 A13 D-32)', async () => {
    const { db } = fakeDb([partnerRow({ idle_expires_at: new Date(NOW.getTime() + 900_000), absolute_expires_at: new Date(NOW.getTime() + 28_800_000) })]); const out = await createClaimsResolver({ db, now: () => NOW }).resolve(jwt() as any, claimsReq({ endpointFamily: 'partner', bffKey: 'portal' }) as any);
    expect(out).toEqual({ kind: 'rejected', code: 'auth.unauthenticated' });
  });
});

// ---- review round 1 (C2.T10-review.md items 1-3) ----
describe('changeOwnPassword: the verifying sign-in leaves no live GoTrue session (review item 3)', () => {
  it('after a successful current-password check the session that sign-in opened is closed: signOut(thatAccessToken, "local"), and the change still succeeds', async () => {
    const { w, ok } = await setup(); const spy = vi.spyOn(w.fake, 'signInWithPassword'); const me = w.people.get('ME')!;
    const r: any = await ok('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW })); expect(r.status).toBe(204);
    const tok = await spy.mock.results[0]!.value; expect(tok.ok).toBe(true);
    const outs = w.gcalls.filter((c) => c.method === 'signOut'); expect(outs).toHaveLength(1); expect(outs[0]!.args).toEqual([tok.tokens.accessToken, 'local']);
    expect((await w.fake.signInWithPassword(me.email, NEW_PW)).ok).toBe(true);
  });
  it('a signOut failure does not fail the change, but is not swallowed silently: logged (warn/error) without a password', async () => {
    const { w, ok } = await setup(); vi.spyOn(w.fake, 'signOut').mockRejectedValueOnce(new Error('gotrue down'));
    const r: any = await ok('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW })); expect(r.status).toBe(204);
    expect(w.log.warn.mock.calls.length + w.log.error.mock.calls.length).toBeGreaterThan(0);
    const s = sinks(w); for (const secret of [OLD_PW, NEW_PW]) expect(s).not.toContain(secret);
  });
  it('a wrong current password opens no session, so nothing is signed out', async () => {
    const { w, fail } = await setup(); await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: WRONG_PW, newPassword: NEW_PW }));
    expect(w.gcalls.some((c) => c.method === 'signOut')).toBe(false);
  });
});

describe('changeOwnPassword: tenant password_min_length is read and fails closed (review item 2c, AC-A6.1)', () => {
  it('a stricter tenant minimum (16) rejects a 14-character password (422 auth.password_policy_violation); nothing changed', async () => {
    const { w, cur, fail } = await setup(); w.minLength.value = 16; const me = w.people.get('ME')!;
    const { e } = await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: 'Abcdefgh1!xyzw' }));
    expect(e.code).toBe('auth.password_policy_violation'); expect(w.committed()).toHaveLength(0); expect(cur['ME']!.state).toBe('active'); expect((await w.fake.signInWithPassword(me.email, OLD_PW)).ok).toBe(true);
  });
  it('no tenant_settings row (minimum unknown) -> 500 common.internal, NOT the 12 floor: nothing changed', async () => {
    const { w, cur, fail } = await setup(); w.minLength.value = undefined; const me = w.people.get('ME')!; const s2 = w.addSession('ME');
    const { e } = await fail('ME', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW }));
    expect(e.code).toBe('common.internal'); expect(w.committed()).toHaveLength(0); expect([cur['ME']!.state, s2.state]).toEqual(['active', 'active']); expect((await w.fake.signInWithPassword(me.email, OLD_PW)).ok).toBe(true);
  });
  it('the minimum is looked up through the repo seam for a partner too', async () => {
    const { w, ok } = await setup(); await ok('P1', (s, c) => s.changeOwnPassword(c, { currentPassword: OLD_PW, newPassword: NEW_PW })); expect(w.order).toContain('passwordMinLength');
  });
});

// The REAL default repo (repository/self.repo.ts) over a recording tx, not the in-memory fake: a live partner has no core.membership_roles rows and
// partner claims cannot read core roles (P-16 guard), so roles / permissions must come from the claims (ctx.partnerRole), never from SQL (02-TRD s5.2 / s7.1, 08 A28.3).
describe('getMe: partner roles / permissions are built from the claims, not from core role tables (review item 1, AU-T20)', () => {
  const profileRow = (who: { membershipId: string; userId: string; email: string }, o: Record<string, unknown> = {}) => ({ membership_id: who.membershipId, user_id: who.userId, last_login_at: new Date('2026-11-05T04:15:00.000Z'), all_centres: false,
    display_name: 'Demo', email: who.email, role_ids: [], role_codes: [], role_names: [], permissions: [], centre_ids: [], has_verified_factor: false, ...o });
  async function viaRepo(key: Who, c: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}) {
    const { w, cur } = await setup(); const p = w.people.get(key)!; const sql: string[] = [];
    const { createSelfRepo } = await import('../../repository/self.repo.js');
    const svc = createSelfService({ ...w.deps, repo: createSelfRepo() as any });
    const query = vi.fn(async (text: string) => { sql.push(text); return { rows: /FROM core\.memberships/.test(text) ? [profileRow(p, rowOver)] : [], rowCount: 1 }; });
    const { ctx } = w.ctxFor(key, cur[key]!, { tx: { query }, ...c });
    return { p, sql, svc, ctx, query };
  }
  it('partner_admin: roles = [partner_admin], permissions = the fixed partner set - even though the DB role tables return nothing', async () => {
    const { fixedActorPermissions } = await import('../../domain/permission-set.js'); const { svc, ctx } = await viaRepo('P1');
    const b = ((await svc.getMe(ctx, {})) as any).body; expect(b.roles.map((r: any) => r.code)).toEqual(['partner_admin']);
    expect(fixedActorPermissions('partner', 'partner_admin').length).toBeGreaterThan(0); expect([...b.permissions].sort()).toEqual(fixedActorPermissions('partner', 'partner_admin'));
    expect(b.permissions).toContain('identity.self.manage'); expect(b.centre_scope).toEqual({ all: false, centre_ids: [] });
  });
  it('partner_member gets the member set (not the admin set)', async () => {
    const { fixedActorPermissions } = await import('../../domain/permission-set.js'); const { svc, ctx } = await viaRepo('P2');
    const b = ((await svc.getMe(ctx, {})) as any).body; expect(b.roles.map((r: any) => r.code)).toEqual(['partner_member']); expect([...b.permissions].sort()).toEqual(fixedActorPermissions('partner', 'partner_member'));
    expect(b.permissions).not.toContain('partners.partner_user.manage');
  });
  it('no statement a partner request issues touches core.membership_roles / core.roles / core.role_permissions / core.membership_centres', async () => {
    const { svc, ctx, sql } = await viaRepo('P1'); await svc.getMe(ctx, {}); expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) expect(s).not.toMatch(/membership_roles|core\.roles|role_permissions|membership_centres/);
  });
  it('a role / permission / centre value the DB hands back for a partner is ignored (the claims win)', async () => {
    const { svc, ctx } = await viaRepo('P1', {}, { role_ids: [idN(0x9001)], role_codes: ['tenant_admin'], role_names: ['Tenant admin'], permissions: ['identity.user.manage'], centre_ids: [idN(0x9002)], all_centres: true });
    const b = ((await svc.getMe(ctx, {})) as any).body; expect(b.roles.map((r: any) => r.code)).toEqual(['partner_admin']); expect(b.permissions).not.toContain('identity.user.manage'); expect(b.centre_scope).toEqual({ all: false, centre_ids: [] });
  });
  it('a partner ctx without partnerRole fails 401 auth.unauthenticated (no guess, no DB role fallback)', async () => {
    const { svc, ctx } = await viaRepo('P1', { partnerRole: undefined }); const e = await rejection(svc.getMe(ctx, {})); expect(e.code).toBe('auth.unauthenticated'); expect(e.statusCode).toBe(401);
  });
  it('staff control: the same repo DOES read the role tables for a staff session (so the partner assertions above are meaningful)', async () => {
    const { svc, ctx, sql } = await viaRepo('ME', {}, { role_ids: [idN(0x9003)], role_codes: ['tenant_admin'], role_names: ['Tenant admin'], permissions: ['identity.self.manage'] });
    const b = ((await svc.getMe(ctx, {})) as any).body; expect(b.roles.map((r: any) => r.code)).toEqual(['tenant_admin']); expect(sql.join('\n')).toMatch(/membership_roles/);
  });
});
