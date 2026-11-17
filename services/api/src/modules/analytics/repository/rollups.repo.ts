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
export function int(v: unknown, col: string): number {
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

// ------------------------------------------------------------------ AN-T09: volume, top centres, referrer volume, collections (TRD §6.3/§6.4)
export type VolumeGroupBy = IncomeGroupBy;
export interface VolumeRow {
  key: string; orders_registered: number; orders_cancelled: number; patient_visits: number; new_patients: number;
  urgent_orders: number; opd_orders: number; ipd_orders: number; tests_ordered: number;
}
export interface TopCentreRow {
  centre_id: string; branch_id: string; orders: number; patient_visits: number; tests_ordered: number; net_sales_paisa: number;
  orders_walk_in: number; orders_home: number; orders_centre: number; orders_partner: number;
}
export interface ReferrerVolumeRow { business_date?: string | null; referrer_id: string | null; orders: number; patient_visits: number; tests_ordered: number }
export interface ReferrerBillingRow { business_date?: string | null; referrer_id: string; net_billed_paisa: number }
export type CollectionGroupBy = 'method' | 'staff' | 'staff_method' | 'centre' | 'day' | 'ad_month';
export interface CollectionRow {
  method_code?: string; staff_id?: string | null; centre_id?: string | null; period?: string;
  entries: number; reversals: number; gross_collected_paisa: number; reversed_paisa: number; net_collected_paisa: number;
}

const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const WHERE = 'WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3';

export async function volumeRows(tx: RollupsTx, a: Base & { readonly groupBy: VolumeGroupBy }): Promise<VolumeRow[]> {
  const scope = checkScope(a.scope);
  if (typeof a.groupBy !== 'string' || !Object.hasOwn(KEY_SQL, a.groupBy)) throw new TypeError('rollups: groupBy outside the allow-list');
  if (!scope.all && scope.centreIds.length === 0) return [];
  const key = KEY_SQL[a.groupBy];
  // tests_ordered = daily_centre_volume.order_items summed by the same key (TRD §6.4); FULL JOIN so neither side can drop a key.
  const sql = `WITH o AS (
  SELECT ${key}::text AS key, sum(orders_registered)::bigint AS orders_registered, sum(cancelled_orders)::bigint AS orders_cancelled,
         sum(patients_distinct)::bigint AS patient_visits, sum(new_patients)::bigint AS new_patients, sum(urgent_orders)::bigint AS urgent_orders,
         sum(opd_orders)::bigint AS opd_orders, sum(ipd_orders)::bigint AS ipd_orders
  FROM analytics.daily_orders ${WHERE} ${SCOPE_SQL} GROUP BY ${key}
), c AS (
  SELECT ${key}::text AS key, sum(order_items)::bigint AS tests_ordered
  FROM analytics.daily_centre_volume ${WHERE} ${SCOPE_SQL} GROUP BY ${key}
)
SELECT coalesce(o.key, c.key) AS key, coalesce(o.orders_registered, 0) AS orders_registered, coalesce(o.orders_cancelled, 0) AS orders_cancelled,
       coalesce(o.patient_visits, 0) AS patient_visits, coalesce(o.new_patients, 0) AS new_patients, coalesce(o.urgent_orders, 0) AS urgent_orders,
       coalesce(o.opd_orders, 0) AS opd_orders, coalesce(o.ipd_orders, 0) AS ipd_orders, coalesce(c.tests_ordered, 0) AS tests_ordered
FROM o FULL JOIN c ON o.key = c.key ORDER BY 1`;
  const { rows } = await tx.query(sql, [a.tenantId, a.from, a.to, scope.all, [...scope.centreIds]]);
  return rows.map((r) => ({
    key: String(r.key), orders_registered: int(r.orders_registered, 'orders_registered'), orders_cancelled: int(r.orders_cancelled, 'orders_cancelled'),
    patient_visits: int(r.patient_visits, 'patient_visits'), new_patients: int(r.new_patients, 'new_patients'), urgent_orders: int(r.urgent_orders, 'urgent_orders'),
    opd_orders: int(r.opd_orders, 'opd_orders'), ipd_orders: int(r.ipd_orders, 'ipd_orders'), tests_ordered: int(r.tests_ordered, 'tests_ordered'),
  }));
}

export async function topCentresRows(tx: RollupsTx, a: Base): Promise<TopCentreRow[]> {
  const scope = checkScope(a.scope);
  if (!scope.all && scope.centreIds.length === 0) return [];
  const mode = (m: string) => `coalesce(sum(orders) FILTER (WHERE collection_mode = '${m}'), 0)::bigint AS orders_${m}`; // constants only
  const sql = `WITH v AS (
  SELECT centre_id, (array_agg(branch_id ORDER BY business_date DESC))[1] AS branch_id,
         sum(orders)::bigint AS orders, sum(patients_distinct)::bigint AS patient_visits, sum(order_items)::bigint AS tests_ordered,
         ${['walk_in', 'home', 'centre', 'partner'].map(mode).join(', ')}
  FROM analytics.daily_centre_volume ${WHERE} ${SCOPE_SQL} GROUP BY centre_id
), n AS (
  SELECT centre_id, (sum(net_paisa) - sum(credit_notes_paisa))::bigint AS net_sales_paisa
  FROM analytics.daily_income ${WHERE} ${SCOPE_SQL} GROUP BY centre_id
)
SELECT v.centre_id::text AS centre_id, v.branch_id::text AS branch_id, v.orders, v.patient_visits, v.tests_ordered,
       coalesce(n.net_sales_paisa, 0)::bigint AS net_sales_paisa, v.orders_walk_in, v.orders_home, v.orders_centre, v.orders_partner
FROM v LEFT JOIN n ON n.centre_id = v.centre_id ORDER BY v.centre_id`;
  const { rows } = await tx.query(sql, [a.tenantId, a.from, a.to, scope.all, [...scope.centreIds]]);
  return rows.map((r) => ({
    centre_id: String(r.centre_id), branch_id: String(r.branch_id), orders: int(r.orders, 'orders'), patient_visits: int(r.patient_visits, 'patient_visits'),
    tests_ordered: int(r.tests_ordered, 'tests_ordered'), net_sales_paisa: int(r.net_sales_paisa, 'net_sales_paisa'),
    orders_walk_in: int(r.orders_walk_in, 'orders_walk_in'), orders_home: int(r.orders_home, 'orders_home'),
    orders_centre: int(r.orders_centre, 'orders_centre'), orders_partner: int(r.orders_partner, 'orders_partner'),
  }));
}

/** Volume only (D-44): reads daily_referrer_volume and nothing else. Grouped by the RAW referrer id; the canonical merge is the service's. */
export async function referrerVolumeRows(tx: RollupsTx, a: Base & { readonly grain?: DepartmentGrain }): Promise<ReferrerVolumeRow[]> {
  const scope = checkScope(a.scope);
  if (!scope.all && scope.centreIds.length === 0) return [];
  const day = a.grain === 'day'; // AN-T10: per-day rows for the *_month group_bys (the service groups months, incl. B.S.)
  const sql = `SELECT ${day ? 'business_date::text AS business_date, ' : ''}referrer_id::text AS referrer_id, sum(orders)::bigint AS orders, sum(patients_distinct)::bigint AS patient_visits, sum(order_items)::bigint AS tests_ordered
FROM analytics.daily_referrer_volume ${WHERE} ${SCOPE_SQL} GROUP BY ${day ? 'business_date, ' : ''}referrer_id ORDER BY ${day ? 'business_date, ' : ''}referrer_id`;
  const { rows } = await tx.query(sql, [a.tenantId, a.from, a.to, scope.all, [...scope.centreIds]]);
  return rows.map((r) => ({
    ...(day ? { business_date: String(r.business_date) } : {}),
    referrer_id: strOrNull(r.referrer_id), orders: int(r.orders, 'orders'), patient_visits: int(r.patient_visits, 'patient_visits'), tests_ordered: int(r.tests_ordered, 'tests_ordered'),
  }));
}

/** AN-T10 (US-07.2): net billed per referrer from daily_referrer_billing ONLY (signed paisa). Raw referrer id; rows always carry a referrer (no SELF row). */
export async function referrerBillingRows(tx: RollupsTx, a: Base & { readonly grain?: DepartmentGrain }): Promise<ReferrerBillingRow[]> {
  const scope = checkScope(a.scope);
  if (!scope.all && scope.centreIds.length === 0) return [];
  const day = a.grain === 'day';
  const sql = `SELECT ${day ? 'business_date::text AS business_date, ' : ''}referrer_id::text AS referrer_id, sum(net_billed_paisa)::bigint AS net_billed_paisa
FROM analytics.daily_referrer_billing ${WHERE} AND referrer_id IS NOT NULL ${SCOPE_SQL} GROUP BY ${day ? 'business_date, ' : ''}referrer_id ORDER BY ${day ? 'business_date, ' : ''}referrer_id`;
  const { rows } = await tx.query(sql, [a.tenantId, a.from, a.to, scope.all, [...scope.centreIds]]);
  return rows.map((r) => ({
    ...(day ? { business_date: String(r.business_date) } : {}),
    referrer_id: String(r.referrer_id), net_billed_paisa: int(r.net_billed_paisa, 'net_billed_paisa'),
  }));
}

// dimension -> [select, group] SQL constants, chosen by allow-list key only
const COLL_DIMS: Readonly<Record<string, readonly [string, string]>> = {
  method: ['payment_method_code AS method_code', 'payment_method_code'],
  staff: ['collected_by_membership_id::text AS staff_id', 'collected_by_membership_id'],
  centre: ['centre_id::text AS centre_id', 'centre_id'],
  day: ['business_date::text AS period', 'business_date'],
  ad_month: ["date_trunc('month', business_date)::date::text AS period", "date_trunc('month', business_date)"],
};
const COLL_GROUPS: Readonly<Record<CollectionGroupBy, readonly string[]>> = {
  method: ['method'], staff: ['staff'], staff_method: ['staff', 'method'], centre: ['centre'], day: ['day'], ad_month: ['ad_month'],
};

export async function collectionRows(
  tx: RollupsTx,
  a: Base & { readonly groupBy: CollectionGroupBy; readonly paymentMethodCodes?: readonly string[] | undefined },
): Promise<CollectionRow[]> {
  const scope = checkScope(a.scope);
  if (typeof a.groupBy !== 'string' || !Object.hasOwn(COLL_GROUPS, a.groupBy)) throw new TypeError('rollups: groupBy outside the allow-list');
  if (!scope.all && scope.centreIds.length === 0) return [];
  const dims = COLL_GROUPS[a.groupBy].map((d) => COLL_DIMS[d]!);
  const values: unknown[] = [a.tenantId, a.from, a.to, scope.all, [...scope.centreIds]];
  let byMethod = '';
  if (a.paymentMethodCodes?.length) { values.push([...a.paymentMethodCodes]); byMethod = ' AND payment_method_code = ANY ($6)'; }
  const group = dims.map((d) => d[1]).join(', ');
  const sql = `SELECT ${dims.map((d) => d[0]).join(', ')}, sum(entries)::bigint AS entries, sum(reversals)::bigint AS reversals,
       sum(gross_collected_paisa)::bigint AS gross_collected_paisa, sum(reversed_paisa)::bigint AS reversed_paisa, sum(net_collected_paisa)::bigint AS net_collected_paisa
FROM analytics.daily_collections ${WHERE} ${SCOPE_SQL}${byMethod}
GROUP BY ${group} ORDER BY ${group}`;
  const { rows } = await tx.query(sql, values);
  return rows.map((r) => ({
    ...('method_code' in r ? { method_code: String(r.method_code) } : {}),
    ...('staff_id' in r ? { staff_id: strOrNull(r.staff_id) } : {}),
    ...('centre_id' in r ? { centre_id: strOrNull(r.centre_id) } : {}),
    ...('period' in r ? { period: String(r.period) } : {}),
    entries: int(r.entries, 'entries'), reversals: int(r.reversals, 'reversals'),
    gross_collected_paisa: int(r.gross_collected_paisa, 'gross_collected_paisa'), reversed_paisa: int(r.reversed_paisa, 'reversed_paisa'),
    net_collected_paisa: int(r.net_collected_paisa, 'net_collected_paisa'),
  }));
}

// Filter-option sources: distinct codes seen in scope (C8 cannot read the foreign billing/lab coded sets).
async function distinctCodes(tx: RollupsTx, col: string, table: string, a: { tenantId: string; scope: RollupScope }): Promise<string[]> {
  const scope = checkScope(a.scope);
  if (!scope.all && scope.centreIds.length === 0) return [];
  const { rows } = await tx.query(
    `SELECT DISTINCT ${col} AS code FROM ${table} WHERE tenant_id = $1 AND ($2 OR (centre_id IS NOT NULL AND centre_id = ANY ($3))) ORDER BY code`,
    [a.tenantId, scope.all, [...scope.centreIds]],
  );
  return rows.map((r) => String(r.code));
}
export const paymentMethodCodes = (tx: RollupsTx, a: { tenantId: string; scope: RollupScope }) =>
  distinctCodes(tx, 'payment_method_code', 'analytics.daily_collections', a);
export const specimenTypeCodes = (tx: RollupsTx, a: { tenantId: string; scope: RollupScope }) =>
  distinctCodes(tx, 'specimen_type_code', 'analytics.daily_specimens', a);

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

// ------------------------------------------------------------------ AN-T13: backlog snapshot (TRD §6.7 "Backlog", §8.2)
export interface BacklogRow { centre_id: string; stage: 'awaiting_results' | 'ready_unreleased'; orders: number; oldest_registered_at: string | null }

/** analytics.report_backlog under the standard scope predicate; one row per (centre, stage). The snapshot follows the SCOPE, not the live RLS. */
export async function backlogRows(tx: RollupsTx, a: { readonly tenantId: string; readonly scope: RollupScope }): Promise<BacklogRow[]> {
  const scope = checkScope(a.scope);
  if (!scope.all && scope.centreIds.length === 0) return []; // empty restricted scope sees nothing
  const { rows } = await tx.query(
    `SELECT centre_id, stage, sum(orders)::bigint AS orders, min(oldest_registered_at) AS oldest_registered_at
FROM analytics.report_backlog
WHERE tenant_id = $1 AND ($2 OR (centre_id IS NOT NULL AND centre_id = ANY ($3)))
GROUP BY centre_id, stage ORDER BY centre_id, stage`,
    [a.tenantId, scope.all, [...scope.centreIds]],
  );
  return rows.map((r) => ({
    centre_id: String(r.centre_id), stage: r.stage as BacklogRow['stage'], orders: int(r.orders, 'orders'),
    oldest_registered_at: r.oldest_registered_at === null || r.oldest_registered_at === undefined ? null
      : r.oldest_registered_at instanceof Date ? r.oldest_registered_at.toISOString() : String(r.oldest_registered_at),
  }));
}
