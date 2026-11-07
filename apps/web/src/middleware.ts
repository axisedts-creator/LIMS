// Staff-web BFF edge of every request (02-TRD §12.1):
//  1. per-request CSP nonce + security headers (REQ-SEC-089, 08 A18.1) — img-src 'self' data: only;
//  2. Origin / Sec-Fetch-Site check on every non-safe method → 403 auth.csrf_failed (REQ-SEC-091);
//  3. session: __Host-lims_sid → C2 resolveSession (touch:false on X-Lims-Background, 08 A25 D-206);
//     C2's 401 auth.session_expired is relayed (sign-in page for documents, problem+json otherwise).
// (auth) and (display) routes are excluded from the staff-session requirement (01-CHUNK-MAP §3).
import { NextResponse, type NextRequest } from 'next/server';
import { readSessionId } from './core/session/cookie';
import { getSessionResolver } from './core/session/provider';
import { BACKGROUND_HEADER, encodeSession, H_ACCESS_TOKEN, H_NONCE, H_PATHNAME, H_SESSION, INTERNAL_HEADERS } from './core/session/request';
import { problem, type Problem } from './core/session/types';
import { signInPageHtml } from './core/shell/sign-in-page';

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/|__nextjs|favicon.ico).*)'],
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_EXEMPT = [/^\/auth(\/|$)/, /^\/queue-display(\/|$)/];

function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    "img-src 'self' data:",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// [CONV] report-only first (REQ-SEC-089 "report-only first"); flip to 'content-security-policy' to enforce.
const CSP_HEADER = 'content-security-policy-report-only';

function secure(res: NextResponse, csp: string): NextResponse {
  res.headers.set(CSP_HEADER, csp);
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('referrer-policy', 'same-origin');
  res.headers.set('cache-control', 'no-store');
  return res;
}

const problemResponse = (p: Problem, status: number, csp: string) =>
  secure(new NextResponse(JSON.stringify(p), { status, headers: { 'content-type': 'application/problem+json' } }), csp);

function wantsJson(req: NextRequest): boolean {
  const a = req.headers.get('accept') ?? '';
  return /json/i.test(a) && !/text\/html/i.test(a);
}

function allowedOrigin(req: NextRequest): string {
  return process.env.LIMS_ORIGIN_STAFF_WEB ?? req.nextUrl.origin;
}

/** REQ-SEC-091: Origin must equal the staff-web origin, and Sec-Fetch-Site (when sent) must be same-origin. */
function csrfOk(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (!origin || origin !== allowedOrigin(req)) return false;
  if (site !== null && site !== 'same-origin') return false;
  return true;
}

export async function middleware(req: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp(nonce);

  if (!SAFE_METHODS.has(req.method) && !csrfOk(req))
    return problemResponse(problem('auth.csrf_failed', 'Request origin rejected', 403), 403, csp);

  const fwd = new Headers(req.headers);
  for (const h of INTERNAL_HEADERS) fwd.delete(h);
  fwd.set(CSP_HEADER, csp); // Next reads the nonce from the request CSP header and stamps its own scripts
  fwd.set(H_NONCE, nonce);
  fwd.set(H_PATHNAME, req.nextUrl.pathname);

  const path = req.nextUrl.pathname;
  if (!SESSION_EXEMPT.some((re) => re.test(path))) {
    const sid = readSessionId(req.headers.get('cookie'));
    const unauth = (p: Problem, reason: 'expired' | 'missing') =>
      wantsJson(req)
        ? problemResponse(p, 401, csp)
        : secure(new NextResponse(signInPageHtml(reason), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } }), csp);

    if (!sid) return unauth(problem('auth.unauthenticated', 'Authentication required', 401), 'missing');
    const r = await (await getSessionResolver()).resolve(sid, { touch: !req.headers.has(BACKGROUND_HEADER) });
    if (!r.ok) {
      if (r.status === 401) return unauth(r.problem, r.problem.code === 'auth.session_expired' ? 'expired' : 'missing');
      return problemResponse(r.problem, r.status, csp);
    }
    fwd.set(H_SESSION, encodeSession(r.session));
    fwd.set(H_ACCESS_TOKEN, r.accessToken);
  }

  return secure(NextResponse.next({ request: { headers: fwd } }), csp);
}
