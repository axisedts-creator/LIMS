// AC-16.10 annotated file (#101 downloadImportReport).
import { proxyDownload } from '@/features/catalog/server/proxyDownload';
import { UUID_RE } from '@/features/catalog/server/types';

export async function GET(_req: Request, { params }: { params: Promise<{ import_id: string }> }) {
  const { import_id } = await params;
  if (!UUID_RE.test(import_id)) return new Response(null, { status: 400 });
  return proxyDownload(`/v1/catalog/imports/${import_id}/report-file`);
}
