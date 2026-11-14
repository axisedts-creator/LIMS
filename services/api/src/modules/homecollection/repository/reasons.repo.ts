// homecollection.g_cs_reasons — GLOBAL seed table (08 A19 D-130): no tenant_id, read-only from the app. Values are bound parameters.
import type { Tx } from './shared.repo.js';

export async function listReasonsBySet(tx: Tx, setCode: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.g_cs_reasons WHERE set_code = $1 AND is_active ORDER BY sort_order, code', [setCode]);
  return rows;
}

export async function getReason(tx: Tx, setCode: string, code: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.g_cs_reasons WHERE set_code = $1 AND code = $2 AND is_active', [setCode, code]);
  return rows[0] ?? null;
}
