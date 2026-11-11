// lab.barcode_counters: per-tenant sequence (02-TRD §6.1). Row lock on UPDATE serialises concurrent allocations; no gaps except rolled-back txs.
import { query, type RepoCtx } from './base.repo.js';

/** Next value of the tenant's counter (bigint arrives as a string). First use creates the row at 0. */
export async function allocateBarcodeSeq(rc: RepoCtx): Promise<string> {
  await query(rc, `INSERT INTO lab.barcode_counters (tenant_id, last_value, created_by, updated_by) VALUES ($1, 0, $2, $2)
                   ON CONFLICT (tenant_id) DO NOTHING`, [rc.actorId]);
  const rows = await query(rc, `UPDATE lab.barcode_counters SET last_value = last_value + 1, updated_at = now(), updated_by = $2
                                WHERE tenant_id = $1 RETURNING last_value`, [rc.actorId]);
  return String(rows[0]!['last_value']);
}
