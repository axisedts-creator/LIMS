// billing.credit_accounts, keyed (tenant_id, credit_party_id).
import type { Tx } from '../../../core/db/tx.js';

export async function getCreditAccount(tx: Pick<Tx, 'query'>, a: { tenantId: string; creditPartyId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = $2', [a.tenantId, a.creditPartyId]);
  return rows[0];
}
