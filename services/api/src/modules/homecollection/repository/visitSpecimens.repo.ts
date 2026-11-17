// homecollection.visit_specimens (read model of lab.specimens per visit). Unique (tenant_id, visit_id, specimen_id).
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.visit_specimens';
const INSERT_COLS = ['id', 'centre_id', 'visit_id', 'specimen_id', 'order_id', 'specimen_type_code', 'container_code', 'status', 'is_active', 'replaces_specimen_id',
  'last_seq', 'refreshed_at'] as const;
const UPDATE_COLS = ['specimen_type_code', 'container_code', 'status', 'is_active', 'replaces_specimen_id', 'last_seq', 'refreshed_at', 'updated_by'] as const;

export const insertVisitSpecimen = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row);
export const getVisitSpecimenById = (tx: Tx, tenantId: string, visitSpecimenId: string) => getRowById(tx, T, tenantId, visitSpecimenId);
export const updateVisitSpecimen = (tx: Tx, tenantId: string, visitSpecimenId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, [], tenantId, visitSpecimenId, expectedVersion, patch);

export async function listVisitSpecimensByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visit_specimens WHERE tenant_id = $1 AND visit_id = $2 ORDER BY created_at, id', [tenantId, visitId]);
  return rows;
}

/** 02-TRD §8/§9: queue homecollection.refresh_visit_specimens in the caller's tx (job_key refresh:<visit_id>, one pending job per visit). */
export async function enqueueRefreshVisitSpecimens(tx: Tx, tenantId: string, visitId: string): Promise<void> {
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['homecollection.refresh_visit_specimens', JSON.stringify({ tenant_id: tenantId, visit_id: visitId }), `refresh:${visitId}`]);
}

export async function listVisitSpecimensByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visit_specimens WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id', [tenantId, orderId]);
  return rows;
}
