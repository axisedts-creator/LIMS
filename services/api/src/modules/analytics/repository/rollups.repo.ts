// Rollup reads (02-TRD §6 intro + §6.1 income + §6.2 department income; 07-SECURITY P1, REQ-SEC-013/017).
// One bound SELECT per call: tenant `$1`, [from, to) `$2/$3`, scope `$4` (all) / `$5` (centres); nothing from input is ever
// part of the statement text — group keys and grains come from a closed allow-list. Scope is mandatory.
// bigint columns arrive from pg as strings: returned as safe integers, anything beyond 2^53 is refused (never rounded).

import { DELIVERY_COLS, MESSAGE_COLS, RELEASE_COLS, RESULT_COLS } from '../domain/columns.js';

export interface RollupsTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface RollupScope { readonly all: boolean; readonly centreIds: readonly string[] }
interface Base { readonly tenantId: string; readonly from: string; readonly to: string; readonly scope: RollupScope }

export type IncomeGroupBy = 'day' | 'ad_month' | 'branch' | 'centre'; // bs_month is grouped in the service (metrics.groupByBsMonth)
export type DepartmentGrain = 'total' | 'day';

export interface IncomeRow {
  key: string | null; invoices_issued: number; invoices_cancelled: number; gross_paisa: number; discount_paisa: number; exempt_paisa: number;
  taxable_paisa: number; vat_paisa: number; other_tax_paisa: number; invoiced_paisa: number; credit_notes_paisa: number; net_sales_paisa: number;
}
export interface DepartmentIncomeRow {
  business_date: string | null; department_id: string | null; line_count: number; gross_paisa: number; discount_paisa: number; net_paisa: number;
}

// SQL fragments are constants selected by allow-list key, never built from input.
const KEY_SQL: Readonly<Record<IncomeGroupBy, string>> = {
  day: 'business_date',
  ad_month: "date_trunc('month', business_date)::date",
  branch: 'branch_id',
  centre: 'centre_id',
};
const SCOPE_SQL = 'AND ($4 OR (centre_id IS NOT NULL AND centre_id = ANY ($5)))';

export function checkScope(scope: unknown): RollupScope {
  const s = scope as RollupScope | null | undefined;
  if (!s || typeof s.all !== 'boolean' || !Array.isArray(s.centreIds)) throw new TypeError('rollups: scope is mandatory ({ all: boolean, centreIds: string[] })');
  return s;
}

/** pg bigint (string) or number -> safe integer; anything else, or beyond 2^53, throws. */
function int(v: unknown, col: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?[0-9]{1,20}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || (typeof v === 'string' && BigInt(v) !== BigInt(n))) throw new RangeError(`rollups: ${col} is not a safe integer`);
  return n;
}

export async function incomeRows(
  tx: RollupsTx,
  a: Base & { readonly groupBy: IncomeGroupBy },
): Promise<IncomeRow[]> {
  const scope = checkScope(a.scope);
  if (typeof a.groupBy !== 'string' || !Object.hasOwn(KEY_SQL, a.groupBy)) throw new TypeError('rollups: groupBy outside the allow-list');
  if (!scope.all && scope.centreIds.length === 0) return []; // empty restricted scope sees nothing
  const key = KEY_SQL[a.groupBy];
  const sql = `SELECT ${key}::text AS key,
       sum(invoices_issued)::bigint AS invoices_issued, sum(invoices_cancelled)::bigint AS invoices_cancelled,
       sum(gross_paisa)::bigint AS gross_paisa, sum(discount_paisa)::bigint AS discount_paisa, sum(exempt_paisa)::bigint AS exempt_paisa,
       sum(taxable_paisa)::bigint AS taxable_paisa, sum(vat_paisa)::bigint AS vat_paisa, sum(other_tax_paisa)::bigint AS other_tax_paisa,
       sum(net_paisa)::bigint AS invoiced_paisa, sum(credit_notes_paisa)::bigint AS credit_notes_paisa,
       (sum(net_paisa) - sum(credit_notes_paisa))::bigint AS net_sales_paisa
FROM analytics.daily_income
WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3 ${SCOPE_SQL}
GROUP BY ${key} ORDER BY ${key}`;
  const { rows } = await tx.query(sql, [a.tenantId, a.from, a.to, scope.all, [...scope.centreIds]]);
  return rows.map((r) => ({
    key: r.key === null || r.key === undefined ? null : String(r.key),
    invoices_issued: int(r.invoices_issued, 'invoices_issued'), invoices_cancelled: int(r.invoices_cancelled, 'invoices_cancelled'),
    gross_paisa: int(r.gross_paisa, 'gross_paisa'), discount_paisa: int(r.discount_paisa, 'discount_paisa'), exempt_paisa: int(r.exempt_paisa, 'exempt_paisa'),
    taxable_paisa: int(r.taxable_paisa, 'taxable_paisa'), vat_paisa: int(r.vat_paisa, 'vat_paisa'), other_tax_paisa: int(r.other_tax_paisa, 'other_tax_paisa'),
    invoiced_paisa: int(r.invoiced_paisa, 'invoiced_paisa'), credit_notes_paisa: int(r.credit_notes_paisa, 'credit_notes_paisa'),
    net_sales_paisa: int(r.net_sales_paisa, 'net_sales_paisa'),
  }));
}

export async function departmentIncomeRows(
  tx: RollupsTx,
  a: Base & { readonly departmentIds?: readonly string[] | undefined; readonly grain: DepartmentGrain },
): Promise<DepartmentIncomeRow[]> {
  const scope = checkScope(a.scope);
  if (a.grain !== 'total' && a.grain !== 'day') throw new TypeError('rollups: grain outside the allow-list');
  if (!scope.all && scope.centreIds.length === 0) return [];
  const values: unknown[] = [a.tenantId, a.from, a.to, scope.all, [...scope.centreIds]];
  let byDept = '';
  if (a.departmentIds?.length) { values.push([...a.departmentIds]); byDept = ' AND department_id = ANY ($6)'; }
  const day = a.grain === 'day';
  const sql = `SELECT ${day ? 'business_date::text' : 'NULL::text'} AS business_date, department_id,
       sum(line_count)::bigint AS line_count, sum(gross_paisa)::bigint AS gross_paisa, sum(discount_paisa)::bigint AS discount_paisa, sum(net_paisa)::bigint AS net_paisa
FROM analytics.daily_department_income
WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3 ${SCOPE_SQL}${byDept}
GROUP BY ${day ? 'business_date, ' : ''}department_id ORDER BY ${day ? 'business_date, ' : ''}department_id`;
  const { rows } = await tx.query(sql, values);
  return rows.map((r) => ({
    business_date: r.business_date === null || r.business_date === undefined ? null : String(r.business_date),
    department_id: r.department_id === null || r.department_id === undefined ? null : String(r.department_id),
    line_count: int(r.line_count, 'line_count'), gross_paisa: int(r.gross_paisa, 'gross_paisa'),
    discount_paisa: int(r.discount_paisa, 'discount_paisa'), net_paisa: int(r.net_paisa, 'net_paisa'),
  }));
}

// ------------------------------------------------------------------ AN-T11: results, rejections, specimens, critical values, deliveries, releases, interface messages
// (02-TRD §6.5, §6.8). Same contract as above: one bound SELECT, $1 tenant, $2/$3 [from, to), $4/$5 scope, extra filters after $5.
const DATE_KEYS = { day: 'business_date', ad_month: "date_trunc('month', business_date)::date" } as const;
const RESULT_KEYS = { department: 'department_id', test: 'test_id', processing_branch: 'processing_branch_id', ...DATE_KEYS } as const;
const REJECTION_KEYS = { reason: 'reason_code', centre: 'centre_id', specimen_type: 'specimen_type_code', ...DATE_KEYS } as const;
const SPECIMEN_KEYS = { total: '', centre: 'centre_id', specimen_type: 'specimen_type_code', ...DATE_KEYS } as const;
const DELIVERY_KEYS = { channel: 'channel', ...DATE_KEYS } as const;
const RELEASE_KEYS = { total: '', ...DATE_KEYS } as const;

/** The grouping expression for `groupBy`, chosen from a closed list only ('' = one total row). */
function keyOf(map: Readonly<Record<string, string>>, groupBy: unknown): string {
  if (typeof groupBy !== 'string' || !Object.hasOwn(map, groupBy)) throw new TypeError('rollups: groupBy outside the allow-list');
  return map[groupBy]!;
}

async function read(
  tx: RollupsTx, a: Base, table: string, key: string, sel: string, measures: string, extra: { sql: string; values: unknown[] } = { sql: '', values: [] },
): Promise<any[]> {
  const scope = checkScope(a.scope);
  if (!scope.all && scope.centreIds.length === 0) return [];
  const tail = key ? `GROUP BY ${key} ORDER BY ${key}` : 'HAVING count(*) > 0'; // total: one row, none for an empty window
  const sql = `SELECT ${sel}, ${measures}
FROM ${table}
WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3 ${SCOPE_SQL}${extra.sql}
${tail}`;
  return (await tx.query(sql, [a.tenantId, a.from, a.to, scope.all, [...scope.centreIds], ...extra.values])).rows;
}
const keySel = (key: string): string => (key ? `${key}::text AS key` : 'NULL::text AS key');
const col = (c: string): string => (c === 'read' ? '"read"' : c);
const sumCols = (cols: readonly string[]): string => cols.map((c) => `sum(${col(c)})::bigint AS ${col(c)}`).join(', ');
const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nint = (v: unknown, name: string): number | null => (v === null || v === undefined ? null : int(v, name));
const ints = <C extends string>(r: Record<string, unknown>, cols: readonly C[]): Record<C, number> =>
  Object.fromEntries(cols.map((c) => [c, int(r[c], c)])) as Record<C, number>;

export type ResultsRow = { key: string | null } & Record<(typeof RESULT_COLS)[number], number>;
export type RejectionRow = { key: string | null; rejections: number; recollections_ordered: number };
export type SpecimenRow = { key: string | null; received: number };
export type CriticalValueRow = { business_date: string; detected: number; notified: number; median_notify_seconds: number | null; max_notify_seconds: number | null };
export type DeliveryRow = { key: string | null } & Record<(typeof DELIVERY_COLS)[number], number>;
export type ReleaseRow = { key: string | null } & Record<(typeof RELEASE_COLS)[number], number>;
export type InterfaceMessageRow = { instrument_id: string; centre_id: string } & Record<(typeof MESSAGE_COLS)[number], number>;

export async function resultsRows(
  tx: RollupsTx,
  a: Base & { readonly groupBy: keyof typeof RESULT_KEYS; readonly departmentIds?: readonly string[] | undefined; readonly processingBranchIds?: readonly string[] | undefined },
): Promise<ResultsRow[]> {
  const key = keyOf(RESULT_KEYS, a.groupBy);
  const extra = { sql: '', values: [] as unknown[] };
  if (a.departmentIds?.length) { extra.values.push([...a.departmentIds]); extra.sql += ` AND department_id = ANY ($${5 + extra.values.length})`; }
  if (a.processingBranchIds?.length) { extra.values.push([...a.processingBranchIds]); extra.sql += ` AND processing_branch_id = ANY ($${5 + extra.values.length})`; }
  const rows = await read(tx, a, 'analytics.daily_results', key, keySel(key), sumCols(RESULT_COLS), extra);
  return rows.map((r) => ({ key: nullable(r.key), ...ints(r, RESULT_COLS) }));
}

export async function rejectionRows(tx: RollupsTx, a: Base & { readonly groupBy: keyof typeof REJECTION_KEYS }): Promise<RejectionRow[]> {
  const key = keyOf(REJECTION_KEYS, a.groupBy);
  const rows = await read(tx, a, 'analytics.daily_rejections', key, keySel(key), sumCols(['rejections', 'recollections_ordered']));
  return rows.map((r) => ({ key: nullable(r.key), ...ints(r, ['rejections', 'recollections_ordered'] as const) }));
}

/** Received specimens (aliquots are excluded upstream). */
export async function specimenRows(tx: RollupsTx, a: Base & { readonly groupBy: keyof typeof SPECIMEN_KEYS }): Promise<SpecimenRow[]> {
  const key = keyOf(SPECIMEN_KEYS, a.groupBy);
  const rows = await read(tx, a, 'analytics.daily_specimens', key, keySel(key), sumCols(['received']));
  return rows.map((r) => ({ key: nullable(r.key), received: int(r.received, 'received') }));
}

/** One row per business date. The median is not additive: only a day backed by a single source row keeps it. */
export async function criticalValueRows(tx: RollupsTx, a: Base): Promise<CriticalValueRow[]> {
  const rows = await read(tx, a, 'analytics.daily_critical_values', 'business_date', 'business_date::text AS business_date',
    `${sumCols(['detected', 'notified'])}, (CASE WHEN count(*) = 1 THEN max(median_notify_seconds) END)::bigint AS median_notify_seconds, max(max_notify_seconds)::bigint AS max_notify_seconds`);
  return rows.map((r) => ({
    business_date: String(r.business_date), ...ints(r, ['detected', 'notified'] as const),
    median_notify_seconds: nint(r.median_notify_seconds, 'median_notify_seconds'), max_notify_seconds: nint(r.max_notify_seconds, 'max_notify_seconds'),
  }));
}

export async function deliveryRows(tx: RollupsTx, a: Base & { readonly groupBy: keyof typeof DELIVERY_KEYS }): Promise<DeliveryRow[]> {
  const key = keyOf(DELIVERY_KEYS, a.groupBy);
  const rows = await read(tx, a, 'analytics.daily_deliveries', key, keySel(key), sumCols(DELIVERY_COLS));
  return rows.map((r) => ({ key: nullable(r.key), ...ints(r, DELIVERY_COLS) }));
}

/** released = every published version (addenda included); amended = report_kind 'amended' only; overrides = release_basis 'override'. */
export async function releaseRows(tx: RollupsTx, a: Base & { readonly groupBy: keyof typeof RELEASE_KEYS }): Promise<ReleaseRow[]> {
  const key = keyOf(RELEASE_KEYS, a.groupBy);
  const kind = (k: string) => `coalesce(sum(released) FILTER (WHERE report_kind = '${k}'), 0)::bigint AS ${k}`;
  const measures = ['sum(released)::bigint AS released', kind('final'), kind('partial'), kind('preliminary'), kind('amended'),
    "coalesce(sum(released) FILTER (WHERE release_basis = 'override'), 0)::bigint AS overrides"].join(', ');
  const rows = await read(tx, a, 'analytics.daily_releases', key, keySel(key), measures);
  return rows.map((r) => ({ key: nullable(r.key), ...ints(r, RELEASE_COLS) }));
}

export async function interfaceMessageRows(tx: RollupsTx, a: Base): Promise<InterfaceMessageRow[]> {
  const rows = await read(tx, a, 'analytics.daily_interface_messages', 'instrument_id, centre_id', 'instrument_id, centre_id', sumCols(MESSAGE_COLS));
  return rows.map((r) => ({ instrument_id: String(r.instrument_id), centre_id: String(r.centre_id), ...ints(r, MESSAGE_COLS) }));
}
