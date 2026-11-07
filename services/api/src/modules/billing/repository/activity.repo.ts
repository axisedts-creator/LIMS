// billing.activity_log is append-only. Read here.
import type { Tx } from '../../../core/db/tx.js';

export async function getActivity(tx: Pick<Tx, 'query'>, a: { tenantId: string; activityId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.activity_log WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.activityId]);
  return rows[0];
}
