// engagement.link_codes (S I U D; staff side: insert, supersede, revoke, read) + reads/revoke of account_patient_links and the account phone for L1-L4 (02-TRD §4.3.1, §5 L1-L4).
// Every statement binds tenant_id (REQ-SEC-024). HMAC columns are raw 32-byte Buffers (bytea, 08 A5.5), never hex. Statements stay simple (no OR / JOIN / sub-select) so the in-house FakeDb interprets them.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
export type Row = Record<string, any>;

const LINK_COLS = 'id, account_id, patient_id, relationship, method, display_name, status, suspend_reason, visible_from, revoked_reason_code, revoked_at, version';
const SELECT_LINKS = 'SELECT ' + LINK_COLS + ' FROM engagement.account_patient_links'; // constant column list only; values are always $n parameters

/** No settings row = feature never switched on = off. */
export async function settings(tx: Q, tenantId: string): Promise<Row | undefined> {
  const { rows } = await tx.query(
    'SELECT app_enabled, allowed_phone_prefixes, app_consent_text_version, max_accounts_per_patient, link_code_ttl_hours FROM engagement.settings WHERE tenant_id = $1', [tenantId]);
  return rows[0];
}

export async function activeLinkCount(tx: Q, a: { tenantId: string; patientId: string }): Promise<number> {
  const { rows } = await tx.query("SELECT count(*) FROM engagement.account_patient_links WHERE tenant_id = $1 AND patient_id = $2 AND status = 'active'", [a.tenantId, a.patientId]);
  return Number(rows[0]?.['count'] ?? 0);
}

/** Unexpired issued codes of one patient, oldest first (the 3-code rule of 02-TRD §4.3.1 step 3). */
export async function liveCodes(tx: Q, a: { tenantId: string; patientId: string; now: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    "SELECT id FROM engagement.link_codes WHERE tenant_id = $1 AND patient_id = $2 AND status = 'issued' AND expires_at > $3 ORDER BY created_at ASC, id ASC", [a.tenantId, a.patientId, a.now]);
  return rows;
}

export async function supersede(tx: Q, a: { tenantId: string; userId: string; id: string; now: string }): Promise<void> {
  await tx.query(
    "UPDATE engagement.link_codes SET status = 'revoked', revoke_reason = 'superseded', updated_at = $3, updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND status = 'issued'", [a.tenantId, a.id, a.now, a.userId]);
}

export async function insertCode(tx: Q, a: {
  tenantId: string; userId: string; patientId: string; codeHmac: Buffer; boundPhoneHmac: Buffer; boundPhoneLast2: string; recordPhoneHmac: Buffer | null; relationship: string; consentId: string;
  displayName: string; sex: string | null; expiresAt: string; now: string;
}): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO engagement.link_codes (id, tenant_id, patient_id, code_hmac, bound_phone_hmac, bound_phone_last2, record_phone_hmac, relationship, consent_id, display_name_snapshot, sex_snapshot,
       issued_by_membership_id, status, created_at, created_by, expires_at, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'issued', $13, $12, $14, $13, $12)`,
    [id, a.tenantId, a.patientId, a.codeHmac, a.boundPhoneHmac, a.boundPhoneLast2, a.recordPhoneHmac, a.relationship, a.consentId, a.displayName, a.sex, a.userId, a.now, a.expiresAt]);
  return id;
}

export async function getCode(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT id, status FROM engagement.link_codes WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id]);
  return rows[0];
}

/** Conditional revoke (only an `issued` code): undefined = it was redeemed / revoked in between. */
export async function revokeCode(tx: Q, a: { tenantId: string; userId: string; id: string; now: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    "UPDATE engagement.link_codes SET status = 'revoked', revoke_reason = 'staff', updated_at = $3, updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND status = 'issued' RETURNING id", [a.tenantId, a.id, a.now, a.userId]);
  return rows[0];
}

/** L3: contract columns only (no hash, no code, no phone). */
export async function codesOf(tx: Q, a: { tenantId: string; patientId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    'SELECT id, status, expires_at, created_at FROM engagement.link_codes WHERE tenant_id = $1 AND patient_id = $2 ORDER BY created_at DESC, id DESC LIMIT 50', [a.tenantId, a.patientId]);
  return rows;
}

export async function linksOf(tx: Q, a: { tenantId: string; patientId: string }): Promise<Row[]> {
  const { rows } = await tx.query(SELECT_LINKS + ' WHERE tenant_id = $1 AND patient_id = $2 ORDER BY created_at DESC, id DESC LIMIT 50', [a.tenantId, a.patientId]);
  return rows;
}

export async function getLink(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(SELECT_LINKS + ' WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id]);
  return rows[0];
}

/** Conditional revoke guarded by version and a non-terminal status: undefined = lost a race. */
export async function revokeLink(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number; reason: string; now: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.account_patient_links SET status = 'revoked', revoked_by_kind = 'staff', revoked_reason_code = $4, revoked_at = $5, version = version + 1, updated_at = $5, updated_by = $6
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status IN ('active', 'suspended') RETURNING ${LINK_COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.reason, a.now, a.userId]);
  return rows[0];
}

/** account_id -> phone_e164, for the masked phone of L3 / L4 (the full number never leaves the service). */
export async function accountPhones(tx: Q, a: { tenantId: string; accountIds: readonly string[] }): Promise<Row[]> {
  if (a.accountIds.length === 0) return [];
  const { rows } = await tx.query('SELECT id, phone_e164 FROM engagement.accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [a.tenantId, [...a.accountIds]]);
  return rows;
}
