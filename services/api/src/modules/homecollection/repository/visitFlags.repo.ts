// homecollection.visit_flags (05-SCHEMA §4). Update columns = the visit_flags__mutable_columns trigger list. One open flag per (visit, kind, related) -> 23505.
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.visit_flags';
const INSERT_COLS = ['id', 'centre_id', 'visit_id', 'kind', 'status', 'related_id', 'detail_code', 'resolution_code', 'resolution_note', 'resolved_by', 'resolved_at'] as const;
const UPDATE_COLS = ['status', 'resolution_code', 'resolution_note', 'resolved_by', 'resolved_at', 'updated_by'] as const;

export const insertVisitFlag = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row);
export const getVisitFlagById = (tx: Tx, tenantId: string, flagId: string) => getRowById(tx, T, tenantId, flagId);
export const updateVisitFlag = (tx: Tx, tenantId: string, flagId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, [], tenantId, flagId, expectedVersion, patch);

/**
 * HC-T14 worker task: open flag for (visit, kind, related) unless one is already open (the partial unique index visit_flags__tenant_id_open__p_uq). Null when it already existed.
 * created_by / updated_by = the given actor (the module's system actor in the task).
 */
export async function insertOpenVisitFlagIfAbsent(tx: Tx, tenantId: string, actorId: string,
  row: { id: string; centre_id: string; visit_id: string; kind: string; related_id: string | null }): Promise<any | null> {
  const { rows } = await tx.query(
    `INSERT INTO homecollection.visit_flags (id, tenant_id, centre_id, visit_id, kind, status, related_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $7)
     ON CONFLICT (tenant_id, visit_id, kind, (coalesce(related_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE status = 'open' DO NOTHING RETURNING *`,
    [row.id, tenantId, row.centre_id, row.visit_id, row.kind, row.related_id, actorId]);
  return rows[0] ?? null;
}

export async function listVisitFlagsByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visit_flags WHERE tenant_id = $1 AND visit_id = $2 ORDER BY created_at, id', [tenantId, visitId]);
  return rows;
}
