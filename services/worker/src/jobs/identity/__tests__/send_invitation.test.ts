// C2-T11 worker task identity.send_invitation (02-TRD §10 row; 05-SCHEMA §4.4 identity.invitations; 03-APP-FLOW §2.2 M1; 01-PRD AC-B1.x via T13 enqueue).
// ASSUMED seams (spec silent; writer: dispute if wrong):
//  - ../tasks/send_invitation.ts exports `SEND_INVITATION = 'identity.send_invitation'`, `sendInvitation: TaskHandler` (default wiring) and `createSendInvitation(deps) -> TaskHandler`,
//    deps = { gotrue: Pick<GoTrueGateway,'sendInvite'>, repo: {
//      loadInvitation(tx, tenantId | undefined, invitationId) -> { id, status, email: string|null, expires_at: Date|string } | undefined,
//      markSent(tx, { tenantId, invitationId, issuedAt }) -> sets status 'sent', issued_at (= ctx.now()),
//      markFailed(tx, { tenantId, invitationId, errorCode }) -> sets status 'failed', last_error_code } }.
//  - payload { tenant_id, invitation_id } (tenant kinds, ctx.tenantId = tenant_id) or { invitation_id } (platform staff invite, ctx.tenantId undefined; the platform-staff service enqueues exactly this).
//  - sends ONLY a 'pending' invitation with an e-mail that has not expired (ctx.now()); any other state (sent/accepted/expired/revoked/failed, row missing, e-mail redacted) is a silent no-op (idempotent by invitation id: a resend is a NEW row, 08/core-admin RESEND_SQL).
//  - sendInvite(email, '/auth/confirm') then markSent. PERMANENT failure = GoTrue 4xx other than 429 -> markFailed(errorCode = the GoTrue error code) and the job RESOLVES (no retry, no dead letter).
//    Transient (LimsError dependency_unavailable, GoTrue 429/5xx) -> rethrown (queue retries, max_attempts 8, final attempt -> dead letter), nothing marked. (The job tx rolls back on a throw, so a mark would be lost anyway.)
//  - malformed payload -> REJECTS (dead-letter path), no GoTrue call. The e-mail never appears in a log line or a thrown message.
import { describe, expect, it, vi } from 'vitest';
import { SEND_INVITATION, createSendInvitation, sendInvitation } from '../tasks/send_invitation.js';
import { TENANT, OTHER_TENANT, NOW, idN, mk, makeCtx, down, gt, err } from './t11.helpers.js';

const INV = idN(0x1a1);
const row = (o: Record<string, unknown> = {}) => ({ id: INV, status: 'pending', email: mk('invitee'), expires_at: '2026-11-18T04:00:00.000Z', ...o });
function world(...a: [r?: Record<string, unknown> | undefined, o?: { tenantId?: string | undefined; sendInvite?: (e: string, p: string) => Promise<void> }]) {
  const r = a.length ? a[0] : row(); const o = a[1] ?? {};
  const c =makeCtx({ tenantId: 'tenantId' in o ? o.tenantId : TENANT }); const order: string[] = [];
  const sendInvite = vi.fn(async (e: string, p: string) => { order.push('sendInvite'); await o.sendInvite?.(e, p); });
  const loadInvitation = vi.fn(async () => { order.push('load'); return r; });
  const markSent = vi.fn(async () => { order.push('markSent'); }); const markFailed = vi.fn(async () => { order.push('markFailed'); });
  const task = createSendInvitation({ gotrue: { sendInvite }, repo: { loadInvitation, markSent, markFailed } } as any);
  return { ...c, sendInvite, loadInvitation, markSent, markFailed, order, run: (p: unknown) => task(p as any, c.ctx) };
}
const tenantPayload = { tenant_id: TENANT, invitation_id: INV };

describe('send_invitation: pending invitation -> GoTrue invite e-mail, then the row is marked sent', () => {
  it('task id is identity.send_invitation', () => { expect(SEND_INVITATION).toBe('identity.send_invitation'); });
  it('tenant invite: load (under the job tenant) -> sendInvite(email, /auth/confirm) -> markSent(issuedAt = ctx.now()), in that order, once', async () => {
    const r = row(); const w = world(r); await w.run(tenantPayload);
    expect(w.loadInvitation).toHaveBeenCalledWith(w.tx, TENANT, INV); expect(w.sendInvite.mock.calls).toEqual([[r.email, '/auth/confirm']]);
    expect(w.markSent).toHaveBeenCalledWith(w.tx, { tenantId: TENANT, invitationId: INV, issuedAt: NOW }); expect(w.order).toEqual(['load', 'sendInvite', 'markSent']); expect(w.markFailed).not.toHaveBeenCalled();
  });
  it('platform-staff invite ({ invitation_id }, no tenant): tenantId undefined end to end', async () => {
    const w = world(row(), { tenantId: undefined }); await w.run({ invitation_id: INV });
    expect(w.loadInvitation).toHaveBeenCalledWith(w.tx, undefined, INV); expect(w.sendInvite).toHaveBeenCalledTimes(1); expect(w.markSent).toHaveBeenCalledWith(w.tx, { tenantId: undefined, invitationId: INV, issuedAt: NOW });
  });
});

describe('idempotency by invitation: anything that is not a live pending invitation is a silent no-op', () => {
  it.each(['sent', 'accepted', 'expired', 'revoked', 'failed'])('status %s -> no e-mail, nothing written, resolves (a duplicate / replayed job sends nothing)', async (status) => {
    const w = world(row({ status })); await expect(w.run(tenantPayload)).resolves.toBeUndefined(); expect(w.sendInvite).not.toHaveBeenCalled(); expect(w.markSent).not.toHaveBeenCalled(); expect(w.markFailed).not.toHaveBeenCalled();
  });
  it.each([['row missing', undefined], ['e-mail redacted (NULL)', row({ email: null })], ['expires_at already past', row({ expires_at: '2026-11-11T03:59:59.000Z' })]] as const)('%s -> no e-mail, nothing written, resolves', async (_n, r) => {
    const w = world(r as any); await expect(w.run(tenantPayload)).resolves.toBeUndefined(); expect(w.sendInvite).not.toHaveBeenCalled(); expect(w.markSent).not.toHaveBeenCalled(); expect(w.markFailed).not.toHaveBeenCalled();
  });
  it('after a successful run the same payload run again with the row now sent sends nothing more', async () => {
    const w = world(row()); await w.run(tenantPayload); const again = world(row({ status: 'sent' })); await again.run(tenantPayload); expect(w.sendInvite).toHaveBeenCalledTimes(1); expect(again.sendInvite).not.toHaveBeenCalled();
  });
});

describe('failures: permanent -> row failed, transient -> retry then dead letter', () => {
  it.each([[422, 'email_exists'], [400, 'validation_failed'], [422, 'email_address_invalid']])('GoTrue %i %s is permanent: markFailed(last_error_code = %s), no markSent, job resolves (no retry)', async (status, code) => {
    const w = world(row(), { sendInvite: async () => { throw gt('sendInvite', status, code); } });
    await expect(w.run(tenantPayload)).resolves.toBeUndefined(); expect(w.markFailed).toHaveBeenCalledWith(w.tx, { tenantId: TENANT, invitationId: INV, errorCode: code }); expect(w.markSent).not.toHaveBeenCalled();
  });
  it.each([
    ['dependency outage', down, 'common.dependency_unavailable'],
    ['GoTrue 429 over_email_send_rate_limit', () => gt('sendInvite', 429, 'over_email_send_rate_limit'), undefined],
    ['GoTrue 401 no_authorization (bad/rotated service key: operator must see it, not a silent failed row)', () => gt('sendInvite', 401, 'no_authorization'), undefined],
    ['GoTrue 403 not_admin', () => gt('sendInvite', 403, 'not_admin'), undefined],
    ['GoTrue 500', () => gt('sendInvite', 500, 'unexpected_failure'), undefined],
    ['GoTrue 503', () => gt('sendInvite', 503, 'unexpected_failure'), undefined],
  ] as const)('%s is transient: rethrown for the queue (max_attempts 8), nothing marked, e-mail not in the message', async (_n, mkErr, code) => {
    const r = row(); const w = world(r, { sendInvite: async () => { throw mkErr(); } }); const e = await err(w.run(tenantPayload));
    expect(e).toBeDefined(); if (code) expect(e.code).toBe(code); expect(w.markFailed).not.toHaveBeenCalled(); expect(w.markSent).not.toHaveBeenCalled(); expect(String(e.message)).not.toContain(String(r.email));
  });
  it('a failing markSent (DB error after the e-mail went out) is rethrown, never swallowed', async () => {
    const w = world(); const boom = new Error('db down'); w.markSent.mockRejectedValueOnce(boom); expect(await err(w.run(tenantPayload))).toBe(boom);
  });
  it('the invitee e-mail is never logged (success, permanent failure, transient failure)', async () => {
    for (const f of [undefined, () => gt('sendInvite', 422, 'email_exists'), down]) {
      const r = row(); const w = world(r, { sendInvite: async () => { if (f) throw f(); } }); await err(w.run(tenantPayload)); expect(w.logged()).not.toContain(String(r.email));
    }
  });
});

describe('robustness / isolation', () => {
  it('payload tenant_id different from the job tenant -> rejects, no load, no e-mail', async () => {
    const w = world(); expect(await err(w.run({ tenant_id: OTHER_TENANT, invitation_id: INV }))).toBeDefined(); expect(w.sendInvite).not.toHaveBeenCalled(); expect(w.loadInvitation).not.toHaveBeenCalled();
  });
  it.each([[{}], [{ invitation_id: 5 }], [{ invitation_id: 'nope', tenant_id: TENANT }], [{ tenant_id: TENANT }], [{ invitation_id: INV, tenant_id: TENANT, email: 'x@y.test' }], [{ invitation_id: INV, extra: 1 }], [undefined]])('malformed payload %j -> rejects (dead-letter path), nothing sent or loaded', async (payload) => {
    const w = world(); expect(await err(w.run(payload))).toBeDefined(); expect(w.sendInvite).not.toHaveBeenCalled(); expect(w.loadInvitation).not.toHaveBeenCalled();
  });
  it('the default wiring rejects a malformed payload before any GoTrue/DB access', async () => {
    const { ctx, tx } = makeCtx({ tenantId: TENANT }); expect(await err(sendInvitation({ nonsense: true } as any, ctx))).toBeDefined(); expect(tx.query).not.toHaveBeenCalled();
  });
});
