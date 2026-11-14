// anatomic.molecular_results — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const MOLECULAR_RESULTS_UPDATABLE = { result_value_id: '', result_code: '', value_decimal: '', unit_code: '', method_text: '', kit_name: '', kit_lot: '', kit_expiry_on: '', batch_id: '', comment_text: '', is_active: '' } as const;

export async function insertMolecularResult(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.molecular_results (id, tenant_id, centre_id, case_id, assay_id, assay_code, target_id, target_code, result_value_id, result_code, value_decimal, unit_code, method_text, kit_name, kit_lot, kit_expiry_on, batch_id, comment_text, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['assay_id'] ?? null, row['assay_code'] ?? null, row['target_id'] ?? null, row['target_code'] ?? null, row['result_value_id'] ?? null, row['result_code'] ?? null, row['value_decimal'] ?? null, row['unit_code'] ?? null, row['method_text'] ?? null, row['kit_name'] ?? null, row['kit_lot'] ?? null, row['kit_expiry_on'] ?? null, row['batch_id'] ?? null, row['comment_text'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getMolecularResult(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.molecular_results WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listMolecularResults(tx: Q, i: { tenantId: string; caseId: string; activeOnly?: boolean }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.molecular_results WHERE tenant_id = $1 AND case_id = $2 AND (NOT $3::boolean OR is_active) ORDER BY target_code, id`, [i.tenantId, i.caseId, i.activeOnly ?? false]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateMolecularResult(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, MOLECULAR_RESULTS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.molecular_results SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
