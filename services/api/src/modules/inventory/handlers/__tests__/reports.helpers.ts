// C12.T-19 test helpers (not a test file). Synthetic data only. Operations #92 getInventoryReport and #93 exportInventoryReport (02-TRD §5.5 / §5.10 / §5.11 / §6.3 / §8.6; PRD AC-21.1-21.9, §8.3;
// 07-SECURITY P-B6 / PE-1 / PE-3 / P-9). (#90 listInventoryAlerts / #91 acknowledgeInventoryAlert share the plan row but have no file, no AC and no done_when in T-19: NOT covered here.)
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention and ctx stub as T-09 / T-12 / T-15 (lots / receipts / consumption helpers):
//   * `handlers[operationId](req, ctx)` with `req.params.report_code` and `req.query` (values already typed: within_days is a number, dates are 'YYYY-MM-DD' strings). Success => { status: 200, body | CSV };
//     failure => the handler THROWS a LimsError. handlers/index.ts must replace the two stubs (new file handlers/reports.ts is expected; T-19 lists only the service + repo files).
//   * GATE ORDER (#92). `IdentityPort.assertRole(ctx, { permission: 'inventory.item.read' })` with NO branchId is the FIRST thing, before validation and before any tx statement (like #49 / #63 / #69).
//     report_code = cost_per_test then also asserts `inventory.cost.read` (no branchId) => 403 auth.forbidden. consumption_reconciliation with `getActor().centreScope.all = false` => 403 auth.forbidden
//     (TRD #92, 07-SECURITY P-B6). All three refusals leave the tx untouched. Then strict validation (400 common.validation_failed), then the 366-day cap (422 inventory.range_too_large), then the store / branch
//     visibility reads (404 common.not_found for a store_id or branch_id that is unknown or whose branch the caller cannot see, P-B6), then the report.
//   * GATE ORDER (#93). `assertRole({ permission: 'inventory.report.export' })` first (privileged: at aal1 the port answers 403 auth.mfa_required, PE-1), then `inventory.cost.read` for cost_per_test, then
//     the same centreScope rule, then validation, range (422 inventory.range_too_large), visibility (404), then rows > exportMaxRows => 422 inventory.export_too_large. #93 does NOT need inventory.item.read.
//   * CONFIG. The caps are read at call time through `loadInventoryConfig()` (process.env: LIMS_INVENTORY_REPORT_MAX_DAYS 366, LIMS_INVENTORY_REPORT_SCREEN_ROWS 5000, LIMS_INVENTORY_EXPORT_MAX_ROWS 50000);
//     the tests lower them through process.env and restore them. "Rows" are the report's `rows` array (the totals row is not a row).
//   * WIRE (#92). `{ report_code, params, columns, rows, totals, generated_at, truncated }` and nothing else. `params` echoes the supplied query keys. `columns` = ColumnMeta { key, label, is_cost } for the row
//     keys of the report (TRD §5.11 table; is_cost true exactly for the † columns). `generated_at` = ctx.now(). More than reportScreenRows rows => `rows` is cut to that many and `truncated` is true.
//     Quantities are DecimalString (numeric value compared, not the text), money is an integer number. A cost-less caller (no `inventory.cost.read`) gets no `*_paisa` / `*_paisa_x1e6` key anywhere (columns,
//     rows, totals; mapper report.dto.ts) and `cost_per_test` is refused (403). Rows are the caller's visible branches only; tenant filter explicit.
//   * REPORT ROWS (TRD §5.11). daily_consumption: business_date x store x item x movement_kind from consumption_daily (summed over instrument and test); a cd row with a negative quantity (reversal) nets.
//     analyser_consumption: instrument x item x movement_kind (rows with instrument NULL are NOT in it), every row of an instrument carries the same `tests[]` { test_id, test_code, tests_counted, rerun_events,
//     qc_events } of that instrument in the period (test_counts_daily); `instrument_label` = display_name of instruments.v_pub_instrument_directory. cost_per_test: one row per (test, instrument) that has
//     counts or consumption in the period (instrument_id null / absent = "none"); null CPT values may be `null` or absent. wastage: store x item x category (`recorded:<reason_code>` from the wastage
//     movements, `expiry_writeoff`, `count_variance` = count_adjust_out net of the negative count_adjust_in rows). expiry: store x lot with stock (qty <> 0) and an expiry date on or before today + within_days
//     (tenant date of ctx.now()), expired lots included; default within_days = settings.expiry_alert_days (30). stock_valuation: store x item x lot (lot_id absent for the unlotted row) with qty <> 0; now = stock_balances,
//     `as_of` (a date, tests stay clear of its boundary) = sum of stock_movements before it; avg_unit_cost_paisa_x1e6 = round_half_up(value * 1e6 / qty).
//     consumption_reconciliation: `rows` holds BOTH blocks: test rows { business_date, test_id, test_code, c12_verified_result_events, lab_results_verified, diff = c12 - lab, diff_bp = round(abs(diff) * 10000 /
//     greatest(c12, lab)) } and instrument rows { instrument_id, instrument_label, business_date, c12_qc_observations, instrument_qc_records, diff = c12 - records }; `totals.unresolved_facts` / `totals.dismissed_facts` =
//     consumption_facts of the tenant with business_date in the window and that status. The report never writes (no alert rows).
//   * CSV (#93). 200 { body: string | Buffer, headers } with content-type text/csv, content-disposition attachment (plain .csv name), cache-control no-store, x-content-type-options nosniff; UTF-8 BOM, CRLF;
//     header row = the `columns[].key` list of the same report for the same caller (cost columns dropped without inventory.cost.read); one record per `rows` entry (a nested array / object cell is the writer's choice);
//     every text cell passes neutraliseFormula, numeric cells stay plain decimal text (a negative number is NOT prefixed). Exactly one `ctx.audit.access({ action: 'data.export', entityType: 'inventory_report',
//     outcome: 'allowed', detail: primitives only, including `report_code` })` per success, none on any refusal.
import { LimsError } from '../../../../core/errors.js';
import { access as coreAccess } from '../../../../core/audit/access.js';
import { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, rej, uid, type Req, type Tx } from './masters.helpers.js';
import { ADJUST, COST, READ, addDays, makeLotCtx, ymdIn, type LotOpts, type LotStub } from './lots.helpers.js';
import { bodyText, csvObjects, headerOf, parseCsv } from './receipts.helpers.js';

export { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, rej, uid, ADJUST, COST, READ, addDays, ymdIn, bodyText, csvObjects, headerOf, parseCsv, LimsError };
export type { Req, Tx, LotOpts };
export const EXPORT = 'inventory.report.export';
export const NOW = '2026-06-15T06:00:00.000Z'; // frozen ctx.now(); the tenant date (Asia/Kathmandu) is 2026-06-15
export const TODAY = '2026-06-15';

export const REPORTS = ['daily_consumption', 'analyser_consumption', 'cost_per_test', 'wastage', 'expiry', 'stock_valuation', 'consumption_reconciliation'] as const;
export type ReportCode = (typeof REPORTS)[number];
export const OPS = { get: 'getInventoryReport', csv: 'exportInventoryReport' } as const;
/** operationId -> permission the handler must assert (02-TRD §5.5 #92 / #93). */
export const PERMISSION: Record<string, string> = { getInventoryReport: READ, exportInventoryReport: EXPORT };

export interface RepOpts extends LotOpts { analytes?: Record<string, string[]> }
export interface RepStub extends LotStub { audit: any[]; catalogCalls: { testId: string }[] }

/** ctx for a lab manager who reads, sees cost and exports: item.read + cost.read + report.export; aal2; Asia/Kathmandu; frozen clock NOW; fake CatalogPort.getTest (unknown test => no analytes);
 *  `audit.access` spy that also runs the REAL core validator (an invalid entry fails the test). */
export function makeRepCtx(tx: Tx, tenantId: string, o: RepOpts = {}): RepStub {
  const st = makeLotCtx(tx, tenantId, { permissions: [READ, COST, EXPORT], now: NOW, ...o });
  const port = st.ctx.ports.IdentityPort;
  const base = port.assertRole.bind(port);
  port.assertRole = async (c: unknown, req: { permission: string; branchId?: string }) => {
    await base(c, req); // records the request, rejects a missing permission with auth.forbidden
    if (req.permission === EXPORT && (o.aal ?? 'aal2') === 'aal1') throw new LimsError('auth.mfa_required'); // privileged (PE-1)
  };
  const catalogCalls: { testId: string }[] = [];
  st.ctx.ports.CatalogPort = {
    async getTest(_c: unknown, i: { testId: string; asOf?: string }) {
      catalogCalls.push({ testId: i.testId });
      const ids = o.analytes?.[i.testId] ?? [];
      return { id: i.testId, code: 'T', name: 'Synthetic test', departmentId: uid(1), departmentCode: 'D', specimenTypeCodes: [], workflowType: 'standard', isActive: true, revision: 1,
        analytes: ids.map((id, n) => ({ id, code: `A${n}`, name: `Analyte ${n}`, resultType: 'numeric', reportable: true, sortOrder: n })) };
    },
  };
  const audit: any[] = [];
  const recorder: Tx = { async query() { return { rows: [] }; } };
  st.ctx.audit = { async access(e: unknown) { audit.push(e); await coreAccess({ tenantId, requestId: 'r-t19', actor: st.ctx.actor, tx: recorder }, e as never); } };
  return { ...st, audit, catalogCalls };
}

// ------------------------------------------------------------------ permission sets / scopes
export const NO_COST: RepOpts = { permissions: [READ, EXPORT] };
export const READER: RepOpts = { permissions: [READ, COST] }; // no export
export const READ_ONLY: RepOpts = { permissions: [READ] };
export const EXPORT_ONLY: RepOpts = { permissions: [EXPORT] };
export const BR1_ONLY: RepOpts = { all: false, branchIds: [BR1] };
export const BR2_ONLY: RepOpts = { all: false, branchIds: [BR2] };

// ------------------------------------------------------------------ request builders
export const win = (from: string, to: string, over: Record<string, unknown> = {}) => ({ business_date_from: from, business_date_to: to, ...over });
export const rep = (code: string, query: Record<string, unknown> = {}): Req => ({ params: { report_code: code }, query });

// ------------------------------------------------------------------ contract shapes (inventory.yaml ReportResult / ReportRow / ColumnMeta; no tenant / audit columns ever)
export const RESULT_KEYS = ['report_code', 'params', 'columns', 'rows', 'totals', 'generated_at', 'truncated'];
export const COLUMN_KEYS = ['key', 'label', 'is_cost'];
export const ROW_KEYS = ['business_date', 'store_id', 'store_code', 'item_id', 'item_code', 'item_name', 'base_uom_code', 'movement_kind', 'qty_consumed', 'value_consumed_paisa', 'movements', 'instrument_id', 'instrument_label',
  'tests', 'test_id', 'test_code', 'test_name', 'tests_counted', 'direct_value_paisa', 'fixed_value_on_instrument_paisa', 'fixed_share_paisa', 'cpt_direct_paisa', 'cpt_loaded_paisa', 'cpt_standard_paisa', 'standard_is_complete',
  'breakdown', 'category', 'qty', 'value_paisa', 'lot_id', 'lot_no', 'expiry_on', 'days_to_expiry', 'qty_base', 'lot_status', 'has_open_container', 'avg_unit_cost_paisa_x1e6', 'c12_verified_result_events',
  'lab_results_verified', 'diff', 'diff_bp', 'c12_qc_observations', 'instrument_qc_records', 'unresolved_facts', 'dismissed_facts'];
export const BREAKDOWN_KEYS = ['consume_test', 'consume_analyte', 'consume_rerun', 'consume_qc', 'consume_calibration'];
/** Money fields that must vanish without inventory.cost.read (02-TRD §6.3). */
export const COST_FIELD = /_paisa(_x1e6)?$|^value_basis$/;
/** Every key at every depth. */
export function deepKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out); }
  return out;
}
export const num = (v: unknown): number => { const n = Number(v); if (Number.isNaN(n)) throw new Error(`not a number: ${JSON.stringify(v)}`); return n; };
/** numeric value of a decimal-string cell, tolerating "4", "4.0", "4.000000" */
export const isNum = (s: string): boolean => /^-?\d+(\.\d+)?$/.test(s);
