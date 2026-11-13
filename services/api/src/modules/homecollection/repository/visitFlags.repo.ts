// homecollection.visit_flags (05-SCHEMA §4). Update columns = the visit_flags__mutable_columns trigger list. One open flag per (visit, kind, related) -> 23505.
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.visit_flags';
const INSERT_COLS = ['id', 'centre_id', 'visit_id', 'kind', 'status', 'related_id', 'detail_code', 'resolution_code', 'resolution_note', 'resolved_by', 'resolved_at'] as const;
const UPDATE_COLS = ['status', 'resolution_code', 'resolution_note', 'resolved_by', 'resolved_at', 'updated_by'] as const;

export const insertVisitFlag = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row);
export const getVisitFlagById = (tx: Tx, tenantId: string, flagId: string) => getRowById(tx, T, tenantId, flagId);
export const updateVisitFlag = (tx: Tx, tenantId: string, flagId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, [], tenantId, flagId, expectedVersion, patch);

export async function listVisitFlagsByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visit_flags WHERE tenant_id = $1 AND visit_id = $2 ORDER BY created_at, id', [tenantId, visitId]);
  return rows;
}
