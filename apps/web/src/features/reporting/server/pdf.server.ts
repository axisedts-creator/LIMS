import 'server-only';
// Same-origin PDF download proxy for the reporting screens: the browser never holds the bearer token (REQ-SEC-068), so the staff web fetches the
// PDF server-side and streams it back as an attachment. The API enforces permission and centre scope; this only forwards the answer.
import { randomBytes, randomUUID } from 'node:crypto';
import { getAccessToken } from '@/core/session/server';
import { UUID_RE } from './types';

const FAIL: Record<number, number> = { 401: 401, 403: 403, 404: 404 };

/** `apiPath` is built from a validated UUID by the caller. Only application/pdf is ever passed through. */
export async function proxyPdf(apiPath: (id: string) => string, id: string, filename: string): Promise<Response> {
  if (!UUID_RE.test(id)) return new Response(null, { status: 404 });
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) return new Response(null, { status: 500 });
  const token = await getAccessToken();
  const headers = new Headers({ accept: 'application/pdf', 'x-request-id': randomUUID(), traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01` });
  if (token) headers.set('authorization', `Bearer ${token}`);
  const up = await fetch(new URL(apiPath(id), origin), { headers, cache: 'no-store', redirect: 'error' });
  if (!up.ok) return new Response(null, { status: FAIL[up.status] ?? 502 });
  if (!(up.headers.get('content-type') ?? '').toLowerCase().startsWith('application/pdf')) return new Response(null, { status: 502 });
  return new Response(up.body, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
