// smartreport.library_versions (class M, 05-SCHEMA §2.1). Open = draft|in_review, approved = the one active version (partial unique indexes, §5).
import { clampLimit, cols, getRow, insertRow, updateRow, without, type RepoCtx, type Row, type UpdateSpec } from './common.repo.js';

const T = 'smartreport.library_versions';
// Lifecycle columns are update-only: a new version is always draft (03-APP-FLOW §1.1); approval goes through review.
const LIFECYCLE = cols(`status submitted_at submitted_by_membership_id approved_at approved_by_membership_id approval_note returned_at
  returned_by_membership_id return_comment retired_at`);
const INS = cols(`id version_no language formula_version score_enabled credit_in_range_bp credit_borderline_bp credit_out_of_range_bp credit_critical_bp
  min_groups_scored band_good_min band_fair_min critical_forces_needs_attention borderline_fraction_bp min_mapped_results trend_enabled trend_max_points
  trend_lookback_days trend_stable_bp trends_max advice_max_blocks followup_max source_version_id change_summary content_sha256 is_active`);
const SPEC: UpdateSpec = {
  table: T,
  allow: without([...INS, ...LIFECYCLE], 'id', 'version_no', 'source_version_id'),
  statement: (set, n) => `UPDATE smartreport.library_versions SET ${set}, version = version + 1, updated_at = now(), updated_by = $${n}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
};

export const insertLibraryVersion = (rc: RepoCtx, row: Row) => insertRow(rc, T, INS, row, true);
export const getLibraryVersion = (rc: RepoCtx, id: string) => getRow(rc, T, id);
export const updateLibraryVersion = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SPEC, id, expectedVersion, patch);

export async function getOpenLibraryVersion(rc: RepoCtx): Promise<Row | null> {
  const { rows } = await rc.tx.query(`SELECT * FROM smartreport.library_versions WHERE tenant_id = $1 AND status IN ('draft', 'in_review')`, [rc.tenantId]);
  return rows[0] ?? null;
}
export async function getApprovedLibraryVersion(rc: RepoCtx): Promise<Row | null> {
  const { rows } = await rc.tx.query(`SELECT * FROM smartreport.library_versions WHERE tenant_id = $1 AND status = 'approved'`, [rc.tenantId]);
  return rows[0] ?? null;
}
export async function listLibraryVersions(rc: RepoCtx, o: { limit: number }): Promise<Row[]> {
  return (await rc.tx.query(`SELECT * FROM smartreport.library_versions WHERE tenant_id = $1 ORDER BY version_no DESC LIMIT $2`, [rc.tenantId, clampLimit(o.limit)])).rows;
}
