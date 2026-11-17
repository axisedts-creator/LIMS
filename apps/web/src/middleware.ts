// Staff-web BFF edge of every request (02-TRD §12.1):
//  1. per-request CSP nonce + security headers (REQ-SEC-089, 08 A18.1) — img-src 'self' data: only;
//  2. Origin / Sec-Fetch-Site check on every non-safe method → 403 auth.csrf_failed (REQ-SEC-091);
//  3. session: __Host-lims_sid → C2 resolveSession (touch:false on X-Lims-Background, 08 A25 D-206);
//     C2's 401 auth.session_expired is relayed (307 to /auth/login or /auth/session-expired for documents (LD-200), problem+json otherwise).
// (auth) and (display) routes are excluded from the staff-session requirement (01-CHUNK-MAP §3).
import { NextResponse, type NextRequest } from 'next/server';
import { readSessionId } from './core/session/cookie';
import { getSessionResolver } from './core/session/provider';
import { BACKGROUND_HEADER, encodeSession, H_ACCESS_TOKEN, H_NONCE, H_PATHNAME, H_SESSION, INTERNAL_HEADERS } from './core/session/request';
import { problem, type Problem } from './core/session/types';

export const config = {
  runtime: 'nodejs',
  // T0D-FAVICON-1 (LD-310): icon + manifest files are public static assets; without this the login tab gets a 307 instead of the icon.
  matcher: ['/((?!_next/|__nextjs|favicon.ico|icon\\.png|apple-icon\\.png|icon-512\\.png|manifest\\.webmanifest).*)'],
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
    // LD-200 (2026-11-15, CR-C1-WEB-STYLE-1 option 3): documents go to the real sign-in screen; JSON keeps problem+json 401.
    // LD-203 (2026-11-15, WEB-AUTH-REDIRECT-2): reproduced on `next start`: a relative Location makes Next throw
    // "TypeError: Invalid URL" → 500. Location is an absolute URL: fixed literal path (never request data → no open
    // redirect) on the request's own origin.
    const unauth = (p: Problem, reason: 'expired' | 'missing') =>
      wantsJson(req)
        ? problemResponse(p, 401, csp)
        : secure(
            NextResponse.redirect(new URL(reason === 'expired' ? '/auth/session-expired' : '/auth/login', req.nextUrl.origin), 307),
            csp,
          );

    if (!sid) return unauth(problem('auth.unauthenticated', 'Authentication required', 401), 'missing');
    const r = await (await getSessionResolver()).resolve(sid, { touch: !req.headers.has(BACKGROUND_HEADER) });
    if (!r.ok) {
      if (r.status === 401) return unauth(r.problem, r.problem.code === 'auth.session_expired' ? 'expired' : 'missing');
      // T0D-WAKE-1 (LD-277, RS-07): no answer from the API -> documents see the waking state in place (URL kept, so a refresh retries).
      if (r.waking && !wantsJson(req)) return secure(NextResponse.rewrite(new URL('/auth/waking', req.nextUrl.origin), { request: { headers: fwd } }), csp);
      return problemResponse(r.problem, r.status, csp);
    }
    fwd.set(H_SESSION, encodeSession(r.session));
    fwd.set(H_ACCESS_TOKEN, r.accessToken);
  }

  return secure(NextResponse.next({ request: { headers: fwd } }), csp);
}
