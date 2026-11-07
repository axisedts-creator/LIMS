// billing.credit_charges.
import type { Tx } from '../../../core/db/tx.js';

export async function getCreditCharge(tx: Pick<Tx, 'query'>, a: { tenantId: string; chargeId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_charges WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.chargeId]);
  return rows[0];
}
