// Staff shell (02-TRD §12.1; 10-DESIGN-SYSTEM §3, T0D-UI-R04, LD-140): PageShell + top bar (global search, centre
// switcher, actor) + rail + SessionTimeoutDialog. Nav entries come from the generated manifest (build-nav.ts) filtered
// by the actor's permissions (UI hint only — the API enforces; AC-0D-7.1), grouped onto the 8 rail groups.
import type { ReactNode } from 'react';
import { PageShell } from '@lims/ui/components/PageShell';
import { t } from '../i18n/messages';
import { navEntries } from '../nav/generated';
import { RAIL_GROUPS, railGroupFor } from '../nav/rail-groups';
import { hasPermission } from '../permissions/routes';
import type { ShellSession } from '../session/types';
import { CentreSwitcher, type Centre } from './CentreSwitcher';
import { GlobalSearch } from './GlobalSearch';
import { Rail, type RailGroup } from './Rail';
import { SessionTimeoutDialog } from './SessionTimeoutDialog';

export type ShellCentres = { options: readonly Centre[]; activeId: string | null };

export function AppShell({ session, pathname, centres, children }: { session: ShellSession; pathname: string; centres?: ShellCentres; children: ReactNode }) {
  const perms = session.actor.permissions;
  const visible = navEntries.filter((e) => hasPermission(perms, e.permission));
  const groups: RailGroup[] = RAIL_GROUPS.map((g) => ({
    id: g.id,
    label: t(g.labelKey),
    items: visible
      .filter((e) => railGroupFor(e.group) === g.id)
      .sort((a, b) => a.order - b.order)
      .map((e) => ({ id: e.id, label: t(e.label), path: e.path, current: pathname === e.path, ...(e.chord ? { chord: e.chord } : {}) })),
  })).filter((g) => g.items.length > 0);
  const now = Date.now();
  return (
    <PageShell
      data-testid="app-shell"
      topBar={
        <div className="lims-topbar">
          <span className="lims-topbar-app">{t('core.shell.app_name')}</span>
          <GlobalSearch canPatients={hasPermission(perms, 'frontdesk.patient.read')} canSpecimens={hasPermission(perms, 'lab.specimen.read')} />
          {centres ? <CentreSwitcher centres={centres.options} activeId={centres.activeId} /> : null}
          <span className="lims-topbar-actor">{session.actor.displayName}</span>
        </div>
      }
      nav={<Rail groups={groups} />}
    >
      {children}
      <SessionTimeoutDialog
        idleMs={Date.parse(session.idleExpiresAt) - now}
        absoluteMs={Date.parse(session.absoluteExpiresAt) - now}
      />
    </PageShell>
  );
}
