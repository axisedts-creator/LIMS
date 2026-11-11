import { callApi, PAYMENT_ID, token22, type PortalPayment } from '@/server/api';
import { forbidden, originAllowed } from '@/server/origin';
import { getSession } from '@/server/session';

// POST only + Origin check (REQ-SEC-091/092). Forwards {gateway} and nothing else to PP1 (08 A11.1); the Idempotency-Key is the form's hidden nonce.
// Nothing the form carries beyond those two fields is read, and nothing about the money is sent: the lab system decides what is owed (REQ-SEC-046).
const GATEWAYS = ['esewa', 'khalti'];
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!originAllowed(req)) return forbidden();
  const { token } = await ctx.params;
  const form = await req.formData().catch(() => undefined);
  const back = (q: string) => see(`/r/${encodeURIComponent(token)}/${form?.get('from') === 'dues' ? 'dues' : 'report'}${q}`);   // whitelist: only these two pages
  const session = await getSession();
  if (!token22(token) || !session) return see(`/r/${encodeURIComponent(token)}`);
  const gateway = form?.get('gateway'); const nonce = form?.get('nonce');
  if (typeof gateway !== 'string' || !GATEWAYS.includes(gateway) || typeof nonce !== 'string' || !NONCE.test(nonce)) return back('?pay=error');

  const r = await callApi<PortalPayment>('POST', '/portal/payment-requests', { stage: 'session', credential: session, json: { gateway }, headers: { 'Idempotency-Key': nonce } });
  if ((r.status === 200 || r.status === 202) && r.body?.id && PAYMENT_ID.test(r.body.id)) return see(`/r/${encodeURIComponent(token)}/payments/${r.body.id}`);
  if (r.status === 401 || (r.status === 404 && r.code === 'reporting.link_invalid')) return see(`/r/${encodeURIComponent(token)}`);   // session gone: new code
  if (r.status === 409) return back('?pay=in_progress');
  return back('?pay=error');
}

const see = (location: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
