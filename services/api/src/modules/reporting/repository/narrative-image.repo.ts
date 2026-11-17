// reporting.input_files rows of kind narrative_image (N6/N7, worker reporting.process_input_file; 02-TRD §6.4, §9; 05-SCHEMA input_files).
// REQ-SEC-024: explicit tenant_id on every statement. Static SQL only; every value is a parameter.
import type { Tx } from './settings.repo.js';

/** The narrative an image is attached to (BOLA: tenant predicate + caller re-check). */
export async function findNarrative(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT id, tenant_id, centre_id, order_id, status
    FROM reporting.narrative_reports WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

export async function insertImage(tx: Tx, r: {
  id: string; tenantId: string; centreId: string; orderId: string; narrativeReportId: string; originalFilename: string; declaredMime: string;
  sizeBytes: number; sha256: string; quarantinePath: string; caption: string | null; actorId: string;
}): Promise<any> {
  const { rows } = await tx.query(`INSERT INTO reporting.input_files (id, tenant_id, centre_id, order_id, narrative_report_id, kind, state,
      original_filename, declared_mime, size_bytes, sha256_original, quarantine_object_path, caption, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) RETURNING *`,
  [r.id, r.tenantId, r.centreId, r.orderId, r.narrativeReportId, 'narrative_image', 'pending_scan', r.originalFilename, r.declaredMime,
    r.sizeBytes, r.sha256, r.quarantinePath, r.caption, r.actorId]);
  return rows[0];
}

/** Worker: sanitizing -> ready with the re-encoded image facts. */
export async function markImageReady(tx: Tx, tenantId: string, id: string, r: { path: string; sha256: string; mime: string; width: number; height: number; actorId: string }): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.input_files SET state = $4, sanitized_object_path = $5, sanitized_sha256 = $6, detected_mime = $7,
      image_width = $8, image_height = $9, last_error_code = $10, version = version + 1, updated_by = $11, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND state = $3 RETURNING *`,
  [tenantId, id, 'sanitizing', 'ready', r.path, r.sha256, r.mime, r.width, r.height, null, r.actorId]);
  return rows[0];
}
