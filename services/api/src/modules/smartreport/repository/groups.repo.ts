// smartreport.group_settings (class M, draft-only edits by trigger, 05-SCHEMA §2.5).
import { activeOnly, cols, getRow, insertRow, updateRow, without, type ListOpts, type RepoCtx, type Row, type UpdateSpec } from './common.repo.js';

const T = 'smartreport.group_settings';
const INS = cols('id library_version_id group_code display_en display_ne score_weight sort_order is_shown is_active');
const SPEC: UpdateSpec = {
  table: T,
  allow: without(INS, 'id', 'library_version_id', 'group_code'),
  statement: (set, n) => `UPDATE smartreport.group_settings SET ${set}, version = version + 1, updated_at = now(), updated_by = $${n}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
};

export const insertGroupSetting = (rc: RepoCtx, row: Row) => insertRow(rc, T, INS, row, true);
export const getGroupSetting = (rc: RepoCtx, id: string) => getRow(rc, T, id);
export const updateGroupSetting = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SPEC, id, expectedVersion, patch);
export async function listGroupSettings(rc: RepoCtx, libraryVersionId: string, o?: ListOpts): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.group_settings WHERE tenant_id = $1 AND library_version_id = $2${activeOnly(o)} ORDER BY sort_order ASC, id`,
    [rc.tenantId, libraryVersionId])).rows;
}
