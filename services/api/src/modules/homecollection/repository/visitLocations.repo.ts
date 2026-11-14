// homecollection.visit_locations (class E: insert, read, and the retention delete — the only DELETE grant, 05-SCHEMA §4.1 (3)). No update.
import { insertRow, type Tx } from './shared.repo.js';

const T = 'homecollection.visit_locations';
const INSERT_COLS = ['id', 'centre_id', 'visit_id', 'mutation_id', 'kind', 'latitude', 'longitude', 'accuracy_m', 'captured_at', 'expires_at'] as const;

export const insertVisitLocation = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row, { actorCols: ['created_by'] });

export async function listLocationsByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visit_locations WHERE tenant_id = $1 AND visit_id = $2 ORDER BY captured_at, id', [tenantId, visitId]);
  return rows;
}

/** Retention purge (system actor): deletes the tenant's expired rows, returns how many. */
export async function deleteExpiredLocations(tx: Tx, tenantId: string): Promise<number> {
  const r = await tx.query('DELETE FROM homecollection.visit_locations WHERE tenant_id = $1 AND expires_at < now()', [tenantId]);
  return r.rowCount ?? 0;
}
