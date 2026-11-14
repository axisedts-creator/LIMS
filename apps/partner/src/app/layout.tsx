import type { ReactNode } from 'react';
import { ServiceWorkerRegistrar } from '@/core/pwa';

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
