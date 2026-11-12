// homecollection.visit_assignments (class A, append-only: insert + read only).
import { insertRow, type Tx } from './shared.repo.js';

const T = 'homecollection.visit_assignments';
const INSERT_COLS = ['id', 'centre_id', 'visit_id', 'route_id', 'membership_id', 'route_date', 'action', 'reason_code'] as const;

export const insertVisitAssignment = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row, { actorCols: ['created_by'] });

export async function listAssignmentsByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visit_assignments WHERE tenant_id = $1 AND visit_id = $2 ORDER BY created_at, id', [tenantId, visitId]);
  return rows;
}
