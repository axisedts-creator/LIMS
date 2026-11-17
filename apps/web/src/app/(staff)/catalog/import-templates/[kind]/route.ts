// AC-16.1 blank template download (#96): kind is whitelisted before anything is proxied.
import { proxyDownload } from '@/features/catalog/server/proxyDownload';
import { IMPORT_KINDS } from '@/features/catalog/server/types';

export async function GET(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!(IMPORT_KINDS as readonly string[]).includes(kind)) return new Response(null, { status: 400 });
  return proxyDownload(`/v1/catalog/import-templates/${kind}`);
}
