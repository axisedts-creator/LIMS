// inventory.consumption_rules (05 §2.23; one current rule per key via UNIQUE ... NULLS NOT DISTINCT). Explicit tenant filter on every statement.
import { type ListOpts, type Row, type RepoCtx, Q, activeOnly, getRow, insertRow, query, table, updateRow } from './_base.js';

const RULES = table('consumption_rules', 'M', ['rule_kind', 'test_id', 'analyte_id', 'instrument_id', 'item_id', 'qty_base', 'entered_qty', 'entered_pack_id', 'effective_from',
  'effective_to', 'supersedes_rule_id', 'notes']);

export const insertRule = (rc: RepoCtx, row: Row) => insertRow(rc, RULES, row);
export const getRule = (rc: RepoCtx, id: string) => getRow(rc, RULES, id);
export const listRulesByItem = (rc: RepoCtx, itemId: string, opts?: ListOpts) =>
  query(rc, `SELECT * FROM inventory.consumption_rules WHERE tenant_id = $1 AND item_id = $2${activeOnly(opts)} ORDER BY id`, [itemId]);

/**
 * Rules effective at `at` for a consumer match: test_id / analyte_id equal (null matches null), instrument_id = given OR rule-for-any-instrument (NULL).
 * `= $n` / `IS NULL` per side (not IS NOT DISTINCT FROM) so consumption_rules__tenant_id_match__idx stays usable. Instrument-specific first, then id.
 */
export function listRulesForMatch(rc: RepoCtx, f: { ruleKind: string; testId: string | null; analyteId: string | null; instrumentId: string | null; at: string }): Promise<Row[]> {
  const q = new Q();
  let w = ` AND rule_kind = ${q.p(f.ruleKind)}`;
  w += f.testId == null ? ' AND test_id IS NULL' : ` AND test_id = ${q.p(f.testId)}`;
  w += f.analyteId == null ? ' AND analyte_id IS NULL' : ` AND analyte_id = ${q.p(f.analyteId)}`;
  w += f.instrumentId == null ? ' AND instrument_id IS NULL' : ` AND (instrument_id = ${q.p(f.instrumentId)} OR instrument_id IS NULL)`;
  const at = q.p(f.at);
  w += ` AND is_active AND effective_from <= ${at} AND (effective_to IS NULL OR effective_to > ${at})`;
  return query(rc, `SELECT * FROM inventory.consumption_rules WHERE tenant_id = $1${w} ORDER BY (instrument_id IS NULL), id`, q.vals);
}
export const updateRule = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, RULES, id, expectedVersion, patch);
