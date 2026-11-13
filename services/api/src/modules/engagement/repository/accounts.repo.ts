// engagement.accounts, only what E3 verify needs (05-SCHEMA §3 accounts, §5.2 PRE_ACC; 02-TRD §4.1 step 3). REQ-SEC-024: every statement binds tenant_id besides RLS.
// Pre-auth callers see/insert only the account whose phone is the phone of their OWN verified challenge (PRE_ACC), so these queries never name another phone's row.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

/** The live (status <> 'deleted') account of a phone; a deleted one is never reused (re-sign-in creates a new account, 06-PLAN T-AC1). */
export async function findLiveByPhone(tx: Q, a: { tenantId: string; phoneE164: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT id, membership_id, user_id, phone_e164 FROM engagement.accounts WHERE tenant_id = $1 AND phone_e164 = $2 AND status <> 'deleted'`,
    [a.tenantId, a.phoneE164]);
  return rows[0];
}

/** First sign-in: id = the challenge id (deterministic for the retry window, TRD §4.1 step 3). */
export async function insertAccount(tx: Q, a: { id: string; tenantId: string; phoneE164: string; phoneHmac: Uint8Array; createdBy: string }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.accounts (id, tenant_id, phone_e164, phone_hmac, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, membership_id, user_id, phone_e164`,
    [a.id, a.tenantId, a.phoneE164, a.phoneHmac, a.createdBy]);
  return rows[0]!;
}

/** After C2 provisioned/opened the session: store the C2 ids and the sign-in facts; returns the columns of the Account wire shape. */
export async function recordLogin(tx: Q, a: { id: string; tenantId: string; membershipId: string; userId: string; loginAt: string; appPlatform: string; updatedBy: string }): Promise<Row> {
  const { rows } = await tx.query(
    `UPDATE engagement.accounts SET membership_id = $3, user_id = $4, last_login_at = $5, last_app_platform = $6, updated_by = $7, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, status, reminders_opt_out, last_login_at, created_at, version`,
    [a.tenantId, a.id, a.membershipId, a.userId, a.loginAt, a.appPlatform, a.updatedBy]);
  return rows[0]!;
}
