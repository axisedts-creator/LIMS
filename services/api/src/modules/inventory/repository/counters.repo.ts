// inventory.number_counters (05 §2.5): gapless-per-commit document numbers. Explicit tenant filter on every statement.
import { LimsError } from '../../../core/errors.js';
import { type RepoCtx, query } from './_base.js';

/**
 * Next number of (series, period_key), first value 1. The row is created lazily (ON CONFLICT DO NOTHING); the UPDATE takes the row lock, so concurrent
 * transactions queue and each gets a distinct value (a rollback leaves a gap, never a duplicate). Bad series / period_key: the DB CHECK refuses (23514).
 */
export async function allocateNumber(rc: RepoCtx, series: string, periodKey: string): Promise<number> {
  if (typeof series !== 'string' || typeof periodKey !== 'string') throw new LimsError('common.internal');
  await query(rc, 'INSERT INTO inventory.number_counters (tenant_id, series, period_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [series, periodKey]);
  const rows = await query(rc, `UPDATE inventory.number_counters SET next_value = next_value + 1, updated_at = now()
                                 WHERE tenant_id = $1 AND series = $2 AND period_key = $3 RETURNING next_value - 1 AS allocated`, [series, periodKey]);
  return Number(rows[0]!['allocated']);
}
