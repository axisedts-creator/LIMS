import 'server-only';
// BFF -> /v1/partners/** (02-TRD §3.6). Server-only: the access JWT is resolved here and never returned to the caller.
import { headers as nextHeaders } from 'next/headers';
import { redirect } from 'next/navigation';
import { requirePartnerSession, LOGIN_SESSION_ENDED } from './auth-guard';
import { checkCsrf } from './csrf';
import { hex, partnerApiOrigin, type Problem } from './session';

export interface PartnerApiOptions { method?: string; body?: unknown; headers?: Record<string, string> }
export type PartnerApiResult<T = unknown> = { ok: true; status: number; data?: T } | { ok: false; status: number; problem: Problem };

const PATH_OK = /^\/v1\/partners\/[A-Za-z0-9\-._~/%?&=,:+]*$/;
const PATH_BAD = /\.\.|\/\.(\/|\?|$)|%2e|%2f|%5c|\/\//i; // dot segments, encoded dots/slashes, empty segments
const PASS_THROUGH = new Set(['idempotency-key', 'if-match', 'if-none-match', 'accept-language']);

export async function partnerApi<T = unknown>(path: string, opts: PartnerApiOptions = {}): Promise<PartnerApiResult<T>> {
  if (!PATH_OK.test(path) || PATH_BAD.test(path)) throw new Error('partnerApi: path must be /v1/partners/**'); // SSRF / path guard
  const method = (opts.method ?? 'GET').toUpperCase();
  const csrf = checkCsrf({ method, headers: await nextHeaders() });
  if (!csrf.ok) return { ok: false, status: 403, problem: { code: csrf.code, status: 403, title: csrf.code } };

  const { accessToken } = await requirePartnerSession(); // redirects for no/expired/not-active sessions
  const h: Record<string, string> = {
    accept: 'application/json', authorization: `Bearer ${accessToken}`, 'x-request-id': crypto.randomUUID(), traceparent: `00-${hex(16)}-${hex(8)}-01`,
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (PASS_THROUGH.has(k.toLowerCase()) && !/[\r\n]/.test(v)) h[k.toLowerCase()] = v;
  if (opts.body !== undefined) h['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(new URL(path, partnerApiOrigin()), {
      method, headers: h, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    return { ok: false, status: 503, problem: { code: 'common.dependency_unavailable', status: 503, title: 'common.dependency_unavailable' } };
  }
  const json = (await res.json().catch(() => undefined)) as any;
  if (res.ok) return { ok: true, status: res.status, ...(json !== undefined ? { data: json as T } : {}) };
  const code: string = typeof json?.code === 'string' ? json.code : res.status >= 500 ? 'common.dependency_unavailable' : 'common.internal';
  if (res.status === 401 && code === 'auth.session_expired') redirect(LOGIN_SESSION_ENDED);
  if (res.status === 403 && code === 'auth.mfa_required') redirect('/auth/mfa');
  if (res.status === 403 && code === 'identity.mfa_enrolment_required') redirect('/auth/mfa/enrol');
  return { ok: false, status: res.status, problem: json?.code ? json : { code, status: res.status, title: code } };
}
