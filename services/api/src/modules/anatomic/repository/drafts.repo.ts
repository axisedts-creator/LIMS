// anatomic.report_drafts — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { json, setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const REPORT_DRAFTS_UPDATABLE = { status: '', change_reason_code: '', change_reason_text: '', gross_text: '', microscopy_text: '', impression_text: '', comment_text: '', flag: '', is_critical: '', synoptic: 'jsonb', ancillary: 'jsonb', image_ids: '', diagnosis_codes: '', consumed_version_no: '', consumed_at: '', discarded_at: '' } as const;

export async function insertReportDraft(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.report_drafts (id, tenant_id, centre_id, case_id, kind, status, change_reason_code, change_reason_text, gross_text, microscopy_text, impression_text, comment_text, flag, is_critical, synoptic, ancillary, image_ids, diagnosis_codes, base_version_no, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::text, 'open'), $7, $8, COALESCE($9::text, ''), COALESCE($10::text, ''), COALESCE($11::text, ''), COALESCE($12::text, ''), $13, COALESCE($14::boolean, false), COALESCE($15::jsonb, '[]'::jsonb), COALESCE($16::jsonb, '[]'::jsonb), COALESCE($17::uuid[], '{}'), COALESCE($18::text[], '{}'), COALESCE($19::integer, 0), $20, $21) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['kind'] ?? null, row['status'] ?? null, row['change_reason_code'] ?? null, row['change_reason_text'] ?? null, row['gross_text'] ?? null, row['microscopy_text'] ?? null, row['impression_text'] ?? null, row['comment_text'] ?? null, row['flag'] ?? null, row['is_critical'] ?? null, json(row['synoptic']), json(row['ancillary']), row['image_ids'] ?? null, row['diagnosis_codes'] ?? null, row['base_version_no'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getReportDraft(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.report_drafts WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listReportDrafts(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.report_drafts WHERE tenant_id = $1 AND case_id = $2 ORDER BY created_at, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateReportDraft(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, REPORT_DRAFTS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.report_drafts SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

/** The single open draft of a case (partial unique index), if any. */
export async function getOpenDraft(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.report_drafts WHERE tenant_id = $1 AND case_id = $2 AND status = 'open'`, [i.tenantId, i.caseId]);
  return rows[0];
}
