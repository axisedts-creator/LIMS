// lab.delta_check_rules: versioned rows, one active rule per analyte (05-SCHEMA §1; delta_check_rules__tenant_id_analyte__p_uq).
import { first, getRow, insertRow, isUuid, table, updateRow, type RepoCtx, type Row } from './base.repo.js';

export const DELTA_CHECK_RULES = table('lab.delta_check_rules', 'id', ['id', 'tenant_id', 'rule_id', 'rule_version', 'analyte_id', 'unit_code', 'window_seconds',
  'abs_threshold', 'pct_threshold', 'effective_from', 'effective_to', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  { frozen: ['rule_id', 'rule_version', 'analyte_id'] });

export const insertDeltaRule = (rc: RepoCtx, row: Row) => insertRow(rc, DELTA_CHECK_RULES, row);
export const getDeltaRule = (rc: RepoCtx, id: string) => getRow(rc, DELTA_CHECK_RULES, id);
export const updateDeltaRule = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, DELTA_CHECK_RULES, id, expectedVersion, patch);

/** The analyte's active rule (predicate = the partial unique index's). */
export const getActiveDeltaRule = async (rc: RepoCtx, analyteId: string) =>
  (isUuid(analyteId) ? first(rc, 'SELECT * FROM lab.delta_check_rules WHERE tenant_id = $1 AND analyte_id = $2 AND effective_to IS NULL AND is_active', [analyteId]) : null);
