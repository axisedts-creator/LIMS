import type { ReactNode } from 'react';
import '@lims/ui/tokens.css';
import '@lims/ui/fonts.css';
import '@lims/ui/kit.css';
import './portal.css';

export const metadata = { title: 'Lab report', robots: { index: false, follow: false } };
// Every page is rendered per request so Next can put the middleware's CSP nonce on its scripts.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="portal lims-root">
        <main className="portal-main">{children}</main>
        <footer className="portal-footer">Your data stays on servers in Nepal.</footer>
      </body>
    </html>
  );
}
