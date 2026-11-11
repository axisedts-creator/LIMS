// F21a TRF preview proxy (US-FD-09.4; 04-UI-UX §4): the BFF streams the clean file with the session's bearer token; the browser never sees a
// Storage URL (07-SECURITY). Mirrors billing/exports/[export_id]/content/route.ts. Quarantined (422 common.upload_quarantined) and unknown (404)
// files get an empty non-200 response, so the file body is never returned for them.
import { getAccessToken } from '@/core/session/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASS = [403, 404, 422];

export async function GET(_req: Request, { params }: { params: Promise<{ attachment_id: string }> }) {
  const { attachment_id } = await params;
  const origin = process.env.LIMS_ORIGIN_API;
  if (!UUID_RE.test(attachment_id)) return new Response(null, { status: 400 });
  if (!origin) return new Response(null, { status: 500 });
  const token = await getAccessToken();
  if (!token) return new Response(null, { status: 401 });
  const up = await fetch(new URL(`/v1/frontdesk/trf-attachments/${attachment_id}/content`, origin), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' });
  if (!up.ok || !up.body) return new Response(null, { status: PASS.includes(up.status) ? up.status : 502 });
  return new Response(up.body, {
    status: 200,
    headers: {
      'content-type': up.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
