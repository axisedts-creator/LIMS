// billing.cs_payment_methods (tenant) over billing.g_cs_payment_methods (global): the tenant row wins, else the global one.
import type { Tx } from '../../../core/db/tx.js';

export interface PaymentMethod { readonly code: string; readonly is_cash: boolean; readonly requires_reference: boolean; readonly is_active: boolean }

export async function getPaymentMethod(tx: Pick<Tx, 'query'>, a: { tenantId: string; code: string }): Promise<PaymentMethod | undefined> {
  const { rows } = await tx.query(
    `SELECT code, is_cash, requires_reference, is_active FROM billing.cs_payment_methods WHERE tenant_id = $1 AND code = $2
     UNION ALL
     SELECT g.code, g.is_cash, g.requires_reference, g.is_active FROM billing.g_cs_payment_methods g
      WHERE g.code = $2 AND NOT EXISTS (SELECT 1 FROM billing.cs_payment_methods t WHERE t.tenant_id = $1 AND t.code = $2)
     LIMIT 1`, [a.tenantId, a.code]);
  return rows[0] as PaymentMethod | undefined;
}
