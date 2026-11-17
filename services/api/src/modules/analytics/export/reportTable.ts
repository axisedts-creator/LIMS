// Report -> export table (02-TRD §10.2 step 4: "the same service functions as the API", with an EXPLICIT scope). Used by the API (request-time
// validation of params, no read) and by the worker (build). One entry per exportable report; a report without an entry is refused at request time.
// [CONV] columns = the fields of the report's API rows (the registry's exportColumns list is a wire-name hint, not binding).
import { LimsError } from '../../../core/errors.js';
import { RESULT_COLS } from '../domain/columns.js';
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import { referralIncentive, REFERRAL_GROUP_BY } from '../service/referral.service.js';
import {
  COLLECTIONS_GROUP_BY, DEPARTMENT_GROUP_BY, INCOME_GROUP_BY, INCOME_MONEY, MAX_DEPARTMENT_IDS, MAX_PAYMENT_METHOD_CODES, MAX_REFERRER_IDS, TESTS_DONE_GROUP_BY,
  VOLUME_GROUP_BY, VOLUME_MONEY, checkCodeList, checkGroupBy, checkUuidList, collections, departmentIncome, income, invalidField, testsDone, topCentres, topReferrers, volume,
  type ReportsContext,
} from '../service/reports.service.js';
import { MAX_FILTER_IDS } from '../service/context.service.js';
import type { ExportCell, ExportColumn, ExportKind } from './layout.js';

type Row = Record<string, unknown>;
interface Spec { title: string; columns: ExportColumn[]; args(params: Row): Row; run(ctx: ReportsContext, a: { period: Period; scope: Scope; now: string; args: Row }): Promise<readonly object[]> }

const T = (key: string, label: string): ExportColumn => ({ key, label, kind: 'text' });
const N = (key: string, label: string, kind: ExportKind = 'count'): ExportColumn => ({ key, label, kind });
const words = (k: string): string => { const s = k.replace(/_(paisa|bp|seconds)$/, '').replaceAll('_', ' '); return s[0]!.toUpperCase() + s.slice(1); };
const numeric = (k: string): ExportColumn => N(k, k.endsWith('_paisa') ? `${words(k)} (paisa)` : k.endsWith('_bp') ? `${words(k)} (bp)` : words(k), k.endsWith('_paisa') ? 'paisa' : k.endsWith('_bp') ? 'bp' : 'count');
const filters = (p: Row): Row => (p.filters === undefined ? {} : (p.filters as Row));
const sub = <T extends string>(allowed: readonly T[], p: Row, key: string, dflt: T): T => checkGroupBy(allowed, filters(p)[key], dflt, `filters.${key}`);

const SPECS: Readonly<Record<string, Spec>> = Object.freeze({
  income: {
    title: 'Income report', columns: [T('label', 'Label'), T('label_bs', 'B.S. date'), ...INCOME_MONEY.map(numeric)],
    args: (p) => ({ groupBy: checkGroupBy(INCOME_GROUP_BY, p.group_by, 'day') }),
    run: async (ctx, a) => (await income(ctx, { period: a.period, scope: a.scope, groupBy: a.args.groupBy as never })).rows,
  },
  department_income: {
    title: 'Department income report', columns: [T('label', 'Label'), N('line_count', 'Lines'), numeric('gross_paisa'), numeric('discount_paisa'), numeric('net_paisa'), numeric('share_bp')],
    args: (p) => ({ groupBy: checkGroupBy(DEPARTMENT_GROUP_BY, p.group_by, 'department'), departmentIds: checkUuidList(filters(p).department_id, 'filters.department_id', MAX_DEPARTMENT_IDS) }),
    run: async (ctx, a) => (await departmentIncome(ctx, { period: a.period, scope: a.scope, groupBy: a.args.groupBy as never, departmentIds: a.args.departmentIds as string[] })).rows,
  },
  collections: {
    title: 'Collections report', columns: [T('label', 'Label'), T('label_bs', 'B.S. date'), ...['entries', 'reversals', 'gross_collected_paisa', 'reversed_paisa', 'net_collected_paisa'].map(numeric)],
    args: (p) => ({ groupBy: checkGroupBy(COLLECTIONS_GROUP_BY, p.group_by, 'method'), paymentMethodCodes: checkCodeList(filters(p).payment_method_code, 'filters.payment_method_code', MAX_PAYMENT_METHOD_CODES) }),
    run: async (ctx, a) => (await collections(ctx, { period: a.period, scope: a.scope, groupBy: a.args.groupBy as never, paymentMethodCodes: a.args.paymentMethodCodes as string[] })).rows,
  },
  volume: {
    title: 'Volume report', columns: [T('label', 'Label'), T('label_bs', 'B.S. date'), ...VOLUME_MONEY.map(numeric)],
    args: (p) => ({ groupBy: checkGroupBy(VOLUME_GROUP_BY, p.group_by, 'day') }),
    run: async (ctx, a) => (await volume(ctx, { period: a.period, scope: a.scope, groupBy: a.args.groupBy as never })).rows,
  },
  top_referrers: {
    title: 'Top referrers', columns: [N('rank', 'Rank'), T('label', 'Referrer'), ...['orders', 'patient_visits', 'tests_ordered'].map(numeric)],
    args: (p) => ({ rollup: sub(['canonical', 'none'] as const, p, 'rollup', 'canonical'), referrerIds: checkUuidList(filters(p).referrer_id, 'filters.referrer_id', MAX_REFERRER_IDS) }),
    run: async (ctx, a) => (await topReferrers(ctx, { period: a.period, scope: a.scope, sort: '-orders', limit: 100, rollup: a.args.rollup as never, referrerIds: a.args.referrerIds as string[] })).rows,
  },
  top_centres: {
    title: 'Top centres', columns: [N('rank', 'Rank'), T('label', 'Centre'), ...['orders', 'patient_visits', 'tests_ordered', 'net_sales_paisa'].map(numeric)],
    args: () => ({}),
    run: async (ctx, a) => (await topCentres(ctx, { period: a.period, scope: a.scope, sort: '-orders', limit: 50 })).rows,
  },
  referral_incentive: {
    title: 'Referral business report', columns: [T('label', 'Referrer'), T('period_label', 'Period'), ...['orders', 'patient_visits', 'tests_ordered', 'net_billed_paisa'].map(numeric)],
    args: (p) => ({
      groupBy: checkGroupBy(REFERRAL_GROUP_BY, p.group_by, 'referrer'), rollup: sub(['canonical', 'none'] as const, p, 'rollup', 'canonical'),
      referrerIds: checkUuidList(filters(p).referrer_id, 'filters.referrer_id', MAX_REFERRER_IDS),
    }),
    run: async (ctx, a) => (await referralIncentive(ctx, { period: a.period, scope: a.scope, groupBy: a.args.groupBy as never, rollup: a.args.rollup as never, referrerIds: a.args.referrerIds as string[], now: a.now as never })).rows,
  },
  tests_done: {
    title: 'Tests done', columns: [T('label', 'Label'), T('label_bs', 'B.S. date'), ...RESULT_COLS.map(numeric)],
    args: (p) => ({
      groupBy: checkGroupBy(TESTS_DONE_GROUP_BY, p.group_by, 'department'), departmentIds: checkUuidList(filters(p).department_id, 'filters.department_id', MAX_DEPARTMENT_IDS),
      processingBranchIds: checkUuidList(filters(p).processing_branch_id, 'filters.processing_branch_id', MAX_FILTER_IDS),
    }),
    run: async (ctx, a) => (await testsDone(ctx, { period: a.period, scope: a.scope, groupBy: a.args.groupBy as never, departmentIds: a.args.departmentIds, processingBranchIds: a.args.processingBranchIds })).rows,
  },
});

export const isExportable = (code: string): boolean => Object.hasOwn(SPECS, code);

/** Request-time check of the report-specific params (allow-lists, limits). Throws common.validation_failed; reads nothing. */
export function checkReportParams(code: string, params: Row): void {
  const spec = SPECS[code];
  if (!spec) throw invalidField('report_code');
  spec.args(params);
}

/** Build the rows of one report with the given (already resolved) period and EXPLICIT scope. */
export async function buildReport(
  ctx: ReportsContext, code: string, params: Row, a: { period: Period; scope: Scope; now: string },
): Promise<{ title: string; columns: ExportColumn[]; rows: Record<string, ExportCell>[] }> {
  const spec = SPECS[code];
  if (!spec) throw new LimsError('analytics.report_unknown');
  const raw = await spec.run(ctx, { ...a, args: spec.args(params) });
  const rows = raw.map((r) => Object.fromEntries(spec.columns.map((c): [string, ExportCell] => {
    const v = (r as Row)[c.key];
    if (c.kind === 'text') return [c.key, v === undefined || v === null ? '' : String(v)];
    return [c.key, typeof v === 'number' ? v : '']; // absent measure (e.g. SELF net billed) = blank cell, never 0
  })));
  return { title: spec.title, columns: spec.columns.map((c) => ({ ...c })), rows };
}
