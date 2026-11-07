// billing.cash_sessions.
import type { Tx } from '../../../core/db/tx.js';

export async function getCashSession(tx: Pick<Tx, 'query'>, a: { tenantId: string; sessionId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.cash_sessions WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.sessionId]);
  return rows[0];
}
