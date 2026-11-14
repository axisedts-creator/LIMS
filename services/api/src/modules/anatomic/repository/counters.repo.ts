// anatomic.accession_counters (class E counter, 05-SCHEMA §1/§6). Allocation exactly as 02-TRD §4.2: lazy row create, then ONE atomic UPDATE;
// the row lock serialises concurrent accessions (AC-02.2). Rolling the caller's transaction back gives the number back (gaps are allowed, not fiscal).
// Pattern overflow (last_value >= 10^N -> anatomic.accession_pattern_invalid) is the service's call, not the repository's.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export interface CounterKey { readonly tenantId: string; readonly seriesKey: string; readonly yearAd: number; readonly actorId: string }

/** Returns the newly allocated number (1 for the first allocation of a (series, year)). */
export async function bumpAccessionCounter(tx: Q, k: CounterKey): Promise<number> {
  await tx.query(
    `INSERT INTO anatomic.accession_counters (tenant_id, series_key, year_ad, last_value, created_by, updated_by)
     VALUES ($1, $2, $3, 0, $4, $4) ON CONFLICT (tenant_id, series_key, year_ad) DO NOTHING`,
    [k.tenantId, k.seriesKey, k.yearAd, k.actorId]);
  const { rows } = await tx.query(
    `UPDATE anatomic.accession_counters SET last_value = last_value + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND series_key = $2 AND year_ad = $3 RETURNING last_value`,
    [k.tenantId, k.seriesKey, k.yearAd, k.actorId]);
  if (!rows[0]) throw new Error('anatomic.accession_counters: counter row not visible after create');
  return Number(rows[0].last_value);
}

/** Current value without allocating (settings screens, diagnostics); undefined when the series was never used. */
export async function getAccessionCounter(tx: Q, k: Omit<CounterKey, 'actorId'>): Promise<number | undefined> {
  const { rows } = await tx.query(
    `SELECT last_value FROM anatomic.accession_counters WHERE tenant_id = $1 AND series_key = $2 AND year_ad = $3`,
    [k.tenantId, k.seriesKey, k.yearAd]);
  return rows[0] ? Number(rows[0].last_value) : undefined;
}
