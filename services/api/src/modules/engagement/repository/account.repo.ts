// engagement.accounts / account_patient_links / payment_requests / addresses - E10-E12 (05-SCHEMA §3, §4 guard_patient_link_update, §5.2 patient RLS; 02-TRD §4.14).
// REQ-SEC-024: every statement binds tenant_id besides RLS and names the account itself.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;
const COLS = 'id, membership_id, phone_e164, status, reminders_opt_out, last_login_at, created_at, version';

/** The caller's live account, row-locked (a deleted account is never served). */
export async function lockLiveByMembership(tx: Q, a: { tenantId: string; membershipId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT ${COLS} FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2 AND status = 'active' FOR UPDATE`, [a.tenantId, a.membershipId]);
  return rows[0];
}

export async function setOptOut(tx: Q, a: { tenantId: string; id: string; version: number; optOut: boolean; updatedBy: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.accounts SET reminders_opt_out = $4, version = version + 1, updated_at = now(), updated_by = $5
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'active' RETURNING ${COLS}`,
    [a.tenantId, a.id, a.version, a.optOut, a.updatedBy]);
  return rows[0];
}

/** TRD §4.14: status deleted, phone cleared (frees the number for a new account), deleted_at. Returns undefined when the version moved. */
export async function markDeleted(tx: Q, a: { tenantId: string; id: string; version: number; now: string; updatedBy: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.accounts SET status = 'deleted', phone_e164 = NULL, phone_hmac = NULL, deleted_at = $4, version = version + 1, updated_at = now(), updated_by = $5
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'active' RETURNING id`,
    [a.tenantId, a.id, a.version, a.now, a.updatedBy]);
  return rows[0];
}

/** Active and suspended links -> revoked by the account; an earlier revoke keeps its own reason. suspend_* cleared (links__suspend__ck) - see the T-AC1 impl note. */
export async function revokeLinks(tx: Q, a: { tenantId: string; accountId: string; now: string; updatedBy: string }): Promise<void> {
  await tx.query(
    `UPDATE engagement.account_patient_links SET status = 'revoked', revoked_by_kind = 'account', revoked_reason_code = 'account_deleted', revoked_at = $3,
       suspend_reason = NULL, suspended_at = NULL, is_active = false, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND account_id = $2 AND status IN ('active', 'suspended')`,
    [a.tenantId, a.accountId, a.now, a.updatedBy]);
}

/** queued|ready -> expired; the secret-bearing action_json is scrubbed when a request leaves `ready` (payment_requests__action__ck). */
export async function expirePayments(tx: Q, a: { tenantId: string; accountId: string; updatedBy: string }): Promise<void> {
  await tx.query(
    `UPDATE engagement.payment_requests SET status = 'expired', action_json = NULL, version = version + 1, updated_at = now(), updated_by = $3
     WHERE tenant_id = $1 AND account_id = $2 AND status IN ('queued', 'ready')`,
    [a.tenantId, a.accountId, a.updatedBy]);
}

export async function deactivateAddresses(tx: Q, a: { tenantId: string; accountId: string; updatedBy: string }): Promise<void> {
  await tx.query(
    `UPDATE engagement.addresses SET is_active = false, version = version + 1, updated_at = now(), updated_by = $3
     WHERE tenant_id = $1 AND account_id = $2 AND is_active = true`,
    [a.tenantId, a.accountId, a.updatedBy]);
}
