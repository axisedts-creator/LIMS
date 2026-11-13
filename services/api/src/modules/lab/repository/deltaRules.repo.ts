// lab.delta_check_rules: versioned rows, one active rule per analyte (05-SCHEMA §1; delta_check_rules__tenant_id_analyte__p_uq).
import { first, getRow, insertRow, isUuid, query, table, updateRow, type RepoCtx, type Row } from './base.repo.js';

export const DELTA_CHECK_RULES = table('lab.delta_check_rules', 'id', ['id', 'tenant_id', 'rule_id', 'rule_version', 'analyte_id', 'unit_code', 'window_seconds',
  'abs_threshold', 'pct_threshold', 'effective_from', 'effective_to', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  { frozen: ['rule_id', 'rule_version', 'analyte_id'] });

export const insertDeltaRule = (rc: RepoCtx, row: Row) => insertRow(rc, DELTA_CHECK_RULES, row);
export const getDeltaRule = (rc: RepoCtx, id: string) => getRow(rc, DELTA_CHECK_RULES, id);
export const updateDeltaRule = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, DELTA_CHECK_RULES, id, expectedVersion, patch);

/** T-29 (AC-12.4): the active version IN FORCE at `at` — effective_from inclusive, effective_to exclusive (a superseded version ends where the next begins). */
export const getEffectiveDeltaRuleRow = async (rc: RepoCtx, analyteId: string, at: Date) =>
  (isUuid(analyteId)
    ? first(rc, `SELECT * FROM lab.delta_check_rules WHERE tenant_id = $1 AND analyte_id = $2 AND is_active AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)
                  ORDER BY effective_from DESC LIMIT 1`, [analyteId, at])
    : null);

/** T-29 #49: every version row of the tenant (history included), optional analyte / is_active filters; contract maxItems 200. */
export const listDeltaRules = (rc: RepoCtx, f: { analyteId?: string; isActive?: boolean } = {}) => {
  const vals: unknown[] = [];
  const where = ['tenant_id = $1'];
  if (f.analyteId !== undefined) { vals.push(f.analyteId); where.push(`analyte_id = $${vals.length + 1}`); }
  if (f.isActive !== undefined) { vals.push(f.isActive); where.push(`is_active = $${vals.length + 1}`); }
  return query(rc, `SELECT * FROM lab.delta_check_rules WHERE ${where.join(' AND ')} ORDER BY analyte_id, rule_version LIMIT 200`, vals);
};

/** The analyte's active rule (predicate = the partial unique index's). */
export const getActiveDeltaRule = async (rc: RepoCtx, analyteId: string) =>
  (isUuid(analyteId) ? first(rc, 'SELECT * FROM lab.delta_check_rules WHERE tenant_id = $1 AND analyte_id = $2 AND effective_to IS NULL AND is_active', [analyteId]) : null);
