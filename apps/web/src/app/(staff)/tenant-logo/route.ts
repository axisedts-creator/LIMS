// CR TENANT-LOGO-1: the signed-in lab's own logo for the staff sidebar (getOwnTenantLogoContent). The request names no tenant and no asset:
// the API reads the tenant from the session's bearer token, so one lab can never ask for another lab's logo. Same shape as
// engagement/content/assets/[asset_id]/route.ts: the browser never holds the token or a storage URL (REQ-SEC-068); only PNG and JPEG bodies
// are passed on. No logo (404), not yet scanned (422), forbidden (403) or API down (502) get an empty response and the sidebar shows the
// default logo. Cached in this browser only for 5 minutes; the sidebar adds ?t=<tenant code> so two labs on one browser never share an entry.
import { getAccessToken } from '@/core/session/server';

const PASS = [403, 404, 422];
const TYPES = ['image/png', 'image/jpeg'];

export async function GET() {
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) return new Response(null, { status: 500 });
  const token = await getAccessToken();
  if (!token) return new Response(null, { status: 401 });
  const up = await fetch(new URL('/v1/identity/me/tenant-logo/content', origin), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' }).catch(() => undefined);
  const type = (up?.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!up?.ok || !up.body || !TYPES.includes(type)) return new Response(null, { status: up && PASS.includes(up.status) ? up.status : 502, headers: { 'cache-control': 'no-store' } });
  return new Response(up.body, { status: 200, headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300', vary: 'cookie' } });
}
