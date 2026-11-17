import type { ReactNode } from 'react';
import { ServiceWorkerRegistrar } from '@/core/pwa';

// C13.T20, REQ-SEC-088–092: nonce CSP needs per-request render; prerendered pages carry no nonce and
// 'strict-dynamic' would block their scripts once PARTNER_CSP_ENFORCE=true.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Partner portal', manifest: '/manifest.webmanifest', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistrar />
        <main>{children}</main>
      </body>
    </html>
  );
}
