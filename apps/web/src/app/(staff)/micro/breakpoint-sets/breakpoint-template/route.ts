// "Download template" (04-UI-UX §6.1; TRD §5 M49): the BFF streams the API's CSV template with the session's token — the browser never sees the API origin
// (REQ-SEC-085). Always an attachment, nosniff, no-store; the upstream content-type is not trusted.
import { getAccessToken } from '@/core/session/server';

export async function GET(): Promise<Response> {
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) return new Response(null, { status: 500 });
  const token = await getAccessToken();
  if (!token) return new Response(null, { status: 401 });
  let up: Response;
  try {
    up = await fetch(new URL('/v1/micro/breakpoint-import-template', origin), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' });
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!up.ok || !up.body) {
    await up.body?.cancel().catch(() => undefined);
    return new Response(null, { status: up.status === 403 || up.status === 404 ? up.status : 502 });
  }
  return new Response(up.body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="breakpoint-template.csv"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
