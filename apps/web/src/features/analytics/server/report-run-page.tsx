import 'server-only';
// S7 Report run (04-UI-UX §9; 03-APP-FLOW S7): permission -> id format -> getReportRun -> one read per non-omitted, known report code with the run's period and
// effective scope (viewer ∩ schedule). Unknown codes are ignored (never turned into a request path). API 404 = not a recipient/owner/expired -> not-found copy.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { ReportRunView, type RunCard } from '../components/ReportRunView';
import type { PageVM } from '../components/report-types';
import { REPORT_CODES, UUID_RE } from '../report-codes';
import { dashboardQuery, getDashboard } from './dashboard.server';
import { getReportRun } from './report-runs.server';
import { buildPage } from './report-views';
import { REFERRAL_DEF, REPORT_DEFS, getPendingSummary, getReport, reportQuery, requirePermission, type Json, type ReportDef } from './reports.server';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const DASHBOARD = { code: 'dashboard' } as const;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

export async function reportRunPage(id: string) {
  const perms = await requirePermission('analytics.dashboard.read');
  if (!UUID_RE.test(id)) notFound();
  let run: Json;
  try {
    run = await getReportRun(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const omitted = new Set(strs(run['viewer_omitted_report_codes']));
  const period = obj(run['period']);
  const scope = obj(run['effective_scope']);
  const centres = strs(scope['centre_ids']);
  const sp: Record<string, string> = {};
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (ISO.test(str(period['business_date_from'])) && ISO.test(str(period['business_date_to']))) {
    sp['business_date_from'] = str(period['business_date_from']);
    sp['business_date_to'] = str(period['business_date_to']); // half-open [from, to) in request and response alike (01-PRD:246; AN-T20-ruling #2)
  }
  if (scope['all_centres'] === false && centres.length > 0) sp['centre_id'] = centres.join(',');

  const defs: (ReportDef | typeof DASHBOARD)[] = [];
  for (const code of strs(run['report_codes'])) {
    if (omitted.has(code) || defs.some((d) => d.code === code)) continue;
    const reg = REPORT_CODES.find((r) => r.code === code);
    if (!reg || !perms.includes(reg.permission)) continue; // unknown code, or a report this session may not read: no request
    const def = code === DASHBOARD.code ? DASHBOARD : code === REFERRAL_DEF.code ? REFERRAL_DEF : Object.values(REPORT_DEFS).find((d) => d.code === code);
    if (def) defs.push(def);
  }

  const cards = await Promise.all(defs.map(async (def): Promise<RunCard> => {
    if (!('slug' in def)) { // read-only Dashboard card: same period + scope, no refresh/export actions (04-UI-UX §9)
      const q = dashboardQuery(sp).toString();
      return { id: 'dashboard', title: 'Dashboard', dashboard: await getDashboard(sp), query: q };
    }
    const q = reportQuery(def, sp);
    const [body, summary] = await Promise.all([getReport(def, q), def.slug === 'pending-tests' ? getPendingSummary(q) : undefined]);
    const vm: PageVM = buildPage({ def, body, ...(summary ? { summary } : {}), q, options: undefined, perms, tabs: [], hub: false, pdfEnabled: false, basePath: '/analytics/reports', pageId: 'staff.analytics.reports' });
    return { id: def.slug, title: vm.title, vm };
  }));

  return <ReportRunView scheduleName={str(run['schedule_name'])} periodAd={str(period['label_ad'])} periodBs={str(period['label_bs'])} cards={cards} />;
}
