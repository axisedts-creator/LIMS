// Release path (02-TRD §4.6 rules 1-6): report_versions / reports / portal_links statements used by service/release.service.ts.
// REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters. Runs on the caller's tx.
import type { Tx } from './settings.repo.js';

export async function findVersionForRelease(tx: Tx, tenantId: string, versionId: string): Promise<any | undefined> {
  return (await tx.query(`SELECT id, report_id, version_no, status, report_kind, completeness, order_item_ids, page_count, pdf_bytes, rendered_at, version
    FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, versionId])).rows[0];
}

export async function lockReportForRelease(tx: Tx, tenantId: string, reportId: string): Promise<any | undefined> {
  return (await tx.query(`SELECT id, order_id, patient_id, centre_id, referrer_id, partner_id, order_source, state FROM reporting.reports
    WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, reportId])).rows[0];
}

export async function hasNewerVersion(tx: Tx, tenantId: string, reportId: string, versionNo: number): Promise<boolean> {
  return (await tx.query(`SELECT version_no FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 AND version_no > $3 AND status <> 'discarded' LIMIT 1`,
    [tenantId, reportId, versionNo])).rows.length > 0;
}

/** Hold metadata only: no `version` bump (see service). */
export async function markHeld(tx: Tx, tenantId: string, versionId: string, basis: string, at: string, actorId: string): Promise<void> {
  await tx.query(`UPDATE reporting.report_versions SET held_basis = $3, held_checked_at = $4, updated_by = $5, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND status = 'rendered'`, [tenantId, versionId, basis, at, actorId]);
}

/** Returns the superseded version_no, or null when nothing was released before. */
export async function supersedeReleased(tx: Tx, tenantId: string, reportId: string, byVersionNo: number, at: string, actorId: string): Promise<number | null> {
  const row = (await tx.query(`UPDATE reporting.report_versions SET status = 'superseded', superseded_at = $3, superseded_by_version_no = $4, version = version + 1,
      updated_by = $5, updated_at = now() WHERE tenant_id = $1 AND report_id = $2 AND status = 'released' RETURNING version_no`, [tenantId, reportId, at, byVersionNo, actorId])).rows[0];
  return row ? row.version_no : null;
}

export async function markReleased(tx: Tx, tenantId: string, versionId: string, expectedVersion: number, r: {
  at: string; actorId: string; mode: string; basis: string; overrideId: string | null; audiences: string[]; supersedesVersionNo: number | null;
}): Promise<{ version: number } | undefined> {
  return (await tx.query(`UPDATE reporting.report_versions SET status = 'released', released_at = $3, released_by = $4, release_mode = $5, release_basis = $6,
      release_override_id = $7, audiences = $8::text[], supersedes_version_no = $9, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND status = 'rendered' AND version = $10 RETURNING version`,
  [tenantId, versionId, r.at, r.actorId, r.mode, r.basis, r.overrideId, r.audiences, r.supersedesVersionNo, expectedVersion])).rows[0];
}

/** final_released_at only when `finalAt` is given (first release of a COMPLETE version); first_released_at keeps the original time. */
export async function setReportReleased(tx: Tx, tenantId: string, reportId: string, versionNo: number, at: string, finalAt: string | null, actorId: string): Promise<{ version: number } | undefined> {
  return (await tx.query(`UPDATE reporting.reports SET released_version_no = $3, first_released_at = COALESCE(first_released_at, $4),
      final_released_at = COALESCE(final_released_at, $5), version = version + 1, updated_by = $6, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING version`,
  [tenantId, reportId, versionNo, at, finalAt, actorId])).rows[0];
}

export async function revokeDuesLinks(tx: Tx, tenantId: string, reportId: string, at: string, actorId: string): Promise<void> {
  await tx.query(`UPDATE reporting.portal_links SET revoked_at = $3, revoked_by = $4, revoke_reason_code = 'dues_settled', version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND report_id = $2 AND purpose = 'dues' AND revoked_at IS NULL`, [tenantId, reportId, at, actorId]);
}
