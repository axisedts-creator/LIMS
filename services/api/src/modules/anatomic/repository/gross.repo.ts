// anatomic.gross_records — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const GROSS_RECORDS_UPDATABLE = { gross_text: '', pieces_count: '', dimensions_mm: '', weight_g: '', is_complete: '', completed_at: '', grossed_by_membership_id: '' } as const;

export async function insertGrossRecord(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.gross_records (id, tenant_id, centre_id, case_id, part_id, gross_text, pieces_count, dimensions_mm, weight_g, is_complete, completed_at, grossed_by_membership_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::text, ''), $7, $8, $9, COALESCE($10::boolean, false), $11, $12, $13, $14) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['part_id'] ?? null, row['gross_text'] ?? null, row['pieces_count'] ?? null, row['dimensions_mm'] ?? null, row['weight_g'] ?? null, row['is_complete'] ?? null, row['completed_at'] ?? null, row['grossed_by_membership_id'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getGrossRecord(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.gross_records WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listGrossRecords(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.gross_records WHERE tenant_id = $1 AND case_id = $2 ORDER BY created_at, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateGrossRecord(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, GROSS_RECORDS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.gross_records SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
