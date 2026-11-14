// C12.T-19 report queries (02-TRD §5.11 report rows, §8.6 CPT; PRD §8.3, AC-21.1-21.7). Read-only: no statement here writes. $1 = ctx tenant on every statement (REQ-SEC-024) plus RLS;
// every other value is a bound parameter, every SQL fragment below is a constant. Counts / money / quantities leave as text (pg bigint / numeric) and are shaped by service/reports.service.ts.
// Totals and the row count come from window functions over the full result, so a LIMIT (screen / export cap + 1) never changes them (one statement per report block).
import { type RepoCtx, type Row, Q, query } from './_base.js';

/** Which stores a report may see: one store, one branch, and/or the caller's visible branches (P-B1, P-B6). */
export interface Scope { storeId?: string; branchId?: string; visible?: readonly string[] }
export interface Flt extends Scope { from: string; to: string; instrumentId?: string; testId?: string; itemId?: string }
export interface Page { rows: Row[]; count: number; totals: Record<string, string> }

const CONSUME = "('issue','return_to_store','consume_test','consume_analyte','consume_rerun','consume_qc','consume_calibration','consume_fixed')";
const CPT_KINDS = "('consume_test','consume_analyte','consume_rerun','consume_qc','consume_calibration')";

/** Store join conditions (alias `s`): the visibility rules. */
function storeOn(q: Q, s: Scope): string {
  let w = '';
  if (s.storeId !== undefined) w += ` AND s.id = ${q.p(s.storeId)}`;
  if (s.branchId !== undefined) w += ` AND s.branch_id = ${q.p(s.branchId)}`;
  if (s.visible !== undefined) w += ` AND s.branch_id = ANY(${q.p([...s.visible])}::uuid[])`;
  return w;
}

/** Wrap one report block: rows + total row count + column sums over the whole block, cut to `limit`. `order` is a constant. */
async function paged(rc: RepoCtx, q: Q, base: string, order: string, sums: readonly string[], limit: number): Promise<Page> {
  const t = sums.map((c) => `, sum(b.${c}) OVER ()::text AS _t_${c}`).join('');
  const rows = await query(rc, `SELECT b.*, count(*) OVER ()::int AS _n${t} FROM (${base}) b ORDER BY ${order} LIMIT ${q.p(limit)}`, q.vals);
  const totals: Record<string, string> = {};
  for (const c of sums) totals[c] = String(rows[0]?.[`_t_${c}`] ?? '0');
  const count = Number(rows[0]?._n ?? 0);
  // `_sort_*` = sort keys that are not report columns (TRD §5.11: the columns are fixed).
  return { rows: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== '_n' && !k.startsWith('_t_') && !k.startsWith('_sort_')))), count, totals };
}

/** consumption_daily filters shared by the consumption reports (alias `cd`, store alias `s`). */
function cdWhere(q: Q, f: Flt, instrumentRequired = false): string {
  let w = ` AND cd.business_date >= ${q.p(f.from)}::date AND cd.business_date < ${q.p(f.to)}::date`;
  if (f.itemId !== undefined) w += ` AND cd.item_id = ${q.p(f.itemId)}`;
  if (f.instrumentId !== undefined) w += ` AND cd.instrument_id = ${q.p(f.instrumentId)}`;
  if (f.testId !== undefined) w += ` AND cd.attributed_test_id = ${q.p(f.testId)}`;
  if (instrumentRequired) w += ' AND cd.instrument_id IS NOT NULL';
  return w;
}

// ---------------------------------------------------------------- daily_consumption (AC-21.1)
export function dailyConsumption(rc: RepoCtx, f: Flt, limit: number): Promise<Page> {
  const q = new Q();
  const on = storeOn(q, f);
  const w = cdWhere(q, f);
  const base = `SELECT to_char(cd.business_date, 'YYYY-MM-DD') AS business_date, cd.store_id, s.store_code, cd.item_id, i.item_code, i.name AS item_name, i.base_uom_code, cd.movement_kind,
        sum(cd.qty_consumed)::text AS qty_consumed, sum(cd.value_consumed_paisa)::bigint AS value_consumed_paisa, sum(cd.movements)::bigint AS movements
      FROM inventory.consumption_daily cd
      JOIN inventory.stores s ON s.tenant_id = cd.tenant_id AND s.id = cd.store_id${on}
      JOIN inventory.items i ON i.tenant_id = cd.tenant_id AND i.id = cd.item_id
     WHERE cd.tenant_id = $1 AND cd.movement_kind IN ${CONSUME}${w}
     GROUP BY cd.business_date, cd.store_id, s.store_code, cd.item_id, i.item_code, i.name, i.base_uom_code, cd.movement_kind`;
  return paged(rc, q, base, 'business_date, store_code, item_code, movement_kind', ['value_consumed_paisa', 'movements'], limit);
}

// ---------------------------------------------------------------- analyser_consumption (AC-21.2)
export function analyserConsumption(rc: RepoCtx, f: Flt, limit: number): Promise<Page> {
  const q = new Q();
  const on = storeOn(q, f);
  const w = cdWhere(q, f, true);
  const base = `SELECT cd.instrument_id, coalesce(d.display_name, cd.instrument_id::text) AS instrument_label, cd.item_id, i.item_code, cd.movement_kind,
        sum(cd.qty_consumed)::text AS qty_consumed, sum(cd.value_consumed_paisa)::bigint AS value_consumed_paisa, sum(cd.movements)::bigint AS movements
      FROM inventory.consumption_daily cd
      JOIN inventory.stores s ON s.tenant_id = cd.tenant_id AND s.id = cd.store_id${on}
      JOIN inventory.items i ON i.tenant_id = cd.tenant_id AND i.id = cd.item_id
      LEFT JOIN instruments.v_pub_instrument_directory d ON d.tenant_id = cd.tenant_id AND d.instrument_id = cd.instrument_id
     WHERE cd.tenant_id = $1 AND cd.movement_kind IN ${CONSUME}${w}
     GROUP BY cd.instrument_id, d.display_name, cd.item_id, i.item_code, cd.movement_kind`;
  return paged(rc, q, base, 'instrument_label, instrument_id, item_code, movement_kind', ['value_consumed_paisa', 'movements'], limit);
}

/** The per-test count block of the given instruments over the window (not store-scoped: test_counts_daily has no store). */
export function analyserTests(rc: RepoCtx, instrumentIds: readonly string[], f: { from: string; to: string; testId?: string }): Promise<Row[]> {
  const q = new Q();
  const w = ` AND t.business_date >= ${q.p(f.from)}::date AND t.business_date < ${q.p(f.to)}::date AND t.instrument_id = ANY(${q.p([...instrumentIds])}::uuid[])` + (f.testId === undefined ? '' : ` AND t.test_id = ${q.p(f.testId)}`);
  return query(rc, `SELECT t.instrument_id, t.test_id, d.code AS test_code, sum(t.tests_counted)::bigint AS tests_counted, sum(t.rerun_events)::bigint AS rerun_events, sum(t.qc_events)::bigint AS qc_events
      FROM inventory.test_counts_daily t LEFT JOIN catalog.v_pub_test_directory d ON d.tenant_id = t.tenant_id AND d.test_id = t.test_id
     WHERE t.tenant_id = $1${w} GROUP BY t.instrument_id, t.test_id, d.code ORDER BY d.code, t.test_id`, q.vals);
}

// ---------------------------------------------------------------- cost_per_test (AC-21.3; TRD §8.6, PRD §8.3): one statement, CTEs
// round_half_up = floor(x + 0.5) on exact numeric (all operands are non-negative in practice; a net-negative D rounds toward +infinity, which is half-up too).
export function costPerTest(rc: RepoCtx, f: Flt, limit: number): Promise<Page> {
  const q = new Q();
  const from = q.p(f.from), to = q.p(f.to);
  const on = storeOn(q, f);
  const item = f.itemId === undefined ? '' : ` AND cd.item_id = ${q.p(f.itemId)}`;
  const flt = (f.testId === undefined ? '' : ` AND k.test_id = ${q.p(f.testId)}`) + (f.instrumentId === undefined ? '' : ` AND k.instrument_id = ${q.p(f.instrumentId)}`);
  const kind = (k: string) => `coalesce(sum(v) FILTER (WHERE movement_kind = '${k}'), 0)::bigint AS ${k}`;
  const base = `WITH nn AS (SELECT instrument_id, test_id, sum(tests_counted)::bigint AS cnt FROM inventory.test_counts_daily
                            WHERE tenant_id = $1 AND business_date >= ${from}::date AND business_date < ${to}::date GROUP BY instrument_id, test_id),
      nt AS (SELECT instrument_id, sum(cnt) AS ntot FROM nn GROUP BY instrument_id),
      cd AS (SELECT cd.instrument_id, cd.attributed_test_id AS test_id, cd.movement_kind, cd.value_consumed_paisa AS v FROM inventory.consumption_daily cd
               JOIN inventory.stores s ON s.tenant_id = cd.tenant_id AND s.id = cd.store_id${on}
              WHERE cd.tenant_id = $1 AND cd.business_date >= ${from}::date AND cd.business_date < ${to}::date${item}),
      d AS (SELECT instrument_id, test_id, sum(v)::bigint AS d, ${kind('consume_test')}, ${kind('consume_analyte')}, ${kind('consume_rerun')}, ${kind('consume_qc')}, ${kind('consume_calibration')}
              FROM cd WHERE test_id IS NOT NULL AND movement_kind IN ${CPT_KINDS} GROUP BY instrument_id, test_id),
      f AS (SELECT instrument_id, sum(v)::bigint AS f FROM cd WHERE movement_kind = 'consume_fixed' AND instrument_id IS NOT NULL GROUP BY instrument_id),
      k AS (SELECT instrument_id, test_id FROM nn UNION SELECT instrument_id, test_id FROM d),
      r AS (SELECT k.test_id, k.instrument_id, coalesce(nn.cnt, 0) AS cnt, coalesce(d.d, 0) AS d, coalesce(f.f, 0) AS f, coalesce(nt.ntot, 0) AS ntot,
                   coalesce(d.consume_test, 0) AS b_test, coalesce(d.consume_analyte, 0) AS b_analyte, coalesce(d.consume_rerun, 0) AS b_rerun, coalesce(d.consume_qc, 0) AS b_qc, coalesce(d.consume_calibration, 0) AS b_cal
              FROM k LEFT JOIN nn ON nn.test_id = k.test_id AND nn.instrument_id IS NOT DISTINCT FROM k.instrument_id
                     LEFT JOIN d ON d.test_id = k.test_id AND d.instrument_id IS NOT DISTINCT FROM k.instrument_id
                     LEFT JOIN f ON f.instrument_id = k.instrument_id LEFT JOIN nt ON nt.instrument_id IS NOT DISTINCT FROM k.instrument_id
             WHERE true${flt})
      SELECT r.test_id, td.code AS test_code, td.name AS test_name, r.instrument_id, r.cnt::bigint AS tests_counted, r.d::bigint AS direct_value_paisa, r.f::bigint AS fixed_value_on_instrument_paisa,
             (CASE WHEN r.ntot = 0 THEN 0 ELSE floor(r.f::numeric * r.cnt / r.ntot + 0.5) END)::bigint AS fixed_share_paisa,
             (CASE WHEN r.cnt = 0 THEN NULL ELSE floor(r.d::numeric / r.cnt + 0.5) END)::bigint AS cpt_direct_paisa,
             (CASE WHEN r.cnt = 0 THEN NULL WHEN r.ntot = 0 THEN floor(r.d::numeric / r.cnt + 0.5)
                   ELSE floor((r.d::numeric * r.ntot + r.f::numeric * r.cnt) / (r.ntot::numeric * r.cnt) + 0.5) END)::bigint AS cpt_loaded_paisa,
             r.b_test::bigint AS consume_test, r.b_analyte::bigint AS consume_analyte, r.b_rerun::bigint AS consume_rerun, r.b_qc::bigint AS consume_qc, r.b_cal::bigint AS consume_calibration
        FROM r LEFT JOIN catalog.v_pub_test_directory td ON td.tenant_id = $1 AND td.test_id = r.test_id`;
  return paged(rc, q, base, 'test_code, instrument_id NULLS LAST, test_id', ['tests_counted', 'direct_value_paisa'], limit);
}

/** cpt_standard inputs: active per_test / per_analyte rules of the tests (window + instrument precedence: domain/rules.ts matchRules, TRD §8.3), active instrument bindings, and the average cost of (store, item) = Σ value / Σ qty over rows with qty > 0 (TRD §4.3 step 4). */
export const standardRules = (rc: RepoCtx, testIds: readonly string[]): Promise<Row[]> =>
  query(rc, `SELECT id, rule_kind, test_id, analyte_id, instrument_id, item_id, qty_base::text AS qty_base, to_json(effective_from) #>> '{}' AS effective_from,
                    to_json(effective_to) #>> '{}' AS effective_to, is_active FROM inventory.consumption_rules
              WHERE tenant_id = $1 AND is_active AND rule_kind IN ('per_test','per_analyte') AND test_id = ANY($2::uuid[]) ORDER BY id`, [[...testIds]]);
export const activeBindings = (rc: RepoCtx): Promise<Row[]> => query(rc, 'SELECT instrument_id, store_id FROM inventory.instrument_bindings WHERE tenant_id = $1 AND is_active');
export const averageCosts = (rc: RepoCtx, storeIds: readonly string[], itemIds: readonly string[]): Promise<Row[]> =>
  query(rc, `SELECT store_id, item_id, sum(value_paisa)::text AS value_paisa, sum(qty_base)::text AS qty_base FROM inventory.stock_balances
              WHERE tenant_id = $1 AND qty_base > 0 AND store_id = ANY($2::uuid[]) AND item_id = ANY($3::uuid[]) GROUP BY store_id, item_id`, [[...storeIds], [...itemIds]]);

// ---------------------------------------------------------------- wastage (AC-21.4)
export function wastage(rc: RepoCtx, f: Flt, limit: number): Promise<Page> {
  const q = new Q();
  const on = storeOn(q, f);
  const from = q.p(f.from), to = q.p(f.to);
  const mItem = f.itemId === undefined ? '' : ` AND m.item_id = ${q.p(f.itemId)}`;
  const cItem = f.itemId === undefined ? '' : ` AND cd.item_id = ${q.p(f.itemId)}`;
  const base = `WITH w AS (
        SELECT m.store_id, m.item_id, 'recorded:' || coalesce(m.reason_code, 'unspecified') AS category, -m.qty_base AS qty, -m.value_paisa AS val
          FROM inventory.stock_movements m WHERE m.tenant_id = $1 AND m.movement_kind = 'wastage' AND m.business_date >= ${from}::date AND m.business_date < ${to}::date${mItem}
        UNION ALL
        SELECT cd.store_id, cd.item_id, 'expiry_writeoff', cd.qty_consumed, cd.value_consumed_paisa
          FROM inventory.consumption_daily cd WHERE cd.tenant_id = $1 AND cd.movement_kind = 'expiry_writeoff' AND cd.business_date >= ${from}::date AND cd.business_date < ${to}::date${cItem}
        UNION ALL
        SELECT cd.store_id, cd.item_id, 'count_variance', cd.qty_consumed, cd.value_consumed_paisa
          FROM inventory.consumption_daily cd WHERE cd.tenant_id = $1 AND cd.movement_kind IN ('count_adjust_out','count_adjust_in') AND cd.business_date >= ${from}::date AND cd.business_date < ${to}::date${cItem})
      SELECT w.store_id, s.store_code AS _sort_store_code, w.item_id, i.item_code, w.category, sum(w.qty)::text AS qty, sum(w.val)::bigint AS value_paisa
        FROM w JOIN inventory.stores s ON s.tenant_id = $1 AND s.id = w.store_id${on} JOIN inventory.items i ON i.tenant_id = $1 AND i.id = w.item_id
       GROUP BY w.store_id, s.store_code, w.item_id, i.item_code, w.category`;
  return paged(rc, q, base, '_sort_store_code, item_code, category', ['value_paisa'], limit);
}

// ---------------------------------------------------------------- expiry (AC-21.5): lots with stock whose expiry is on or before today + within_days (expired included)
export function expiry(rc: RepoCtx, f: Scope & { today: string; withinDays: number; itemId?: string }, limit: number): Promise<Page> {
  const q = new Q();
  const on = storeOn(q, f);
  const today = q.p(f.today), within = q.p(f.withinDays);
  const item = f.itemId === undefined ? '' : ` AND sb.item_id = ${q.p(f.itemId)}`;
  const base = `SELECT sb.store_id, s.store_code AS _sort_store_code, sb.item_id, i.item_code, sb.lot_id, l.lot_no, to_char(l.expiry_on, 'YYYY-MM-DD') AS expiry_on, (l.expiry_on - ${today}::date)::int AS days_to_expiry,
        sb.qty_base::text AS qty_base, sb.value_paisa::bigint AS value_paisa, l.status AS lot_status,
        EXISTS (SELECT 1 FROM inventory.opened_containers oc WHERE oc.tenant_id = sb.tenant_id AND oc.store_id = sb.store_id AND oc.item_id = sb.item_id AND oc.lot_id = sb.lot_id AND oc.status = 'open') AS has_open_container
      FROM inventory.stock_balances sb
      JOIN inventory.lots l ON l.tenant_id = sb.tenant_id AND l.id = sb.lot_id
      JOIN inventory.stores s ON s.tenant_id = sb.tenant_id AND s.id = sb.store_id${on}
      JOIN inventory.items i ON i.tenant_id = sb.tenant_id AND i.id = sb.item_id
     WHERE sb.tenant_id = $1 AND sb.qty_base <> 0 AND l.expiry_on IS NOT NULL AND l.expiry_on <= ${today}::date + ${within}::int${item}`;
  return paged(rc, q, base, 'expiry_on, _sort_store_code, item_code, lot_no', ['value_paisa'], limit);
}

// ---------------------------------------------------------------- stock_valuation (AC-21.6): now = stock_balances; as_of = Σ stock_movements with occurred_at < start of that tenant day
export function stockValuation(rc: RepoCtx, f: Scope & { asOf?: string; tz: string; itemId?: string }, limit: number): Promise<Page> {
  const q = new Q();
  const on = storeOn(q, f);
  const item = f.itemId === undefined ? '' : ` AND sb.item_id = ${q.p(f.itemId)}`;
  const src = f.asOf === undefined
    ? 'SELECT tenant_id, store_id, item_id, lot_id, qty_base, value_paisa FROM inventory.stock_balances WHERE tenant_id = $1'
    : `SELECT tenant_id, store_id, item_id, lot_id, sum(qty_base) AS qty_base, sum(value_paisa) AS value_paisa FROM inventory.stock_movements
        WHERE tenant_id = $1 AND occurred_at < (${q.p(f.asOf)}::date::timestamp AT TIME ZONE ${q.p(f.tz)}::text) GROUP BY tenant_id, store_id, item_id, lot_id`;
  const base = `SELECT sb.store_id, s.store_code AS _sort_store_code, sb.item_id, i.item_code, sb.lot_id, l.lot_no, sb.qty_base::text AS qty_base, sb.value_paisa::bigint AS value_paisa,
        floor(sb.value_paisa::numeric * 1000000 / sb.qty_base + 0.5)::bigint AS avg_unit_cost_paisa_x1e6
      FROM (${src}) sb
      JOIN inventory.stores s ON s.tenant_id = sb.tenant_id AND s.id = sb.store_id${on}
      JOIN inventory.items i ON i.tenant_id = sb.tenant_id AND i.id = sb.item_id
      LEFT JOIN inventory.lots l ON l.tenant_id = sb.tenant_id AND l.id = sb.lot_id
     WHERE sb.qty_base <> 0${item}`;
  return paged(rc, q, base, '_sort_store_code, item_code, lot_no NULLS FIRST', ['value_paisa'], limit);
}

// ---------------------------------------------------------------- consumption_reconciliation (AC-21.7)
/** Test block: test_counts_daily.verified_result_events (all instruments) vs lab.v_pub_result_daily.results_verified (all centres: the caller has centreScope.all). */
export function reconTests(rc: RepoCtx, f: { from: string; to: string; testId?: string }, limit: number): Promise<Page> {
  const q = new Q();
  const from = q.p(f.from), to = q.p(f.to);
  const t = f.testId === undefined ? '' : ` AND test_id = ${q.p(f.testId)}`;
  const base = `WITH c AS (SELECT test_id, business_date, sum(verified_result_events)::bigint AS c12 FROM inventory.test_counts_daily
                           WHERE tenant_id = $1 AND business_date >= ${from}::date AND business_date < ${to}::date${t} GROUP BY test_id, business_date),
      l AS (SELECT test_id, business_date, sum(results_verified)::bigint AS lab FROM lab.v_pub_result_daily
             WHERE tenant_id = $1 AND business_date >= ${from}::date AND business_date < ${to}::date${t} GROUP BY test_id, business_date),
      j AS (SELECT coalesce(c.test_id, l.test_id) AS test_id, coalesce(c.business_date, l.business_date) AS business_date, coalesce(c.c12, 0) AS c12, coalesce(l.lab, 0) AS lab
              FROM c FULL JOIN l ON l.test_id = c.test_id AND l.business_date = c.business_date)
      SELECT to_char(j.business_date, 'YYYY-MM-DD') AS business_date, j.test_id, td.code AS test_code, j.c12 AS c12_verified_result_events, j.lab AS lab_results_verified, (j.c12 - j.lab) AS diff,
             (CASE WHEN greatest(j.c12, j.lab) = 0 THEN 0 ELSE floor(abs(j.c12 - j.lab)::numeric * 10000 / greatest(j.c12, j.lab) + 0.5) END)::bigint AS diff_bp
        FROM j LEFT JOIN catalog.v_pub_test_directory td ON td.tenant_id = $1 AND td.test_id = j.test_id WHERE j.c12 <> 0 OR j.lab <> 0`;
  return paged(rc, q, base, 'business_date, test_code, test_id', [], limit);
}

/** Instrument block (D-74): instrument_qc_daily.qc_observations vs instruments.v_pub_message_daily.qc_records (summed over centres). */
export function reconInstruments(rc: RepoCtx, f: { from: string; to: string; instrumentId?: string }, limit: number): Promise<Page> {
  const q = new Q();
  const from = q.p(f.from), to = q.p(f.to);
  const i = f.instrumentId === undefined ? '' : ` AND instrument_id = ${q.p(f.instrumentId)}`;
  const base = `WITH c AS (SELECT instrument_id, business_date, qc_observations::bigint AS c12 FROM inventory.instrument_qc_daily
                           WHERE tenant_id = $1 AND business_date >= ${from}::date AND business_date < ${to}::date${i}),
      m AS (SELECT instrument_id, business_date, sum(qc_records)::bigint AS recs FROM instruments.v_pub_message_daily
             WHERE tenant_id = $1 AND business_date >= ${from}::date AND business_date < ${to}::date${i} GROUP BY instrument_id, business_date),
      j AS (SELECT coalesce(c.instrument_id, m.instrument_id) AS instrument_id, coalesce(c.business_date, m.business_date) AS business_date, coalesce(c.c12, 0) AS c12, coalesce(m.recs, 0) AS recs
              FROM c FULL JOIN m ON m.instrument_id = c.instrument_id AND m.business_date = c.business_date)
      SELECT j.instrument_id, coalesce(d.display_name, j.instrument_id::text) AS _sort_instrument_label, to_char(j.business_date, 'YYYY-MM-DD') AS business_date,
             j.c12 AS c12_qc_observations, j.recs AS instrument_qc_records, (j.c12 - j.recs) AS diff
        FROM j LEFT JOIN instruments.v_pub_instrument_directory d ON d.tenant_id = $1 AND d.instrument_id = j.instrument_id WHERE j.c12 <> 0 OR j.recs <> 0`;
  return paged(rc, q, base, 'business_date, _sort_instrument_label, instrument_id', [], limit);
}

/** Open (`unresolved`) and `dismissed` consumption facts of the tenant with business_date in the window. */
export async function factCounts(rc: RepoCtx, f: { from: string; to: string }): Promise<{ unresolved: number; dismissed: number }> {
  const r = await query(rc, `SELECT count(*) FILTER (WHERE status = 'unresolved')::int AS unresolved, count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed FROM inventory.consumption_facts
                              WHERE tenant_id = $1 AND business_date >= $2::date AND business_date < $3::date`, [f.from, f.to]);
  return { unresolved: Number(r[0]?.['unresolved'] ?? 0), dismissed: Number(r[0]?.['dismissed'] ?? 0) };
}
