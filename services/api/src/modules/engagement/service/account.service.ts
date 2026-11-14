// E10 getMyAccount, E11 updateMyAccount (reminder opt-out, US-EN-23.3), E12 deleteMyAccount (US-EN-19.1/19.2) - 02-TRD §4.14, §5, §6.2 revokePatientSessions; 07-SECURITY REQ-SEC-024/096/097/139.
// [CONV] Order: IdentityPort.assertRole (handler) -> patient actor only -> If-Match shape (428/400) -> body (400) -> row lock + lookup (404) -> version (409) -> writes -> C2 revoke -> access_log.
// [CONV] C2 is called after the DB writes inside the same transaction: if it fails everything rolls back (the account is never deleted while its sessions live).
// The caller's account is found by membership_id = ctx.actor.id (TRD §4.2 claims.membership_id). A deleted account is "not found" (its session is gone).
import { LimsError } from '../../../core/errors.js';
import { maskPhone } from '../domain/phone.js';
import * as defaultRepo from '../repository/account.repo.js';
import { invalid, parseIfMatch, type SlotCtx } from './slot.service.js';

export type AccountRepo = typeof defaultRepo;
export interface AccountCtx extends SlotCtx {
  readonly audit: { access(e: Record<string, unknown>): Promise<void> };
  readonly ports?: { IdentityPort?: { revokePatientSessions(ctx: unknown, i: { membershipId: string; reason: string; deactivateMembership: boolean }): Promise<unknown> } };
}
type Out = { status: number; body?: Record<string, unknown> };
type Row = Record<string, any>;

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Exactly one key, of the allowed name; no unknown field is ever echoed. */
function only(body: unknown, key: string): unknown {
  if (!isObj(body) || Object.keys(body).length !== 1 || !(key in body)) return invalid('/');
  return body[key];
}
const wire = (a: Row): Record<string, unknown> => ({
  id: a['id'], phone_masked: maskPhone(a['phone_e164']), status: a['status'], reminders_opt_out: a['reminders_opt_out'],
  ...(a['last_login_at'] == null ? {} : { last_login_at: iso(a['last_login_at']) }), created_at: iso(a['created_at']), version: a['version'],
});
function mapDbError(e: unknown): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '42501') throw new LimsError('common.not_found'); // RLS: not the caller's row
  throw new LimsError('common.internal');
}

export function createAccountService(repo: AccountRepo = defaultRepo) {
  const scope = (ctx: AccountCtx) => {
    if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx || typeof ctx.now !== 'function') throw new LimsError('auth.unauthenticated');
    if (ctx.actor.type !== 'patient') throw new LimsError('auth.forbidden'); // staff / system actors have no patient account
    return { tx: ctx.tx as any, tenantId: ctx.tenantId, membershipId: ctx.actor.id, now: iso(ctx.now()) };
  };
  const mine = async (s: ReturnType<typeof scope>): Promise<Row> => {
    const a = await repo.lockLiveByMembership(s.tx, { tenantId: s.tenantId, membershipId: s.membershipId }).catch(mapDbError);
    if (!a) throw new LimsError('common.not_found');
    return a;
  };
  return {
    async get(ctx: AccountCtx): Promise<Out> {
      const s = scope(ctx);
      return { status: 200, body: wire(await mine(s)) };
    },
    async update(ctx: AccountCtx, a: { headers: unknown; body: unknown }): Promise<Out> {
      const s = scope(ctx);
      const expected = parseIfMatch(a.headers);
      const optOut = only(a.body, 'reminders_opt_out');
      if (typeof optOut !== 'boolean') return invalid('/reminders_opt_out');
      const cur = await mine(s);
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      const row = await repo.setOptOut(s.tx, { tenantId: s.tenantId, id: cur['id'], version: expected, optOut, updatedBy: s.membershipId }).catch(mapDbError);
      if (!row) throw new LimsError('common.version_conflict');
      return { status: 200, body: wire(row) };
    },
    async remove(ctx: AccountCtx, a: { headers: unknown; body: unknown }): Promise<Out> {
      const s = scope(ctx);
      const expected = parseIfMatch(a.headers);
      if (only(a.body, 'confirm') !== true) return invalid('/confirm');
      const cur = await mine(s);
      if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
      const k = { tenantId: s.tenantId, accountId: cur['id'], updatedBy: s.membershipId };
      try {
        // [CONV] Links last: addresses UPDATE is PAT_ACC_PID (05-SCHEMA §4 policy table), which only sees ACTIVE links - after revokeLinks it would match 0 rows.
        // payment_requests UPDATE is PAT_ACC (link-independent), so it can go first.
        await repo.expirePayments(s.tx, k);
        await repo.deactivateAddresses(s.tx, k);
        await repo.revokeLinks(s.tx, { ...k, now: s.now });
        if (!(await repo.markDeleted(s.tx, { tenantId: s.tenantId, id: cur['id'], version: expected, now: s.now, updatedBy: s.membershipId }))) throw new LimsError('common.version_conflict');
      } catch (e) { mapDbError(e); }
      // C2 revokes the sessions under its own system actor (08 A28.2); a failure propagates and rolls the whole deletion back.
      await ctx.ports!.IdentityPort!.revokePatientSessions(ctx, { membershipId: cur['membership_id'], reason: 'account_deleted', deactivateMembership: true });
      await ctx.audit.access({ action: 'patient_account.delete', entityType: 'patient_account', entityId: cur['id'], outcome: 'success' }); // no phone, no name
      return { status: 204 };
    },
  };
}
export type AccountService = ReturnType<typeof createAccountService>;
