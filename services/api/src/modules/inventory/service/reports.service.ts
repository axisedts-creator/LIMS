// C12.T-19 reports #92 getInventoryReport / #93 exportInventoryReport (02-TRD §5.5, §5.10, §5.11, §6.3, §8.6; PRD AC-21.1-21.9, §8.3; 07-SECURITY P-B6, PE-1, PE-3, P-9). Read-only: no report writes a row.
// Order (the handler has already asserted the permissions, the all-centres rule, the strict query and the range cap): store_id / branch_id visibility (404, P-B6) -> the report block(s) with the cap as LIMIT
// -> shape -> cost allowlist (mappers/report.dto.ts: strips every † key and column; cost_per_test is 403 without inventory.cost.read) -> #93 only: row cap (422), CSV, one access-log row.
// [CONV] Rows / totals / counts come out of one statement per block (views.repo.ts), so the caps never change a total. Counts and money are JSON integers, quantities DecimalStrings; null values are omitted from rows.
// [CONV] as_of = the start of that tenant day (`occurred_at < as_of`, TRD §5.11). expiry `within_days` defaults to settings.expiry_alert_days (30 when the tenant has no settings row yet: a read never writes, A17 P-22).
// [CONV] CSV: header = the permitted columns[].key; a nested cell (analyser `tests`, cost_per_test `breakdown`) is compact JSON text; quantities are written as exact decimals, never neutralised.
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import { loadInventoryConfig } from '../config.js';
import { Dec, toCsv, type CsvCell } from '../domain/csv.js';
import { scaled } from '../domain/quantity.js';
import { nowMs } from '../domain/tenantTime.js';
import type { ReportCode, ReportQuery } from '../handlers/reports.schemas.js';
import { toReportResultDto } from '../mappers/report.dto.js';
import * as v from '../repository/views.repo.js';
import { getSettings } from '../repository/settings.repo.js';
import { getStore } from '../repository/stores.repo.js';
import { type RepoCtx, type Row } from '../repository/_base.js';
import { clock, permissionsOf } from './purchasing.service.js';
import { listVisibleBranchIds } from './scope.service.js';

type Scope = Parameters<typeof listVisibleBranchIds>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const num = (x: unknown): number => Number(x);
const compact = (r: Row): Row => Object.fromEntries(Object.entries(r).filter(([, x]) => x !== null && x !== undefined));
const opt = <K extends string>(k: K, x: string | undefined): { [P in K]?: string } => (x === undefined ? {} : ({ [k]: x } as { [P in K]?: string }));
const RECON_INTS = new Set(['c12_verified_result_events', 'lab_results_verified', 'diff', 'diff_bp', 'c12_qc_observations', 'instrument_qc_records']);

// ---------------------------------------------------------------- columns (TRD §5.11; cost columns †)
const COLS: Record<ReportCode, readonly string[]> = {
  daily_consumption: ['business_date', 'store_id', 'store_code', 'item_id', 'item_code', 'item_name', 'base_uom_code', 'movement_kind', 'qty_consumed', 'value_consumed_paisa', 'movements'],
  analyser_consumption: ['instrument_id', 'instrument_label', 'item_id', 'item_code', 'movement_kind', 'qty_consumed', 'value_consumed_paisa', 'movements', 'tests'],
  cost_per_test: ['test_id', 'test_code', 'test_name', 'instrument_id', 'tests_counted', 'direct_value_paisa', 'fixed_value_on_instrument_paisa', 'fixed_share_paisa', 'cpt_direct_paisa', 'cpt_loaded_paisa',
    'cpt_standard_paisa', 'standard_is_complete', 'breakdown'],
  wastage: ['store_id', 'store_code', 'item_id', 'item_code', 'category', 'qty', 'value_paisa'],
  expiry: ['store_id', 'store_code', 'item_id', 'item_code', 'lot_id', 'lot_no', 'expiry_on', 'days_to_expiry', 'qty_base', 'value_paisa', 'lot_status', 'has_open_container'],
  stock_valuation: ['store_id', 'store_code', 'item_id', 'item_code', 'lot_id', 'lot_no', 'qty_base', 'value_paisa', 'avg_unit_cost_paisa_x1e6'],
  consumption_reconciliation: ['business_date', 'test_id', 'test_code', 'c12_verified_result_events', 'lab_results_verified', 'diff', 'diff_bp', 'instrument_id', 'instrument_label', 'c12_qc_observations',
    'instrument_qc_records'],
};
const COST_ONLY = new Set(['standard_is_complete', 'breakdown']); // cost_per_test columns without a *_paisa name that are still †
const isCost = (k: string): boolean => k.endsWith('_paisa') || k.endsWith('_paisa_x1e6') || COST_ONLY.has(k);
const label = (k: string): string => (k.charAt(0).toUpperCase() + k.slice(1)).replaceAll('_', ' ');
const columnsOf = (code: ReportCode) => COLS[code].map((key) => ({ key, label: label(key), is_cost: isCost(key) }));
const DECIMALS = new Set(['qty_consumed', 'qty', 'qty_base']);

// ---------------------------------------------------------------- scope (P-B1 / P-B6)
/** store_id / branch_id the caller cannot see, or that do not exist, are 404 (never 403, never an empty list); no filter = the caller's visible branches only. */
async function scopeOf(ctx: HandlerContext, rc: RepoCtx, q: ReportQuery): Promise<v.Scope> {
  const vis = await listVisibleBranchIds(ctx as unknown as Scope);
  const s: v.Scope = vis.all ? {} : { visible: vis.branchIds };
  if (q.store_id !== undefined) {
    const st = await getStore(rc, q.store_id);
    if (st === null || !(vis.all || vis.branchIds.includes(st['branch_id']))) throw new LimsError('common.not_found');
    s.storeId = q.store_id;
  }
  if (q.branch_id !== undefined) {
    if (!(vis.all || vis.branchIds.includes(q.branch_id))) throw new LimsError('common.not_found');
    await (ctx as unknown as { core: { branch(c: unknown, i: { branchId: string }): Promise<unknown> } }).core.branch(ctx, { branchId: q.branch_id }); // unknown branch -> 404
    s.branchId = q.branch_id;
  }
  return s;
}

// ---------------------------------------------------------------- cpt_standard (PRD §8.3)
const MICRO = 1_000_000n;
async function addStandard(ctx: HandlerContext, rc: RepoCtx, rows: Row[], nowIso: string): Promise<void> {
  if (rows.length === 0) return;
  const rules = await v.standardRules(rc, [...new Set(rows.map((r) => r['test_id'] as string))]);
  const bind = new Map((await v.activeBindings(rc)).map((b) => [b['instrument_id'] as string, b['store_id'] as string]));
  const dflt = ((await getSettings(rc))?.['default_consumption_store_id'] ?? null) as string | null;
  const reportable = new Map<string, Set<string>>(); // reportable analytes of the tests that carry a per_analyte rule (CatalogPort.getTest)
  for (const t of new Set(rules.filter((r) => r['rule_kind'] === 'per_analyte').map((r) => r['test_id'] as string))) {
    try {
      const test = await (ctx.ports as any).CatalogPort.getTest(ctx, { testId: t, asOf: nowIso });
      reportable.set(t, new Set((test?.analytes ?? []).filter((a: Row) => a['reportable'] !== false).map((a: Row) => a['id'] as string)));
    } catch (e) { if (!(e instanceof LimsError && e.code === 'common.not_found')) throw e; reportable.set(t, new Set()); }
  }
  const hits = rows.map((r) => {
    const store = bind.get(r['instrument_id'] as string) ?? dflt;
    const rs = rules.filter((x) => x['test_id'] === r['test_id'] && (x['instrument_id'] === null || x['instrument_id'] === r['instrument_id'])
      && (x['rule_kind'] === 'per_test' || reportable.get(x['test_id'])?.has(x['analyte_id']) === true));
    return { store, rs };
  });
  const stores = [...new Set(hits.flatMap((h) => (h.store === null ? [] : [h.store])))];
  const items = [...new Set(hits.flatMap((h) => h.rs.map((x) => x['item_id'] as string)))];
  const cost = new Map((stores.length === 0 || items.length === 0 ? [] : await v.averageCosts(rc, stores, items)).map((c) => [`${c['store_id']}|${c['item_id']}`, c]));
  rows.forEach((r, i) => {
    const { store, rs } = hits[i]!;
    let micro = 0n; let complete = rs.length > 0 && store !== null;
    for (const x of rs) {
      const c = store === null ? undefined : cost.get(`${store}|${x['item_id']}`);
      if (c === undefined) { complete = false; continue; }
      const qty = scaled(x['qty_base'], 6); const bal = scaled(c['qty_base'], 6);
      micro += (qty * BigInt(c['value_paisa']) * MICRO * 2n + bal) / (bal * 2n); // qty x value / balance in micro-paisa, half up
    }
    r['standard_is_complete'] = complete;
    if (rs.length > 0 && (micro > 0n || complete)) r['cpt_standard_paisa'] = Number((micro + MICRO / 2n) / MICRO); // rounded once, half up
  });
}

// ---------------------------------------------------------------- the seven reports -> { rows, count (before the cap), totals }
interface Built { rows: Row[]; count: number; totals: Row }

async function build(ctx: HandlerContext, rc: RepoCtx, code: ReportCode, q: ReportQuery, scope: v.Scope, limit: number): Promise<Built> {
  const f = { ...scope, from: q.business_date_from ?? '', to: q.business_date_to ?? '', ...opt('instrumentId', q.instrument_id), ...opt('testId', q.test_id), ...opt('itemId', q.item_id) };
  const itemId = opt('itemId', q.item_id);
  switch (code) {
    case 'daily_consumption': {
      const p = await v.dailyConsumption(rc, f, limit);
      return { count: p.count, totals: { value_consumed_paisa: num(p.totals['value_consumed_paisa']), movements: num(p.totals['movements']) },
        rows: p.rows.map((r) => compact({ ...r, value_consumed_paisa: num(r['value_consumed_paisa']), movements: num(r['movements']) })) };
    }
    case 'analyser_consumption': {
      const p = await v.analyserConsumption(rc, f, limit);
      const ids = [...new Set(p.rows.map((r) => r['instrument_id'] as string))];
      const tests = new Map<string, Row[]>();
      if (ids.length > 0) {
        for (const t of await v.analyserTests(rc, ids, { from: f.from, to: f.to, ...opt('testId', q.test_id) })) {
          const l = tests.get(t['instrument_id']) ?? [];
          l.push({ test_id: t['test_id'], test_code: t['test_code'] ?? t['test_id'], tests_counted: num(t['tests_counted']), rerun_events: num(t['rerun_events']), qc_events: num(t['qc_events']) });
          tests.set(t['instrument_id'], l);
        }
      }
      return { count: p.count, totals: { value_consumed_paisa: num(p.totals['value_consumed_paisa']), movements: num(p.totals['movements']) },
        rows: p.rows.map((r) => compact({ ...r, value_consumed_paisa: num(r['value_consumed_paisa']), movements: num(r['movements']), tests: (tests.get(r['instrument_id']) ?? []).map((t) => ({ ...t })) })) };
    }
    case 'cost_per_test': {
      const p = await v.costPerTest(rc, f, limit);
      const rows = p.rows.map((r) => {
        const o: Row = { ...r, breakdown: { consume_test: num(r['consume_test']), consume_analyte: num(r['consume_analyte']), consume_rerun: num(r['consume_rerun']), consume_qc: num(r['consume_qc']), consume_calibration: num(r['consume_calibration']) } };
        for (const k of ['consume_test', 'consume_analyte', 'consume_rerun', 'consume_qc', 'consume_calibration']) delete o[k];
        for (const k of ['tests_counted', 'direct_value_paisa', 'fixed_value_on_instrument_paisa', 'fixed_share_paisa', 'cpt_direct_paisa', 'cpt_loaded_paisa']) if (o[k] !== null) o[k] = num(o[k]);
        return o;
      });
      await addStandard(ctx, rc, rows, new Date(nowMs(ctx.now())).toISOString());
      return { count: p.count, totals: { tests_counted: num(p.totals['tests_counted']), direct_value_paisa: num(p.totals['direct_value_paisa']) }, rows: rows.map(compact) };
    }
    case 'wastage': {
      const p = await v.wastage(rc, f, limit);
      return { count: p.count, totals: { value_paisa: num(p.totals['value_paisa']) }, rows: p.rows.map((r) => compact({ ...r, value_paisa: num(r['value_paisa']) })) };
    }
    case 'expiry': {
      const { today } = await clock(ctx);
      const days = q.within_days ?? Number((await getSettings(rc))?.['expiry_alert_days'] ?? 30);
      const p = await v.expiry(rc, { ...scope, today, withinDays: days, ...itemId }, limit);
      return { count: p.count, totals: { value_paisa: num(p.totals['value_paisa']) }, rows: p.rows.map((r) => compact({ ...r, value_paisa: num(r['value_paisa']) })) };
    }
    case 'stock_valuation': {
      const { tz } = await clock(ctx);
      const p = await v.stockValuation(rc, { ...scope, tz, ...opt('asOf', q.as_of), ...itemId }, limit);
      return { count: p.count, totals: { value_paisa: num(p.totals['value_paisa']) },
        rows: p.rows.map((r) => compact({ ...r, value_paisa: num(r['value_paisa']), avg_unit_cost_paisa_x1e6: r['avg_unit_cost_paisa_x1e6'] === null ? null : num(r['avg_unit_cost_paisa_x1e6']) })) };
    }
    case 'consumption_reconciliation': {
      const w = { from: f.from, to: f.to };
      const t = await v.reconTests(rc, { ...w, ...opt('testId', q.test_id) }, limit);
      const i = await v.reconInstruments(rc, { ...w, ...opt('instrumentId', q.instrument_id) }, limit);
      const facts = await v.factCounts(rc, w);
      const ints = (r: Row) => compact(Object.fromEntries(Object.entries(r).map(([k, x]) => [k, RECON_INTS.has(k) ? num(x) : x])));
      return { count: t.count + i.count, totals: { unresolved_facts: facts.unresolved, dismissed_facts: facts.dismissed }, rows: [...t.rows.map(ints), ...i.rows.map(ints)] };
    }
  }
}

// ---------------------------------------------------------------- #92
async function run(ctx: HandlerContext, code: ReportCode, q: ReportQuery, limit: number, onTooMany?: () => never): Promise<{ result: Row; permissions: readonly string[] }> {
  const rc = rcOf(ctx);
  const permissions = await permissionsOf(ctx);
  const scope = await scopeOf(ctx, rc, q);
  const b = await build(ctx, rc, code, q, scope, limit);
  if (b.count > limit && onTooMany) onTooMany();
  const result: Row = { report_code: code, params: { ...q }, columns: columnsOf(code), rows: b.rows.slice(0, limit), totals: b.totals, generated_at: new Date(nowMs(ctx.now())).toISOString(), truncated: b.count > limit };
  return { result: toReportResultDto(result, permissions), permissions };
}

export async function getReport(ctx: HandlerContext, code: ReportCode, q: ReportQuery): Promise<Row> {
  return (await run(ctx, code, q, (await loadInventoryConfig()).reportScreenRows)).result;
}

// ---------------------------------------------------------------- #93 CSV + access log (§5.10)
const cellOf = (key: string, x: unknown): CsvCell => {
  if (x === null || x === undefined) return '';
  if (typeof x === 'string') return DECIMALS.has(key) ? new Dec(x) : x;
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return String(x);
  return JSON.stringify(x);
};

export async function exportReport(ctx: HandlerContext, code: ReportCode, q: ReportQuery): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const audit = (ctx as unknown as { audit?: { access?: (e: Record<string, unknown>) => Promise<void> } }).audit;
  if (typeof audit?.access !== 'function') throw new LimsError('common.internal'); // the access-log row is mandatory
  const max = (await loadInventoryConfig()).exportMaxRows;
  const { result } = await run(ctx, code, q, max, () => { throw new LimsError('inventory.export_too_large'); });
  const keys = (result['columns'] as Row[]).map((c) => c['key'] as string);
  const rows = result['rows'] as Row[];
  const body = toCsv(keys, rows.map((r) => keys.map((k) => cellOf(k, r[k]))));
  await audit.access({ action: 'data.export', entityType: 'inventory_report', outcome: 'allowed', detail: { ...q, report_code: code, row_count: rows.length } });
  const span = q.business_date_from !== undefined ? `${q.business_date_from}_${q.business_date_to}` : String(result['generated_at']).slice(0, 10);
  return {
    status: 200, body,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="inventory-${code}-${span}.csv"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  };
}
