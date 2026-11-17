import 'server-only';
// Download proxy for SCR-18/19 files (REQ-SEC-085, 08 A13 D-20): the BFF streams the API file with the session's bearer token; the browser never
// sees a storage URL. Always an attachment, nosniff, no-store; the upstream content-type is never trusted (every C3 download is an .xlsx).
import { getAccessToken } from '@/core/session/server';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PASS = new Set([403, 404, 409]);

/** `path` is an API path built by the caller from an already-validated param. */
export async function proxyDownload(path: string): Promise<Response> {
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) return new Response(null, { status: 500 });
  const token = await getAccessToken();
  if (!token) return new Response(null, { status: 401 });
  let up: Response;
  try {
    up = await fetch(new URL(path, origin), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' });
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!up.ok || !up.body) {
    await up.body?.cancel().catch(() => undefined);
    return new Response(null, { status: PASS.has(up.status) ? up.status : 502 });
  }
  const disposition = up.headers.get('content-disposition');
  return new Response(up.body, {
    status: 200,
    headers: {
      'content-type': XLSX,
      'content-disposition': disposition && /^attachment/i.test(disposition) ? disposition : 'attachment',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
