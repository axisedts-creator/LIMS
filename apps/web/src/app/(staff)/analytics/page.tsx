// S1 Owner dashboard (C8 03-APP-FLOW §5, 04-UI-UX §3). Period/centre/branch come from the URL; only whitelisted params reach the API.
// API 5xx rejects -> error.tsx; an API 403 propagates the same way (no figures are rendered). The route permission is the (staff) layout's job.
import { DashboardView } from '@/features/analytics/components/DashboardView';
import { dashboardQuery, getDashboard } from '@/features/analytics/server/dashboard.server';

export default async function AnalyticsDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const dto = await getDashboard(sp);
  const q = dashboardQuery(sp);
  for (const k of ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs']) q.delete(k);
  return <DashboardView dto={dto} query={q.toString()} />;
}
