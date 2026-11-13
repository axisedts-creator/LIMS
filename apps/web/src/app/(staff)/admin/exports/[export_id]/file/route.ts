// Audit-export download BFF route (AC-D4.5; 07-SECURITY; REQ-SEC-068): streams GET /v1/identity/audit-exports/{id}/file with the session
// Bearer, which never reaches the browser. The API enforces requester-only + download count. Redirects are never followed; upstream
// error bodies are never echoed.
import 'server-only';
import { getAccessToken } from '@/core/session/server';
import { UUID_RE } from '@/features/admin/lib';

const PASS = new Set([403, 404, 409, 410, 422]);
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
    up = await fetch(new URL(`/v1/identity/audit-exports/${id}/file`, origin), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' });
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
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': disposition && /^attachment\b/i.test(disposition) ? disposition : 'attachment; filename="audit-export.csv"',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
