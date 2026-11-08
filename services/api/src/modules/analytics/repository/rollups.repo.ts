// Rollup reads (02-TRD §6 intro + §6.1 income + §6.2 department income; 07-SECURITY P1, REQ-SEC-013/017).
// One bound SELECT per call: tenant `$1`, [from, to) `$2/$3`, scope `$4` (all) / `$5` (centres); nothing from input is ever
// part of the statement text — group keys and grains come from a closed allow-list. Scope is mandatory.
// bigint columns arrive from pg as strings: returned as safe integers, anything beyond 2^53 is refused (never rounded).

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

function checkScope(scope: unknown): RollupScope {
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
