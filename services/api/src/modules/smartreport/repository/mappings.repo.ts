// smartreport.analyte_groups (class M, draft-only edits by trigger, 05-SCHEMA §2.4): analyte -> organ group mapping.
import { activeOnly, cols, getRow, insertRow, updateRow, without, type ListOpts, type RepoCtx, type Row, type UpdateSpec } from './common.repo.js';

const T = 'smartreport.analyte_groups';
const INS = cols('id library_version_id analyte_id group_code include_in_score trend_enabled borderline_fraction_bp trend_stable_bp sort_order is_active');
const SPEC: UpdateSpec = {
  table: T,
  allow: without(INS, 'id', 'library_version_id', 'analyte_id'),
  statement: (set, n) => `UPDATE smartreport.analyte_groups SET ${set}, version = version + 1, updated_at = now(), updated_by = $${n}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
};

export const insertMapping = (rc: RepoCtx, row: Row) => insertRow(rc, T, INS, row, true);
export const getMapping = (rc: RepoCtx, id: string) => getRow(rc, T, id);
export const updateMapping = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SPEC, id, expectedVersion, patch);
export async function listMappings(rc: RepoCtx, libraryVersionId: string, o?: ListOpts): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.analyte_groups WHERE tenant_id = $1 AND library_version_id = $2${activeOnly(o)} ORDER BY sort_order ASC, id`,
    [rc.tenantId, libraryVersionId])).rows;
}
