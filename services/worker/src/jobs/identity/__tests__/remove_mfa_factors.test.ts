// C2-T11 worker task identity.remove_mfa_factors (02-TRD §10 row; 01-PRD US-B5; 05-SCHEMA §4.2 identity.mfa_factors; 03-APP-FLOW MFA reset).
// "Given a user who lost their phone, When an admin resets MFA, Then all factors are removed (GoTrue + mirror)" (sessions are revoked synchronously by the T13 handler, not here).
// ASSUMED seams (spec silent; writer: dispute if wrong):
//  - ../tasks/remove_mfa_factors.ts exports `REMOVE_MFA_FACTORS = 'identity.remove_mfa_factors'`, `removeMfaFactors: TaskHandler` (default wiring) and
//    `createRemoveMfaFactors(deps) -> TaskHandler`, deps = { gotrue: Pick<GoTrueGateway,'adminDeleteFactor'>, repo: {
//      listFactors(tx, { tenantId, userId }) -> [{ id, gotrue_factor_id, status }]  (the MIRROR rows: a worker has no access token, so it cannot call mfaListFactors),
//      markRemoved(tx, { tenantId, userId, factorIds /* our ids */, removedAt: ctx.now(), removedBy: ctx.actor.id, reason: 'admin_reset' }) -> status 'removed', removed_at/by, removal_reason } }.
//  - payload { tenant_id, user_id, membership_id } (tenant, ctx.tenantId = tenant_id) or { user_id, platform_staff_id } (platform; the platform-staff service enqueues exactly this, ctx.tenantId undefined).
//  - every non-'removed' mirror factor (verified AND unverified) -> adminDeleteFactor(user_id, gotrue_factor_id); GoTrue 404 (mfa_factor_not_found / user_not_found) = already gone = success;
//    then ONE markRemoved with every handled factor. Any other failure -> rethrow BEFORE markRemoved (the job tx rolls back; the retry re-lists and finishes). No factors -> no-op.
//  - malformed payload -> REJECTS (dead-letter path). max_attempts 10 (manifest test).
import { describe, expect, it, vi } from 'vitest';
import { REMOVE_MFA_FACTORS, createRemoveMfaFactors, removeMfaFactors } from '../tasks/remove_mfa_factors.js';
import { TENANT, OTHER_TENANT, NOW, ACTOR, idN, makeCtx, makeGotrue, signedInUser, down, gt, err } from './t11.helpers.js';

const USER = idN(0x7a), MEMB = idN(0xb1), STAFF = idN(0xd2);
const mirror = (n: number, status = 'verified', gotrueId = idN(0x9000 + n)) => ({ id: idN(0x8000 + n), gotrue_factor_id: gotrueId, status });
function world(rows: any[], o: { tenantId?: string | undefined; fail?: Parameters<typeof makeGotrue>[0] } = {}) {
  const g = makeGotrue(o.fail); const c = makeCtx({ tenantId: 'tenantId' in o ? o.tenantId : TENANT });
  const listFactors = vi.fn(async () => rows); const markRemoved = vi.fn(async () => undefined);
  const task = createRemoveMfaFactors({ gotrue: g.gotrue, repo: { listFactors, markRemoved } } as any);
  return { ...g, ...c, listFactors, markRemoved, run: (p: unknown) => task(p as any, c.ctx) };
}
const tenantPayload = (user = USER) => ({ tenant_id: TENANT, user_id: user, membership_id: MEMB });

describe('US-B5: all factors removed in GoTrue and in the mirror', () => {
  it('task id is identity.remove_mfa_factors', () => { expect(REMOVE_MFA_FACTORS).toBe('identity.remove_mfa_factors'); });
  it('tenant user with a verified and an unverified factor: both deleted at GoTrue, one markRemoved(admin_reset) with both mirror ids', async () => {
    const w = world([mirror(1), mirror(2, 'unverified')]); await w.run(tenantPayload());
    expect(w.listFactors).toHaveBeenCalledWith(w.tx, { tenantId: TENANT, userId: USER });
    expect(w.of('adminDeleteFactor').map((c) => c.a)).toEqual([[USER, idN(0x9001)], [USER, idN(0x9002)]]);
    expect(w.markRemoved).toHaveBeenCalledTimes(1); expect(w.markRemoved).toHaveBeenCalledWith(w.tx, { tenantId: TENANT, userId: USER, factorIds: [idN(0x8001), idN(0x8002)], removedAt: NOW, removedBy: ACTOR, reason: 'admin_reset' });
  });
  it('end to end on the GoTrue fake: the user really has no factor left afterwards', async () => {
    const g = makeGotrue(); const u = await signedInUser(g.gw); const f1: any = await g.gw.mfaEnrollTotp(u.tokens.accessToken, 'a'); const f2: any = await g.gw.mfaEnrollTotp(u.tokens.accessToken, 'b');
    expect(await g.gw.mfaListFactors(u.tokens.accessToken)).toHaveLength(2);
    const c = makeCtx({ tenantId: TENANT }); const markRemoved = vi.fn(async () => undefined);
    const task = createRemoveMfaFactors({ gotrue: g.gotrue, repo: { listFactors: async () => [mirror(1, 'verified', f1.factorId), mirror(2, 'unverified', f2.factorId)], markRemoved } } as any);
    await task(tenantPayload(u.userId) as any, c.ctx); expect(await g.gw.mfaListFactors(u.tokens.accessToken)).toEqual([]); expect(markRemoved).toHaveBeenCalledTimes(1);
  });
  it('platform staff ({ user_id, platform_staff_id }, no tenant): listFactors / markRemoved get tenantId undefined', async () => {
    const w = world([mirror(1)], { tenantId: undefined }); await w.run({ user_id: USER, platform_staff_id: STAFF });
    expect(w.listFactors).toHaveBeenCalledWith(w.tx, { tenantId: undefined, userId: USER }); expect(w.of('adminDeleteFactor')).toHaveLength(1); expect(w.markRemoved).toHaveBeenCalledWith(w.tx, expect.objectContaining({ tenantId: undefined, userId: USER, reason: 'admin_reset' }));
  });
  it('mirror rows already "removed" are left alone (no GoTrue call, not in markRemoved)', async () => {
    const w = world([mirror(1, 'removed'), mirror(2)]); await w.run(tenantPayload());
    expect(w.of('adminDeleteFactor').map((c) => c.a[1])).toEqual([idN(0x9002)]); expect(w.markRemoved.mock.calls[0]![1].factorIds).toEqual([idN(0x8002)]);
  });
  it('no factors at all -> no GoTrue call, no write, resolves', async () => {
    for (const rows of [[], [mirror(1, 'removed')]]) { const w = world(rows); await expect(w.run(tenantPayload())).resolves.toBeUndefined(); expect(w.calls).toHaveLength(0); expect(w.markRemoved).not.toHaveBeenCalled(); }
  });
});

describe('idempotency (job_key mfa_reset:<membership or staff id>:<version>) and retry behaviour', () => {
  it.each([['mfa_factor_not_found'], ['user_not_found']])('GoTrue 404 %s = already deleted -> success, the mirror row is still marked removed', async (code) => {
    const w = world([mirror(1)], { fail: { adminDeleteFactor: { err: () => gt('adminDeleteFactor', 404, code) } } });
    await expect(w.run(tenantPayload())).resolves.toBeUndefined(); expect(w.markRemoved.mock.calls[0]![1].factorIds).toEqual([idN(0x8001)]);
  });
  it('running the whole job twice on the fake is a success both times (second pass: every delete is a 404)', async () => {
    const g = makeGotrue(); const u = await signedInUser(g.gw); const f: any = await g.gw.mfaEnrollTotp(u.tokens.accessToken); const c = makeCtx({ tenantId: TENANT });
    const task = createRemoveMfaFactors({ gotrue: g.gotrue, repo: { listFactors: async () => [mirror(1, 'verified', f.factorId)], markRemoved: async () => undefined } } as any);
    await task(tenantPayload(u.userId) as any, c.ctx); await expect(task(tenantPayload(u.userId) as any, c.ctx)).resolves.toBeUndefined();
  });
  it('2nd factor fails transiently: the job rejects, markRemoved is NOT called; the retry deletes the rest (1st is a 404 now) and marks BOTH removed', async () => {
    const calls: string[] = []; let boom = true;
    const deleted = new Set<string>();
    const gotrue = { adminDeleteFactor: async (_u: string, f: string) => {
      calls.push(f); if (deleted.has(f)) throw gt('adminDeleteFactor', 404, 'mfa_factor_not_found');
      if (f === idN(0x9002) && boom) { boom = false; throw down(); } deleted.add(f);
    } };
    const c = makeCtx({ tenantId: TENANT }); const markRemoved = vi.fn(async () => undefined);
    const task = createRemoveMfaFactors({ gotrue, repo: { listFactors: async () => [mirror(1), mirror(2)], markRemoved } } as any);
    const e = await err(task(tenantPayload() as any, c.ctx)); expect(e?.code).toBe('common.dependency_unavailable'); expect(markRemoved).not.toHaveBeenCalled();
    await task(tenantPayload() as any, c.ctx); expect(markRemoved).toHaveBeenCalledTimes(1); expect(markRemoved.mock.calls[0]![1].factorIds).toEqual([idN(0x8001), idN(0x8002)]);
  });
  it.each([['dependency outage', down], ['GoTrue 500', () => gt('adminDeleteFactor', 500, 'unexpected_failure')], ['GoTrue 429', () => gt('adminDeleteFactor', 429, 'over_request_rate_limit')]] as const)('%s -> rethrown for the queue (max_attempts 10), nothing marked', async (_n, mkErr) => {
    const w = world([mirror(1)], { fail: { adminDeleteFactor: { err: mkErr } } }); expect(await err(w.run(tenantPayload()))).toBeDefined(); expect(w.markRemoved).not.toHaveBeenCalled();
  });
  it('a failing markRemoved (DB error) is rethrown, never swallowed', async () => {
    const w = world([mirror(1)]); const boom = new Error('db down'); w.markRemoved.mockRejectedValueOnce(boom); expect(await err(w.run(tenantPayload()))).toBe(boom);
  });
});

describe('isolation / robustness', () => {
  it('payload tenant_id different from the job tenant -> rejects, no listing, GoTrue untouched', async () => {
    const w = world([mirror(1)]); expect(await err(w.run({ ...tenantPayload(), tenant_id: OTHER_TENANT }))).toBeDefined(); expect(w.listFactors).not.toHaveBeenCalled(); expect(w.calls).toHaveLength(0);
  });
  it.each([[{}], [{ user_id: 'nope', tenant_id: TENANT, membership_id: MEMB }], [{ tenant_id: TENANT, user_id: USER }], [{ user_id: USER }], [{ user_id: USER, platform_staff_id: 'nope' }],
    [{ ...{ tenant_id: TENANT, user_id: USER, membership_id: MEMB }, platform_staff_id: STAFF }], [{ tenant_id: TENANT, user_id: USER, membership_id: MEMB, extra: 1 }], [undefined]])('malformed payload %j -> rejects (dead-letter path), nothing listed or deleted', async (payload) => {
    const w = world([mirror(1)], { tenantId: (payload as any)?.tenant_id ? TENANT : undefined }); expect(await err(w.run(payload))).toBeDefined(); expect(w.listFactors).not.toHaveBeenCalled(); expect(w.calls).toHaveLength(0);
  });
  it('a missing tenant context for a tenant payload (ctx.tenantId undefined, payload has tenant_id) is rejected', async () => {
    const w = world([mirror(1)], { tenantId: undefined }); expect(await err(w.run(tenantPayload()))).toBeDefined(); expect(w.calls).toHaveLength(0);
  });
  it('the default wiring rejects a malformed payload before any GoTrue/DB access', async () => {
    const { ctx, tx } = makeCtx({ tenantId: TENANT }); expect(await err(removeMfaFactors({ nonsense: true } as any, ctx))).toBeDefined(); expect(tx.query).not.toHaveBeenCalled();
  });
});
