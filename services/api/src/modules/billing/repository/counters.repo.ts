// billing.fiscal_counters. Gapless numbering (05-SCHEMA §3): the DB guard only accepts last_no = old or old + 1, so this is the only write.
// Allocation policy (lock_timeout, fiscal-year rollover) belongs to BL-T04 counter.service; a refused guard propagates raw.
import type { Tx } from '../../../core/db/tx.js';

export interface CounterKey { readonly tenantId: string; readonly series: string; readonly fiscalYearBs: string }

const BUMP = `UPDATE billing.fiscal_counters SET last_no = last_no + 1, updated_at = now()
  WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3 AND closed_at IS NULL AND is_active
  RETURNING last_no`;

/** Returns the new last_no, or undefined when no open counter row matches. */
export async function bumpCounter(tx: Pick<Tx, 'query'>, k: CounterKey): Promise<number | undefined> {
  const { rows } = await tx.query(BUMP, [k.tenantId, k.series, k.fiscalYearBs]);
  return rows[0]?.last_no;
}
