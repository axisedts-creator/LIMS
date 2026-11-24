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

/** Find existing patients in frontdesk.patients matching the phone that are not yet linked to this account. */
export async function findUnlinkedPatientsByPhone(tx: Q, a: { tenantId: string; accountId: string; phoneE164: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT p.id, p.full_name, p.sex
     FROM frontdesk.patients p
     WHERE p.tenant_id = $1
       AND p.phone_e164 = $2
       AND p.anonymised_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM engagement.account_patient_links l
         WHERE l.tenant_id = $1 AND l.account_id = $3 AND l.patient_id = p.id AND l.status IN ('active', 'suspended')
       )
     ORDER BY p.created_at ASC`,
    [a.tenantId, a.phoneE164, a.accountId]);
  return rows;
}

/** Check if the account already has an active or suspended self-link. */
export async function hasActiveSelfLink(tx: Q, a: { tenantId: string; accountId: string }): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM engagement.account_patient_links
     WHERE tenant_id = $1 AND account_id = $2 AND relationship = 'self' AND status IN ('active', 'suspended')`,
    [a.tenantId, a.accountId]);
  return rows.length > 0;
}

/** Auto-link an existing lab patient to the newly verified mobile account and enqueue historical report backfill. */
export async function autoLinkPatient(tx: Q, a: {
  id: string;
  tenantId: string;
  accountId: string;
  patientId: string;
  relationship: string;
  displayName: string;
  sexSnapshot: string | null;
  phoneHmac: Uint8Array;
  actorId: string;
}): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.account_patient_links (
       id, tenant_id, account_id, patient_id, relationship, method,
       display_name, sex_snapshot, status, visible_from, record_phone_hmac_at_link,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, 'self_registered', $6, $7, 'active', NULL, $8, $9, $9)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [a.id, a.tenantId, a.accountId, a.patientId, a.relationship, a.displayName, a.sexSnapshot, a.phoneHmac, a.actorId]);
  await tx.query(
    `SELECT app.enqueue_job('engagement.backfill_link', jsonb_build_object('tenant_id', $1, 'link_id', $2), $3, NULL, 10)`,
    [a.tenantId, a.id, `backfill:${a.id}`]);
}
