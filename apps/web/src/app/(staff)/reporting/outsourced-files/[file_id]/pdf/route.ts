// Open a sanitised outsourced PDF (downloadOutsourcedReport = GET /outsourced-files/{id}/content) through the server-side proxy.
import { proxyPdf } from '@/features/reporting/server/pdf.server';

export async function GET(_req: Request, { params }: { params: Promise<{ file_id: string }> }) {
  const { file_id } = await params;
  return proxyPdf((id) => `/v1/reporting/outsourced-files/${id}/content`, file_id, 'outsourced-report.pdf');
}
