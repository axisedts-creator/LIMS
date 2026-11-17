// C2-T11 worker task identity.gotrue_signout (02-TRD §10 row; 01-PRD AC-A1.3, AC-B4.1; 03-APP-FLOW §2.3, §4.3; 08 A38-2).
// ASSUMED seams (spec silent; writer: dispute if wrong):
//  - ../tasks/gotrue_signout.ts exports `GOTRUE_SIGNOUT = 'identity.gotrue_signout'`, `gotrueSignout: TaskHandler` (default wiring, lazy gateway) and
//    `createGotrueSignout(deps) -> TaskHandler`, deps = { gotrue: Pick<GoTrueGateway,'adminSignOutUser'|'signOut'>,
//    repo: { sessionAccessToken(tx, tenantId, sessionId, userId) -> Promise<string | null> } (userId = payload user_id; the lookup must be scoped to it, review #4) } (the repo reads identity.sessions under tenant claims and decrypts; null = row gone).
//  - payload shapes are the ones the C2 enqueuers already use: { user_id } (platform kind, ctx.tenantId undefined) | { user_id, tenant_id } | { user_id, tenant_id, session_id }
//    | { tenant_id, user_ids: uuid[<=200], reason } (role change / tenant suspend fan-out, 03-APP-FLOW §9.2). Any other shape is a bug: the job REJECTS (-> retries -> dead letter), it never silently succeeds.
//  - session_id + tenant -> repo token -> signOut(token,'local') ONLY (the user's other sessions stay); token null -> nothing to do (the LIMS session row is already revoked/gone), resolves.
//    Platform kind -> ALWAYS adminSignOutUser(user_id), repo and tx untouched (a worker cannot read a platform session row, 02-TRD §10).
//  - GoTrue says the user (404 user_not_found) or the session (session_not_found) is already gone -> success. Any other failure is rethrown so the queue retries (max_attempts 10).
import { describe, expect, it, vi } from 'vitest';
import { GOTRUE_SIGNOUT, createGotrueSignout, gotrueSignout } from '../tasks/gotrue_signout.js';
import { TENANT, OTHER_TENANT, idN, makeCtx, makeGotrue, signedInUser, alive, down, gt, err } from './t11.helpers.js';

function world(o: { tenantId?: string | undefined; token?: string | null; fail?: Parameters<typeof makeGotrue>[0]; attempt?: number } = {}) {
  const g = makeGotrue(o.fail); const c = makeCtx({ tenantId: 'tenantId' in o ? o.tenantId : TENANT, ...(o.attempt ? { attempt: o.attempt } : {}) });
  const sessionAccessToken = vi.fn(async (_tx: unknown, _t: string, _s: string, _u: string) => (o.token === undefined ? null : o.token));
  const task = createGotrueSignout({ gotrue: g.gotrue, repo: { sessionAccessToken } } as any);
  return { ...g, ...c, sessionAccessToken, run: (p: unknown) => task(p as any, c.ctx) };
}
const REASONS = ['lock', 'deactivate', 'tenant_suspended', 'password_change', 'role_change', 'mfa_reset', 'admin_revoke'];

describe('AC-A1.3 / AC-B4.1: sign-out by user id', () => {
  it('task id is identity.gotrue_signout', () => { expect(GOTRUE_SIGNOUT).toBe('identity.gotrue_signout'); });
  it('{user_id, tenant_id}: adminSignOutUser(user_id) kills every GoTrue session of the user (the lock / deactivate job)', async () => {
    const w = world(); const u = await signedInUser(w.gw); const u2 = await signedInUser(w.gw, 'other');
    await w.run({ user_id: u.userId, tenant_id: TENANT });
    expect(w.of('adminSignOutUser')).toEqual([{ m: 'adminSignOutUser', a: [u.userId] }]); expect(await alive(w.gw, u.tokens.accessToken)).toBe(false); expect(await alive(w.gw, u2.tokens.accessToken)).toBe(true);
    expect(w.sessionAccessToken).not.toHaveBeenCalled();
  });
  it('{user_id} only (login with a locked account, AC-A1.3; platform kind): adminSignOutUser, the repo and the tx are never touched', async () => {
    const w = world({ tenantId: undefined }); const u = await signedInUser(w.gw);
    await w.run({ user_id: u.userId }); expect(w.of('adminSignOutUser')).toHaveLength(1); expect(await alive(w.gw, u.tokens.accessToken)).toBe(false);
    expect(w.sessionAccessToken).not.toHaveBeenCalled(); expect(w.tx.query).not.toHaveBeenCalled();
  });
  it('platform kind with a stray session_id is STILL adminSignOutUser(user_id) (never a token lookup)', async () => {
    const w = world({ tenantId: undefined, token: 'x.y.z' }); const u = await signedInUser(w.gw); await w.run({ user_id: u.userId, session_id: idN(9) });
    expect(w.of('adminSignOutUser')).toHaveLength(1); expect(w.of('signOut')).toHaveLength(0); expect(w.sessionAccessToken).not.toHaveBeenCalled();
  });
  it.each(REASONS)('fan-out payload { tenant_id, user_ids, reason: %s }: every user is signed out, nobody else', async (reason) => {
    const w = world(); const a = await signedInUser(w.gw, 'a'); const b = await signedInUser(w.gw, 'b'); const keep = await signedInUser(w.gw, 'keep');
    await w.run({ tenant_id: TENANT, user_ids: [a.userId, b.userId], reason });
    expect(w.of('adminSignOutUser').map((c) => c.a[0]).sort()).toEqual([a.userId, b.userId].sort()); expect(await alive(w.gw, keep.tokens.accessToken)).toBe(true);
    expect(await alive(w.gw, a.tokens.accessToken)).toBe(false); expect(await alive(w.gw, b.tokens.accessToken)).toBe(false);
  });
  it('fan-out: a user GoTrue no longer knows (404 user_not_found) is skipped, the rest are still signed out, the job succeeds', async () => {
    const w = world(); const a = await signedInUser(w.gw, 'a');
    await expect(w.run({ tenant_id: TENANT, user_ids: [idN(0x77), a.userId], reason: 'role_change' })).resolves.toBeUndefined(); expect(await alive(w.gw, a.tokens.accessToken)).toBe(false);
  });
  it('fan-out: a transient failure for one user does not stop the others, and the job still rejects so the queue retries', async () => {
    const calls: string[] = []; let n = 0;
    const gotrue = { adminSignOutUser: async (id: string) => { calls.push(id); if (++n === 1) throw down(); }, signOut: async () => undefined };
    const c = makeCtx({ tenantId: TENANT }); const task = createGotrueSignout({ gotrue, repo: { sessionAccessToken: async () => null } } as any);
    const ids = [idN(1), idN(2), idN(3)]; const e = await err(task({ tenant_id: TENANT, user_ids: ids, reason: 'tenant_suspended' } as any, c.ctx));
    expect(e?.code).toBe('common.dependency_unavailable'); expect(calls).toEqual(ids);
  });
  it('a batch of 200 is accepted, 201 is a malformed payload', async () => {
    const w = world(); const ids = (n: number) => Array.from({ length: n }, (_, i) => idN(0x1000 + i));
    await expect(w.run({ tenant_id: TENANT, user_ids: ids(200), reason: 'role_change' })).resolves.toBeUndefined();
    const w2 = world(); expect(await err(w2.run({ tenant_id: TENANT, user_ids: ids(201), reason: 'role_change' }))).toBeDefined(); expect(w2.calls).toHaveLength(0);
  });
});

describe('sign-out of ONE session (self-service revoke / logout / password change)', () => {
  it('{user_id, tenant_id, session_id}: reads the token under the job tenant and calls signOut(token, local); the user\'s other sessions survive', async () => {
    const w = world(); const u = await signedInUser(w.gw); const second: any = (await w.gw.signInWithPassword(u.email, 'Old-pass-Lims!9xyz')).tokens; const sid = idN(0x5e);
    w.sessionAccessToken.mockResolvedValue(u.tokens.accessToken); await w.run({ user_id: u.userId, tenant_id: TENANT, session_id: sid });
    expect(w.sessionAccessToken).toHaveBeenCalledWith(w.tx, TENANT, sid, u.userId); expect(w.of('signOut')).toEqual([{ m: 'signOut', a: [u.tokens.accessToken, 'local'] }]); expect(w.of('adminSignOutUser')).toHaveLength(0);
    expect(await alive(w.gw, u.tokens.accessToken)).toBe(false); expect(await alive(w.gw, second.accessToken)).toBe(true);
  });
  it('session row gone (token null) -> resolves, no GoTrue call at all', async () => {
    const w = world({ token: null }); const u = await signedInUser(w.gw); await expect(w.run({ user_id: u.userId, tenant_id: TENANT, session_id: idN(0x5e) })).resolves.toBeUndefined(); expect(w.of('signOut')).toHaveLength(0); expect(w.of('adminSignOutUser')).toHaveLength(0);
  });
  it('the token never reaches a log line or the thrown message', async () => {
    const tok = 'SENTINEL.ACCESS.TOKEN'; const w = world({ token: tok, fail: { signOut: { err: () => gt('signOut', 500, 'unexpected_failure') } } });
    const e = await err(w.run({ user_id: idN(1), tenant_id: TENANT, session_id: idN(2) })); expect(e).toBeDefined(); expect(String(e.message)).not.toContain(tok); expect(w.logged()).not.toContain(tok);
  });
});

describe('idempotency (job_key signout:<session_id or user_id>:<reason>) and failure behaviour', () => {
  it('running the same job twice is a success both times (GoTrue sign-out of an already signed-out session/user is success)', async () => {
    const w = world(); const u = await signedInUser(w.gw); const p = { user_id: u.userId, tenant_id: TENANT };
    await expect(w.run(p)).resolves.toBeUndefined(); await expect(w.run(p)).resolves.toBeUndefined();
    const w2 = world({ token: u.tokens.accessToken }); const s = { user_id: u.userId, tenant_id: TENANT, session_id: idN(3) }; await expect(w2.run(s)).resolves.toBeUndefined(); await expect(w2.run(s)).resolves.toBeUndefined();
  });
  it.each([
    ['404 user_not_found', 'adminSignOutUser', gt('adminSignOutUser', 404, 'user_not_found'), { user_id: idN(1), tenant_id: TENANT }],
    ['session_not_found on signOut', 'signOut', gt('signOut', 403, 'session_not_found'), { user_id: idN(1), tenant_id: TENANT, session_id: idN(2) }],
  ] as const)('GoTrue "%s" = already gone -> resolves', async (_n, method, e, payload) => {
    const w = world({ token: 'a.b.c', fail: { [method]: { err: () => e } } }); await expect(w.run(payload)).resolves.toBeUndefined();
  });
  it.each([
    ['dependency outage (LimsError)', down, 'common.dependency_unavailable'],
    ['GoTrue 500', () => gt('adminSignOutUser', 500, 'unexpected_failure'), undefined],
    ['GoTrue 429', () => gt('adminSignOutUser', 429, 'over_request_rate_limit'), undefined],
  ] as const)('%s is rethrown so the queue retries (nothing swallowed)', async (_n, mkErr, code) => {
    const w = world({ fail: { adminSignOutUser: { err: mkErr } } }); const e = await err(w.run({ user_id: idN(1), tenant_id: TENANT })); expect(e).toBeDefined(); if (code) expect(e.code).toBe(code);
  });
  it('fail once, succeed on the retry (queue attempt 2): the user ends up signed out', async () => {
    const w = world({ fail: { adminSignOutUser: { err: down, times: 1 } } }); const u = await signedInUser(w.gw);
    expect(await err(w.run({ user_id: u.userId, tenant_id: TENANT }))).toBeDefined(); await w.run({ user_id: u.userId, tenant_id: TENANT }); expect(await alive(w.gw, u.tokens.accessToken)).toBe(false);
  });
  it('payload tenant_id different from the job tenant -> rejects, GoTrue untouched (no cross-tenant sign-out)', async () => {
    const w = world(); const u = await signedInUser(w.gw); const e = await err(w.run({ user_id: u.userId, tenant_id: OTHER_TENANT })); expect(e).toBeDefined(); expect(w.of('adminSignOutUser')).toHaveLength(0); expect(await alive(w.gw, u.tokens.accessToken)).toBe(true);
  });
  it.each([[{}], [{ user_id: 5 }], [{ user_id: 'not-a-uuid' }], [{ tenant_id: TENANT }], [{ tenant_id: TENANT, user_ids: [] , reason: 'x' }], [{ tenant_id: TENANT, user_ids: ['nope'], reason: 'x' }],
    [{ user_id: idN(1), user_ids: [idN(2)], tenant_id: TENANT }], [{ user_id: idN(1), tenant_id: TENANT, session_id: 'nope' }], [undefined]])('malformed payload %j -> rejects (dead-letter path), GoTrue untouched', async (payload) => {
    const w = world(); expect(await err(w.run(payload))).toBeDefined(); expect(w.calls).toHaveLength(0);
  });
  it('the default wiring rejects a malformed payload before touching GoTrue or the DB', async () => {
    const { ctx, tx } = makeCtx({ tenantId: TENANT }); expect(await err(gotrueSignout({ nonsense: true } as any, ctx))).toBeDefined(); expect(tx.query).not.toHaveBeenCalled();
  });
});
