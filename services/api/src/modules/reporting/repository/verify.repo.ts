// Q1 public QR lookup + R14-R16 token / link revoke and list (06-PLAN C6-T22). REQ-SEC-024: explicit tenant_id on every tenant statement.
// Q1 reads ONLY through the DEFINER (05-SCHEMA §6.2): no direct qr_tokens lookup by token under the app role (REQ-SEC-018).
import type { Tx } from './settings.repo.js';

export interface QrVerifyRow { lab_name: string; patient_display: string; panel_names: string[]; issued_at: Date | string; version_no: number; status: string }

export async function verifyQr(tx: Tx, tokenSha256: Uint8Array): Promise<QrVerifyRow | undefined> {
  return (await tx.query('SELECT * FROM app.reporting_verify_qr($1)', [Buffer.from(tokenSha256)])).rows[0] as QrVerifyRow | undefined;
}

export async function findQrByVersion(tx: Tx, tenantId: string, versionId: string): Promise<{ id: string; revoked_at: Date | string | null } | undefined> {
  return (await tx.query('SELECT id, revoked_at FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_version_id = $2', [tenantId, versionId])).rows[0] as any;
}

/** First revoker wins: only an unrevoked row matches; undefined = somebody else got there first. */
export async function revokeQr(tx: Tx, tenantId: string, id: string, at: string, actorId: string, reasonCode: string, reasonText: string | null): Promise<{ revoked_at: Date | string } | undefined> {
  return (await tx.query(`UPDATE reporting.qr_tokens SET revoked_at = $3, revoked_by = $4, revoke_reason_code = $5, revoke_reason_text = $6, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING revoked_at`, [tenantId, id, at, actorId, reasonCode, reasonText])).rows[0] as any;
}

export async function findLink(tx: Tx, tenantId: string, id: string): Promise<{ id: string; revoked_at: Date | string | null } | undefined> {
  return (await tx.query('SELECT id, revoked_at FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0] as any;
}

/** portal_links has no reason-text column (05-SCHEMA §2.6); the guard trigger keeps revoked_* write-once. */
export async function revokeLink(tx: Tx, tenantId: string, id: string, at: string, actorId: string, reasonCode: string): Promise<{ revoked_at: Date | string } | undefined> {
  return (await tx.query(`UPDATE reporting.portal_links SET revoked_at = $3, revoked_by = $4, revoke_reason_code = $5, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING revoked_at`, [tenantId, id, at, actorId, reasonCode])).rows[0] as any;
}

export async function reportExists(tx: Tx, tenantId: string, reportId: string): Promise<boolean> {
  return (await tx.query('SELECT id FROM reporting.reports WHERE tenant_id = $1 AND id = $2', [tenantId, reportId])).rows.length > 0;
}

export async function linksOfReport(tx: Tx, tenantId: string, reportId: string, limit: number): Promise<any[]> {
  return (await tx.query(`SELECT id, channel, recipient_kind, destination_masked, expires_at, revoked_at, last_used_at, use_count FROM reporting.portal_links
    WHERE tenant_id = $1 AND report_id = $2 ORDER BY created_at DESC, id LIMIT $3`, [tenantId, reportId, limit])).rows;
}
