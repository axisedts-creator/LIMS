import 'server-only';
// AN-T19: server side of the report hub / report pages / Collections page. Order: permission -> whitelisted query -> API reads -> plain-JSON view model.
// Secondary reads (filter options, the income / department income pair) failing never break the page.
// T0D-UIREPORT-2 (LD-353 rule 6): 501 operation_pending = NotAvailable, any 5xx = ErrorState in the page; both keep the title (loadOr). 403/404 still throw.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { t } from '@/core/i18n/messages';
import { loadOr } from '@/core/shell/NotAvailable';
import { ReferralState } from '../components/ReferralState';
import { ReportView } from '../components/ReportView';
import { MIS_REPORTS, misHref } from '../report-codes';
import { buildPage, tabsFor } from './report-views';
import { REFERRAL_DEF, REPORT_DEFS, getCollectionsFilterOptions, getFilterOptions, getPendingSummary, getReport, referralQuery, reportQuery, requirePermission, type Json } from './reports.server';

type SP = Record<string, string | string[] | undefined>;
const pdfEnabled = () => process.env['LIMS_ANALYTICS_PDF_ENABLED'] === 'true'; // LD-83: PDF export stays disabled until the flag is on

/** Page titles known before the read (the same names the view model builds), so a failed read keeps them. */
const TITLES: Record<string, string> = {
  income: 'Income', 'department-income': 'Department income', volume: 'Volume', 'top-referrers': 'Top referrers', 'top-centres': 'Top centres', 'tests-done': 'Tests done',
  tat: 'Turnaround time (TAT)', 'pending-tests': 'Pending tests', 'quality-indicators': 'Quality indicators', delivery: 'Delivery', interfaces: 'Instrument interfaces',
};
/** T0D-UIREPORT-2: income and department income each draw one chart from the other's operation (default grouping: day / department). */
const PAIR: Record<string, string> = { income: 'department-income', 'department-income': 'income' };
function pairRead(slug: string, sp: SP): Promise<Json | undefined> | undefined {
  const other = PAIR[slug] ? REPORT_DEFS[PAIR[slug]] : undefined;
  if (!other) return undefined;
  const q = reportQuery(other, sp);
  q.delete('group_by');
  return getReport(other, q).catch(() => undefined);
}

/** `hub` = /analytics/reports (the first tab, Income, is the landing report). */
export async function reportPage(slug: string, sp: SP, hub = false) {
  if (!Object.hasOwn(REPORT_DEFS, slug) || slug === 'collections') notFound(); // Collections lives at /analytics/collections (D-46)
  const def = REPORT_DEFS[slug]!;
  const perms = await requirePermission('analytics.dashboard.read');
  return loadOr(hub ? t('analytics.nav.reports') : TITLES[slug] ?? slug, undefined, async () => {
    const q = reportQuery(def, sp);
    const [body, summary, options] = await Promise.all([getReport(def, q), slug === 'pending-tests' ? getPendingSummary(q) : undefined, getFilterOptions()]);
    const other = await pairRead(slug, sp); // after the main read: the main read stays the first call, and a failed page reads nothing more
    const vm = buildPage({ def, body, ...(summary ? { summary } : {}), ...(other ? { other } : {}), q, options, perms, tabs: tabsFor(perms), hub, pdfEnabled: pdfEnabled(), basePath: hub ? '/analytics/reports' : `/analytics/reports/${slug}`, pageId: 'staff.analytics.reports' });
    // T0D-MISREPORTS-1 (LD-321): the hub also lists the catalogue reports the session may open (by definition permission)
    if (hub) vm.more = MIS_REPORTS.filter((r) => perms.includes(r.permission)).map((r) => ({ href: misHref(r.code), label: r.title }));
    return <ReportView vm={vm} />;
  });
}

/** S4 (AN-T20): analytics.referral_report.read, checked before any API call. The API's 403 auth.mfa_required / common.feature_disabled are page states (04-UI-UX §5). */
export async function referralPage(sp: SP) {
  const perms = await requirePermission('analytics.referral_report.read');
  const q = referralQuery(sp);
  return loadOr(t('analytics.nav.referral'), undefined, async () => {
    try {
      const [body, options] = await Promise.all([getReport(REFERRAL_DEF, q), getFilterOptions()]);
      return (
        <ReportView
          vm={buildPage({ def: REFERRAL_DEF, body, q, options, perms, tabs: [], hub: false, pdfEnabled: pdfEnabled(), basePath: '/analytics/referral-incentive', pageId: 'staff.analytics.referral_incentive' })}
        />
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.problem.code === 'auth.mfa_required') return <ReferralState kind="mfa" />;
      if (e instanceof ApiError && e.status === 403 && e.problem.code === 'common.feature_disabled') return <ReferralState kind="disabled" />;
      throw e;
    }
  });
}

/** S2b: analytics.collections.read ONLY (a finance user holds no analytics.dashboard.read), so it reads the collections filter options (#30), never #29. */
export async function collectionsPage(sp: SP) {
  const def = REPORT_DEFS['collections']!;
  const perms = await requirePermission('analytics.collections.read');
  return loadOr(t('analytics.nav.collections'), undefined, async () => {
    const q = reportQuery(def, sp);
    const [body, options] = await Promise.all([getReport(def, q), getCollectionsFilterOptions()]);
    // T0D-UIREPORT-2 ruling (LD-353): one more read grouped by day for the hero line, after the main read; failing = No data yet
    let other: Json | undefined = body;
    if (q.get('group_by') !== 'day') {
      const dq = new URLSearchParams(q);
      dq.set('group_by', 'day');
      other = await getReport(def, dq).catch(() => undefined);
    }
    return (
      <ReportView
        vm={buildPage({ def, body, ...(other ? { other } : {}), q, options, perms, tabs: tabsFor(perms), hub: false, pdfEnabled: pdfEnabled(), basePath: '/analytics/collections', pageId: 'staff.analytics.collections' })}
      />
    );
  });
}
