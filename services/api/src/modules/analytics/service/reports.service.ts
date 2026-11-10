// Report methods of module analytics (02-TRD §3.2 reports.service, §5 #2/#3, §6.1/§6.2; PRD US-03.x, US-04.x; 07-SECURITY P1).
// AN-T08: income + departmentIncome. Period and scope arrive resolved (handler: resolvePeriod / resolveScope); the tenant is
// always ctx.tenantId. Money is integer paisa: every sum is checked to stay a safe integer (never rounded).
import { adToBs, formatAd, formatBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';
import { DELIVERY_COLS, MESSAGE_COLS, RELEASE_COLS, RESULT_COLS, TAT_SEGMENTS } from '../domain/columns.js';
import { groupByBsMonth, ratioBp } from '../domain/metrics.js';
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import * as labelsRepo from '../repository/labels.repo.js';
import * as rollups from '../repository/rollups.repo.js';
import * as sourceViews from '../repository/sourceViews.repo.js';
import * as tatRepo from '../repository/tat.repo.js';
import { MAX_FILTER_IDS } from './context.service.js';
import { branchLabels, centreLabels, departmentLabels, instrumentLabels, referrerLabels, staffLabels, testLabels, type LabelsContext } from './labels.service.js';

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

export const invalidField = (path: string): LimsError =>
  new LimsError('common.validation_failed', `Invalid ${path}`, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
/** Allow-list check: the value picks an SQL fragment / grouping / sort only through this list (07 injection; abuse case 1). */
export function checkGroupBy<T extends string>(allowed: readonly T[], v: unknown, dflt: T, path = 'group_by'): T {
  if (v === undefined) return dflt;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw invalidField(path);
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

// ------------------------------------------------------------------ AN-T09: volume (M01–M08), top centres (M35–M38), top referrers (M30–M32), collections (M25–M29)
export const VOLUME_GROUP_BY = INCOME_GROUP_BY;
export const COLLECTIONS_GROUP_BY = ['method', 'staff', 'staff_method', 'centre', 'day', 'ad_month', 'bs_month'] as const;
export type CollectionsGroupBy = (typeof COLLECTIONS_GROUP_BY)[number];
export const TOP_CENTRES_SORT = ['-orders', '-net_sales_paisa', '-patient_visits', '-tests_ordered'] as const;
export const TOP_REFERRERS_SORT = ['-orders', '-patient_visits', '-tests_ordered'] as const;
export const MAX_PAYMENT_METHOD_CODES = 20;
export const MAX_REFERRER_IDS = 20;

const VOLUME_BASE = ['orders_registered', 'orders_cancelled', 'patient_visits', 'new_patients', 'urgent_orders', 'opd_orders', 'ipd_orders', 'tests_ordered'] as const;
export const VOLUME_MONEY = ['orders_registered', 'orders_cancelled', 'net_orders', 'patient_visits', 'new_patients', 'urgent_orders', 'opd_orders', 'ipd_orders', 'tests_ordered'] as const;
export type VolumeTotals = Record<(typeof VOLUME_MONEY)[number], number>;
export interface VolumeOutRow extends VolumeTotals { key: string; label: string; label_bs?: string; is_inactive?: true }
const withNet = (r: Record<(typeof VOLUME_BASE)[number], number>): VolumeTotals => ({ ...r, net_orders: r.orders_registered - r.orders_cancelled }); // M03, never clamped
const pickBase = (r: Record<string, any>) => Object.fromEntries(VOLUME_BASE.map((k) => [k, r[k]])) as Record<(typeof VOLUME_BASE)[number], number>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Integer query value in [min, max]; numeric strings accepted (query strings), anything else -> 400. */
export function checkInt(v: unknown, path: string, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  const n = typeof v === 'string' && /^-?[0-9]{1,6}$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw invalidField(path);
  return n;
}
export function checkUuidList(v: unknown, path: string, max: number): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !UUID.test(x))) throw invalidField(path);
  return v as string[];
}
export function checkCodeList(v: unknown, path: string, max: number): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x.length < 1 || x.length > 100)) throw invalidField(path);
  return v as string[];
}

const labelOf = (names: Map<string, { name: string; isActive: boolean }>, id: string | null, none: string) => {
  const l = id === null ? undefined : names.get(id);
  return { label: l?.name ?? (id === null ? none : shortId(id)), ...(l && !l.isActive ? { is_inactive: true as const } : {}) };
};

export async function volume(ctx: ReportsContext, a: { period: Period; scope: Scope; groupBy: IncomeGroupBy }): Promise<{ rows: VolumeOutRow[]; totals: VolumeTotals }> {
  const raw = await rollups.volumeRows(ctx.tx, { tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, scope: a.scope, groupBy: a.groupBy === 'bs_month' ? 'day' : a.groupBy });
  const rows: VolumeOutRow[] = [];
  switch (a.groupBy) {
    case 'day':
      for (const r of raw) rows.push({ ...withNet(pickBase(r)), key: r.key, label: formatAd(r.key as IsoDate), label_bs: formatBs(adToBs(r.key as IsoDate), 'display') });
      break;
    case 'ad_month':
      for (const r of raw) { const k = r.key.slice(0, 7); rows.push({ ...withNet(pickBase(r)), key: k, label: k }); }
      break;
    case 'bs_month':
      for (const g of groupByBsMonth(raw.map((r) => ({ businessDate: r.key as IsoDate, ...pickBase(r) })), VOLUME_BASE)) {
        rows.push({ ...withNet(pickBase(g)), key: g.key, label: `${g.key} B.S.` });
      }
      break;
    case 'branch': {
      const names = await branchLabels(ctx);
      for (const r of raw) rows.push({ ...withNet(pickBase(r)), key: r.key, ...labelOf(names, r.key, 'No branch') });
      break;
    }
    case 'centre': {
      const names = await centreLabels(ctx);
      for (const r of raw) rows.push({ ...withNet(pickBase(r)), key: r.key, ...labelOf(names, r.key, 'No centre') });
      break;
    }
  }
  return { rows, totals: sumOf(rows, VOLUME_MONEY) };
}

// ------------------------------------------------------------------ top centres
export interface TopCentreOutRow {
  rank: number; centre_id: string; label: string; branch_id: string; orders: number; patient_visits: number; tests_ordered: number; net_sales_paisa: number;
  by_mode: { walk_in: number; home: number; centre: number; partner: number };
}
const TC_TOTALS = ['orders', 'patient_visits', 'tests_ordered', 'net_sales_paisa'] as const;

export async function topCentres(
  ctx: ReportsContext, a: { period: Period; scope: Scope; sort: (typeof TOP_CENTRES_SORT)[number]; limit: number },
): Promise<{ rows: TopCentreOutRow[]; totals: Record<(typeof TC_TOTALS)[number], number> }> {
  const raw = await rollups.topCentresRows(ctx.tx, { tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, scope: a.scope });
  const names = await centreLabels(ctx);
  const field = a.sort.slice(1) as (typeof TC_TOTALS)[number];
  const all = raw.map((r) => ({
    centre_id: r.centre_id, label: names.get(r.centre_id)?.name ?? shortId(r.centre_id), branch_id: r.branch_id, orders: r.orders, patient_visits: r.patient_visits,
    tests_ordered: r.tests_ordered, net_sales_paisa: r.net_sales_paisa,
    by_mode: { walk_in: r.orders_walk_in, home: r.orders_home, centre: r.orders_centre, partner: r.orders_partner },
  })).sort((x, y) => y[field] - x[field] || x.label.localeCompare(y.label) || x.centre_id.localeCompare(y.centre_id));
  // [CONV] totals cover every centre in scope, not only the truncated top-N; rank is within the caller's scope (no hidden centre is ranked).
  return { rows: all.slice(0, a.limit).map((r, i) => ({ rank: i + 1, ...r })), totals: sumOf(all, TC_TOTALS) };
}

// ------------------------------------------------------------------ top referrers (volume only, D-44)
export interface TopReferrerOutRow { rank: number; referrer_id?: string; label: string; is_self: boolean; is_inactive: boolean; orders: number; patient_visits: number; tests_ordered: number }
const REF_TOTALS = ['orders', 'patient_visits', 'tests_ordered'] as const;

export async function topReferrers(
  ctx: ReportsContext,
  a: { period: Period; scope: Scope; sort: (typeof TOP_REFERRERS_SORT)[number]; limit: number; rollup: 'canonical' | 'none'; referrerIds: readonly string[] },
): Promise<{ rows: TopReferrerOutRow[]; totals: Record<(typeof REF_TOTALS)[number], number> }> {
  const raw = await rollups.referrerVolumeRows(ctx.tx, { tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, scope: a.scope });
  const rawIds = [...new Set(raw.flatMap((r) => (r.referrer_id ? [r.referrer_id] : [])))];
  let names = await referrerLabels(ctx, rawIds);
  const canonOf = (id: string) => (a.rollup === 'canonical' ? (names.get(id)?.canonicalId ?? id) : id);
  const missing = [...new Set(rawIds.map(canonOf))].filter((id) => !names.has(id)); // canonical target with no volume of its own
  if (missing.length) names = new Map([...names, ...(await referrerLabels(ctx, missing))]);

  const groups = new Map<string, { id: string | null; orders: number; patient_visits: number; tests_ordered: number }>();
  for (const r of raw) {
    const id = r.referrer_id === null ? null : canonOf(r.referrer_id);
    const g = groups.get(id ?? '') ?? { id, orders: 0, patient_visits: 0, tests_ordered: 0 };
    groups.set(id ?? '', { id, ...sumOf([g, r], REF_TOTALS) });
  }
  const wanted = new Set(a.referrerIds); // canonical id under rollup=canonical, raw id under none; SELF never matches a filter
  const rows = [...groups.values()].filter((g) => wanted.size === 0 || (g.id !== null && wanted.has(g.id))).map((g) => {
    const l = g.id === null ? undefined : names.get(g.id);
    return {
      ...(g.id === null ? {} : { referrer_id: g.id }), label: g.id === null ? 'SELF' : (l?.displayName ?? shortId(g.id)),
      is_self: g.id === null, is_inactive: l ? !l.isActive : false, orders: g.orders, patient_visits: g.patient_visits, tests_ordered: g.tests_ordered,
    };
  });
  const field = a.sort.slice(1) as (typeof REF_TOTALS)[number];
  rows.sort((x, y) => y[field] - x[field] || x.label.localeCompare(y.label) || (x.referrer_id ?? '').localeCompare(y.referrer_id ?? ''));
  return { rows: rows.slice(0, a.limit).map((r, i) => ({ rank: i + 1, ...r })), totals: sumOf(rows, REF_TOTALS) }; // [CONV] totals before limit
}

export async function searchReferrers(ctx: ReportsContext, query: unknown): Promise<{ referrer_id: string; label: string; is_active: boolean }[]> {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < 2 || q.length > 60) throw invalidField('query');
  const rows = await labelsRepo.searchReferrers(ctx.tx, { tenantId: ctx.tenantId, query: q, limit: 20 });
  return rows.slice(0, 20).map((r) => ({ referrer_id: r.referrer_id, label: r.display_name, is_active: r.is_active }));
}

// ------------------------------------------------------------------ collections
const COLL_MONEY = ['entries', 'reversals', 'gross_collected_paisa', 'reversed_paisa', 'net_collected_paisa'] as const;
export type CollectionsTotals = Record<(typeof COLL_MONEY)[number], number>;
export interface CollectionsOutRow extends CollectionsTotals { key: string; label: string; label_bs?: string; is_inactive?: true }
const GATEWAY = { key: 'gateway', label: 'Online gateway' } as const;

export async function collections(
  ctx: ReportsContext, a: { period: Period; scope: Scope; groupBy: CollectionsGroupBy; paymentMethodCodes: readonly string[] },
): Promise<{ rows: CollectionsOutRow[]; totals: CollectionsTotals }> {
  const raw = await rollups.collectionRows(ctx.tx, {
    tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, scope: a.scope, groupBy: a.groupBy === 'bs_month' ? 'day' : a.groupBy, paymentMethodCodes: a.paymentMethodCodes,
  });
  const m = (r: Record<string, any>): CollectionsTotals => Object.fromEntries(COLL_MONEY.map((k) => [k, r[k]])) as CollectionsTotals;
  const staffIds = [...new Set(raw.flatMap((r) => (r.staff_id ? [r.staff_id] : [])))];
  const staff = a.groupBy === 'staff' || a.groupBy === 'staff_method' ? await staffLabels(ctx, staffIds) : new Map<string, { displayName: string; isActive: boolean }>();
  const staffPart = (id: string | null | undefined) => {
    if (!id) return { key: GATEWAY.key as string, label: GATEWAY.label as string };
    const s = staff.get(id);
    return { key: id, label: s?.displayName ?? shortId(id), ...(s && !s.isActive ? { is_inactive: true as const } : {}) };
  };
  const rows: CollectionsOutRow[] = [];
  switch (a.groupBy) {
    case 'method':
      for (const r of raw) rows.push({ ...m(r), key: r.method_code!, label: r.method_code! }); // [CONV] no message-catalog entry yet: label = code
      break;
    case 'staff':
      for (const r of raw) rows.push({ ...m(r), ...staffPart(r.staff_id) });
      break;
    case 'staff_method':
      for (const r of raw) { const s = staffPart(r.staff_id); rows.push({ ...m(r), ...s, key: `${s.key}|${r.method_code}`, label: `${s.label} · ${r.method_code}` }); }
      break;
    case 'centre': {
      const names = await centreLabels(ctx);
      for (const r of raw) rows.push({ ...m(r), key: r.centre_id ?? 'none', ...labelOf(names, r.centre_id ?? null, 'No centre') });
      break;
    }
    case 'day':
      for (const r of raw) rows.push({ ...m(r), key: r.period!, label: formatAd(r.period as IsoDate), label_bs: formatBs(adToBs(r.period as IsoDate), 'display') });
      break;
    case 'ad_month':
      for (const r of raw) { const k = r.period!.slice(0, 7); rows.push({ ...m(r), key: k, label: k }); }
      break;
    case 'bs_month':
      for (const g of groupByBsMonth(raw.map((r) => ({ businessDate: r.period as IsoDate, ...m(r) })), COLL_MONEY)) rows.push({ ...m(g), key: g.key, label: `${g.key} B.S.` });
      break;
  }
  return { rows, totals: sumOf(rows, COLL_MONEY) };
}

// ------------------------------------------------------------------ filter options (#16, #30)
/** Centres, branches and payment methods the caller may see: only own-scope centres, their branches, codes seen in scope (P4/P5). */
export async function scopedOptions(ctx: ReportsContext, scope: Scope) {
  const centres = (await ctx.core.centres(ctx as never, { activeOnly: false })).filter((c) => scope.all || scope.centreIds.includes(c.id));
  const branchIds = new Set(centres.map((c) => c.branchId));
  const branches = (await ctx.core.branches(ctx as never, { activeOnly: false })).filter((b) => scope.all || branchIds.has(b.id));
  const codes = await rollups.paymentMethodCodes(ctx.tx, { tenantId: ctx.tenantId, scope });
  const byLabel = (x: { label: string; id: string }, y: { label: string; id: string }) => x.label.localeCompare(y.label) || x.id.localeCompare(y.id);
  return {
    centres: centres.map((c) => ({ id: c.id, label: c.name, branch_id: c.branchId, is_active: c.isActive })).sort(byLabel),
    branches: branches.map((b) => ({ id: b.id, label: b.name, is_active: b.isActive })).sort(byLabel),
    payment_methods: codes.map((code) => ({ code, display: code })), // [CONV] display = code until the message catalog has payment-method names
  };
}

export async function analyticsOptions(ctx: ReportsContext, scope: Scope) {
  const base = await scopedOptions(ctx, scope);
  const depts = await departmentLabels(ctx);
  return {
    ...base,
    departments: [...depts].map(([id, d]) => ({ id, label: d.name, is_active: d.isActive })).sort((x, y) => x.label.localeCompare(y.label) || x.id.localeCompare(y.id)),
    specimen_types: (await rollups.specimenTypeCodes(ctx.tx, { tenantId: ctx.tenantId, scope })).map((code) => ({ code })),
  };
}

// recipients (D-47): active memberships holding dashboard.read; memoised per request (= per ctx), failures not memoised.
const recipientsMemo = new WeakMap<object, Promise<{ membership_id: string; display_name: string }[]>>();
export function recipients(ctx: ReportsContext) {
  let p = recipientsMemo.get(ctx);
  if (!p) {
    const mine = (p = ctx.core.memberships.list(ctx as never, { permission: 'analytics.dashboard.read', activeOnly: true })
      .then((rows) => rows.slice(0, 200).map((r) => ({ membership_id: r.membershipId, display_name: r.displayName })))); // explicit pick: no roles/scope leak
    recipientsMemo.set(ctx, mine);
    mine.catch(() => { if (recipientsMemo.get(ctx) === mine) recipientsMemo.delete(ctx); });
  }
  return p;
}

// ------------------------------------------------------------------ AN-T11: tests done, quality indicators, delivery, interfaces (M40–M47, M70–M78, M80–M87, M90–M91)
export const TESTS_DONE_GROUP_BY = ['department', 'test', 'processing_branch', 'day', 'ad_month', 'bs_month'] as const;
export const QUALITY_GROUP_BY = ['reason', 'centre', 'specimen_type', 'day', 'ad_month', 'bs_month'] as const;
export const DELIVERY_GROUP_BY = ['channel', 'day', 'ad_month', 'bs_month'] as const;
type Base = { tenantId: string; from: string; to: string; scope: Scope };
const baseOf = (ctx: ReportsContext, a: { period: Period; scope: Scope }): Base => ({ tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, scope: a.scope });

// [CONV] Bp is 0..1,000,000; a zero denominator shows 0 (the contract has no null Bp).
const bpOf = (n: number, d: number): number => Math.min(1_000_000, Math.max(0, ratioBp(n, d) ?? 0));
/** bs_month is grouped here from days (as income); everything else is grouped by the repo. */
const repoTime = <G extends string>(g: G): Exclude<G, 'bs_month'> | 'day' => (g === 'bs_month' ? 'day' : g) as Exclude<G, 'bs_month'> | 'day';

interface Head { key: string; label: string; label_bs?: string; is_inactive?: true }
type Keyed = { key: string | null };
const named = (key: string, name: string | undefined, prefix: string, active?: boolean): Head =>
  ({ key, label: (name ?? `${prefix} ${shortId(key)}`).slice(0, 200), ...(name !== undefined && active === false ? { is_inactive: true as const } : {}) });

function idList(ids: unknown, path: string, max: number): string[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > max) throw new LimsError('common.validation_failed', 'Too many ids', [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
  return [...new Set(ids as string[])];
}

/** Row header (key, label, label_bs, is_inactive) for one group_by; labels come from catalog/core views only. */
async function headOf(ctx: ReportsContext, g: string, keys: readonly (string | null)[]): Promise<(k: string | null) => Head> {
  switch (g) {
    case 'day': return (k) => ({ key: k!, label: formatAd(k as IsoDate), label_bs: formatBs(adToBs(k as IsoDate), 'display') });
    case 'ad_month': return (k) => ({ key: k!.slice(0, 7), label: k!.slice(0, 7) });
    case 'bs_month': return (k) => ({ key: k!, label: `${k} B.S.` });
    case 'department': { const m = await departmentLabels(ctx); return (k) => (k === null ? { key: 'none', label: 'No department' } : named(k, m.get(k)?.name, 'Department', m.get(k)?.isActive)); }
    case 'test': {
      const m = await testLabels(ctx, keys.filter((k): k is string => k !== null));
      return (k) => (k === null ? { key: 'none', label: 'No test' } : named(k, m.get(k)?.name, 'Test', m.get(k)?.isActive));
    }
    case 'processing_branch': { const m = await branchLabels(ctx); return (k) => (k === null ? { key: 'none', label: 'No branch' } : named(k, m.get(k)?.name, 'Branch', m.get(k)?.isActive)); }
    case 'centre': { const m = await centreLabels(ctx); return (k) => (k === null ? { key: 'none', label: 'No centre' } : named(k, m.get(k)?.name, 'Centre', m.get(k)?.isActive)); }
    case 'reason': return (k) => (k === null ? { key: 'unspecified', label: 'Unspecified' } : { key: k.slice(0, 64), label: k.slice(0, 200) });
    default: return (k) => (k === null ? { key: 'total', label: 'Total' } : { key: k.slice(0, 64), label: k.slice(0, 200) }); // specimen_type, channel codes as-is; 'total'
  }
}

/** Repo rows -> labelled rows carrying exactly `fields`. */
async function rowsOf<F extends string>(ctx: ReportsContext, g: string, raw: readonly (Keyed & Record<F, number>)[], fields: readonly F[]): Promise<Array<Head & Record<F, number>>> {
  const only = (r: Record<F, number>): Record<F, number> => Object.fromEntries(fields.map((f) => [f, r[f]])) as unknown as Record<F, number>;
  const rows: Array<Keyed & Record<F, number>> = g === 'bs_month'
    ? groupByBsMonth(raw.map((r) => ({ businessDate: r.key as IsoDate, ...only(r) })), fields)
    : [...raw];
  const head = await headOf(ctx, g, rows.map((r) => r.key));
  return rows.map((r) => ({ ...head(r.key), ...only(r) }));
}

// ---- tests done (M40–M47; CR-C8-004: scoped on daily_results.centre_id)
type Measure<C extends readonly string[]> = Record<C[number], number>;
export type TestsDoneTotals = Measure<typeof RESULT_COLS>;
export type TestsDoneRow = Head & TestsDoneTotals;

export async function testsDone(
  ctx: ReportsContext,
  a: { period: Period; scope: Scope; groupBy: (typeof TESTS_DONE_GROUP_BY)[number]; departmentIds?: unknown; processingBranchIds?: unknown },
): Promise<{ rows: TestsDoneRow[]; totals: TestsDoneTotals }> {
  const departmentIds = idList(a.departmentIds, 'department_id', MAX_DEPARTMENT_IDS);
  const branchIds = idList(a.processingBranchIds, 'processing_branch_id', MAX_FILTER_IDS);
  if (departmentIds.length) {
    const known = await departmentLabels(ctx);
    if (departmentIds.some((id) => !known.has(id))) throw new LimsError('common.not_found'); // foreign/unknown: one shape, id never echoed (07 P1)
  }
  if (branchIds.length) {
    const known = await branchLabels(ctx);
    if (branchIds.some((id) => !known.has(id))) throw new LimsError('common.not_found');
  }
  const raw = await rollups.resultsRows(ctx.tx, { ...baseOf(ctx, a), groupBy: repoTime(a.groupBy), departmentIds, processingBranchIds: branchIds });
  const rows = await rowsOf(ctx, a.groupBy, raw, RESULT_COLS);
  return { rows, totals: sumOf(rows, RESULT_COLS) };
}

// ---- quality indicators (M70–M73 rejections, M75–M78 critical values; CR-C8-004)
const REJECTION_COLS = ['rejections', 'recollections_ordered'] as const;
export interface RejectionOutRow extends Head { rejections: number; recollections_ordered: number; specimens_received: number; per_100_received_bp: number }
export interface CriticalValueOutRow { business_date: string; detected: number; notified: number; notified_bp: number; median_notify_seconds?: number; max_notify_seconds?: number }
export interface QualityOut {
  rejections: { rows: RejectionOutRow[]; totals: { rejections: number; recollections_ordered: number; specimens_received: number; per_100_received_bp: number } };
  criticalValues: { rows: CriticalValueOutRow[]; totals: { detected: number; notified: number; notified_bp: number; max_notify_seconds?: number } };
}

export async function qualityIndicators(ctx: ReportsContext, a: { period: Period; scope: Scope; groupBy: (typeof QUALITY_GROUP_BY)[number] }): Promise<QualityOut> {
  const base = baseOf(ctx, a);
  const g = a.groupBy;
  const rejRaw = await rollups.rejectionRows(ctx.tx, { ...base, groupBy: repoTime(g) });
  const spcRaw = await rollups.specimenRows(ctx.tx, { ...base, groupBy: g === 'reason' ? 'total' : repoTime(g) });
  const rejRows = await rowsOf(ctx, g, rejRaw, REJECTION_COLS);
  const spcRows = g === 'reason' ? [] : await rowsOf(ctx, g, spcRaw, ['received'] as const);
  const received = sumOf(spcRaw, ['received']).received;

  // Numerator and denominator share one key space; a key with specimens but no rejection shows 0 (period denominator for reason rows).
  const byKey = new Map<string, RejectionOutRow>();
  const blank = (h: Head): RejectionOutRow => ({ key: h.key, label: h.label, ...(h.label_bs ? { label_bs: h.label_bs } : {}), ...(h.is_inactive ? { is_inactive: true as const } : {}),
    rejections: 0, recollections_ordered: 0, specimens_received: g === 'reason' ? received : 0, per_100_received_bp: 0 });
  for (const r of rejRows) byKey.set(r.key, { ...blank(r), rejections: r.rejections, recollections_ordered: r.recollections_ordered });
  for (const s of spcRows) byKey.set(s.key, { ...(byKey.get(s.key) ?? blank(s)), specimens_received: s.received });
  const timeGroup = g === 'day' || g === 'ad_month' || g === 'bs_month';
  const rows = [...byKey.values()].map((r) => ({ ...r, per_100_received_bp: bpOf(r.rejections, r.specimens_received) }))
    .sort((x, y) => (timeGroup ? 0 : y.rejections - x.rejections) || x.key.localeCompare(y.key));
  const rej = sumOf(rejRows, REJECTION_COLS);

  const cv = await rollups.criticalValueRows(ctx.tx, base);
  const cvRows: CriticalValueOutRow[] = cv.map((r) => ({
    business_date: r.business_date, detected: r.detected, notified: r.notified, notified_bp: bpOf(r.notified, r.detected),
    ...(r.median_notify_seconds === null ? {} : { median_notify_seconds: r.median_notify_seconds }), // medians are not additive: kept per day only
    ...(r.max_notify_seconds === null ? {} : { max_notify_seconds: r.max_notify_seconds }),
  }));
  const cvSum = sumOf(cv, ['detected', 'notified']);
  const maxes = cv.map((r) => r.max_notify_seconds).filter((m): m is number => m !== null);
  return {
    rejections: { rows, totals: { ...rej, specimens_received: received, per_100_received_bp: bpOf(rej.rejections, received) } },
    criticalValues: { rows: cvRows, totals: { ...cvSum, notified_bp: bpOf(cvSum.notified, cvSum.detected), ...(maxes.length ? { max_notify_seconds: Math.max(...maxes) } : {}) } }, // Σ, Σ, max of max
  };
}

// ---- delivery (M80, M85–M87; CR-C8-005: NULL-centre deliveries match the all-centres branch of the scope predicate only)
export type DeliveryOutRow = Head & Measure<typeof DELIVERY_COLS> & { failure_share_bp: number };
export type DeliveryTotals = Measure<typeof DELIVERY_COLS> & { failure_share_bp: number };
export type ReleaseOutRow = Head & Measure<typeof RELEASE_COLS>;
export type ReleaseTotals = Measure<typeof RELEASE_COLS>;
const failureShare = (r: Measure<typeof DELIVERY_COLS>): number => bpOf(r.failed, r.sent + r.failed + r.suppressed);

export async function delivery(ctx: ReportsContext, a: { period: Period; scope: Scope; groupBy: (typeof DELIVERY_GROUP_BY)[number] }): Promise<{
  deliveries: { rows: DeliveryOutRow[]; totals: DeliveryTotals }; releases: { rows: ReleaseOutRow[]; totals: ReleaseTotals };
}> {
  const base = baseOf(ctx, a);
  const g = a.groupBy;
  const dRaw = await rollups.deliveryRows(ctx.tx, { ...base, groupBy: repoTime(g) });
  const rRaw = await rollups.releaseRows(ctx.tx, { ...base, groupBy: g === 'channel' ? 'total' : repoTime(g) });
  const dRows = (await rowsOf(ctx, g, dRaw, DELIVERY_COLS)).map((r) => ({ ...r, failure_share_bp: failureShare(r) }));
  const rRows = await rowsOf(ctx, g === 'channel' ? 'total' : g, rRaw, RELEASE_COLS);
  const dSum = sumOf(dRows, DELIVERY_COLS);
  return {
    deliveries: { rows: dRows, totals: { ...dSum, failure_share_bp: failureShare(dSum) } },
    releases: { rows: rRows, totals: sumOf(rRows, RELEASE_COLS) },
  };
}

// ---- interfaces (M90 messages per instrument over the period, M91 agents by state — live, not period-bound)
export interface InstrumentOutRow extends Measure<typeof MESSAGE_COLS> { instrument_id: string; instrument_code?: string; label?: string; is_active?: boolean; centre_id: string }

export async function interfaces(ctx: ReportsContext, a: { period: Period; scope: Scope }): Promise<{
  instruments: InstrumentOutRow[]; agents: { by_state: { state: string; count: number }[]; agents: sourceViews.AgentStatusRow[] };
}> {
  const base = baseOf(ctx, a);
  const raw = await rollups.interfaceMessageRows(ctx.tx, base);
  const labels = await instrumentLabels(ctx, raw.map((r) => r.instrument_id));
  const instruments = raw.map((r): InstrumentOutRow => {
    const l = labels.get(r.instrument_id); // no directory row: code/label/is_active omitted (never a guess)
    return {
      instrument_id: r.instrument_id, ...(l ? { instrument_code: l.instrumentCode, label: l.label.slice(0, 200), is_active: l.isActive } : {}), centre_id: r.centre_id,
      ...(Object.fromEntries(MESSAGE_COLS.map((k) => [k, r[k]])) as Measure<typeof MESSAGE_COLS>),
    };
  });
  const agents = (await sourceViews.listAgentStatus(ctx.tx, { tenantId: ctx.tenantId, scope: a.scope })).map((x) => ({
    agent_id: x.agent_id, centre_id: x.centre_id, state: x.state, last_heartbeat_at: x.last_heartbeat_at, agent_version: x.agent_version, queue_depth: x.queue_depth,
  }));
  const counts = new Map<string, number>();
  for (const x of agents) counts.set(x.state, (counts.get(x.state) ?? 0) + 1);
  return { instruments, agents: { by_state: [...counts].sort(([x], [y]) => x.localeCompare(y)).map(([state, count]) => ({ state, count })), agents } };
}

// ------------------------------------------------------------------ AN-T12: TAT (M60–M64; TRD §6.6, PRD US-11.x)
export const TAT_GROUP_BY = ['none', 'centre', 'processing_branch', 'priority', 'specimen_type', 'day', 'ad_month', 'bs_month'] as const;
export type TatSegment = (typeof TAT_SEGMENTS)[number];
export interface TatFilters {
  segments: TatSegment[]; priority?: 'routine' | 'urgent'; specimenTypeCodes: string[]; processingBranchIds: string[];
}
export interface TatOutRow { segment: TatSegment; key?: string; label?: string; n: number; median_seconds?: number; p90_seconds?: number; max_seconds?: number; anomalies: number }

const bad = (path: string): LimsError => new LimsError('common.validation_failed', 'Invalid filter', [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/; // _common.yaml Code

/** Pure validation of the TAT filters (limits and allow-lists), run before any lookup or read. Segments come back deduplicated in canonical order. */
export function tatFilters(q: { segment?: unknown; priority?: unknown; specimen_type_code?: unknown; processing_branch_id?: unknown }): TatFilters {
  let segments: TatSegment[] = [...TAT_SEGMENTS];
  if (q.segment !== undefined) {
    if (!Array.isArray(q.segment) || q.segment.length > TAT_SEGMENTS.length || q.segment.some((s) => !(TAT_SEGMENTS as readonly unknown[]).includes(s))) throw bad('segment');
    if (q.segment.length) segments = TAT_SEGMENTS.filter((s) => (q.segment as unknown[]).includes(s));
  }
  if (q.priority !== undefined && q.priority !== 'routine' && q.priority !== 'urgent') throw bad('priority');
  const codes = q.specimen_type_code === undefined ? [] : q.specimen_type_code;
  if (!Array.isArray(codes) || codes.length > MAX_FILTER_IDS || codes.some((c) => typeof c !== 'string' || !CODE.test(c))) throw bad('specimen_type_code');
  const branchIds = q.processing_branch_id === undefined ? [] : q.processing_branch_id;
  if (!Array.isArray(branchIds) || branchIds.length > MAX_FILTER_IDS || branchIds.some((b) => typeof b !== 'string')) throw bad('processing_branch_id');
  return {
    segments, ...(q.priority === undefined ? {} : { priority: q.priority }),
    specimenTypeCodes: [...new Set(codes as string[])], processingBranchIds: [...new Set(branchIds as string[])],
  };
}

const nextDay = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** [from, to) cut at B.S. month boundaries: a median is never merged from smaller groups, so each month is asked of the repo on its own. */
function bsMonthRanges(from: string, to: string): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = [];
  for (let d = from; d < to; d = nextDay(d)) {
    const key = bsMonthOf(d);
    const last = out.at(-1);
    if (last?.key === key) last.to = nextDay(d); else out.push({ key, from: d, to: nextDay(d) });
  }
  return out;
}

/** Half-up to whole seconds (TRD §6.6); durations are never negative here (negatives are anomalies and carry no stats). */
const wholeSeconds = (v: number | null): number | undefined => {
  if (v === null) return undefined;
  const r = Math.floor(v + 0.5);
  if (!Number.isSafeInteger(r)) throw new RangeError('tat: seconds is not a safe integer');
  return r;
};

export async function tat(ctx: ReportsContext, a: { period: Period; scope: Scope; groupBy: (typeof TAT_GROUP_BY)[number]; filters: TatFilters }): Promise<{ rows: TatOutRow[]; segments: TatSegment[] }> {
  const { filters: f, groupBy: g } = a;
  if (f.processingBranchIds.length) {
    const known = await branchLabels(ctx);
    if (f.processingBranchIds.some((id) => !known.has(id))) throw new LimsError('common.not_found'); // foreign/unknown: one shape, id never echoed (07 P1)
  }
  const base = { ...baseOf(ctx, a), segments: f.segments, priority: f.priority, specimenTypeCodes: f.specimenTypeCodes, processingBranchIds: f.processingBranchIds };
  let raw: tatRepo.TatRow[] = [];
  if (g === 'bs_month') {
    for (const r of bsMonthRanges(a.period.from, a.period.to)) {
      for (const x of await tatRepo.tatRows(ctx.tx, { ...base, from: r.from, to: r.to, groupBy: 'none' })) raw.push({ ...x, key: r.key });
    }
  } else {
    raw = await tatRepo.tatRows(ctx.tx, { ...base, groupBy: g });
  }
  if (g === 'none') { // [CONV] ungrouped: one row per requested segment, n 0 when it has no sample
    for (const s of f.segments) if (!raw.some((x) => x.segment === s)) raw.push({ segment: s, key: null, n: 0, median_seconds: null, p90_seconds: null, max_seconds: null, anomalies: 0 });
  }
  raw.sort((x, y) => TAT_SEGMENTS.indexOf(x.segment) - TAT_SEGMENTS.indexOf(y.segment)); // stable: the repo's key order is kept inside a segment

  const centres = g === 'centre' ? await centreLabels(ctx) : undefined;
  const branches = g === 'processing_branch' ? await branchLabels(ctx) : undefined;
  const head = (k: string | null): { key?: string; label?: string } => {
    switch (g) {
      case 'none': return {};
      case 'day': return { key: k!, label: formatAd(k as IsoDate) };
      case 'ad_month': return { key: k!.slice(0, 7), label: k!.slice(0, 7) };
      case 'bs_month': return { key: k!, label: `${k} B.S.` };
      case 'centre': return k === null ? { key: 'none', label: 'No centre' } : named(k, centres!.get(k)?.name, 'Centre');
      case 'processing_branch': return k === null ? { key: 'none', label: 'No branch' } : named(k, branches!.get(k)?.name, 'Branch');
      case 'priority': return k === null ? { key: 'none', label: 'No priority' } : { key: k.slice(0, 64), label: k };
      case 'specimen_type': return k === null ? { key: 'none', label: 'No specimen type' } : { key: k.slice(0, 64), label: k.slice(0, 200) };
    }
  };
  const rows = raw.filter((r) => g === 'none' || r.n > 0 || r.anomalies > 0).map((r): TatOutRow => {
    const median = wholeSeconds(r.median_seconds), p90 = wholeSeconds(r.p90_seconds), max = wholeSeconds(r.max_seconds);
    return {
      segment: r.segment, ...head(r.key), n: r.n,
      ...(median === undefined ? {} : { median_seconds: median }), ...(p90 === undefined ? {} : { p90_seconds: p90 }), ...(max === undefined ? {} : { max_seconds: max }),
      anomalies: r.anomalies,
    };
  });
  return { rows, segments: f.segments };
}
