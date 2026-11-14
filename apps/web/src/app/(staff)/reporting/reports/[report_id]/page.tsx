// 04-UI-UX §2.2 Report detail (staff.reporting.report). A malformed id fails validation in the BFF before any request → notFound().
import { ReportDetailView } from '@/features/reporting/components/ReportDetailView';
import { gate } from '@/features/reporting/server/gate.server';
import { getReport } from '@/features/reporting/server/read.server';

export default async function ReportDetailPage({ params }: { params: Promise<{ report_id: string }> }) {
  const { report_id } = await params;
  return gate('reporting.report.read', async (permissions) => <ReportDetailView report={await getReport(report_id)} permissions={permissions} />);
}
