// E37 downloadInstrumentAttachment stream proxy (AC-12.6, 08 A13 P-2): GET /instruments/messages/{id}/attachment.
// The bytes are piped through; the browser never sees a Storage URL (a redirect from upstream is NOT followed) and never renders the file.
import 'server-only';
import { randomUUID } from 'node:crypto';
import { getAccessToken } from '@/core/session/server';
import { UUID_RE } from '@/features/instruments/server/types';

const SAFE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/tiff']; // anything else (html, svg, js …) is sent as octet-stream
const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox" } as const;
const fail = (status: number, text?: string) => new Response(text ?? null, { status, headers: { ...BASE_HEADERS, ...(text ? { 'content-type': 'text/plain; charset=utf-8' } : {}) } });

/** `attachment; filename="x"` — only a conservative file name is carried over; the upstream disposition (inline …) is never echoed. */
function disposition(upstream: string | null): string {
  const name = /filename\*?="?([^";\r\n]{1,100})"?/i.exec(upstream ?? '')?.[1]?.replace(/[^\w. -]/g, '_');
  return name ? `attachment; filename="${name}"` : 'attachment';
}

export async function GET(_req: Request, { params }: { params: Promise<{ instrument_message_id: string }> }): Promise<Response> {
  const { instrument_message_id: id } = await params;
  if (!UUID_RE.test(id)) return fail(400);
  const token = await getAccessToken();
  if (!token) return fail(401);
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) return fail(502);
  let up: Response;
  try {
    up = await fetch(new URL(`/v1/instruments/messages/${id}/attachment/content`, origin), {
      headers: { authorization: `Bearer ${token}`, 'x-request-id': randomUUID() },
      cache: 'no-store',
      redirect: 'error', // never follow: a redirect would expose the Storage URL
    });
  } catch {
    return fail(502);
  }
  if (!up.ok || !up.body) {
    void up.body?.cancel().catch(() => undefined); // upstream detail is never forwarded
    // [CONV] 422 common.upload_quarantined → the spec's text; 403/404 mapped; everything else 502.
    if (up.status === 422) return fail(422, 'This file is not available.');
    return fail([403, 404].includes(up.status) ? up.status : 502);
  }
  const type = (up.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return new Response(up.body, {
    status: 200,
    headers: { ...BASE_HEADERS, 'content-type': SAFE_TYPES.includes(type) ? type : 'application/octet-stream', 'content-disposition': disposition(up.headers.get('content-disposition')) },
  });
}
