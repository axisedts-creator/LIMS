// billing.release_overrides is append-only. Read here.
import type { Tx } from '../../../core/db/tx.js';

export async function getReleaseOverride(tx: Pick<Tx, 'query'>, a: { tenantId: string; overrideId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.release_overrides WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.overrideId]);
  return rows[0];
}
