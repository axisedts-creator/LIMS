// anatomic.report_versions — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { json, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

export async function insertReportVersion(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.report_versions (id, tenant_id, centre_id, case_id, version_no, version_kind, scope, addon_case_item_id, addendum_id, change_reason_code, change_reason_text, clinical_history_text, gross_text, microscopy_text, impression_text, comment_text, flag, is_critical, synoptic, images, specimen_parts, slides, ancillary, molecular, addenda, diagnosis_codes, signed_by_membership_id, signed_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::text, 'full'), $8, $9, $10, $11, COALESCE($12::text, ''), COALESCE($13::text, ''), COALESCE($14::text, ''), COALESCE($15::text, ''), COALESCE($16::text, ''), $17, COALESCE($18::boolean, false), COALESCE($19::jsonb, '[]'::jsonb), COALESCE($20::jsonb, '[]'::jsonb), COALESCE($21::jsonb, '[]'::jsonb), COALESCE($22::jsonb, '[]'::jsonb), COALESCE($23::jsonb, '[]'::jsonb), COALESCE($24::jsonb, '[]'::jsonb), COALESCE($25::jsonb, '[]'::jsonb), COALESCE($26::jsonb, '[]'::jsonb), $27, $28, $29) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['version_no'] ?? null, row['version_kind'] ?? null, row['scope'] ?? null, row['addon_case_item_id'] ?? null, row['addendum_id'] ?? null, row['change_reason_code'] ?? null, row['change_reason_text'] ?? null, row['clinical_history_text'] ?? null, row['gross_text'] ?? null, row['microscopy_text'] ?? null, row['impression_text'] ?? null, row['comment_text'] ?? null, row['flag'] ?? null, row['is_critical'] ?? null, json(row['synoptic']), json(row['images']), json(row['specimen_parts']), json(row['slides']), json(row['ancillary']), json(row['molecular']), json(row['addenda']), json(row['diagnosis_codes']), row['signed_by_membership_id'] ?? null, row['signed_at'] ?? null, row['created_by'] ?? null]);
  return rows[0] as Row;
}

export async function getReportVersion(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.report_versions WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listReportVersions(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.report_versions WHERE tenant_id = $1 AND case_id = $2 ORDER BY version_no DESC, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Highest version_no of a case, or undefined when never signed. */
export async function getLatestReportVersion(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.report_versions WHERE tenant_id = $1 AND case_id = $2 ORDER BY version_no DESC LIMIT 1`, [i.tenantId, i.caseId]);
  return rows[0];
}
