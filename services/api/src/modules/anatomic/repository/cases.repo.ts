// anatomic.cases / anatomic.case_transitions / anatomic.case_items — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { page, setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const CASES_UPDATABLE = { branch_id: '', status: '', priority: '', accession_no: '', accession_series: '', accession_year: '', clinical_history_text: '', assigned_pathologist_membership_id: '', profile_missing: '', current_version_no: '', molecular_rev: '', accessioned_at: '', accessioned_by: '', signed_out_at: '', cancelled_at: '', cancel_reason_code: '', cancel_reason_text: '' } as const;
const CASE_ITEMS_UPDATABLE = { role: '', lab_approved_version_no: '', lab_approved_at: '', is_active: '' } as const;

export async function insertCase(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.cases (id, tenant_id, centre_id, branch_id, order_id, patient_id, case_kind, status, priority, accession_no, accession_series, accession_year, clinical_history_text, assigned_pathologist_membership_id, profile_missing, received_at, accessioned_at, accessioned_by, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::text, 'received'), COALESCE($9::text, 'routine'), $10, $11, $12, $13, $14, COALESCE($15::boolean, false), $16, $17, $18, $19, $20) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['branch_id'] ?? null, row['order_id'] ?? null, row['patient_id'] ?? null, row['case_kind'] ?? null, row['status'] ?? null, row['priority'] ?? null, row['accession_no'] ?? null, row['accession_series'] ?? null, row['accession_year'] ?? null, row['clinical_history_text'] ?? null, row['assigned_pathologist_membership_id'] ?? null, row['profile_missing'] ?? null, row['received_at'] ?? null, row['accessioned_at'] ?? null, row['accessioned_by'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getCase(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.cases WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.caseId]);
  return rows[0];
}

export async function listCases(tx: Q, i: { tenantId: string; status?: string; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.cases WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY received_at DESC, id LIMIT $3 OFFSET $4`,
    [i.tenantId, i.status ?? null, p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateCase(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, CASES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.cases SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

/** All cases of one order (an order can open one case per kind). */
export async function listCasesByOrder(tx: Q, i: { tenantId: string; orderId: string }): Promise<Row[]> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.cases WHERE tenant_id = $1 AND order_id = $2 ORDER BY received_at, id`, [i.tenantId, i.orderId]);
  return rows;
}

export async function insertCaseTransition(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.case_transitions (id, tenant_id, centre_id, case_id, from_status, to_status, reason_code, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['from_status'] ?? null, row['to_status'] ?? null, row['reason_code'] ?? null, row['created_by'] ?? null]);
  return rows[0] as Row;
}

export async function getCaseTransition(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.case_transitions WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listCaseTransitions(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.case_transitions WHERE tenant_id = $1 AND case_id = $2 ORDER BY created_at, id`, [i.tenantId, i.caseId]);
  return rows;
}

export async function insertCaseItem(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.case_items (id, tenant_id, centre_id, case_id, order_item_id, test_id, role, lab_approved_version_no, lab_approved_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::text, 'primary'), COALESCE($8::integer, 0), $9, $10, $11) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['order_item_id'] ?? null, row['test_id'] ?? null, row['role'] ?? null, row['lab_approved_version_no'] ?? null, row['lab_approved_at'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getCaseItem(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.case_items WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listCaseItems(tx: Q, i: { tenantId: string; caseId: string; activeOnly?: boolean }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.case_items WHERE tenant_id = $1 AND case_id = $2 AND (NOT $3::boolean OR is_active) ORDER BY created_at, id`, [i.tenantId, i.caseId, i.activeOnly ?? false]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateCaseItem(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, CASE_ITEMS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.case_items SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
