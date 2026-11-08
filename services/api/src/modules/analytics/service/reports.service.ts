// Report methods of module analytics (02-TRD §3.2 reports.service, §5 #2/#3, §6.1/§6.2; PRD US-03.x, US-04.x; 07-SECURITY P1).
// AN-T08: income + departmentIncome. Period and scope arrive resolved (handler: resolvePeriod / resolveScope); the tenant is
// always ctx.tenantId. Money is integer paisa: every sum is checked to stay a safe integer (never rounded).
import { adToBs, formatAd, formatBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';
import { groupByBsMonth, ratioBp } from '../domain/metrics.js';
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import * as rollups from '../repository/rollups.repo.js';
import { branchLabels, centreLabels, departmentLabels, type LabelsContext } from './labels.service.js';

export interface ReportsContext extends LabelsContext {
  readonly metrics: { inc(name: string, labels?: Record<string, string>): void };
  readonly log: { warn(o: object, m?: string): void };
}

export const INCOME_GROUP_BY = ['day', 'ad_month', 'bs_month', 'branch', 'centre'] as const;
export const DEPARTMENT_GROUP_BY = ['department', 'department_ad_month', 'department_bs_month'] as const;
export type IncomeGroupBy = (typeof INCOME_GROUP_BY)[number];
export type DepartmentGroupBy = (typeof DEPARTMENT_GROUP_BY)[number];
export const MAX_DEPARTMENT_IDS = 50; // OpenAPI getDepartmentIncomeReport department_id maxItems

export const INCOME_MONEY = [
  'invoices_issued', 'invoices_cancelled', 'gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa',
  'other_tax_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'net_sales_paisa',
] as const;
export type IncomeTotals = Record<(typeof INCOME_MONEY)[number], number>;
export interface IncomeOutRow extends IncomeTotals { key: string; label: string; label_bs?: string; is_inactive?: true }

const DEPT_MONEY = ['line_count', 'gross_paisa', 'discount_paisa', 'net_paisa'] as const;
export type DepartmentTotals = Record<(typeof DEPT_MONEY)[number], number>;
export interface DepartmentOutRow extends DepartmentTotals {
  key: string; label: string; is_inactive?: true; department_id?: string; is_multiple: boolean; period_key?: string; share_bp: number;
}

const FILTER_MSG = [{ path: 'group_by', code: 'common.field_invalid', message: 'Field invalid' }];
/** Allow-list check: the value picks an SQL fragment / grouping only through this list (07 injection; abuse case 1). */
export function checkGroupBy<T extends string>(allowed: readonly T[], v: unknown, dflt: T): T {
  if (v === undefined) return dflt;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new LimsError('common.validation_failed', 'Invalid group_by', FILTER_MSG);
  return v as T;
}

function sumOf<K extends string>(rows: readonly Record<K, number>[], keys: readonly K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const r of rows) {
    for (const k of keys) {
      out[k] += r[k];
      if (!Number.isSafeInteger(out[k])) throw new RangeError(`reports: ${k} total is not a safe integer`); // refused, never rounded
    }
  }
  return out;
}
const bsMonthOf = (d: string): string => formatBs(adToBs(d as IsoDate)).slice(0, 7);
const shortId = (id: string): string => id.slice(-8);

// ------------------------------------------------------------------ income (M10–M20)
export async function income(ctx: ReportsContext, a: { period: Period; scope: Scope; groupBy: IncomeGroupBy }): Promise<{ rows: IncomeOutRow[]; totals: IncomeTotals }> {
  const base = { tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, scope: a.scope };
  const raw = await rollups.incomeRows(ctx.tx, { ...base, groupBy: a.groupBy === 'bs_month' ? 'day' : a.groupBy });
  const rows: IncomeOutRow[] = [];
  switch (a.groupBy) {
    case 'day':
      for (const r of raw) {
        const bs = formatBs(adToBs(r.key as IsoDate), 'display');
        rows.push({ ...money(r), key: r.key!, label: formatAd(r.key as IsoDate), label_bs: bs });
      }
      break;
    case 'ad_month':
      for (const r of raw) { const k = r.key!.slice(0, 7); rows.push({ ...money(r), key: k, label: k }); }
      break;
    case 'bs_month':
      for (const g of groupByBsMonth(raw.map((r) => ({ businessDate: r.key as IsoDate, ...money(r) })), INCOME_MONEY)) {
        rows.push({ ...money(g), key: g.key, label: `${g.key} B.S.` });
      }
      break;
    case 'branch': {
      const names = await branchLabels(ctx);
      for (const r of raw) {
        const l = r.key === null ? undefined : names.get(r.key);
        rows.push({ ...money(r), key: r.key ?? 'none', label: l?.name ?? (r.key === null ? 'No branch' : shortId(r.key)), ...(l && !l.isActive ? { is_inactive: true as const } : {}) });
      }
      break;
    }
    case 'centre': {
      const names = await centreLabels(ctx);
      for (const r of raw) {
        const l = r.key === null ? undefined : names.get(r.key);
        // [CONV] NULL centre (credit-party invoices) is visible to all-centre readers only (scope predicate) and shown as "No centre".
        rows.push({ ...money(r), key: r.key ?? 'none', label: l?.name ?? (r.key === null ? 'No centre' : shortId(r.key)), ...(l && !l.isActive ? { is_inactive: true as const } : {}) });
      }
      break;
    }
  }
  return { rows, totals: sumOf(rows, INCOME_MONEY) };
}
const money = (r: Record<string, any>): IncomeTotals => Object.fromEntries(INCOME_MONEY.map((k) => [k, r[k] as number])) as IncomeTotals;

// ------------------------------------------------------------------ department income (M21/M22, R2)
export async function departmentIncome(
  ctx: ReportsContext,
  a: { period: Period; scope: Scope; groupBy: DepartmentGroupBy; departmentIds?: readonly string[] | undefined },
): Promise<{ rows: DepartmentOutRow[]; totals: DepartmentTotals; reconcilesWithIncome: boolean }> {
  const ids = [...new Set(a.departmentIds ?? [])];
  if (ids.length > MAX_DEPARTMENT_IDS) {
    throw new LimsError('common.validation_failed', 'Too many ids', [{ path: 'department_id', code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  const names = await departmentLabels(ctx);
  if (ids.some((id) => !names.has(id))) throw new LimsError('common.not_found'); // foreign/unknown: one shape, id never echoed (07 P1); inactive ones are valid

  const base = { tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, scope: a.scope };
  const grain = a.groupBy === 'department' ? 'total' : 'day';
  const raw = await rollups.departmentIncomeRows(ctx.tx, { ...base, departmentIds: ids, grain });

  const periodKeyOf = (d: string | null): string | undefined =>
    a.groupBy === 'department' ? undefined : a.groupBy === 'department_ad_month' ? d!.slice(0, 7) : bsMonthOf(d!);
  const cells = new Map<string, { periodKey: string | undefined; departmentId: string | null; sums: DepartmentTotals }>();
  for (const r of raw) {
    const pk = periodKeyOf(r.business_date);
    const id = `${pk ?? ''}|${r.department_id ?? ''}`;
    const cell = cells.get(id) ?? { periodKey: pk, departmentId: r.department_id, sums: sumOf([], DEPT_MONEY) };
    cells.set(id, { ...cell, sums: sumOf([cell.sums, r], DEPT_MONEY) });
  }
  const cellList = [...cells.values()];
  const totals = sumOf(cellList.map((c) => c.sums), DEPT_MONEY);

  const rows: DepartmentOutRow[] = cellList.map((c) => {
    const l = c.departmentId === null ? undefined : names.get(c.departmentId);
    const deptKey = c.departmentId ?? 'multiple';
    return {
      key: c.periodKey ? `${c.periodKey}|${deptKey}` : deptKey,
      label: c.departmentId === null ? 'Multiple departments' : (l?.name ?? `Department ${shortId(c.departmentId)}`),
      ...(l && !l.isActive ? { is_inactive: true as const } : {}),
      ...(c.departmentId === null ? {} : { department_id: c.departmentId }),
      is_multiple: c.departmentId === null,
      ...(c.periodKey ? { period_key: c.periodKey } : {}),
      ...c.sums,
      // [CONV] Bp is 0..1,000,000: a negative share or a zero total shows as 0 (the signed net_paisa carries the truth).
      share_bp: Math.min(1_000_000, Math.max(0, ratioBp(c.sums.net_paisa, totals.net_paisa) ?? 0)),
    };
  }).sort((x, y) => (x.period_key ?? '').localeCompare(y.period_key ?? '') || y.net_paisa - x.net_paisa || x.key.localeCompare(y.key));

  // R2: Σ net over ALL departments (filter ignored) == M12 of the same period and scope.
  const deptNetAll = ids.length === 0 ? totals.net_paisa
    : sumOf(await rollups.departmentIncomeRows(ctx.tx, { ...base, grain: 'total' }), ['net_paisa']).net_paisa;
  const incomeNet = sumOf(await rollups.incomeRows(ctx.tx, { ...base, groupBy: 'day' }), ['net_sales_paisa']).net_sales_paisa;
  const reconcilesWithIncome = deptNetAll === incomeNet;
  if (!reconcilesWithIncome) {
    ctx.metrics.inc('lims_analytics_reconciliation_mismatch_total', { rule: 'R2', family: 'department_income' });
    ctx.log.warn({ event: 'reconciliation_mismatch', rule: 'R2', family: 'department_income', tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, departmentNetPaisa: deptNetAll, incomeNetPaisa: incomeNet }, 'reconciliation_mismatch');
  }
  return { rows, totals, reconcilesWithIncome };
}
