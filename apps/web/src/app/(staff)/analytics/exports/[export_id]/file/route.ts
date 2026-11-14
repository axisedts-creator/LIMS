// Download BFF route for an analytics export (04-UI-UX §7; 07-SECURITY E3, REQ-SEC-100). Streams the API file with the session Bearer token.
// GET only: a plain <a> navigates here. Upstream redirects are never followed and no storage URL is ever exposed; upstream bodies are never echoed.
import 'server-only';
import { getAccessToken } from '@/core/session/server';
import { UUID_RE } from '@/features/analytics/report-codes';

const PASS = new Set([403, 404, 409, 410]); // upstream statuses the browser may see as-is; everything else -> 502
const fail = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

export async function GET(_req: Request, ctx: { params: Promise<{ export_id: string }> }): Promise<Response> {
  const { export_id: id } = await ctx.params;
  if (!UUID_RE.test(id)) return fail(400);
  const token = await getAccessToken();
  const origin = process.env['LIMS_ORIGIN_API'];
  if (!token) return fail(401);
  if (!origin) return fail(502);
  let up: Response;
  try {
    up = await fetch(new URL(`/v1/analytics/exports/${id}/file`, origin), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' });
  } catch {
    return fail(502);
  }
  if (up.status === 401) return fail(401);
  if (PASS.has(up.status)) { await up.body?.cancel().catch(() => undefined); return fail(up.status); }
  if (!up.ok || !up.body) { await up.body?.cancel().catch(() => undefined); return fail(502); }
  const disposition = up.headers.get('content-disposition');
  return new Response(up.body, {
    status: 200,
    headers: {
      'content-type': up.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': disposition && /^attachment\b/i.test(disposition) ? disposition : 'attachment; filename="export"',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
