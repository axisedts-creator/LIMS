// anatomic.item_submissions — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

export async function insertItemSubmission(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.item_submissions (id, tenant_id, centre_id, case_id, case_item_id, item_version_no, report_version_id, idempotency_key, lab_result_id, lab_version_no, lab_status, replayed, submitted_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['case_item_id'] ?? null, row['item_version_no'] ?? null, row['report_version_id'] ?? null, row['idempotency_key'] ?? null, row['lab_result_id'] ?? null, row['lab_version_no'] ?? null, row['lab_status'] ?? null, row['replayed'] ?? null, row['submitted_at'] ?? null, row['created_by'] ?? null]);
  return rows[0] as Row;
}

export async function getItemSubmission(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.item_submissions WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listItemSubmissions(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.item_submissions WHERE tenant_id = $1 AND case_id = $2 ORDER BY submitted_at, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** CR-C11-011: latest item_version_no among the submissions that carried lab result version k (02-TRD §8.2). Undefined = not an anatomic result. */
export async function maxItemVersionForLabResult(tx: Q, i: { tenantId: string; labResultId: string; labVersionNo: number }): Promise<{ case_item_id: string; max_item_version_no: number } | undefined> {
  const { rows } = await tx.query(
    `SELECT case_item_id, max(item_version_no) AS max_item_version_no FROM anatomic.item_submissions
     WHERE tenant_id = $1 AND lab_result_id = $2 AND lab_version_no = $3 GROUP BY case_item_id ORDER BY case_item_id LIMIT 1`, [i.tenantId, i.labResultId, i.labVersionNo]);
  return rows[0];
}

/** Submission by its A1 idempotency key ('anatomic:<case_item_id>:<item_version_no>'). */
export async function getItemSubmissionByKey(tx: Q, i: { tenantId: string; idempotencyKey: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.item_submissions WHERE tenant_id = $1 AND idempotency_key = $2`, [i.tenantId, i.idempotencyKey]);
  return rows[0];
}
