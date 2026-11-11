// smartreport.rules (class M, draft-only edits by trigger, 05-SCHEMA §2.3). Rules by kind use rules__tenant_id_library_version_id_rule_kind__idx.
import { activeOnly, cols, getRow, insertRow, updateRow, without, type ListOpts, type RepoCtx, type Row, type UpdateSpec } from './common.repo.js';

const T = 'smartreport.rules';
const INS = cols(`id library_version_id rule_kind trigger_kind analyte_id group_code direction min_severity priority block_id block_kind
  suggested_test_id interval_days is_active`);
const SPEC: UpdateSpec = {
  table: T,
  allow: without(INS, 'id', 'library_version_id'),
  statement: (set, n) => `UPDATE smartreport.rules SET ${set}, version = version + 1, updated_at = now(), updated_by = $${n}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
};

export const insertRule = (rc: RepoCtx, row: Row) => insertRow(rc, T, INS, row, true);
export const getRule = (rc: RepoCtx, id: string) => getRow(rc, T, id);
export const updateRule = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SPEC, id, expectedVersion, patch);
export async function listRules(rc: RepoCtx, libraryVersionId: string, o?: ListOpts): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.rules WHERE tenant_id = $1 AND library_version_id = $2${activeOnly(o)} ORDER BY priority ASC, id`,
    [rc.tenantId, libraryVersionId])).rows;
}
export async function listRulesByKind(rc: RepoCtx, libraryVersionId: string, ruleKind: string, o?: ListOpts): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.rules WHERE tenant_id = $1 AND library_version_id = $2 AND rule_kind = $3${activeOnly(o)} ORDER BY priority ASC, id`,
    [rc.tenantId, libraryVersionId, ruleKind])).rows;
}
