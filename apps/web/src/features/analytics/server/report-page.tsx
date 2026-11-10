import 'server-only';
// AN-T19: server side of the report hub / report pages / Collections page. Order: permission -> whitelisted query -> API reads -> plain-JSON view model.
// API 5xx and 403 reject (analytics/error.tsx shows the reference); secondary reads (filter options) failing never break the page.
import { notFound } from 'next/navigation';
import { ReportView } from '../components/ReportView';
import { buildPage, tabsFor } from './report-views';
import { REPORT_DEFS, getCollectionsFilterOptions, getFilterOptions, getPendingSummary, getReport, reportQuery, requirePermission } from './reports.server';

type SP = Record<string, string | string[] | undefined>;
const pdfEnabled = () => process.env['LIMS_ANALYTICS_PDF_ENABLED'] === 'true'; // LD-83: PDF export stays disabled until the flag is on

/** `hub` = /analytics/reports (the first tab, Income, is the landing report). */
export async function reportPage(slug: string, sp: SP, hub = false) {
  if (!Object.hasOwn(REPORT_DEFS, slug) || slug === 'collections') notFound(); // Collections lives at /analytics/collections (D-46)
  const def = REPORT_DEFS[slug]!;
  const perms = await requirePermission('analytics.dashboard.read');
  const q = reportQuery(def, sp);
  const [body, summary, options] = await Promise.all([getReport(def, q), slug === 'pending-tests' ? getPendingSummary(q) : undefined, getFilterOptions()]);
  return (
    <ReportView
      vm={buildPage({ def, body, ...(summary ? { summary } : {}), q, options, perms, tabs: tabsFor(perms), hub, pdfEnabled: pdfEnabled(), basePath: hub ? '/analytics/reports' : `/analytics/reports/${slug}`, pageId: 'staff.analytics.reports' })}
    />
  );
}

/** S2b: analytics.collections.read ONLY (a finance user holds no analytics.dashboard.read), so it reads the collections filter options (#30), never #29. */
export async function collectionsPage(sp: SP) {
  const def = REPORT_DEFS['collections']!;
  const perms = await requirePermission('analytics.collections.read');
  const q = reportQuery(def, sp);
  const [body, options] = await Promise.all([getReport(def, q), getCollectionsFilterOptions()]);
  return (
    <ReportView
      vm={buildPage({ def, body, q, options, perms, tabs: tabsFor(perms), hub: false, pdfEnabled: pdfEnabled(), basePath: '/analytics/collections', pageId: 'staff.analytics.collections' })}
    />
  );
}
