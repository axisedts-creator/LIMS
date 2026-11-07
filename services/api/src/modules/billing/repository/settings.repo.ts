// billing.settings, one row per tenant (lazy defaults are created by settings.service, BL-T05).
import type { Tx } from '../../../core/db/tx.js';

export async function getBillingSettings(tx: Pick<Tx, 'query'>, a: { tenantId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.settings WHERE tenant_id = $1', [a.tenantId]);
  return rows[0];
}
