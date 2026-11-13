// inventory.consumption_daily / test_counts_daily / instrument_qc_daily (05 §2.25, §2.26, §2.26a; UNIQUE keys NULLS NOT DISTINCT). Explicit tenant filter on every statement.
import { type Row, type RepoCtx, Q, first, getRow, insertRow, query, table, updateRow } from './_base.js';

const CONSUMPTION = table('consumption_daily', 'M', ['business_date', 'store_id', 'item_id', 'movement_kind', 'instrument_id', 'attributed_test_id', 'qty_consumed',
  'value_consumed_paisa', 'movements']);
const TEST_COUNTS = table('test_counts_daily', 'M', ['business_date', 'instrument_id', 'test_id', 'tests_counted', 'verified_result_events', 'rerun_events', 'qc_events']);

export const insertConsumptionDaily = (rc: RepoCtx, row: Row) => insertRow(rc, CONSUMPTION, row);
export const getConsumptionDaily = (rc: RepoCtx, id: string) => getRow(rc, CONSUMPTION, id);
/** from / to = 'YYYY-MM-DD', both inclusive (index consumption_daily__tenant_id_date__idx). */
export function listConsumptionDaily(rc: RepoCtx, f: { from: string; to: string; storeId?: string }): Promise<Row[]> {
  const q = new Q();
  const range = `business_date >= ${q.p(f.from)} AND business_date <= ${q.p(f.to)}`;
  const store = f.storeId !== undefined ? ` AND store_id = ${q.p(f.storeId)}` : '';
  return query(rc, `SELECT * FROM inventory.consumption_daily WHERE tenant_id = $1 AND ${range}${store} ORDER BY business_date, id`, q.vals);
}
export const updateConsumptionDaily = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, CONSUMPTION, id, expectedVersion, patch);

export const insertTestCountsDaily = (rc: RepoCtx, row: Row) => insertRow(rc, TEST_COUNTS, row);
export const getTestCountsDaily = (rc: RepoCtx, id: string) => getRow(rc, TEST_COUNTS, id);
export const listTestCountsByTest = (rc: RepoCtx, f: { testId: string; from: string; to: string }) =>
  query(rc, `SELECT * FROM inventory.test_counts_daily WHERE tenant_id = $1 AND test_id = $2 AND business_date >= $3 AND business_date <= $4 ORDER BY business_date, id`,
    [f.testId, f.from, f.to]);
export const updateTestCountsDaily = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, TEST_COUNTS, id, expectedVersion, patch);

/** instrument_qc_daily has no id/version (counter, D-74): keyed by (tenant, business_date, instrument). */
export const getQcDaily = (rc: RepoCtx, f: { businessDate: string; instrumentId: string }): Promise<Row | null> =>
  first(rc, 'SELECT * FROM inventory.instrument_qc_daily WHERE tenant_id = $1 AND business_date = $2 AND instrument_id = $3', [f.businessDate, f.instrumentId]);
/** UPSERT: creates the day's row lazily at 1, else qc_observations + 1 (one statement, race-safe). */
export async function incrementQcObservations(rc: RepoCtx, f: { businessDate: string; instrumentId: string }): Promise<Row> {
  return (await query(rc, `INSERT INTO inventory.instrument_qc_daily (tenant_id, business_date, instrument_id, qc_observations, created_by, updated_by)
                           VALUES ($1, $2, $3, 1, $4, $4)
                           ON CONFLICT (tenant_id, business_date, instrument_id)
                           DO UPDATE SET qc_observations = inventory.instrument_qc_daily.qc_observations + 1, updated_at = now(), updated_by = $4
                           RETURNING *`, [f.businessDate, f.instrumentId, rc.actorId]))[0]!;
}
