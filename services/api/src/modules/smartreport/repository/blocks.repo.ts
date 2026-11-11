// smartreport.template_blocks (class M, draft-only edits by trigger, 05-SCHEMA §2.2). Removal = is_active = false.
import { activeOnly, cols, getRow, insertRow, updateRow, without, type ListOpts, type RepoCtx, type Row, type UpdateSpec } from './common.repo.js';

const T = 'smartreport.template_blocks';
const INS = cols('id library_version_id block_key kind text_en text_ne note is_active');
const SPEC: UpdateSpec = {
  table: T,
  allow: without(INS, 'id', 'library_version_id'),
  statement: (set, n) => `UPDATE smartreport.template_blocks SET ${set}, version = version + 1, updated_at = now(), updated_by = $${n}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
};

export const insertBlock = (rc: RepoCtx, row: Row) => insertRow(rc, T, INS, row, true);
export const getBlock = (rc: RepoCtx, id: string) => getRow(rc, T, id);
export const updateBlock = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SPEC, id, expectedVersion, patch);
export async function listBlocks(rc: RepoCtx, libraryVersionId: string, o?: ListOpts): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.template_blocks WHERE tenant_id = $1 AND library_version_id = $2${activeOnly(o)} ORDER BY block_key ASC`,
    [rc.tenantId, libraryVersionId])).rows;
}
