// (display) route group (CR-C16-001): public TV board. No staff shell, no session, no nav, no Providers.
// CSP / security headers come from the same middleware as the staff shell (src/middleware.ts); /queue-display is session-exempt there.
import type { ReactNode } from 'react';

export const metadata = { title: 'Queue display' };
export const dynamic = 'force-dynamic';

export default function DisplayLayout({ children }: { children: ReactNode }) {
  return <main className="lims-queue-display">{children}</main>;
}
