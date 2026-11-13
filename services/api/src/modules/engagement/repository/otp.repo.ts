// engagement.otp_challenges + the otp_day:<yyyymmdd> row of engagement.number_counters (05-SCHEMA §2, §5.3; 02-TRD §4.1 steps 1-2). REQ-SEC-024: every
// statement binds tenant_id besides RLS. Static SQL only; hashes are raw 32-byte Buffers, never hex (08 A5.5). Nothing here logs or returns a secret column
// except `loadForSend`, whose ciphertext only the send task decrypts.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

export interface NewChallenge {
  id: string; tenantId: string; tokenSha256: Uint8Array; phoneE164: string; phoneHmac: Uint8Array; appInstanceId: string; appPlatform: string;
  codeHmac: Uint8Array; codeCiphertext: Uint8Array; codeKeyId: string; createdAt: string; createdBy: string; expiresAt: string;
}

export async function insertChallenge(tx: Q, c: NewChallenge): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.otp_challenges (id, tenant_id, token_sha256, phone_e164, phone_hmac, app_instance_id, app_platform, code_hmac, code_ciphertext, code_key_id, created_at, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [c.id, c.tenantId, c.tokenSha256, c.phoneE164, c.phoneHmac, c.appInstanceId, c.appPlatform, c.codeHmac, c.codeCiphertext, c.codeKeyId, c.createdAt, c.createdBy, c.expiresAt]);
}

/**
 * Durable tenant daily cap (TRD §4.1): count one request in (tenant, counter_key). One statement, race-free: the conditional upsert refuses
 * (no row) once last_value has reached `cap`. true = counted, false = cap reached. The row is a rate key: expires_at lets the purge task drop it.
 */
export async function countDailyRequest(tx: Q, a: { tenantId: string; key: string; cap: number; createdBy: string; expiresAt: string }): Promise<boolean> {
  if (!(a.cap >= 1)) return false; // an INSERT would otherwise count request 1 against a cap of 0
  const { rows } = await tx.query(
    `INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, expires_at, created_by) VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (tenant_id, counter_key) DO UPDATE SET last_value = number_counters.last_value + 1, updated_at = now() WHERE number_counters.last_value < $5
     RETURNING last_value`,
    [a.tenantId, a.key, a.expiresAt, a.createdBy, a.cap]);
  return rows.length === 1;
}

/** The challenge a send job refers to, locked for the rest of the task transaction. */
export async function loadForSend(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT id, phone_e164, phone_hmac, app_instance_id, status, code_ciphertext, code_key_id, created_at, expires_at
     FROM engagement.otp_challenges WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [a.tenantId, a.id]);
  return rows[0];
}

/** E3: the caller's own challenge (PRE_TOK narrows it further), locked for the rest of the request transaction. */
export async function loadForVerify(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT id, phone_e164, phone_hmac, app_instance_id, app_platform, status, attempts, code_hmac, expires_at
     FROM engagement.otp_challenges WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [a.tenantId, a.id]);
  return rows[0];
}

/** Mismatch: attempts + 1 (persisted via commitOnError); `status` is 'failed' once the 5th attempt is used, else unchanged. */
export async function recordMismatch(tx: Q, a: { tenantId: string; id: string; attempts: number; status: string }): Promise<void> {
  await tx.query(
    `UPDATE engagement.otp_challenges SET attempts = $3, status = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [a.tenantId, a.id, a.attempts, a.status]);
}

/** Match: verified + consumed (single use). Must run before the accounts INSERT: PRE_ACC requires a `verified` challenge. */
export async function markVerified(tx: Q, a: { tenantId: string; id: string; attempts: number }): Promise<void> {
  await tx.query(
    `UPDATE engagement.otp_challenges SET attempts = $3, status = 'verified', verified_at = now(), consumed_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [a.tenantId, a.id, a.attempts]);
}

/** TRD §4.1 step 2: earlier pending/sent challenges of the same phone + app instance (tenant) -> superseded. Later ones (a faster second request) stay live. */
export async function supersedeEarlier(tx: Q, a: { tenantId: string; id: string; phoneHmac: Uint8Array; appInstanceId: string; createdAt: string }): Promise<void> {
  await tx.query(
    `UPDATE engagement.otp_challenges SET status = 'superseded', updated_at = now()
     WHERE tenant_id = $1 AND phone_hmac = $2 AND app_instance_id = $3 AND status IN ('pending', 'sent') AND created_at <= $4 AND id <> $5`,
    [a.tenantId, a.phoneHmac, a.appInstanceId, a.createdAt, a.id]);
}

/** The ciphertext is a secret: gone as soon as the code left (sent) or can no longer be sent (failed). */
export async function markSent(tx: Q, a: { tenantId: string; id: string; deliveryId: string }): Promise<void> {
  await tx.query(
    `UPDATE engagement.otp_challenges SET code_ciphertext = NULL, status = 'sent', send_delivery_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [a.tenantId, a.id, a.deliveryId]);
}

export async function markFailed(tx: Q, a: { tenantId: string; id: string }): Promise<void> {
  await tx.query(
    `UPDATE engagement.otp_challenges SET code_ciphertext = NULL, status = 'failed', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [a.tenantId, a.id]);
}
