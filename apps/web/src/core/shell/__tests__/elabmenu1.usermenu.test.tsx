// @vitest-environment jsdom
// T0D-ELABMENU-1 (LD-340; founder 2026-11-17 20:50 NPT: "we do not have a profile section from where we can sign out"): the actor button in the top bar opens a menu with
//   Screen density (Compact / Regular, role menuitemradio), then My account (a link, ONLY when the actor may open admin.me) and Sign out (a link to /auth/logout).
//   The button shows an avatar with the initials (aria-hidden) and the display name. Arrow keys / Home / End move over EVERY item and wrap; Escape closes and returns focus.
// Part 1 drives <UserMenu> directly; part 2 drives <AppShell> with the real manifest (admin.me needs the permission `identity.self.manage`).
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { session, user } from './r04.harness';
import { navEntries } from '@/core/nav/generated';
import { UserMenu } from '../UserMenu';
import { AppShell } from '../AppShell';

vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('./r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock);

const NAME = 'Synthetic Technologist';
const ME = navEntries.find((e) => e.id === 'admin.me')!;
const open = async (name = NAME) => {
  const u = user();
  await u.click(screen.getByRole('button', { name: new RegExp(name.replace(/[<>().*+?]/g, '.')) }));
  return { u, menu: screen.getByRole('menu') };
};
const itemNames = (menu: HTMLElement) => Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((i) => i.textContent!.trim());
const focused = () => document.activeElement?.textContent?.trim();

describe('<UserMenu> items', () => {
  it('shows Screen density, Compact, Regular, then My account and Sign out, in that order', async () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} accountPath="/admin/me" />);
    const { menu } = await open();
    expect(within(menu).getByText('Screen density')).toBeTruthy();
    expect(itemNames(menu)).toEqual(['Compact', 'Regular', 'My account', 'Sign out']);
  });

  it('My account is a link to the path it is given; Sign out is a link to /auth/logout', async () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} accountPath="/admin/me" />);
    const { menu } = await open();
    const me = within(menu).getByRole('menuitem', { name: 'My account' });
    expect(me.tagName).toBe('A');
    expect(me.getAttribute('href')).toBe('/admin/me');
    const out = within(menu).getByRole('menuitem', { name: 'Sign out' });
    expect(out.tagName).toBe('A');
    expect(out.getAttribute('href')).toBe('/auth/logout');
  });

  it('without an account path there is no My account item and Sign out stays', async () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} />);
    const { menu } = await open();
    expect(itemNames(menu)).toEqual(['Compact', 'Regular', 'Sign out']);
    expect(within(menu).queryByText('My account')).toBeNull();
  });

  it('Sign out is a menuitem inside the menu, never a radio (it must not change the density)', async () => {
    const onChange = vi.fn();
    render(<UserMenu name={NAME} density="compact" onChange={onChange} />);
    const { menu } = await open();
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2);
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' }).getAttribute('aria-checked')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the menu is closed at first: no Sign out link until the button is pressed', () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByText('Sign out')).toBeNull();
    expect(screen.getByRole('button', { name: new RegExp(NAME) }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('<UserMenu> avatar and name', () => {
  it.each([
    ['Synthetic Technologist', 'ST'], ['Ana', 'A'], ['  ana   maria   lopez  ', 'AM'], ['ñandu perez', 'ÑP'],
  ])('initials of %j are %j and are hidden from assistive technology', (name, ini) => {
    const { container } = render(<UserMenu name={name} density="compact" onChange={() => {}} />);
    const av = container.querySelector('.lims-topbar-avatar')!;
    expect(av.textContent).toBe(ini);
    expect(av.getAttribute('aria-hidden')).toBe('true');
  });

  it('an empty name does not crash and gives an empty avatar', () => {
    const { container } = render(<UserMenu name="" density="compact" onChange={() => {}} />);
    expect(container.querySelector('.lims-topbar-avatar')!.textContent).toBe('');
  });

  it('a hostile display name is shown as text, never as markup', async () => {
    const evil = '<img src=x onerror=alert(1)> Eve';
    const { container } = render(<UserMenu name={evil} density="compact" onChange={() => {}} accountPath="/admin/me" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button').textContent).toContain(evil);
  });
});

describe('<UserMenu> keyboard', () => {
  it('opens with the checked density focused; ArrowDown reaches every item (Compact, Regular, My account, Sign out) and wraps to the first', async () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} accountPath="/admin/me" />);
    const { u } = await open();
    expect(focused()).toBe('Compact');
    const seen = [focused()];
    for (let i = 0; i < 4; i++) { await u.keyboard('{ArrowDown}'); seen.push(focused()); }
    expect(seen).toEqual(['Compact', 'Regular', 'My account', 'Sign out', 'Compact']);
  });

  it('ArrowUp goes backwards and wraps from the first item to Sign out', async () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} accountPath="/admin/me" />);
    const { u } = await open();
    await u.keyboard('{ArrowUp}');
    expect(focused()).toBe('Sign out');
    await u.keyboard('{ArrowUp}');
    expect(focused()).toBe('My account');
  });

  it('Home and End jump to the first and the last item', async () => {
    render(<UserMenu name={NAME} density="regular" onChange={() => {}} accountPath="/admin/me" />);
    const { u } = await open();
    expect(focused()).toBe('Regular');
    await u.keyboard('{End}');
    expect(focused()).toBe('Sign out');
    await u.keyboard('{Home}');
    expect(focused()).toBe('Compact');
  });

  it('without My account the arrows still reach Sign out and wrap (no hole in the item list)', async () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} />);
    const { u } = await open();
    const seen = [focused()];
    for (let i = 0; i < 3; i++) { await u.keyboard('{ArrowDown}'); seen.push(focused()); }
    expect(seen).toEqual(['Compact', 'Regular', 'Sign out', 'Compact']);
  });

  it('Enter on a density chooses it and closes; Enter on a link item does not change the density', async () => {
    const onChange = vi.fn();
    render(<UserMenu name={NAME} density="compact" onChange={onChange} accountPath="/admin/me" />);
    const { u } = await open();
    await u.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('regular');
    expect(screen.queryByRole('menu')).toBeNull();
    onChange.mockClear();
    await open();
    await u.keyboard('{End}');
    const out = screen.getByRole('menuitem', { name: 'Sign out' });
    out.addEventListener('click', (e) => e.preventDefault()); // jsdom cannot navigate
    await u.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Space on Sign out activates the link (a menu item answers Space as well as Enter)', async () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} />);
    const { u } = await open();
    await u.keyboard('{End}');
    const click = vi.fn((e: Event) => e.preventDefault());
    screen.getByRole('menuitem', { name: 'Sign out' }).addEventListener('click', click);
    await u.keyboard(' ');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the menu and returns focus to the actor button; Tab closes it too', async () => {
    render(<UserMenu name={NAME} density="compact" onChange={() => {}} accountPath="/admin/me" />);
    const { u } = await open();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: new RegExp(NAME) }));
    await u.click(screen.getByRole('button', { name: new RegExp(NAME) }));
    await u.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a click outside closes the menu', async () => {
    render(<div><p>elsewhere</p><UserMenu name={NAME} density="compact" onChange={() => {}} /></div>);
    const { u } = await open();
    await u.click(screen.getByText('elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('<AppShell> wires the menu from the manifest and the permissions', () => {
  const OTHER = navEntries.find((e) => e.id === 'frontdesk.worklist')!.permission; // a real permission that is not the account one
  const shell = (p: string[], menu?: 'elab' | 'modules') =>
    render(
      <AppShell session={session(p) as any} pathname="/lab/worklist" {...(menu ? { menu } : {})}>
        <p>page body</p>
      </AppShell>,
    );

  it('the account entry is permitted by identity.self.manage', () => {
    expect(ME.permission).toBe('identity.self.manage');
    expect(ME.path).toBe('/admin/me');
  });

  it.each([['elab' as const], ['modules' as const]])('menu=%s: an actor who may open admin.me gets My account (link to its path), Sign out and the densities', async (menu) => {
    shell([ME.permission], menu);
    const { menu: m } = await open();
    expect(itemNames(m)).toEqual(['Compact', 'Regular', 'My account', 'Sign out']);
    expect(within(m).getByRole('menuitem', { name: 'My account' }).getAttribute('href')).toBe(ME.path);
    expect(within(m).getByRole('menuitem', { name: 'Sign out' }).getAttribute('href')).toBe('/auth/logout');
  });

  it('an actor without that permission gets no My account item, but still gets Sign out', async () => {
    shell([OTHER]);
    const { menu: m } = await open();
    expect(itemNames(m)).toEqual(['Compact', 'Regular', 'Sign out']);
  });

  it('an actor with no permission at all can still sign out (the menu never depends on the manifest)', async () => {
    shell([]);
    const { menu: m } = await open();
    expect(itemNames(m)).toEqual(['Compact', 'Regular', 'Sign out']);
  });

  it('a platform session has Sign out and no My account (admin.me is a staff entry)', async () => {
    render(<AppShell session={session([ME.permission], { kind: 'platform' }) as any} pathname="/platform/tenants" menu="elab"><p>x</p></AppShell>);
    const { menu: m } = await open();
    expect(itemNames(m)).toEqual(['Compact', 'Regular', 'Sign out']);
  });

  it('the density choice still works from inside the same menu (T0D-DENSITY-1 is not broken)', async () => {
    shell([ME.permission]);
    const { u, menu: m } = await open();
    await u.click(within(m).getByRole('menuitemradio', { name: 'Regular' }));
    expect(screen.getByTestId('app-shell').closest('[data-density]')!.getAttribute('data-density')).toBe('regular');
  });

  it('the staff layout asks for the ElabAssist menu', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'app', '(staff)', 'layout.tsx'), 'utf8');
    expect(src).toMatch(/<AppShell[^>]*\bmenu="elab"/);
  });
});
