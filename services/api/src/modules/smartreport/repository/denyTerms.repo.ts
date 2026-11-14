// smartreport.wording_deny_terms (class M tenant terms, 05-SCHEMA §2.6) and the global seed smartreport.g_cs_wording_deny_terms (§3.3, read-only).
import { activeOnly, cols, getRow, insertRow, updateRow, without, type ListOpts, type RepoCtx, type Row, type UpdateSpec } from './common.repo.js';

const T = 'smartreport.wording_deny_terms';
const INS = cols('id term term_folded language reason is_active');
const SPEC: UpdateSpec = {
  table: T,
  allow: without(INS, 'id'),
  statement: (set, n) => `UPDATE smartreport.wording_deny_terms SET ${set}, version = version + 1, updated_at = now(), updated_by = $${n}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
};

export const insertDenyTerm = (rc: RepoCtx, row: Row) => insertRow(rc, T, INS, row, true);
export const getDenyTerm = (rc: RepoCtx, id: string) => getRow(rc, T, id);
export const updateDenyTerm = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SPEC, id, expectedVersion, patch);
export async function listDenyTerms(rc: RepoCtx, o?: ListOpts): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.wording_deny_terms WHERE tenant_id = $1${activeOnly(o)} ORDER BY term_folded ASC, language`, [rc.tenantId])).rows;
}
/** Global terms: no tenant column (class G); tenants cannot remove them. */
export async function listGlobalDenyTerms(rc: RepoCtx): Promise<Row[]> {
  return (await rc.tx.query('SELECT * FROM smartreport.g_cs_wording_deny_terms WHERE is_active ORDER BY term_folded ASC, language')).rows;
}
