// anatomic.slides — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const SLIDES_UPDATABLE = { status: '', ready_at: '', location_status: '', location_text: '', adequacy_code: '', finding_text: '', include_in_report: '' } as const;

export async function insertSlide(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.slides (id, tenant_id, centre_id, case_id, part_id, block_id, seq, label, stain_id, stain_code, stain_order_id, status, ready_at, location_status, location_text, adequacy_code, finding_text, include_in_report, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::text, 'pending_stain'), $13, COALESCE($14::text, 'in_lab'), $15, $16, $17, COALESCE($18::boolean, false), $19, $20) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['part_id'] ?? null, row['block_id'] ?? null, row['seq'] ?? null, row['label'] ?? null, row['stain_id'] ?? null, row['stain_code'] ?? null, row['stain_order_id'] ?? null, row['status'] ?? null, row['ready_at'] ?? null, row['location_status'] ?? null, row['location_text'] ?? null, row['adequacy_code'] ?? null, row['finding_text'] ?? null, row['include_in_report'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getSlide(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.slides WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listSlides(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.slides WHERE tenant_id = $1 AND case_id = $2 ORDER BY part_id, seq, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateSlide(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, SLIDES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.slides SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
