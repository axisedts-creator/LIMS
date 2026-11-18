// T0D-CONTENT-1 thumbnail proxy (LD-313 d): streams a branding image (getBrandingAssetContent) with the session's bearer token, so the browser
// never holds the token or a storage URL (REQ-SEC-068). Same shape as frontdesk/trf-attachments/[attachment_id]/content/route.ts. Only PNG and
// JPEG bodies are passed on; quarantined (422), unknown (404) and forbidden (403) files get an empty response.
import { getAccessToken } from '@/core/session/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASS = [403, 404, 422];
const TYPES = ['image/png', 'image/jpeg'];

export async function GET(_req: Request, { params }: { params: Promise<{ asset_id: string }> }) {
  const { asset_id } = await params;
  const origin = process.env.LIMS_ORIGIN_API;
  if (!UUID_RE.test(asset_id)) return new Response(null, { status: 400 });
  if (!origin) return new Response(null, { status: 500 });
  const token = await getAccessToken();
  if (!token) return new Response(null, { status: 401 });
  const up = await fetch(new URL(`/v1/identity/settings/branding-assets/${asset_id}/content`, origin), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' });
  const type = (up.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!up.ok || !up.body || !TYPES.includes(type)) return new Response(null, { status: PASS.includes(up.status) ? up.status : 502 });
  return new Response(up.body, { status: 200, headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
}
