import 'server-only';
// T0D-MISREPORTS-1 (LD-321, LD-342 / A39, LD-353 LIST template): the ten MIS catalogue reports on /analytics/reports/[reportCode] and Bill of the Day on
// /billing/bill-of-the-day. Order: definition -> permission (notFound before any API call) -> A39 gate probe (money reports) -> filter options -> view model.
// OPEN CR (.orchestra/notes/T0D-MISREPORTS-1-cr-needed.md): the definitions have no HTTP read, so the screens draw the header row and an empty body; the
// rows reach the user through the CSV export (createAnalyticsExport) and the schedule editor. When the read lands, misQuery() is its query.
import { notFound } from 'next/navigation';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { MisReportView, type MisVM } from '../components/MisReportView';
import { nepalToday } from '../components/period';
import { MIS_GATED, MIS_REPORTS, misBySlug, type MisReport } from '../report-codes';
import { getCollectionsFilterOptions, getFilterOptions, requirePermission } from './reports.server';

type SP = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID_PARAMS = ['party_id', 'representative_id', 'collector_id', 'referrer_id', 'department_id'];
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const ids = (v: string | undefined) => (v ?? '').split(',').filter((x) => UUID.test(x)).slice(0, 20);
const validDay = (v: string | undefined) => (v && DAY.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? v : undefined);

/** Whitelisted filter state of a definition (contract ExportParams shapes): dates inclusive, id lists <= 20, visit_type opd|ipd, min_repeat_count 2..100. */
export function misQuery(def: MisReport, sp: SP, oneDay = false) {
  const today = nepalToday();
  let from = validDay(first(sp['business_date_from']));
  let to = validDay(first(sp['business_date_to']));
  if (oneDay) { from = from ?? today; to = from; } // Bill of the Day: one business day, both ends inclusive (contract example_params)
  else if (!from || !to || from > to) { from = `${today.slice(0, 8)}01`; to = today; } // [CONV] default = this A.D. month to today
  const filters: Record<string, unknown> = {};
  for (const p of def.params) {
    const v = first(sp[p]);
    if (ID_PARAMS.includes(p)) { const l = ids(v); if (l.length) filters[p] = l; }
    else if (p === 'visit_type' && (v === 'opd' || v === 'ipd')) filters[p] = v;
    else if (p === 'min_repeat_count' && v && /^\d{1,3}$/.test(v) && +v >= 2 && +v <= 100) filters[p] = +v;
  }
  const centres = ids(first(sp['centre_id']));
  return { business_date_from: from, business_date_to: to, ...(centres.length ? { centre_id: centres } : {}), ...(Object.keys(filters).length ? { filters } : {}) };
}

type Gate = 'open' | 'mfa' | 'disabled';
/** A39 / LD-342: the money reports share the referral_incentive gate (flag, permission, aal2). No MIS read exists, so the gate is read through the
 * referral report with one row ([CONV], flagged in the impl note: the API logs it as referral_report.view). */
async function gate(def: MisReport): Promise<Gate> {
  if (!MIS_GATED.includes(def.code)) return 'open';
  try {
    await serverFetch('/v1/analytics/reports/referral-incentive?limit=1');
    return 'open';
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && e.problem.code === 'auth.mfa_required') return 'mfa';
    if (e instanceof ApiError && e.status === 403 && e.problem.code === 'common.feature_disabled') return 'disabled';
    throw e;
  }
}

async function build(def: MisReport, sp: SP, perms: readonly string[], basePath: string, oneDay: boolean): Promise<MisVM> {
  const g = await gate(def);
  if (g !== 'open') return { state: g };
  // a finance user holds analytics.collections.read only: its reports read the collections filter options (#30), the others #29
  const options = await (def.permission === 'analytics.collections.read' ? getCollectionsFilterOptions() : getFilterOptions());
  return {
    state: 'open', code: def.code, title: def.title, basePath, oneDay, params: def.params, columns: def.columns,
    query: misQuery(def, sp, oneDay),
    centres: (options?.centres ?? []).map((c) => ({ value: c.id, label: c.label })),
    departments: (options?.departments ?? []).map((d) => ({ value: d.id, label: d.label })),
    canExport: perms.includes('analytics.data.export'), canSchedule: perms.includes('analytics.schedule.manage'),
    pdfEnabled: process.env['LIMS_ANALYTICS_PDF_ENABLED'] === 'true',
  };
}

/** /analytics/reports/[reportCode] for a MIS slug; undefined = not a MIS slug (the caller falls through to the old reports). */
export async function misReportPage(slug: string, sp: SP) {
  const def = misBySlug(slug);
  if (!def) return undefined;
  const perms = await requirePermission(def.permission);
  return <MisReportView vm={await build(def, sp, perms, `/analytics/reports/${slug}`, false)} />;
}

/** /billing/bill-of-the-day (route staff.billing.bill_of_the_day, analytics.collections.read). */
export async function billOfTheDayPage(sp: SP) {
  const def = MIS_REPORTS.find((r) => r.code === 'bill_of_the_day');
  if (!def) notFound();
  const perms = await requirePermission(def.permission);
  return <MisReportView vm={await build(def, sp, perms, '/billing/bill-of-the-day', true)} />;
}
