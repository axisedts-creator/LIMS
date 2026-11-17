// (platform) route group (CR-C2-001): the LIMS provider console. Only platform sessions see the children (03-APP-FLOW §11, CR-C2-009).
// LD-251 (13-M-SERIES s3/s5): same sidebar as the staff shell (AppShell), showing only the platform group for a platform session.
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getRequestPathname, getShellSession } from '@/core/session/server';
import { AppShell } from '@/core/shell/AppShell';

export const dynamic = 'force-dynamic';

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const session = await getShellSession();
  if (!session) notFound();
  if (session.kind !== 'platform') {
    return (
      <main className="lims-platform-denied">
        <section role="alert">
          <h1>Platform access only</h1>
          <p>This console is for the LIMS provider staff. Use your laboratory workspace instead.</p>
        </section>
      </main>
    );
  }
  const pathname = await getRequestPathname();
  return (
    <AppShell session={session} pathname={pathname}>
      <p className="lims-platform-label"><strong>PLATFORM CONSOLE — the LIMS provider staff only</strong></p>
      {children}
    </AppShell>
  );
}
