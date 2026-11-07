// Staff shell (02-TRD §12.1): PageShell + TopBar + SideNav + SessionTimeoutDialog. Nav entries come from the
// generated manifest filtered by the actor's permissions (UI hint only — the API enforces; AC-0D-7.1).
import type { ReactNode } from 'react';
import { PageShell } from '@lims/ui/components/PageShell';
import { t } from '../i18n/messages';
import { navEntries } from '../nav/generated';
import { hasPermission } from '../permissions/routes';
import type { ShellSession } from '../session/types';
import { SessionTimeoutDialog } from './SessionTimeoutDialog';

export function AppShell({ session, pathname, children }: { session: ShellSession; pathname: string; children: ReactNode }) {
  const visible = navEntries.filter((e) => hasPermission(session.actor.permissions, e.permission));
  const now = Date.now();
  return (
    <PageShell
      data-testid="app-shell"
      topBar={
        <div className="lims-topbar">
          <span className="lims-topbar-app">{t('core.shell.app_name')}</span>
          <span className="lims-topbar-actor">{session.actor.displayName}</span>
        </div>
      }
      nav={
        <ul className="lims-sidenav">
          {visible.map((e) => (
            <li key={e.id}>
              <a href={e.path} aria-current={pathname === e.path ? 'page' : undefined} data-chord={e.chord}>
                {t(e.label)}
              </a>
            </li>
          ))}
        </ul>
      }
    >
      {children}
      <SessionTimeoutDialog
        idleMs={Date.parse(session.idleExpiresAt) - now}
        absoluteMs={Date.parse(session.absoluteExpiresAt) - now}
      />
    </PageShell>
  );
}
