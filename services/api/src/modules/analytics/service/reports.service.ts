// Report methods of module analytics (02-TRD §3.2 reports.service, §5 #2/#3, §6.1/§6.2; PRD US-03.x, US-04.x; 07-SECURITY P1).
// AN-T08: income + departmentIncome. Period and scope arrive resolved (handler: resolvePeriod / resolveScope); the tenant is
// always ctx.tenantId. Money is integer paisa: every sum is checked to stay a safe integer (never rounded).
import { adToBs, formatAd, formatBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';
import { groupByBsMonth, ratioBp } from '../domain/metrics.js';
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import * as labelsRepo from '../repository/labels.repo.js';
import * as rollups from '../repository/rollups.repo.js';
import { branchLabels, centreLabels, departmentLabels, referrerLabels, staffLabels, type LabelsContext } from './labels.service.js';

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
