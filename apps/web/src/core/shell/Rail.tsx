'use client';
// Staff sidebar (LD-251, spec/program/13-M-SERIES.md s3; replaces the 248/72 rail of T0D-UI-R04 / LD-140). Rendered inside the kit
// PageShell <nav aria-label="Main">: logo + tenant, "Find a screen", the scrolling group list, the user card. Groups are an accordion
// (one open at a time); the filter opens every group with a match. Entries arrive already permission-filtered by AppShell.
import Link from 'next/link';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { t } from '../i18n/messages';
import { GROUP_ICON, NavIcon } from './NavIcon';

export type RailItem = {
  id: string; label: string; path: string; current: boolean; icon?: string; chord?: string; section?: string;
  createPath?: string; createLabel?: string; badge?: number | string; viewOnly?: boolean;
};
export type RailGroup = { id: string; label: string; items: RailItem[]; /** LD-340: a single entry shown as a plain link (the Dashboard), no accordion */ direct?: boolean };

type Props = {
  groups: RailGroup[];
  tenant: string;
  user: { name: string; role: string };
  logoSrc: string;
  navId: string;
  drawerOpen: boolean;
  onClose: () => void;
};

export function Rail({ groups, tenant, user, logoSrc, navId, drawerOpen, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  let routerPath = '';
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    routerPath = usePathname() || '';
  } catch {
    // outside router
  }

  const [clickedPath, setClickedPath] = useState<string | null>(null);
  const prevRouterPath = useRef(routerPath);

  useEffect(() => {
    if (routerPath && routerPath !== prevRouterPath.current) {
      prevRouterPath.current = routerPath;
      setClickedPath(routerPath);
    }
  }, [routerPath]);

  useEffect(() => {
    setClickedPath(null);
  }, [groups]);

  const [open, setOpen] = useState<string | null>(() => (groups.find((g) => g.items.some((e) => e.current)) ?? groups[0])?.id ?? null);

  useEffect(() => {
    const active = clickedPath;
    if (!active) return;
    const matchedGroup = groups.find((g) => g.items.some((e) => e.path === active));
    if (matchedGroup && !matchedGroup.direct) {
      setOpen(matchedGroup.id);
    }
  }, [clickedPath, groups]);

  const onSelectPath = (path: string) => {
    setClickedPath(path);
    onClose();
  };

  const [query, setQuery] = useState('');
  const scrollTo = useRef<string | null>(null);

  // PageShell (packages/ui) owns the <nav>; id + drawer state are reflected on it (menu button aria-controls, CSS drawer).
  useLayoutEffect(() => {
    const nav = ref.current?.closest('nav');
    nav?.setAttribute('id', navId);
    nav?.setAttribute('data-drawer-open', String(drawerOpen));
  }, [navId, drawerOpen]);
  // opening a group scrolls it to the top of the list (13 s3), after the previous one has collapsed
  useLayoutEffect(() => {
    if (!scrollTo.current) return;
    ref.current?.querySelector(`[data-group="${scrollTo.current}"]`)?.scrollIntoView({ block: 'start' });
    scrollTo.current = null;
  });

  // LD-352: the user card shows the first role and how many more (the full list is in the tooltip), never a wrapped list
  const roles = user.role.split(',').map((x) => x.trim()).filter(Boolean);
  const first = roles[0] ?? '';
  const roleShort = `${first.charAt(0).toUpperCase()}${first.slice(1)}${roles.length > 1 ? ` +${roles.length - 1}` : ''}`;
  const q = query.trim().toLowerCase();
  const filtering = q.length > 0;
  const shown = filtering
    ? groups.map((g) => ({ ...g, items: g.items.filter((e) => e.label.toLowerCase().includes(q)) })).filter((g) => g.items.length > 0)
    : groups;

  const toggle = (id: string) => {
    if (open !== id) scrollTo.current = id;
    setOpen(open === id ? null : id);
  };

  return (
    <div ref={ref} className="lims-rail">
      <div className="lims-rail-brand">
        <img className="lims-rail-logo" src={logoSrc} alt={t('core.shell.logo_alt')} />
        <span className="lims-rail-tenant">{tenant}</span>
        <button type="button" className="lims-btn lims-shell-menu lims-rail-close" aria-label={t('core.nav.close_menu')} onClick={onClose}>
          <NavIcon name="close" />
        </button>
      </div>
      <input
        type="search"
        className="lims-input lims-rail-search"
        aria-label={t('core.nav.find')}
        placeholder={t('core.nav.find')}
        maxLength={60}
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="lims-rail-scroll">
        {filtering && shown.length === 0 ? <p role="status" className="lims-rail-empty">{t('core.nav.find_none')}</p> : null}
        {shown.map((g) => {
          if (g.direct && g.items[0]) {
            const only = g.items[0];
            const isCurrent = clickedPath !== null ? only.path === clickedPath : only.current;
            return (
              <div key={g.id} role="group" aria-label={g.label} data-group={g.id} className="lims-rail-group lims-rail-direct">
                <Link href={only.path} prefetch={false} className="lims-rail-header lims-rail-direct-link" aria-current={isCurrent ? 'page' : undefined} data-chord={only.chord} data-entry-id={only.id} onClick={() => onSelectPath(only.path)}>
                  <NavIcon name={GROUP_ICON[g.id]} />
                  <span className="lims-rail-group-label">{only.label}</span>
                </Link>
              </div>
            );
          }
          const expanded = filtering || open === g.id;
          const listId = `${uid}-${g.id}`;
          let lastSection: string | undefined;
          return (
            <div key={g.id} role="group" aria-label={g.label} data-group={g.id} className="lims-rail-group">
              <button type="button" className="lims-rail-header" aria-expanded={expanded} aria-controls={listId} onClick={() => toggle(g.id)}>
                <NavIcon name={GROUP_ICON[g.id]} />
                <span className="lims-rail-group-label">{g.label}</span>
                <span className="lims-rail-count">{g.items.length}</span>
                <NavIcon name="chevron" className="lims-rail-chevron" />
              </button>
              <ul id={listId} className="lims-sidenav" hidden={!expanded}>
                {g.items.map((e) => {
                  const sub = !filtering && e.section && e.section !== lastSection ? e.section : null;
                  lastSection = e.section;
                  const isCurrent = clickedPath !== null ? e.path === clickedPath : e.current;
                  return [
                    sub ? <li key={`${e.id}#s`} className="lims-rail-subheading" data-subheading="">{sub}</li> : null,
                    <li key={e.id} className="lims-rail-item" data-entry-id={e.id}>
                      <Link href={e.path} prefetch={false} className="lims-rail-link" aria-current={isCurrent ? 'page' : undefined} data-chord={e.chord} onClick={() => onSelectPath(e.path)}>
                        <NavIcon name={e.icon} />
                        <span className="lims-rail-label" title={e.label}>{e.label}</span>
                      </Link>
                      {e.badge !== undefined ? <span className="lims-rail-badge" data-badge="">{e.badge}</span> : null}
                      {e.viewOnly ? <span className="lims-rail-viewonly" data-view-only="">{t('core.nav.view_only')}</span> : null}
                      {expanded && e.createPath && e.createLabel ? (
                        <Link href={e.createPath} prefetch={false} className="lims-rail-create" data-create="" aria-label={e.createLabel} onClick={onClose}>
                          <NavIcon name="plus" />
                        </Link>
                      ) : null}
                    </li>,
                  ];
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <div className="lims-rail-user" data-testid="user-card">
        <span className="lims-rail-user-name" title={user.name}>{user.name}</span>
        <span className="lims-rail-user-role" title={user.role}>{roleShort}</span>
      </div>
    </div>
  );
}
