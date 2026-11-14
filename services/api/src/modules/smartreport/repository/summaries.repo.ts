// smartreport.summaries (class C, centre-scoped, 05-SCHEMA §2.8). Content columns are immutable after insert (trigger); updates touch lifecycle columns only.
import { clampLimit, cols, getRow, insertRow, updateRow, type RepoCtx, type Row, type UpdateSpec } from './common.repo.js';

const T = 'smartreport.summaries';
// status and the approved_*/rejected_*/superseded_* columns are lifecycle: set by updateSummary, never at insert (a new summary is a draft).
const INS = cols(`id centre_id order_id patient_id library_version_id template_library_version formula_version language approved_set_hash
  input_result_versions content content_sha256 health_score_value health_score_band panels_scored deranged_count critical_count unmapped_result_count
  ignored_duplicate_count built_at use_llm_text llm_overlay`);
const LIFECYCLE = cols(`status approved_at approved_by_membership_id use_llm_text llm_overlay rejected_at rejected_by_membership_id reject_reason_code
  reject_comment superseded_at superseded_reason superseded_by_summary_id`);
const SPEC: UpdateSpec = {
  table: T,
  allow: LIFECYCLE,
  statement: (set, n) => `UPDATE smartreport.summaries SET ${set}, version = version + 1, updated_at = now(), updated_by = $${n}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
};
// The queue lists many rows: no content / llm_overlay / input_result_versions (P3 bodies, loaded by getSummary on open).
const QUEUE_COLUMNS = `id, tenant_id, centre_id, order_id, patient_id, library_version_id, template_library_version, formula_version, language, approved_set_hash,
  status, content_sha256, health_score_value, health_score_band, panels_scored, deranged_count, critical_count, unmapped_result_count, ignored_duplicate_count,
  built_at, approved_at, approved_by_membership_id, use_llm_text, rejected_at, rejected_by_membership_id, reject_reason_code, superseded_at, superseded_reason,
  superseded_by_summary_id, version, created_at, created_by, updated_at, updated_by`;

export const insertSummary = (rc: RepoCtx, row: Row) => insertRow(rc, T, INS, row, true);
export const getSummary = (rc: RepoCtx, id: string) => getRow(rc, T, id);
export const updateSummary = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SPEC, id, expectedVersion, patch);

/** The one live (draft | approved | rejected) summary of an order — summaries__tenant_id_order_id__live__p_uq. */
export async function getLiveSummaryByOrder(rc: RepoCtx, orderId: string): Promise<Row | null> {
  const { rows } = await rc.tx.query(
    `SELECT * FROM smartreport.summaries WHERE tenant_id = $1 AND order_id = $2 AND status IN ('draft', 'approved', 'rejected')`, [rc.tenantId, orderId]);
  return rows[0] ?? null;
}
/** Idempotent build key (02-TRD §4): any status, superseded included. */
export async function findSummaryByDeterminismKey(rc: RepoCtx, k: { orderId: string; approvedSetHash: string; libraryVersionId: string }): Promise<Row | null> {
  const { rows } = await rc.tx.query(
    `SELECT * FROM smartreport.summaries WHERE tenant_id = $1 AND order_id = $2 AND approved_set_hash = $3 AND library_version_id = $4`,
    [rc.tenantId, k.orderId, k.approvedSetHash, k.libraryVersionId]);
  return rows[0] ?? null;
}
export async function listSummariesByOrder(rc: RepoCtx, orderId: string): Promise<Row[]> {
  return (await rc.tx.query(`SELECT * FROM smartreport.summaries WHERE tenant_id = $1 AND order_id = $2 ORDER BY built_at DESC`, [rc.tenantId, orderId])).rows;
}
/** Review queue (#27): one status, oldest first, optional centre. */
export async function listReviewQueue(rc: RepoCtx, q: { status: string; centreId?: string | undefined; limit: number }): Promise<Row[]> {
  const limit = clampLimit(q.limit);
  if (q.centreId !== undefined) {
    return (await rc.tx.query(
      `SELECT ${QUEUE_COLUMNS} FROM smartreport.summaries WHERE tenant_id = $1 AND centre_id = $2 AND status = $3 ORDER BY built_at ASC, id ASC LIMIT $4`,
      [rc.tenantId, q.centreId, q.status, limit])).rows;
  }
  return (await rc.tx.query(
    `SELECT ${QUEUE_COLUMNS} FROM smartreport.summaries WHERE tenant_id = $1 AND status = $2 ORDER BY built_at ASC, id ASC LIMIT $3`,
    [rc.tenantId, q.status, limit])).rows;
}
