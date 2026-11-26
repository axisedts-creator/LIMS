'use client';
// Client frame of the staff shell (LD-251, 13-M-SERIES s3): PageShell + top bar (menu button, breadcrumb, global search, centre switcher,
// notifications, actor) + sidebar. Below 1024 px the sidebar is a drawer: the menu button opens it, focus moves in and is trapped,
// Escape (or Close menu) closes it and focus returns to the menu button. CSS decides when the menu button is shown.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { PageShell } from '@lims/ui/components/PageShell';
import { t } from '../i18n/messages';
import { CentreSwitcher, type Centre } from './CentreSwitcher';
import { GlobalSearch } from './GlobalSearch';
import { NavIcon } from './NavIcon';
import { Rail, type RailGroup } from './Rail';
import { SIGN_OUT_PATH, UserMenu, useDensity } from './UserMenu';
// T0D-OFFLINE-2 (LD-322): additive; each part renders nothing without an OfflineProvider above the shell
import { OfflineNotices, OfflineStatusChip, UnlockOverlay, useSignOutGuard } from '../offline/ui/OfflineShell';

export type Crumb = { group: string; entry: string } | null;

type Props = {
  groups: RailGroup[];
  crumb: Crumb;
  tenant: string;
  user: { name: string; role: string };
  /** membership id: the per-user key of the density choice (T0D-DENSITY-1) */
  memberId?: string | undefined;
  logoSrc: string;
  search: { canPatients: boolean; canSpecimens: boolean };
  centres?: { options: readonly Centre[]; activeId: string | null } | undefined;
  children: ReactNode;
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

export function ShellFrame({ groups, crumb, tenant, user, memberId, logoSrc, search, centres, children }: Props) {
  const navId = `lims-nav-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [drawer, setDrawer] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const [density, setDensity] = useDensity(memberId);
  const signOut = useSignOutGuard(SIGN_OUT_PATH);

  // Dynamically resolve breadcrumb based on client pathname so soft navigations never leave stale crumbs
  const displayCrumb: Crumb = (() => {
    if (!pathname) return crumb;
    const normPath = pathname.replace(/\/$/, '') || '/';

    // 1. Direct match with any rail item path
    for (const g of groups) {
      for (const item of g.items) {
        if (item.path && item.path.replace(/\/$/, '') === normPath) {
          return { group: g.label, entry: item.label };
        }
      }
    }

    // 2. Sub-route mappings for lab workflow
    if (normPath.startsWith('/lab/orders/') || normPath.startsWith('/lab/worklists')) {
      const g = groups.find((x) => x.id === 'daily_work') ?? groups[0];
      const item = g?.items.find((x) => x.id === 'lab.worklists');
      return { group: g?.label ?? 'Daily Work', entry: item?.label ?? 'Pathology Result' };
    }
    if (normPath.startsWith('/lab/specimens/')) {
      const g = groups.find((x) => x.id === 'daily_work') ?? groups[0];
      const item = g?.items.find((x) => x.id === 'lab.receive');
      return { group: g?.label ?? 'Daily Work', entry: item?.label ?? 'Receive' };
    }
    if (normPath.startsWith('/frontdesk/registration')) {
      const g = groups.find((x) => x.id === 'daily_work') ?? groups[0];
      const item = g?.items.find((x) => x.id === 'frontdesk.registration_new');
      return { group: g?.label ?? 'Daily Work', entry: item?.label ?? 'Patient Registration' };
    }

    // 3. Prefix match: find the item whose path is the longest prefix of normPath
    let bestMatch: { group: string; entry: string; len: number } | null = null;
    for (const g of groups) {
      for (const item of g.items) {
        const itemPath = item.path?.replace(/\/$/, '');
        if (itemPath && itemPath !== '/' && normPath.startsWith(itemPath + '/') && itemPath.length > (bestMatch?.len ?? 0)) {
          bestMatch = { group: g.label, entry: item.label, len: itemPath.length };
        }
      }
    }
    if (bestMatch) {
      return { group: bestMatch.group, entry: bestMatch.entry };
    }

    return crumb;
  })();

  const close = () => {
    setDrawer(false);
    menu.current?.focus();
  };

  useEffect(() => {
    if (!drawer) return;
    const nav = document.getElementById(navId);
    const items = () => Array.from(nav?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => !el.closest('[hidden]'));
    (nav?.querySelector<HTMLElement>('input[type="search"]') ?? items()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab' || !nav) return;
      const list = items();
      if (list.length === 0) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === -1 || i === list.length - 1 ? 0 : i + 1);
      e.preventDefault();
      list[next]!.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close only touches a ref and a state setter
  }, [drawer, navId]);

  // T0D-DENSITY-1 (LD-310): compact is the default of every staff screen; the wrapper holds the attribute so the whole shell follows it.
  return (
    <div className="lims-density" data-density={density}>
    <PageShell
      data-testid="app-shell"
      topBar={
        <div className="lims-topbar">
          <button
            ref={menu}
            type="button"
            className="lims-btn lims-shell-menu"
            aria-label={t('core.nav.open_menu')}
            aria-expanded={drawer}
            aria-controls={navId}
            onClick={() => setDrawer(true)}
          >
            <NavIcon name="menu" />
          </button>
          <nav className="lims-breadcrumb" aria-label={t('core.nav.breadcrumb')}>
            {displayCrumb ? (
              <ol>
                {displayCrumb.group.trim().toLowerCase() !== displayCrumb.entry.trim().toLowerCase() ? <li>{displayCrumb.group}</li> : null}
                <li aria-current="page">{displayCrumb.entry}</li>
              </ol>
            ) : null}
          </nav>
          <GlobalSearch canPatients={search.canPatients} canSpecimens={search.canSpecimens} />
          <div className="lims-topbar-end">
            <OfflineStatusChip />
            {centres ? <CentreSwitcher centres={centres.options} activeId={centres.activeId} /> : null}
            {/* no notifications contract yet: the control is shown but inert (see .orchestra/notes/T0D-MSERIES-2-impl.md).
                T0D-WEBFIX-2 (LD-301): the reason is its name, tooltip and a visible note; `disabled` keeps it out of the tab order. */}
            <button type="button" className="lims-btn lims-topbar-bell" aria-label={t('core.shell.notifications_unavailable')} title={t('core.shell.notifications_unavailable')} disabled>
              <NavIcon name="bell" />
              <span className="lims-topbar-bell-note" aria-hidden="true">{t('core.shell.notifications_unavailable')}</span>
            </button>
            <UserMenu name={user.name} density={density} onChange={setDensity} accountPath={groups.flatMap((g) => g.items).find((e) => e.id === 'admin.me')?.path} onSignOut={signOut.onSignOut} />
          </div>
        </div>
      }
      nav={<Rail groups={groups} tenant={tenant} user={user} logoSrc={logoSrc} navId={navId} drawerOpen={drawer} onClose={() => { if (drawer) close(); }} />}
    >
      <OfflineNotices />
      {children}
      <UnlockOverlay />
      {signOut.dialog}
    </PageShell>
    </div>
  );
}
