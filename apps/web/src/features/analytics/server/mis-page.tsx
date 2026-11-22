import 'server-only';
// T0D-MISREPORTS-1 (LD-321, LD-342 / A39, LD-353 LIST template): the ten MIS catalogue reports on /analytics/reports/[reportCode] and Bill of the Day on
// /billing/bill-of-the-day. Order: definition -> permission (notFound before any API call) -> the MIS read (its 403 carries the A39 gate) -> filter options.
// T0D-BUILD-4 (LD-447; closes CR item 8 of .orchestra/notes/T0D-MISREPORTS-1-cr-needed.md): rows, totals and paging come from getMisReportPage.
import { notFound } from 'next/navigation';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { MisReportView, type MisPageBody, type MisQuery, type MisVM } from '../components/MisReportView';
import { nepalToday } from '../components/period';
import { MIS_REPORTS, misBySlug, type MisReport } from '../report-codes';
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

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/; // opaque base64url; anything else is dropped, never forwarded

/** getMisReportPage query: the dates, centre_id and the id filters as one comma list each (form, explode false), the scalar filters, limit, cursor. */
function readSearch(q: MisQuery, cursor: string | undefined) {
  const s = new URLSearchParams({ business_date_from: q.business_date_from, business_date_to: q.business_date_to, limit: '50' });
  if (q.centre_id?.length) s.set('centre_id', q.centre_id.join(','));
  for (const [k, v] of Object.entries(q.filters ?? {})) s.set(k, Array.isArray(v) ? v.join(',') : String(v));
  if (cursor) s.set('cursor', cursor);
  return s.toString();
}

async function build(def: MisReport, sp: SP, perms: readonly string[], basePath: string, oneDay: boolean): Promise<MisVM> {
  const query = misQuery(def, sp, oneDay);
  const c = first(sp['cursor']);
  const cursor = c && CURSOR.test(c) ? c : undefined;
  let page: MisPageBody;
  try {
    page = await serverFetch<MisPageBody>(`/v1/analytics/mis-reports/${encodeURIComponent(def.code)}?${readSearch(query, cursor)}`);
  } catch (e) {
    // A39 / LD-342: the money reports' gate (flag, aal2) answers on the read itself; a closed gate shows no column and no amount word
    if (e instanceof ApiError && e.status === 403 && e.problem.code === 'auth.mfa_required') return { state: 'mfa' };
    if (e instanceof ApiError && e.status === 403 && e.problem.code === 'common.feature_disabled') return { state: 'disabled' };
    throw e;
  }
  // a finance user holds analytics.collections.read only: its reports read the collections filter options (#30), the others #29
  const options = await (def.permission === 'analytics.collections.read' ? getCollectionsFilterOptions() : getFilterOptions());
  return {
    state: 'open', code: def.code, title: def.title, basePath, oneDay, params: def.params, columns: def.columns,
    query, cursor,
    page: { rows: Array.isArray(page?.rows) ? page.rows : [], totals: page?.totals ?? {}, ...(page?.next_cursor ? { next_cursor: page.next_cursor } : {}) },
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
