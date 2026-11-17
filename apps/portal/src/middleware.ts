// Portal edge (02-TRD §3.5, REQ-SEC-089/090): per-request CSP nonce, no-referrer, no-store, HSTS, nosniff.
import { NextResponse, type NextRequest } from 'next/server';

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/|__nextjs|favicon.ico).*)'],
};

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

// [CONV] enforced in production; report-only under `next dev` (its overlay injects un-nonced inline code).
const CSP_HEADER = process.env.NODE_ENV === 'production' ? 'content-security-policy' : 'content-security-policy-report-only';

export function middleware(req: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp); // Next reads the nonce from here for its own scripts
  // /v/<token>: the page is served from the constant path /v/_ and reads the token from a header the edge
  // overwrites, so the HTML/RSC payload never depends on the token (AC-10.2: identical response for every non-genuine token).
  const qr = /^\/v\/([^/]*)$/.exec(req.nextUrl.pathname);
  let res: NextResponse;
  if (qr) {
    let t = '';
    try {
      t = decodeURIComponent(qr[1] ?? '');
    } catch {
      /* malformed escape -> empty token -> not found */
    }
    requestHeaders.set('x-qr-token', t);
    res = NextResponse.rewrite(new URL('/v/_', req.url), { request: { headers: requestHeaders } });
  } else res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(CSP_HEADER, csp);
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('cache-control', 'no-store');
  res.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  res.headers.set('x-content-type-options', 'nosniff');
  return res;
}
