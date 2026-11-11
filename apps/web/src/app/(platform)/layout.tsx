// (platform) route group (CR-C2-001): the LIMS provider console. Only platform sessions see the children (03-APP-FLOW §11, CR-C2-009).
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { navManifest, platformLinks } from '@/features/platform/nav.manifest';

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
  const perms = new Set(session.actor.permissions);
  const links = navManifest.entries.filter((e) => perms.has(e.permission)).sort((a, b) => a.order - b.order);
  return (
    <div className="lims-platform-shell" data-theme-header="platform">
      <header className="lims-platform-header">
        <p className="lims-platform-label"><strong>PLATFORM CONSOLE — the LIMS provider staff only</strong></p>
        <nav aria-label="Platform">
          <ul className="lims-platform-nav">
            {links.map((e) => {
              const l = platformLinks[e.id];
              return l ? <li key={e.id}><a href={l.path}>{l.text}</a></li> : null;
            })}
          </ul>
        </nav>
        <p className="lims-platform-user">{session.actor.displayName}</p>
      </header>
      <main className="lims-platform-main">{children}</main>
    </div>
  );
}
