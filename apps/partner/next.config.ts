// Partner portal (C13 02-TRD §3.6, §3.7). Plain object so node can import it; no remote image host, no X-Powered-By.
// C13.T20: no-store on every authenticated response (REQ-SEC-098 spirit), CSP with worker-src/manifest-src 'self' (REQ-SEC-089/090).
import type { NextConfig } from 'next';

// Everything except build-hashed static assets, the manifest and the service worker script (those are public + cacheable).
const APP_SOURCE = '/((?!_next/static|_next/image|fonts/|icons/|manifest\\.webmanifest|sw\\.js).*)';

// CSP ships report-only first, then enforced (plan row T20): set PARTNER_CSP_ENFORCE=true at deploy to flip the header name.
// No remote origins, no eval. Enforcing script-src also needs the per-request nonce from the C1 edge/middleware (open point).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
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

const CSP_HEADER = process.env.PARTNER_CSP_ENFORCE === 'true' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['@lims/ui'],
  images: { unoptimized: true, remotePatterns: [] },
  async headers() {
    return [
      {
        source: APP_SOURCE,
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Pragma', value: 'no-cache' },
          { key: CSP_HEADER, value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache' }, // always revalidate so a new worker version is picked up
          { key: 'Service-Worker-Allowed', value: '/' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default config;
