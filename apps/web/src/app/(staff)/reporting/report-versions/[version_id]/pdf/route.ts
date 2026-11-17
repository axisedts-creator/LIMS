// Download a report version PDF (downloadReportVersionPdf) through the server-side proxy.
import { proxyPdf } from '@/features/reporting/server/pdf.server';

export async function GET(_req: Request, { params }: { params: Promise<{ version_id: string }> }) {
  const { version_id } = await params;
  return proxyPdf((id) => `/v1/reporting/report-versions/${id}/pdf`, version_id, 'report.pdf');
}
