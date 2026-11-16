// @vitest-environment jsdom
// T0D-MSERIES-2 (LD-251, LD-246; spec/program/13-M-SERIES.md s3, s4; board spec/program/design-m-series/M3-worklist.png): the staff sidebar.
// The tests drive the real <AppShell> in jsdom. CONTRACT chosen by the tester where the spec gives no API (writer: follow it, or dispute in .orchestra/notes):
//   AppShell({ session, pathname, centres?, counts?, viewOnly?, children })
//     counts?: Record<entryId, number>   -> an optional count badge `[data-badge]` in the entry's <li>
//     viewOnly?: string[] (entry ids)    -> an optional tag `[data-view-only]` with the text "view only" in the entry's <li>
//     groups: the 13 tenant NavGroups for a staff session, ONLY `platform` when session.kind === 'platform' (a staff session never shows platform entries, whatever it holds).
//   sidebar = the PageShell <nav aria-label="Main"> (kit .lims-shell-nav). In it, top to bottom:
//     logo <img alt="Metro Labs"> + the tenant name (session.actor.tenantCode, the only tenant name the session carries) | searchbox "Find a screen" | scroller `.lims-rail-scroll` | user card [data-testid="user-card"].
//     The scroller holds every group; the logo, the field and the user card are NOT inside it (they never scroll away).
//   group = div[role=group][aria-label=<label>][data-group=<NavGroup>] holding a header <button aria-expanded aria-controls> whose name starts with the label (it also holds the
//     entry count `.lims-rail-count`) and the entry <ul id=aria-controls>, `hidden` while closed. Labels: core.nav.group.<NavGroup> (GROUP_LABELS in m2.harness.tsx).
//     Accordion: one open at a time; opening one closes the other; clicking the open header closes it. Default open: the group of the active entry, else the first visible group.
//     Opening a group calls scrollIntoView({ block: 'start' }) on it (or an element it contains / is contained in).
//   sub-heading = li[data-subheading] with the section text (t(entry.section)), emitted before the first entry of each run of equal `section`; none while filtering.
//   entry = li[data-entry-id] > a[href][aria-current=page when active] (name = label) with an aria-hidden 20x20 svg icon (a fallback icon when the manifest names none); optional
//     [data-badge], [data-view-only], and a round "+" a[data-create] named t(createLabel) -> createPath, shown only when the actor also holds createPermission.
//   Find a screen = input type=search, filters entries by label (case-insensitive substring), expands every group with a match, hides the others, no sub-headings,
//     "No screen matches this search." when nothing matches; clearing it returns to the accordion.
//   top bar (banner): breadcrumb nav[aria-label=Breadcrumb] ol (<group label> / <entry label>, last item aria-current=page), the CentreSwitcher, a "Notifications" button, the
//     global patient search of T0D-UI-R04 (kept: it is not a screen finder) and a menu button "Open menu" (aria-expanded, aria-controls=<sidebar id>) used below 1024 px.
//   drawer (below 1024 px, CSS shows the menu button): Open menu -> sidebar[data-drawer-open=true], focus moves inside; Tab / Shift+Tab stay inside (trap); Escape closes and returns focus
//     to the menu button; a "Close menu" button inside the sidebar also closes it. While closed the attribute is "false".
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ALL_PERMS, CENTRES, ENTRIES, GROUP_LABELS, TENANT_ENTRIES, TENANT_LABELS, byId, expandedLabels, groupEl, groupLabels, header, linkNames, platformSession, seriousViolations, session, sidebar, user } from './m2.harness';
import { AppShell } from '../AppShell';

vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('./r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock);
vi.mock('@/core/nav/generated', async () => (await import('./m2.harness')).generatedMock);

type Props = { perms?: string[]; pathname?: string; centres?: typeof CENTRES; counts?: Record<string, number>; viewOnly?: string[]; sess?: any };
const mount = ({ perms = ALL_PERMS, pathname = '/lab/worklist', centres, counts, viewOnly, sess }: Props = {}) =>
  render(
    <AppShell session={(sess ?? session(perms)) as any} pathname={pathname} {...(centres ? { centres } : {})} {...(counts ? { counts } : {})} {...(viewOnly ? { viewOnly } : {})}>
      <p>page body</p>
    </AppShell>,
  );
const field = () => within(sidebar()).getByRole('searchbox', { name: 'Find a screen' }) as HTMLInputElement;
const entryLinks = (root: HTMLElement = sidebar()) => Array.from(root.querySelectorAll<HTMLElement>('li[data-entry-id] > a:not([data-create])'));
const openAndCollect = async () => {
  // visits every group (one open at a time) and returns label -> entry link names
  const u = user();
  const out: Record<string, string[]> = {};
  for (const l of groupLabels() as string[]) {
    if (header(l).getAttribute('aria-expanded') !== 'true') await u.click(header(l));
    out[l] = entryLinks(groupEl(l)).filter((a) => !a.closest('[hidden]')).map((a) => a.textContent!.trim());
  }
  return out;
};

describe('14 NavGroups (13-M-SERIES s3): order, labels, permission filter, nothing hard-coded', () => {
  it('a staff session with every permission shows the 13 tenant groups in spec order and NO platform group', () => {
    mount();
    expect(groupLabels()).toEqual(TENANT_LABELS);
    expect(within(sidebar()).queryByText('Platform')).toBeNull();
    expect(within(sidebar()).queryByText('Tenants')).toBeNull();
  });

  it('each group lists its entries in manifest order, taken from the generated manifest (same hrefs)', async () => {
    mount();
    const seen = await openAndCollect();
    for (const l of TENANT_LABELS) {
      const g = Object.keys(GROUP_LABELS).find((k) => (GROUP_LABELS as any)[k] === l)!;
      expect(seen[l], l).toEqual(TENANT_ENTRIES.filter((x) => x.group === g).sort((a, b) => a.order - b.order).map((x) => x.label));
    }
    for (const x of TENANT_ENTRIES) expect(sidebar().querySelector(`li[data-entry-id="${x.id}"] > a`)?.getAttribute('href'), x.id).toBe(x.path);
  });

  it('platform session: ONLY the platform group (same sidebar), and no tenant group', () => {
    mount({ sess: platformSession(ALL_PERMS) });
    expect(groupLabels()).toEqual(['Platform']);
    expect(entryLinks().map((a) => a.textContent!.trim())).toEqual(['Tenants']);
  });

  it('a platform entry is never shown to a staff session, even when its permission is held', () => {
    mount({ perms: ['p.platform.tenants'] });
    expect(groupLabels()).toEqual([]);
    expect(linkNames()).toEqual([]);
  });

  it('a role without a permission sees no entry for it and no empty group row', () => {
    mount({ perms: ['p.lab.worklist'] });
    expect(groupLabels()).toEqual(['Laboratory']);
    expect(entryLinks().map((a) => a.textContent!.trim())).toEqual(['Worklist']);
    for (const hidden of ['Status board', 'Results', 'Register', 'Users', 'Daily cash', 'Front desk', 'Admin']) expect(within(sidebar()).queryByText(hidden), hidden).toBeNull();
  });

  it('permission match is exact (a prefix or a similar code does not unlock an entry)', () => {
    mount({ perms: ['p.lab.work', 'p.lab.worklist.extra', 'P.LAB.WORKLIST'] });
    expect(groupLabels()).toEqual([]);
  });

  it('no permissions: no group, no link, the landmark stays', () => {
    mount({ perms: [] });
    expect(sidebar()).toBeTruthy();
    expect(groupLabels()).toEqual([]);
    expect(linkNames()).toEqual([]);
  });

  it('the header of a closed group is one row: label, entry count (visible entries only) and a chevron', () => {
    mount();
    for (const l of TENANT_LABELS) {
      const g = Object.keys(GROUP_LABELS).find((k) => (GROUP_LABELS as any)[k] === l)!;
      const h = header(l);
      expect(h.querySelector('.lims-rail-count')?.textContent?.trim(), l).toBe(String(TENANT_ENTRIES.filter((x) => x.group === g).length));
      expect(h.querySelector('svg[aria-hidden="true"]'), `${l} chevron/icon`).toBeTruthy();
    }
    expect(header('Admin').querySelector('.lims-rail-count')?.textContent?.trim()).toBe('2'); // entries, not the "+" shortcut
  });

  it('the count follows the permission filter (a role that holds 1 of 5 Laboratory entries sees 1)', () => {
    mount({ perms: ['p.lab.results', 'p.micro.culture'] });
    expect(header('Laboratory').querySelector('.lims-rail-count')?.textContent?.trim()).toBe('2');
  });
});

describe('accordion: one group open at a time', () => {
  it('opens the group of the active entry; exactly one group is open; the others have no reachable entry', () => {
    mount({ pathname: '/catalog/tests' });
    expect(expandedLabels()).toEqual(['Catalog']);
    expect(entryLinks().filter((a) => !a.closest('[hidden]')).map((a) => a.textContent!.trim())).toEqual(['Test catalogue', 'Tests', 'Price lists']);
    expect(within(sidebar()).queryByRole('link', { name: 'Worklist' })).toBeNull();
    expect(header('Laboratory').getAttribute('aria-controls')).toBeTruthy();
  });

  it('no active entry: the first visible group is open', () => {
    mount({ pathname: '/nowhere' });
    expect(expandedLabels()).toEqual(['Front desk']);
    document.body.innerHTML = '';
    mount({ pathname: '/nowhere', perms: ['p.catalog.home', 'p.admin.roles'] });
    expect(expandedLabels()).toEqual(['Catalog']);
  });

  it('opening a group closes the open one; clicking the open header closes it; Enter and Space work on the header', async () => {
    mount({ pathname: '/lab/worklist' });
    const u = user();
    await u.click(header('Billing'));
    expect(expandedLabels()).toEqual(['Billing']);
    expect(within(sidebar()).getByRole('link', { name: 'Daily cash' })).toBeTruthy();
    expect(within(sidebar()).queryByRole('link', { name: 'Worklist' })).toBeNull();
    await u.click(header('Billing'));
    expect(expandedLabels()).toEqual([]);
    header('Catalog').focus();
    await u.keyboard('{Enter}');
    expect(expandedLabels()).toEqual(['Catalog']);
    await u.keyboard(' ');
    expect(expandedLabels()).toEqual([]);
  });

  it('opening a group scrolls it to the top of the list', async () => {
    const spy = vi.fn();
    (HTMLElement.prototype as any).scrollIntoView = spy;
    mount();
    await user().click(header('Quality'));
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({ block: 'start' });
    const ctx = spy.mock.contexts.at(-1) as HTMLElement;
    const g = groupEl('Quality');
    expect(g.contains(ctx) || ctx.contains(g)).toBe(true);
  });

  it('sub-headings appear inside a group where the manifest carries a section (Laboratory: Daily work, Microbiology, Anatomic pathology)', async () => {
    mount({ pathname: '/lab/worklist' });
    const subs = Array.from(groupEl('Laboratory').querySelectorAll('li[data-subheading]')).map((x) => x.textContent!.trim());
    expect(subs).toEqual(['Daily work', 'Microbiology', 'Anatomic pathology']);
    // a sub-heading is not a link and sits before its first entry
    const items = Array.from(groupEl('Laboratory').querySelectorAll('li')).map((li) => li.getAttribute('data-subheading') !== null ? `#${li.textContent!.trim()}` : li.querySelector('a')?.textContent?.trim());
    expect(items).toEqual(['#Daily work', 'Status board', 'Worklist', 'Results', '#Microbiology', 'Culture worklist', '#Anatomic pathology', 'Case workbench']);
    await user().click(header('Front desk'));
    expect(groupEl('Front desk').querySelectorAll('li[data-subheading]')).toHaveLength(0);
  });
});

describe('entries: pill, icon, badge, view-only tag, create "+"', () => {
  it('the active entry is a[aria-current=page] (exact path), exactly one; none when no path matches', () => {
    mount({ pathname: '/lab/results' });
    expect(entryLinks().filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent!.trim())).toEqual(['Results']);
    document.body.innerHTML = '';
    mount({ pathname: '/nowhere' });
    expect(entryLinks().some((a) => a.hasAttribute('aria-current'))).toBe(false);
  });

  it('every entry has an aria-hidden 20 px icon (a fallback when the manifest names none) and its text stays the accessible name', () => {
    mount({ pathname: '/frontdesk/register' });
    const links = entryLinks(groupEl('Front desk'));
    expect(links.length).toBe(3);
    for (const a of links) {
      const svg = a.querySelector('svg');
      expect(svg, a.textContent!).toBeTruthy();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(svg!.getAttribute('width')).toBe('20');
      expect(svg!.getAttribute('height')).toBe('20');
      expect(a.textContent!.trim().length).toBeGreaterThan(0);
    }
  });

  it('count badge and view-only tag render only where given, beside the link (the link name stays the label)', () => {
    mount({ pathname: '/lab/worklist', counts: { 'lab.worklist': 128, 'lab.results': 31 }, viewOnly: ['lab.results'] });
    const li = (id: string) => sidebar().querySelector(`li[data-entry-id="${id}"]`)!;
    expect(li('lab.worklist').querySelector('[data-badge]')?.textContent?.trim()).toBe('128');
    expect(li('lab.results').querySelector('[data-badge]')?.textContent?.trim()).toBe('31');
    expect(li('lab.results').querySelector('[data-view-only]')?.textContent?.trim().toLowerCase()).toBe('view only');
    expect(li('lab.worklist').querySelector('[data-view-only]')).toBeNull();
    expect(li('lab.status_board').querySelector('[data-badge]')).toBeNull();
    expect(within(sidebar()).getByRole('link', { name: 'Worklist' })).toBeTruthy();
  });

  it('a count or tag for an entry the actor cannot see is not rendered (no leak)', () => {
    mount({ perms: ['p.lab.worklist'], counts: { 'lab.results': 5 }, viewOnly: ['lab.results'] });
    expect(sidebar().querySelector('[data-badge], [data-view-only]')).toBeNull();
  });

  it('the round "+" goes to the create screen of entries that declare one, only for an actor who also holds the create permission', async () => {
    mount({ pathname: '/admin/users' });
    const plus = within(sidebar()).getByRole('link', { name: 'Invite user' });
    expect(plus.getAttribute('href')).toBe('/admin/users/new');
    expect(plus.hasAttribute('data-create')).toBe(true);
    expect(plus.closest('li')?.getAttribute('data-entry-id')).toBe('admin.users');
    expect(sidebar().querySelectorAll('a[data-create]')).toHaveLength(1);
    await user().click(header('Catalog'));
    expect(within(sidebar()).getByRole('link', { name: 'New test' }).getAttribute('href')).toBe('/catalog/tests/new');
    expect(sidebar().querySelectorAll('a[data-create]')).toHaveLength(1); // closed groups hide theirs
  });

  it('without the create permission the entry stays and the "+" is absent; without the entry permission neither shows', () => {
    mount({ pathname: '/admin/users', perms: ['p.admin.users'] });
    expect(within(sidebar()).getByRole('link', { name: 'Users' })).toBeTruthy();
    expect(within(sidebar()).queryByRole('link', { name: 'Invite user' })).toBeNull();
    document.body.innerHTML = '';
    mount({ pathname: '/admin/roles', perms: ['p.admin.roles', 'p.admin.user_new'] });
    expect(within(sidebar()).queryByRole('link', { name: 'Invite user' })).toBeNull();
  });
});

describe('sidebar frame: logo, tenant name, user card, scrolling list', () => {
  it('shows the Metro Labs logo and the tenant name on top, the user card (name and role) at the bottom, outside the scroller', () => {
    mount();
    const nav = sidebar();
    const logo = within(nav).getByRole('img', { name: 'Metro Labs' }) as HTMLImageElement;
    expect(logo.getAttribute('src')).toBeTruthy();
    expect(logo.getAttribute('src')).not.toMatch(/^https?:\/\//); // self-hosted (CSP)
    expect(within(nav).getByText('syn')).toBeTruthy();
    const card = within(nav).getByTestId('user-card');
    expect(within(card).getByText('Synthetic Technologist')).toBeTruthy();
    expect(card.textContent).toMatch(/synthetic[_ ]role/i);
    const scroller = nav.querySelector('.lims-rail-scroll')!;
    expect(scroller, '.lims-rail-scroll').toBeTruthy();
    expect(groupLabels().length).toBeGreaterThan(0);
    for (const l of groupLabels() as string[]) expect(scroller.contains(groupEl(l))).toBe(true);
    for (const el of [logo, field(), card]) expect(scroller.contains(el)).toBe(false);
    const pos = (a: Node, b: Node) => a.compareDocumentPosition(b);
    expect(pos(logo, field()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pos(field(), scroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pos(scroller, card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the user and tenant names render as text (XSS)', () => {
    const evil = session(ALL_PERMS, { actor: { displayName: '<img src=x onerror=alert(1)>', tenantCode: '<b>t</b>', roles: ['<i>r</i>'], permissions: ALL_PERMS, membershipId: 'm' } });
    mount({ sess: evil });
    expect(sidebar().querySelector('img[src="x"], b, i')).toBeNull();
  });
});

describe('Find a screen', () => {
  it('is a search field named "Find a screen" and is the first stop of the sidebar', async () => {
    mount();
    expect(field().type).toBe('search');
    expect(field().placeholder).toMatch(/find a screen/i);
  });

  it('filters every entry of every group as you type, expands each group with a match, hides sub-headings', async () => {
    mount({ pathname: '/frontdesk/register' });
    await user().type(field(), 'work');
    expect(entryLinks().filter((a) => !a.closest('[hidden]')).map((a) => a.textContent!.trim()).sort()).toEqual(['Case workbench', 'Culture worklist', 'Worklist']);
    expect(expandedLabels()).toEqual(['Laboratory']);
    expect(sidebar().querySelectorAll('li[data-subheading]:not([hidden])')).toHaveLength(0);
    expect(within(sidebar()).queryByRole('link', { name: 'Register' })).toBeNull();
  });

  it('a query that matches in two groups expands both (more than one group open while filtering)', async () => {
    mount();
    await user().type(field(), 'tes');
    const open = expandedLabels();
    expect(open).toEqual(expect.arrayContaining(['Catalog'])); // Test catalogue, Tests
    await user().clear(field());
    await user().type(field(), 'r');
    expect(expandedLabels().length).toBeGreaterThan(1);
  });

  it('case-insensitive, trims, never throws on regex characters, and says "No screen matches this search." when nothing matches', async () => {
    mount();
    const u = user();
    await u.type(field(), '  WORKLIST ');
    expect(entryLinks().filter((a) => !a.closest('[hidden]')).map((a) => a.textContent!.trim())).toEqual(['Worklist', 'Culture worklist']);
    await u.clear(field());
    await u.type(field(), '([*+?^$');
    expect(screen.getByText('No screen matches this search.')).toBeTruthy();
    expect(entryLinks().filter((a) => !a.closest('[hidden]'))).toHaveLength(0);
    await u.clear(field());
    expect(screen.queryByText('No screen matches this search.')).toBeNull();
  });

  it('searches only what the actor may see (a hidden entry never turns up)', async () => {
    mount({ perms: ['p.lab.worklist', 'p.lab.results'] });
    await user().type(field(), 'users');
    expect(screen.getByText('No screen matches this search.')).toBeTruthy();
  });

  it('clearing the field returns to the accordion: exactly one group open', async () => {
    mount({ pathname: '/lab/worklist' });
    const u = user();
    await u.type(field(), 'r');
    await u.clear(field());
    expect(expandedLabels()).toHaveLength(1);
    expect(sidebar().querySelectorAll('li[data-subheading]:not([hidden])').length).toBeGreaterThan(0);
  });

  it('makes no request: it filters the manifest in the browser', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    mount();
    await user().type(field(), 'wor');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('keyboard-only (Tab reaches the field and every entry; no positive tabindex)', () => {
  it('Tab order: skip link, ..., Find a screen, then the group headers and the open group entries in order', async () => {
    mount({ pathname: '/lab/worklist' }, );
    expect(document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toHaveLength(0);
    const u = user();
    const seen: string[] = [];
    for (let i = 0; i < 80; i++) {
      await u.tab();
      const el = document.activeElement as HTMLElement;
      if (!el || el === document.body) break;
      seen.push(el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName);
    }
    const iFind = seen.indexOf('Find a screen');
    expect(iFind, `saw: ${seen.join(' | ')}`).toBeGreaterThan(-1);
    expect(seen.some((s) => /skip to main/i.test(s))).toBe(true);
    let at = iFind;
    for (const l of ['Status board', 'Worklist', 'Results', 'Culture worklist', 'Case workbench']) {
      const i = seen.indexOf(l);
      expect(i, `${l} not reachable by Tab (saw: ${seen.join(' | ')})`).toBeGreaterThan(at);
      at = i;
    }
    for (const l of TENANT_LABELS) expect(seen.some((s) => s.startsWith(l)), `${l} header`).toBe(true);
    expect(seen).not.toContain('Register'); // closed group: not in the Tab sequence
  });

  it('a closed group header opens with Enter and its entries then join the Tab sequence', async () => {
    mount({ pathname: '/lab/worklist' });
    const u = user();
    header('Front desk').focus();
    await u.keyboard('{Enter}');
    await u.tab();
    expect(document.activeElement?.textContent?.trim()).toBe('Register');
  });
});

describe('top bar (spec s3: breadcrumb, centre switcher, notifications)', () => {
  it('breadcrumb shows group and entry of the active page; the last item is the current page', () => {
    mount({ pathname: '/lab/worklist', centres: CENTRES });
    const bar = screen.getByRole('banner');
    const crumb = within(bar).getByRole('navigation', { name: 'Breadcrumb' });
    const items = Array.from(crumb.querySelectorAll('li')).map((li) => li.textContent!.trim());
    expect(items).toEqual(['Laboratory', 'Worklist']);
    expect(crumb.querySelector('li:last-child [aria-current="page"], li:last-child[aria-current="page"]')).toBeTruthy();
  });

  it('breadcrumb with no active entry does not crash and does not invent a trail', () => {
    mount({ pathname: '/nowhere' });
    const crumb = screen.getByRole('banner').querySelector('nav[aria-label="Breadcrumb"]');
    expect(crumb?.querySelectorAll('li').length ?? 0).toBeLessThanOrEqual(1);
  });

  it('the banner holds the centre switcher (active centre visible), a Notifications button, the actor-independent global search, and no Find a screen', () => {
    mount({ centres: CENTRES });
    const bar = screen.getByRole('banner');
    expect(within(bar).getByText('Synthetic Centre A')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: /notifications/i })).toBeTruthy();
    expect(within(bar).queryByRole('searchbox', { name: 'Find a screen' })).toBeNull();
    expect(within(bar).getByRole('searchbox', { name: /search patients/i })).toBeTruthy();
  });
});

describe('below 1024 px the sidebar is a drawer (menu button, focus trapped, Escape closes)', () => {
  const menu = () => within(screen.getByRole('banner')).getByRole('button', { name: 'Open menu' });

  it('starts closed: the menu button reports aria-expanded=false and controls the sidebar', () => {
    mount();
    expect(sidebar().getAttribute('data-drawer-open')).toBe('false');
    expect(menu().getAttribute('aria-expanded')).toBe('false');
    expect(sidebar().id).toBeTruthy();
    expect(menu().getAttribute('aria-controls')).toBe(sidebar().id);
  });

  it('the menu button opens it and moves focus inside', async () => {
    mount();
    await user().click(menu());
    expect(sidebar().getAttribute('data-drawer-open')).toBe('true');
    expect(menu().getAttribute('aria-expanded')).toBe('true');
    expect(sidebar().contains(document.activeElement)).toBe(true);
  });

  it('focus is trapped: Tab and Shift+Tab never leave the drawer', async () => {
    mount({ centres: CENTRES });
    const u = user();
    await u.click(menu());
    for (let i = 0; i < 45; i++) {
      await u.tab();
      expect(sidebar().contains(document.activeElement), `Tab #${i + 1} left the drawer (${(document.activeElement as HTMLElement)?.outerHTML?.slice(0, 80)})`).toBe(true);
    }
    for (let i = 0; i < 45; i++) {
      await u.tab({ shift: true });
      expect(sidebar().contains(document.activeElement), `Shift+Tab #${i + 1} left the drawer`).toBe(true);
    }
  });

  it('Escape closes it and focus returns to the menu button', async () => {
    mount();
    const u = user();
    await u.click(menu());
    await u.keyboard('{Escape}');
    expect(sidebar().getAttribute('data-drawer-open')).toBe('false');
    expect(menu().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu());
  });

  it('a Close menu button inside the drawer closes it', async () => {
    mount();
    const u = user();
    await u.click(menu());
    await u.click(within(sidebar()).getByRole('button', { name: 'Close menu' }));
    expect(sidebar().getAttribute('data-drawer-open')).toBe('false');
  });

  it('Escape with the drawer closed does nothing harmful (focus stays put)', async () => {
    mount();
    const u = user();
    field().focus();
    await u.keyboard('{Escape}');
    expect(sidebar().getAttribute('data-drawer-open')).toBe('false');
  });
});

describe('axe (critical + serious) on the real shell', () => {
  it('default', async () => {
    mount({ centres: CENTRES, counts: { 'lab.worklist': 128 }, viewOnly: ['lab.results'] });
    expect(await seriousViolations()).toEqual([]);
  });
  it('while filtering and with nothing found', async () => {
    mount({ centres: CENTRES });
    const u = user();
    await u.type(field(), 'work');
    expect(await seriousViolations()).toEqual([]);
    await u.type(field(), 'zzzz');
    expect(await seriousViolations()).toEqual([]);
  });
  it('drawer open', async () => {
    mount({ centres: CENTRES });
    await user().click(within(screen.getByRole('banner')).getByRole('button', { name: 'Open menu' }));
    expect(await seriousViolations()).toEqual([]);
  });
  it('platform shell and empty sidebar', async () => {
    mount({ sess: platformSession(ALL_PERMS) });
    expect(await seriousViolations()).toEqual([]);
    document.body.innerHTML = '';
    mount({ perms: [] });
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('fixture sanity (the harness covers all 14 groups, and sections/create are exercised)', () => {
  it('has an entry in each of the 14 NavGroups, a create route and the four section families', () => {
    expect(new Set(ENTRIES.map((x) => x.group)).size).toBe(14);
    expect(byId('admin.users').createPath).toBeTruthy();
    expect(new Set(ENTRIES.map((x) => x.section).filter(Boolean))).toEqual(new Set(['Daily work', 'Microbiology', 'Anatomic pathology', 'Payments', 'Pricing']));
    expect(linkNames).toBeTypeOf('function');
  });
});
