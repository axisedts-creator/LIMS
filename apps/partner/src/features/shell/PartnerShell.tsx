'use client';
// C13.T19 partner shell (04-UI-UX §1.1): PageShell with side nav (desktop), bottom Tabs + "More" Drawer (phones), user Menu. Entries are filtered by PartnerContext.permissions.
// LD-140 (2026-11-13): @lims/ui components only; no hex colours, no inline style objects.
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Drawer } from '@lims/ui/components/Drawer';
import { Menu } from '@lims/ui/components/Menu';
import { PageShell } from '@lims/ui/components/PageShell';
import { Tabs } from '@lims/ui/components/Tabs';
import { CalendarProvider } from '../common/ui';
import type { Me } from '../common/types';

interface Entry { id: string; href: string; label: string; perm?: string }
const ENTRIES: readonly Entry[] = [
  { id: 'home', href: '/', label: 'Home' },
  { id: 'manifests', href: '/manifests', label: 'Manifests' },
  { id: 'orders', href: '/orders', label: 'Samples' },
  { id: 'reports', href: '/reports', label: 'Reports', perm: 'partners.report.read' },
  { id: 'pickups', href: '/pickups', label: 'Pickups' },
  { id: 'prices', href: '/price-list', label: 'Prices', perm: 'partners.price_list.read' },
  { id: 'statements', href: '/statements', label: 'Statements', perm: 'partners.statement.read' },
  { id: 'doctors', href: '/referrers', label: 'Doctors', perm: 'partners.referrer.read' },
  { id: 'users', href: '/users', label: 'Users', perm: 'partners.partner_user.manage' },
];
const PHONE_TABS = new Set(['home', 'manifests', 'orders', 'reports']);
const activeOf = (path: string, e: Entry) => (e.href === '/' ? path === '/' : path === e.href || path.startsWith(`${e.href}/`));

export function PartnerShell({ me, children }: { me: Me; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname() ?? '/';
  const [more, setMore] = useState(false);
  const entries = ENTRIES.filter((e) => !e.perm || me.permissions.includes(e.perm));
  const tabs = entries.filter((e) => PHONE_TABS.has(e.id));
  const rest = [...entries.filter((e) => !PHONE_TABS.has(e.id)), { id: 'account', href: '/account', label: 'Account' }];
  const current = tabs.find((e) => activeOf(path, e))?.id ?? 'more';

  const nav = (list: readonly Entry[], onGo?: () => void) => (
    <ul className="partner-nav-list">
      {list.map((e) => (
        <li key={e.id}>
          <Link href={e.href} {...(activeOf(path, e) ? { 'aria-current': 'page' as const } : {})} {...(onGo ? { onClick: onGo } : {})}>
            {e.label}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <CalendarProvider value={me.tenant.calendar_display}>
      <PageShell
        topBar={
          <div className="partner-topbar">
            <span>
              <strong>{me.tenant.display_name}</strong> · {me.partner.name}
            </span>
            <Menu
              trigger={<Button variant="ghost">{me.user.display_name}</Button>}
              items={[{ id: 'account', label: 'Account' }, { id: 'signout', label: 'Sign out' }]}
              onAction={(id) => router.push(id === 'signout' ? '/auth/logout' : '/account')}
            />
          </div>
        }
        nav={nav(entries)}
      >
        {children}
        <div className="partner-bottom-nav">
          <Tabs
            aria-label="Main"
            items={[...tabs.map((e) => ({ id: e.id, label: e.label })), { id: 'more', label: 'More' }]}
            selectedId={current}
            onChange={(id) => {
              if (id === 'more') setMore(true);
              else router.push(tabs.find((e) => e.id === id)?.href ?? '/');
            }}
          />
        </div>
        <Drawer title="More" isOpen={more} onClose={() => setMore(false)} width="sm">
          {nav(rest, () => setMore(false))}
        </Drawer>
      </PageShell>
    </CalendarProvider>
  );
}
