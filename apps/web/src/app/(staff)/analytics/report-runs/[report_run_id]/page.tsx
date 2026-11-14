// S7 Report run landing from the schedule email (C8 04-UI-UX §9; US-18.4). Permission analytics.dashboard.read, then the id format, then the API (404 -> not-found.tsx).
import { reportRunPage } from '@/features/analytics/server/report-run-page';

export default async function ReportRunPage({ params }: { params: Promise<{ report_run_id: string }> }) {
  const { report_run_id } = await params;
  return reportRunPage(report_run_id);
}
