// F-16 export download (#106 downloadExportFile). 409 file_not_ready passes through (SCR-18 shows "Still preparing").
import { proxyDownload } from '@/features/catalog/server/proxyDownload';
import { UUID_RE } from '@/features/catalog/server/types';

export async function GET(_req: Request, { params }: { params: Promise<{ export_id: string }> }) {
  const { export_id } = await params;
  if (!UUID_RE.test(export_id)) return new Response(null, { status: 400 });
  return proxyDownload(`/v1/catalog/exports/${export_id}/file`);
}
