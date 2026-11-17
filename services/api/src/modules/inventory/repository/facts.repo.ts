// inventory.consumption_facts (05 §2.24). Explicit tenant filter on every statement; dedupe by (tenant, basis_key).
import { type Row, type RepoCtx, Q, first, getRow, insertRow, limitOf, query, table, updateRow } from './_base.js';

const FACTS = table('consumption_facts', 'C', ['fact_kind', 'basis_key', 'source', 'source_event_id', 'source_event_type', 'instrument_id', 'test_id', 'analyte_id', 'department_id',
  'centre_id', 'processing_branch_id', 'occurred_at', 'business_date', 'multiplier', 'store_id', 'status', 'rules_applied', 'value_paisa_total', 'reason_code', 'note',
  'resolved_at', 'resolved_by']);

export const insertFact = (rc: RepoCtx, row: Row) => insertRow(rc, FACTS, row);
export const getFact = (rc: RepoCtx, id: string) => getRow(rc, FACTS, id);
export const findFactByBasisKey = (rc: RepoCtx, key: string) => first(rc, 'SELECT * FROM inventory.consumption_facts WHERE tenant_id = $1 AND basis_key = $2', [key]);
/** Unresolved queue, oldest first (partial index consumption_facts__tenant_id_status__p_idx). */
export function listUnresolvedFacts(rc: RepoCtx, f: { limit?: number } = {}): Promise<Row[]> {
  const q = new Q();
  return query(rc, `SELECT * FROM inventory.consumption_facts WHERE tenant_id = $1 AND status = 'unresolved' ORDER BY occurred_at, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}
export const updateFact = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, FACTS, id, expectedVersion, patch);
