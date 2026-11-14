// Download a print job / template preview PDF (downloadReportPrintPdf) through the server-side proxy.
import { proxyPdf } from '@/features/reporting/server/pdf.server';

export async function GET(_req: Request, { params }: { params: Promise<{ print_id: string }> }) {
  const { print_id } = await params;
  return proxyPdf((id) => `/v1/reporting/prints/${id}/pdf`, print_id, 'print.pdf');
}
