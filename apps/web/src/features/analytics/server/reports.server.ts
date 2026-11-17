import 'server-only';
// #2-#13 report reads + #29/#30 filter options (BFF). Only whitelisted, well-formed search params reach the API (REQ-SEC: nothing else is forwarded);
// the Bearer token comes from the session inside serverFetch. Permission is checked BEFORE any API call.
import { notFound } from 'next/navigation';
import { serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { dashboardQuery } from './dashboard.server';

type SP = Record<string, string | string[] | undefined>;
type Rule = (v: string) => boolean;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const en = (...a: string[]): Rule => (v) => a.includes(v);
const list = (max: number, item: Rule): Rule => (v) => { const p = v.split(','); return p.length <= max && p.every((x) => item(x)); };
const uuids = (max: number) => list(max, (x) => UUID.test(x));
const limit = (max: number): Rule => (v) => /^\d{1,3}$/.test(v) && +v >= 1 && +v <= max;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const DAY_GROUPS = ['day', 'ad_month', 'bs_month', 'branch', 'centre'];
const SEGMENTS = ['pre_analytical', 'transport', 'within_lab', 'total_first_release', 'total_final_release'];

/** `scoped: false` = the API takes no centre_id/branch_id (getTestsDoneReport, analytics.yaml:1304-1349). */
export interface ReportDef { slug: string; path: string; code: string; period: boolean; scoped?: false; params: Record<string, Rule> }
export const REPORT_DEFS: Record<string, ReportDef> = {
  income: { slug: 'income', path: 'income', code: 'income', period: true, params: { group_by: en(...DAY_GROUPS) } },
  'department-income': { slug: 'department-income', path: 'department-income', code: 'department_income', period: true, params: { group_by: en('department', 'department_ad_month', 'department_bs_month'), department_id: uuids(50) } },
  collections: { slug: 'collections', path: 'collections', code: 'collections', period: true, params: { group_by: en('method', 'staff', 'staff_method', 'centre', 'day', 'ad_month', 'bs_month'), payment_method_code: list(20, (x) => CODE.test(x)) } },
  volume: { slug: 'volume', path: 'volume', code: 'volume', period: true, params: { group_by: en(...DAY_GROUPS) } },
  'top-referrers': { slug: 'top-referrers', path: 'top-referrers', code: 'top_referrers', period: true, params: { sort: en('-orders', '-patient_visits', '-tests_ordered'), limit: limit(100), rollup: en('canonical', 'none'), referrer_id: uuids(20) } },
  'top-centres': { slug: 'top-centres', path: 'top-centres', code: 'top_centres', period: true, params: { sort: en('-orders', '-net_sales_paisa', '-patient_visits', '-tests_ordered'), limit: limit(50) } },
  'tests-done': { slug: 'tests-done', path: 'tests-done', code: 'tests_done', period: true, scoped: false, params: { group_by: en('department', 'test', 'processing_branch', 'day', 'ad_month', 'bs_month'), processing_branch_id: uuids(20), department_id: uuids(50) } },
  tat: { slug: 'tat', path: 'tat', code: 'tat', period: true, params: { segment: list(5, (x) => SEGMENTS.includes(x)), priority: en('routine', 'urgent'), specimen_type_code: list(20, (x) => CODE.test(x)), processing_branch_id: uuids(20), group_by: en('none', 'centre', 'processing_branch', 'priority', 'specimen_type', 'day', 'ad_month', 'bs_month') } },
  // no period: live + snapshot (US-16.3); `items` is the main read, `summary` the second
  'pending-tests': { slug: 'pending-tests', path: 'pending-tests/items', code: 'pending_tests', period: false, params: { department_id: uuids(50), priority: en('routine', 'urgent'), item_status: list(5, (x) => ['awaiting_collection', 'awaiting_receipt', 'in_process', 'resulted', 'verified'].includes(x)), overdue_only: en('true', 'false'), sort: en('-age_seconds', 'age_seconds'), processing_branch_id: uuids(20), limit: limit(200), cursor: (v) => v.length <= 512 && /^[A-Za-z0-9_-]+$/.test(v) } },
  'quality-indicators': { slug: 'quality-indicators', path: 'quality-indicators', code: 'quality_indicators', period: true, params: { group_by: en('reason', 'centre', 'specimen_type', 'day', 'ad_month', 'bs_month') } },
  delivery: { slug: 'delivery', path: 'delivery', code: 'delivery', period: true, params: { group_by: en('channel', 'day', 'ad_month', 'bs_month') } },
  interfaces: { slug: 'interfaces', path: 'interfaces', code: 'interfaces', period: true, params: {} },
};
/** S4 (AN-T20): deliberately NOT in REPORT_DEFS (that table feeds /analytics/reports/[reportCode], gated by dashboard.read). Permission: analytics.referral_report.read. */
export const REFERRAL_DEF: ReportDef = {
  slug: 'referral-incentive', path: 'referral-incentive', code: 'referral_incentive', period: true,
  params: { group_by: en('referrer', 'referrer_ad_month', 'referrer_bs_month'), rollup: en('canonical', 'none'), referrer_id: uuids(20), cursor: (v) => v.length <= 512 && /^[A-Za-z0-9_-]+$/.test(v) },
};
/** Referral report query: whitelisted params + cursor pages of 50 (04-UI-UX §5). */
export function referralQuery(sp: SP): URLSearchParams {
  const q = reportQuery(REFERRAL_DEF, sp);
  q.set('limit', '50');
  return q;
}
// the summary read of pending tests takes the same filters minus the list-only ones
const SUMMARY_PARAMS = ['department_id', 'priority', 'processing_branch_id'];

/** Whitelisted query: period (when the report has one) + centre/branch + this report's own params. Malformed values are dropped. */
export function reportQuery(def: ReportDef, sp: SP): URLSearchParams {
  const q = dashboardQuery(sp);
  if (!def.period) for (const k of ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs']) q.delete(k);
  if (def.scoped === false) { q.delete('centre_id'); q.delete('branch_id'); }
  for (const [k, ok] of Object.entries(def.params)) {
    const v = first(sp[k]);
    if (v && ok(v)) q.set(k, v);
  }
  if (!def.period && !q.has('limit')) q.set('limit', '50'); // pending tests: cursor pages of 50 (04-UI-UX §4.9)
  return q;
}

/** Throws notFound() unless the session holds `permission`; returns the session's permissions. Runs before any API read. */
export async function requirePermission(permission: string): Promise<readonly string[]> {
  const perms = (await getShellSession())?.actor.permissions ?? [];
  if (!perms.includes(permission)) notFound();
  return perms;
}

const url = (path: string, q: URLSearchParams) => `/v1/analytics/${path}${q.size ? `?${q.toString()}` : ''}`;
export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- API bodies are read defensively cell by cell

export const getReport = (def: ReportDef, q: URLSearchParams) => serverFetch<Json>(url(`reports/${def.path}`, q));
export function getPendingSummary(q: URLSearchParams) {
  const s = new URLSearchParams();
  for (const k of ['centre_id', 'branch_id', ...SUMMARY_PARAMS]) if (q.has(k)) s.set(k, q.get(k)!);
  return serverFetch<Json>(url('reports/pending-tests/summary', s));
}

export interface FilterOptions {
  centres?: { id: string; label: string; branch_id?: string }[];
  branches?: { id: string; label: string }[];
  departments?: { id: string; label: string }[];
  payment_methods?: { code: string; display: string }[];
  specimen_types?: { code: string; display?: string }[];
}
/** Secondary reads: a failure never breaks the page (the filters are simply absent). */
export const getFilterOptions = () => serverFetch<FilterOptions>('/v1/analytics/filter-options').catch((): FilterOptions | undefined => undefined);
export const getCollectionsFilterOptions = () => serverFetch<FilterOptions>('/v1/analytics/filter-options/collections').catch((): FilterOptions | undefined => undefined);

/** #17 searchAnalyticsReferrers: the text travels in the POST body, never in the URL (REQ-SEC-098). */
export const searchReferrers = (query: string) =>
  serverFetch<{ data: { referrer_id: string; label: string; is_active: boolean }[] }>('/v1/analytics/referrers/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
