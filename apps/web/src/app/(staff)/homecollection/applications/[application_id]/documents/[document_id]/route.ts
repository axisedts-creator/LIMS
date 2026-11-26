// BFF stream of downloadPhleboApplicationDocument (PHLEBO-UI-FULL-1). The staff bearer stays on the server (REQ-SEC-068).
// Both ids are validated as UUIDs before they reach an API path. Only image/png, image/jpeg and application/pdf are ever
// streamed, always as a download (attachment, nosniff, sandboxed, no-store). Upstream errors are relayed as a bare status.
import 'server-only';
import { getAccessToken } from '@/core/session/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf' };
const RELAYED = new Set([401, 403, 404, 429]);
const bare = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(_req: Request, { params }: { params: Promise<{ application_id: string; document_id: string }> }) {
  const { application_id, document_id } = await params;
  if (!UUID.test(application_id) || !UUID.test(document_id)) return bare(404);
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) return bare(500);
  const token = await getAccessToken();
  if (!token) return bare(401);

  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/v1/homecollection/applications/${application_id}/documents/${document_id}`, origin), {
      headers: { authorization: `Bearer ${token}`, accept: 'image/png, image/jpeg, application/pdf' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return bare(502);
  }
  if (!upstream.ok) return bare(RELAYED.has(upstream.status) ? upstream.status : 502);

  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = EXT[type];
  if (!ext || !upstream.body) return bare(502);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': type,
      'content-disposition': `attachment; filename="application-document-${document_id.slice(-6)}.${ext}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
    },
  });
}
