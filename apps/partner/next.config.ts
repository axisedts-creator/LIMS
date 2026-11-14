// Partner portal (C13 02-TRD §3.6, §3.7). Plain object so node can import it; no remote image host, no X-Powered-By.
// C13.T20: no-store on every authenticated response (REQ-SEC-098 spirit), nonce CSP lives in src/middleware.ts.
import type { NextConfig } from 'next';

// Everything except build-hashed static assets, the manifest and the service worker script (those are public + cacheable).
const APP_SOURCE = '/((?!_next/static|_next/image|fonts/|icons/|manifest\\.webmanifest|sw\\.js).*)';

// The CSP is per-request (nonce) and set by src/middleware.ts (C13.T20 review #1, REQ-SEC-088–092).

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
