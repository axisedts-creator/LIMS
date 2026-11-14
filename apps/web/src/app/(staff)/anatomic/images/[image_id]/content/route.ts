// BFF stream of getAnatomicImageContent (04-UI-UX §4.2.5, D-67: the single inline-image exception to P-2). Same-origin <img src> on the Images tab.
// The staff bearer stays on the server (REQ-SEC-068). The id is validated as a UUID before it reaches an API path (REQ-SEC-026/027). Only image/png and image/jpeg are
// ever streamed — never a content type the upstream merely claims — with nosniff, CSP `default-src 'none'; sandbox` and no-store. Upstream errors are relayed as a bare
// status (no body, no cookies). GET only: nothing here changes state. LD-140 (2026-11-13): no UI in this file.
import 'server-only';
import { getAccessToken } from '@/core/session/server';
import { UUID_RE } from '@/features/anatomic/server/types';

export const dynamic = 'force-dynamic';

const ALLOWED = new Set(['image/png', 'image/jpeg']);
const RELAYED = new Set([401, 403, 404, 422, 429]);
const bare = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(_req: Request, { params }: { params: Promise<{ image_id: string }> }) {
  const { image_id } = await params;
  if (!UUID_RE.test(image_id)) return bare(404);
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) return bare(500);
  const token = await getAccessToken();
  if (!token) return bare(401);

  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/v1/anatomic/images/${image_id}/content`, origin), {
      headers: { authorization: `Bearer ${token}`, accept: 'image/png, image/jpeg' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return bare(502);
  }
  if (!upstream.ok) return bare(RELAYED.has(upstream.status) ? upstream.status : 502);

  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED.has(type) || !upstream.body) return bare(502);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': type,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
    },
  });
}
