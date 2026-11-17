// @vitest-environment jsdom
// T0D-ELABMENU-1 (LD-340, founder 2026-11-17 20:37 NPT): the staff sidebar follows ElabAssist when <AppShell menu="elab"> (the staff layout); menu="modules" (default) keeps the 14 module groups.
// Driven through the real <AppShell> and the REAL generated manifest (run `pnpm --dir apps/web run build:nav` first; generated.ts is gitignored).
//   Dashboard group = div[role=group][data-group=dashboard] holding ONE a[data-entry-id=analytics.dashboard] (no button, no aria-expanded, no list).
//   Other groups    = the accordion of T0D-MSERIES-2 (header button + ul with li[data-entry-id]).
//   Platform session: unchanged (only the Platform group) whatever the menu prop says.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { session, user, platformSession } from './m2.harness';
import { navEntries } from '@/core/nav/generated';
import { ELAB_GROUPS, ELAB_PLACE } from '@/core/nav/elab-menu';
import { RAIL_GROUPS } from '@/core/nav/rail-groups';
import { t } from '@/core/i18n/messages';
import { AppShell } from '../AppShell';

vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('./r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock);

const ALL = [...new Set(navEntries.flatMap((e) => [e.permission, ...(e.createPermission ? [e.createPermission] : [])]))];
const staffEntries = navEntries.filter((e) => e.group !== 'platform');
const sidebar = () => screen.getByRole('navigation', { name: 'Main' });
const groupEls = () => Array.from(sidebar().querySelectorAll<HTMLElement>('[role="group"][data-group]'));
const labels = () => groupEls().map((g) => g.getAttribute('aria-label'));
const entryEls = (root: ParentNode = sidebar()) => Array.from(root.querySelectorAll<HTMLElement>('[data-entry-id]'));
const mount = (opts: { perms?: string[]; menu?: 'elab' | 'modules' | undefined; pathname?: string; sess?: unknown } = {}) => {
  const { perms = ALL, pathname = '/lab/worklist', sess } = opts;
  const menu = 'menu' in opts ? opts.menu : 'elab'; // an explicit undefined means "no prop": the default
  return render(
    <AppShell session={(sess ?? session(perms)) as any} pathname={pathname} {...(menu ? { menu } : {})}>
      <p>page body</p>
    </AppShell>,
  );
};

describe('the real manifest is large enough to mean something', () => {
  it('has staff entries and the dashboard entry', () => {
    expect(staffEntries.length).toBeGreaterThan(100);
    expect(navEntries.some((e) => e.id === 'analytics.dashboard')).toBe(true);
  });
});

describe('menu="elab", actor holding every permission', () => {
  it('every manifest entry (except platform) appears exactly once in the sidebar, and nothing else', () => {
    mount();
    const seen = entryEls().map((el) => el.getAttribute('data-entry-id')!);
    const dup = seen.filter((id, i) => seen.indexOf(id) !== i);
    expect(dup, 'an entry shown twice').toEqual([]);
    const lost = staffEntries.map((e) => e.id).filter((id) => !seen.includes(id));
    expect(lost, 'an entry lost by the regrouping').toEqual([]);
    expect(seen.filter((id) => !staffEntries.some((e) => e.id === id)), 'an entry that is not a staff entry of the manifest').toEqual([]);
    expect(seen.length).toBe(staffEntries.length);
  });

  it('keeps each entry href from the manifest (no route change)', () => {
    mount();
    const hrefs = new Map(entryEls().filter((el) => el.tagName === 'A' || el.querySelector('a')).map((el) => [el.getAttribute('data-entry-id')!, (el.tagName === 'A' ? el : el.querySelector('a:not([data-create])')!).getAttribute('href')]));
    for (const e of staffEntries) expect(hrefs.get(e.id), e.id).toBe(e.path);
  });

  it('shows the groups in the order Dashboard, Daily Work, Accounts, Reports, Administration, then the module groups, and no Platform group', () => {
    mount();
    const l = labels();
    expect(l.slice(0, 5)).toEqual(['Dashboard', 'Daily Work', 'Accounts', 'Reports', 'Administration']);
    const expected = ELAB_GROUPS.map((g) => t(g.labelKey)).filter((x) => l.includes(x));
    expect(l).toEqual(expected);
    expect(l).not.toContain('Platform');
    expect(l.length, 'the module groups follow').toBeGreaterThan(5);
  });

  it('every group is non-empty, and the data-group id is the elab group id', () => {
    mount();
    for (const g of groupEls()) {
      expect(ELAB_GROUPS.map((x) => x.id)).toContain(g.getAttribute('data-group'));
      expect(entryEls(g).length, g.getAttribute('aria-label')!).toBeGreaterThan(0);
    }
  });

  it('puts each listed entry in its ELAB_PLACE group, in ELAB_PLACE order', () => {
    mount();
    for (const g of groupEls()) {
      const placed = entryEls(g).map((el) => el.getAttribute('data-entry-id')!).filter((id) => ELAB_PLACE.has(id));
      for (const id of placed) expect(ELAB_PLACE.get(id)!.group, id).toBe(g.getAttribute('data-group'));
      const pos = placed.map((id) => ELAB_PLACE.get(id)!.pos);
      expect(pos, g.getAttribute('data-group')!).toEqual([...pos].sort((a, b) => a - b));
    }
  });

  it('every label is translated: no raw i18n key and no empty name in the sidebar', () => {
    mount();
    for (const a of sidebar().querySelectorAll<HTMLAnchorElement>('li[data-entry-id] a.lims-rail-link .lims-rail-label')) {
      const txt = a.textContent!.trim();
      expect(txt).not.toBe('');
      expect(txt, 'looks like a message key').not.toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
  });

  it('Administration prints its sub-headings in ElabAssist order', () => {
    mount();
    const admin = sidebar().querySelector<HTMLElement>('[data-group="administration"]')!;
    const subs = Array.from(admin.querySelectorAll('[data-subheading]')).map((x) => x.textContent!.trim());
    expect(subs).toEqual(['User Management', 'Ops Masters', 'Test Management', 'Accounting', 'Settings', 'Activity and audit']);
  });
});

describe('the Dashboard group is one plain link', () => {
  it('is a link to the dashboard path named Dashboard, with no accordion button, count or list', () => {
    mount();
    const g = sidebar().querySelector<HTMLElement>('[data-group="dashboard"]')!;
    expect(g.getAttribute('role')).toBe('group');
    expect(g.getAttribute('aria-label')).toBe('Dashboard');
    expect(within(g).queryByRole('button')).toBeNull();
    expect(g.querySelector('[aria-expanded]')).toBeNull();
    expect(g.querySelector('ul')).toBeNull();
    const links = within(g).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe(navEntries.find((e) => e.id === 'analytics.dashboard')!.path);
    expect(links[0]!.textContent!.trim()).toBe('Dashboard');
  });

  it('is marked aria-current="page" on the dashboard path, and only then', () => {
    const path = navEntries.find((e) => e.id === 'analytics.dashboard')!.path;
    const { unmount } = mount({ pathname: path });
    const link = () => sidebar().querySelector<HTMLElement>('[data-group="dashboard"] a')!;
    expect(link().getAttribute('aria-current')).toBe('page');
    unmount();
    mount({ pathname: '/lab/worklist' });
    expect(link().getAttribute('aria-current')).toBeNull();
  });

  it('is shown only to an actor who holds the dashboard permission', () => {
    const perm = navEntries.find((e) => e.id === 'analytics.dashboard')!.permission;
    const { unmount } = mount({ perms: ALL.filter((p) => p !== perm) });
    expect(labels()).not.toContain('Dashboard');
    expect(sidebar().querySelector('[data-entry-id="analytics.dashboard"]')).toBeNull();
    unmount();
    mount({ perms: [perm] }); // the same permission also opens the other analytics entries (they sit under Reports)
    expect(labels()[0]).toBe('Dashboard');
    expect(entryEls(sidebar().querySelector<HTMLElement>('[data-group="dashboard"]')!).map((el) => el.getAttribute('data-entry-id'))).toEqual(['analytics.dashboard']);
  });

  it('still shows the rest of the analytics entries under Reports when the dashboard is a separate group', () => {
    mount();
    const reports = sidebar().querySelector<HTMLElement>('[data-group="reports"]')!;
    const inReports = entryEls(reports).map((el) => el.getAttribute('data-entry-id'));
    expect(inReports).toContain('analytics.reports');
    expect(inReports).not.toContain('analytics.dashboard');
  });
});

describe('permission filter and accordion in the elab menu', () => {
  it('an actor with no permission sees no group (and no crash)', () => {
    mount({ perms: [] });
    expect(labels()).toEqual([]);
  });

  it('an actor with one permission sees only the entries that permission opens', () => {
    const e = staffEntries.find((x) => x.id === 'frontdesk.worklist')!;
    mount({ perms: [e.permission] });
    const ids = entryEls().map((el) => el.getAttribute('data-entry-id')!);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(staffEntries.find((x) => x.id === id)!.permission).toBe(e.permission);
    expect(ids).toContain('frontdesk.worklist');
  });

  it('opening an accordion group still closes the open one (one at a time) and the Dashboard link is not affected', async () => {
    mount({ pathname: '/frontdesk/worklist' });
    const u = user();
    const open = () => Array.from(sidebar().querySelectorAll<HTMLElement>('button.lims-rail-header[aria-expanded="true"]'));
    expect(open()).toHaveLength(1);
    expect(open()[0]!.closest('[data-group]')!.getAttribute('data-group')).toBe('daily_work');
    await u.click(sidebar().querySelector<HTMLElement>('[data-group="accounts"] button.lims-rail-header')!);
    expect(open()).toHaveLength(1);
    expect(open()[0]!.closest('[data-group]')!.getAttribute('data-group')).toBe('accounts');
    expect(sidebar().querySelector('[data-group="dashboard"] a')).toBeTruthy();
  });

  it('the breadcrumb of the active entry names its elab group', () => {
    mount({ pathname: '/frontdesk/worklist' });
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('Daily Work')).toBeTruthy();
  });

  it('"Find a screen" finds an entry in any group and opens it; the Dashboard link is found too', async () => {
    mount();
    const u = user();
    await u.type(within(sidebar()).getByRole('searchbox', { name: 'Find a screen' }), 'dashboard');
    expect(Array.from(sidebar().querySelectorAll('[data-entry-id]')).map((el) => el.getAttribute('data-entry-id'))).toContain('analytics.dashboard');
  });
});

describe('menu="modules" (the default) is unchanged', () => {
  it('without the prop the sidebar shows the module groups of the 13 tenant NavGroups, not the elab groups', () => {
    mount({ menu: undefined });
    const l = labels();
    expect(l).not.toContain('Daily Work');
    expect(l).not.toContain('Dashboard');
    expect(l).toEqual(RAIL_GROUPS.filter((g) => g.id !== 'platform').map((g) => t(g.labelKey)).filter((x) => l.includes(x)));
    expect(l[0]).toBe('Front desk');
  });

  it('explicit menu="modules" gives the same sidebar as the default', () => {
    const a = mount({ menu: undefined });
    const first = sidebar().querySelector('.lims-rail-scroll')!.innerHTML.replace(/id="[^"]*"/g, '').replace(/aria-controls="[^"]*"/g, '');
    a.unmount();
    mount({ menu: 'modules' });
    const second = sidebar().querySelector('.lims-rail-scroll')!.innerHTML.replace(/id="[^"]*"/g, '').replace(/aria-controls="[^"]*"/g, '');
    expect(second).toBe(first);
  });

  it('every staff entry still appears exactly once under the modules menu', () => {
    mount({ menu: 'modules' });
    const seen = entryEls().map((el) => el.getAttribute('data-entry-id')!);
    expect([...seen].sort()).toEqual(staffEntries.map((e) => e.id).sort());
  });
});

describe('a platform session is unchanged', () => {
  const platformEntries = navEntries.filter((e) => e.group === 'platform');
  it('shows only the Platform group, with the same entries, whichever menu the layout asks for', () => {
    const snapshots: string[] = [];
    for (const menu of ['elab', 'modules'] as const) {
      const { unmount } = mount({ menu, sess: platformSession(ALL) });
      expect(labels()).toEqual(['Platform']);
      expect(entryEls().map((el) => el.getAttribute('data-entry-id')!).sort()).toEqual(platformEntries.map((e) => e.id).sort());
      snapshots.push(sidebar().querySelector('.lims-rail-scroll')!.innerHTML.replace(/id="[^"]*"/g, '').replace(/aria-controls="[^"]*"/g, ''));
      unmount();
    }
    expect(snapshots[0]).toBe(snapshots[1]);
  });

  it('a staff session never shows a platform entry even with every permission', () => {
    mount();
    expect(sidebar().querySelector('[data-entry-id^="platform."]')).toBeNull();
  });

  it('a platform session has no Dashboard link and no elab group', () => {
    mount({ sess: platformSession(ALL) });
    expect(labels()).not.toContain('Dashboard');
    expect(labels()).not.toContain('Daily Work');
  });
});
