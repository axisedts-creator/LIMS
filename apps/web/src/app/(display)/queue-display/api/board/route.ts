// BFF for the TV board (03-APP-FLOW §7.2): cookie -> Q9 getQueueBoard with X-Lims-Display-Token. GET only; never caches.
import 'server-only';
import { readDisplayToken } from '../../pairing';

export const dynamic = 'force-dynamic';

const problem = (status: number, code: string, title: string) =>
  new Response(JSON.stringify({ type: `urn:lims:error:${code}`, title, status, code }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });

export async function GET(req: Request): Promise<Response> {
  const token = await readDisplayToken();
  if (!token) return problem(401, 'auth.unauthenticated', 'Not paired');
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) return problem(500, 'common.internal', 'Internal error');

  const headers = new Headers({ accept: 'application/json', 'x-lims-display-token': token });
  const inm = req.headers.get('if-none-match');
  if (inm) headers.set('if-none-match', inm);

  let up: Response;
  try {
    up = await fetch(new URL('/v1/engagement/queue-board', origin), { method: 'GET', headers, cache: 'no-store', redirect: 'manual' });
  } catch {
    return problem(502, 'common.internal', 'Internal error');
  }

  if (up.status === 304) {
    const h = new Headers({ 'cache-control': 'no-store' });
    const etag = up.headers.get('etag');
    if (etag) h.set('etag', etag);
    return new Response(null, { status: 304, headers: h });
  }
  if (up.status === 401) return problem(401, 'auth.unauthenticated', 'Not paired');
  if (up.status !== 200) return problem(up.status >= 500 ? up.status : 502, 'common.internal', 'Internal error');

  const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  const etag = up.headers.get('etag');
  if (etag) h.set('etag', etag);
  return new Response(await up.text(), { status: 200, headers: h });
}
