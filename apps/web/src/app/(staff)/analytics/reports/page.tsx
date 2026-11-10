// S2 report hub (C8 04-UI-UX §4): the tab strip over the report pages; the landing tab is Income. Params are whitelisted server-side.
import { reportPage } from '@/features/analytics/server/report-page';

export default async function ReportHubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return reportPage('income', await searchParams, true);
}
