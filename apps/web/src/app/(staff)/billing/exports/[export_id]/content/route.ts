// B29a download proxy: the BFF streams the export with the session's bearer token; the browser never sees a storage URL (08 A13 P-2).
import { getAccessToken } from '@/core/session/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ export_id: string }> }) {
  const { export_id } = await params;
  const origin = process.env.LIMS_ORIGIN_API;
  if (!UUID_RE.test(export_id)) return new Response(null, { status: 400 });
  if (!origin) return new Response(null, { status: 500 });
  const token = await getAccessToken();
  if (!token) return new Response(null, { status: 401 });
  const up = await fetch(new URL(`/v1/billing/exports/${export_id}/content`, origin), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' });
  if (!up.ok || !up.body) return new Response(null, { status: up.status === 409 || up.status === 404 || up.status === 403 ? up.status : 502 });
  return new Response(up.body, {
    status: 200,
    headers: {
      'content-type': up.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': up.headers.get('content-disposition') ?? 'attachment',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
