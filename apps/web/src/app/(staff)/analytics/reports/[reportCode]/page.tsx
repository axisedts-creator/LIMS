// S3 report pages /analytics/reports/{report_code} (C8 04-UI-UX §4.1, 4.2, 4.4-4.12). Unknown codes are a 404 before any API call;
// `collections` is its own route (/analytics/collections, D-46). The page checks analytics.dashboard.read itself (no route-table entry gates sub-pages).
import { notFound } from 'next/navigation';
import { REPORT_DEFS } from '@/features/analytics/server/reports.server';
import { reportPage } from '@/features/analytics/server/report-page';

export default async function ReportPage({ params, searchParams }: { params: Promise<{ reportCode: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { reportCode } = await params;
  if (!Object.hasOwn(REPORT_DEFS, reportCode) || reportCode === 'collections') notFound();
  return reportPage(reportCode, await searchParams);
}
