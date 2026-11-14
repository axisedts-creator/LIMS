// C13.T20 — per-request nonce CSP (07-SECURITY REQ-SEC-088–092, 02-TRD §3.6). Report-only by default; PARTNER_CSP_ENFORCE=true
// switches to the enforced header (plan row T20: "CSP report-only then enforced"). Cache-Control/Pragma/nosniff stay in next.config.ts headers().
import { NextResponse, type NextRequest } from 'next/server';

function policy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID()); // fresh per request; any client-sent x-nonce is overwritten below
  const csp = policy(nonce);
  const header = process.env.PARTNER_CSP_ENFORCE === 'true' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';

  const forwarded = new Headers(request.headers);
  forwarded.set('x-nonce', nonce);
  forwarded.set('Content-Security-Policy', csp); // Next reads the nonce from this request header and stamps its inline scripts

  const res = NextResponse.next({ request: { headers: forwarded } });
  res.headers.set(header, csp);
  return res;
}

// Skip build-hashed static assets, the manifest and the service worker script (public + cacheable, no HTML).
export const config = {
  matcher: ['/((?!_next/static|_next/image|fonts/|icons/|manifest\\.webmanifest|sw\\.js).*)'],
};
