// frontdesk.settings (05-SCHEMA §3), one row per tenant (PK tenant_id).
import type { Tx } from './shared.repo.js';

export async function getSettings(tx: Tx, tenantId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.settings WHERE tenant_id = $1', [tenantId]);
  return rows[0] ?? null;
}
