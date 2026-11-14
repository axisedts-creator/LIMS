// anatomic.images — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const IMAGES_UPDATABLE = { part_id: '', kind: '', caption: '', state: '', quarantine_reason_code: '', scan_state: '', scan_attempts: '', is_active: '' } as const;

export async function insertImage(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.images (id, tenant_id, centre_id, case_id, part_id, kind, caption, bucket, object_path, state, quarantine_reason_code, scan_state, scan_attempts, mime_type, byte_size, sha256, width_px, height_px, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::text, 'anatomic-images'), $9, COALESCE($10::text, 'processing'), $11, $12, COALESCE($13::smallint, 0), $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['part_id'] ?? null, row['kind'] ?? null, row['caption'] ?? null, row['bucket'] ?? null, row['object_path'] ?? null, row['state'] ?? null, row['quarantine_reason_code'] ?? null, row['scan_state'] ?? null, row['scan_attempts'] ?? null, row['mime_type'] ?? null, row['byte_size'] ?? null, row['sha256'] ?? null, row['width_px'] ?? null, row['height_px'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getImage(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.images WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listImages(tx: Q, i: { tenantId: string; caseId: string; activeOnly?: boolean }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.images WHERE tenant_id = $1 AND case_id = $2 AND (NOT $3::boolean OR is_active) ORDER BY created_at, id`, [i.tenantId, i.caseId, i.activeOnly ?? false]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateImage(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, IMAGES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.images SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
