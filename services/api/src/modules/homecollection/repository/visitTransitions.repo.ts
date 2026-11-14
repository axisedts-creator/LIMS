// homecollection.visit_transitions (class A, append-only: insert + read only).
import { insertRow, type Tx } from './shared.repo.js';

const T = 'homecollection.visit_transitions';
const INSERT_COLS = ['id', 'centre_id', 'visit_id', 'from_status', 'to_status', 'cause', 'reason_code', 'reason_text', 'mutation_id', 'at'] as const;

export const insertVisitTransition = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row, { actorCols: ['created_by'] });

export async function listTransitionsByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.visit_transitions WHERE tenant_id = $1 AND visit_id = $2 ORDER BY at, id', [tenantId, visitId]);
  return rows;
}
