// @vitest-environment jsdom
// T0D-DENSITY-1 (LD-310; founder 2026-11-17 04:49 and 05:03 NPT): compact is the default density of every staff screen; auth screens keep regular;
// a switch in the user menu stores the choice per user in local storage (try/catch, falls back to compact); regular stays available.
//
// CONTRACT chosen by the tester where the brief gives no name (writer: follow it, or dispute in .orchestra/notes):
//   The staff shell root (the element with data-testid="app-shell", or an ancestor wrapper) carries data-density="compact" | "regular".
//   Server render and first client render are "compact" (no flash, no hydration mismatch); the stored choice is applied after mount.
//   User menu: a <button aria-haspopup="menu"> in the top bar whose accessible name contains the actor's display name. Pressing it opens role="menu"
//   with two role="menuitemradio" items named /compact/i and /regular/i; aria-checked marks the current one; choosing one applies it at once
//   and closes the menu. (A Rail user card is not a button, so the name is unique.)
//   Storage: window.localStorage, one key per user that starts with "lims.density" and includes the actor's membershipId; the value is "compact" or "regular".
//   Anything else (missing, "banana", a throwing getItem/setItem) means compact; a throwing setItem still switches the screen for this page view.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PERMS, session, user } from './r04.harness';
import { AppShell } from '../AppShell';

vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('./r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock);
vi.mock('@/core/nav/generated', async () => (await import('./r04.harness')).generatedMock);

const A = '01a1a98a-ac40-7000-8000-000000000900';
const B = '01a1a98a-ac40-7000-8000-000000000901';
const NAME = 'Synthetic Technologist';
const shellOf = (membershipId = A) =>
  (
    <AppShell session={session(ALL_PERMS, { actor: { displayName: NAME, tenantCode: 'syn', roles: ['r'], permissions: ALL_PERMS, membershipId } }) as any} pathname="/lab/worklist">
      <p>page body</p>
    </AppShell>
  );
const density = () => (screen.getByTestId('app-shell').closest('[data-density]') as HTMLElement | null)?.getAttribute('data-density') ?? null;
const keys = () => Object.keys(localStorage).filter((k) => k.startsWith('lims.density'));
const openMenu = async () => {
  const u = user();
  await u.click(screen.getByRole('button', { name: new RegExp(NAME) }));
  return { u, menu: screen.getByRole('menu') };
};

beforeEach(() => localStorage.clear());

describe('default density (done_when 1)', () => {
  it('the staff shell is compact by default, in the server HTML and in the first client render', () => {
    const html = renderToString(shellOf());
    expect(html).toMatch(/data-density="compact"/);
    expect(html).not.toMatch(/data-density="regular"/);
    render(shellOf());
    expect(density()).toBe('compact');
  });
  it('the compact attribute wraps the whole shell: top bar, rail and page body are inside it', () => {
    render(shellOf());
    const host = screen.getByTestId('app-shell').closest('[data-density]')!;
    expect(host.contains(screen.getByRole('banner'))).toBe(true);
    expect(host.contains(screen.getByRole('navigation', { name: 'Main' }))).toBe(true);
    expect(host.contains(screen.getByRole('main'))).toBe(true);
  });
});

describe('the user menu switch', () => {
  it('opens a menu with Compact (checked) and Regular, named radio items', async () => {
    render(shellOf());
    const { menu } = await openMenu();
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent?.trim())).toEqual([expect.stringMatching(/compact/i), expect.stringMatching(/regular/i)]);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    expect(items[1]!.getAttribute('aria-checked')).toBe('false');
  });
  it('choosing Regular switches the screen at once, stores it in local storage and closes the menu', async () => {
    render(shellOf());
    const { u, menu } = await openMenu();
    await u.click(within(menu).getByRole('menuitemradio', { name: /regular/i }));
    expect(density()).toBe('regular');
    expect(keys().length).toBe(1);
    expect(localStorage.getItem(keys()[0]!)).toBe('regular');
    expect(screen.queryByRole('menu')).toBeNull();
    const again = (await openMenu()).menu;
    expect(within(again).getByRole('menuitemradio', { name: /regular/i }).getAttribute('aria-checked')).toBe('true');
  });
  it('and back to Compact', async () => {
    render(shellOf());
    let r = await openMenu();
    await r.u.click(within(r.menu).getByRole('menuitemradio', { name: /regular/i }));
    r = await openMenu();
    await r.u.click(within(r.menu).getByRole('menuitemradio', { name: /compact/i }));
    expect(density()).toBe('compact');
    expect(localStorage.getItem(keys()[0]!)).toBe('compact');
  });
  it('Escape closes the menu and returns focus to its button', async () => {
    render(shellOf());
    const { u } = await openMenu();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: new RegExp(NAME) }));
  });
  it('is reachable and operable by keyboard alone (Enter opens, arrows move, Enter chooses)', async () => {
    render(shellOf());
    const u = user();
    screen.getByRole('button', { name: new RegExp(NAME) }).focus();
    await u.keyboard('{Enter}');
    const menu = screen.getByRole('menu');
    expect(menu.contains(document.activeElement)).toBe(true);
    await u.keyboard('{ArrowDown}');
    await u.keyboard('{Enter}');
    expect(density()).toBe('regular');
  });
});

describe('stored choice (per user, local storage, try/catch)', () => {
  it('a stored "regular" is applied after mount', async () => {
    render(shellOf());
    const { u, menu } = await openMenu();
    await u.click(within(menu).getByRole('menuitemradio', { name: /regular/i }));
    document.body.innerHTML = '';
    render(shellOf());
    await waitFor(() => expect(density()).toBe('regular'));
  });
  it('the choice is per user: another user on the same browser still gets compact', async () => {
    render(shellOf(A));
    const { u, menu } = await openMenu();
    await u.click(within(menu).getByRole('menuitemradio', { name: /regular/i }));
    document.body.innerHTML = '';
    render(shellOf(B));
    await act(async () => {});
    expect(density()).toBe('compact');
    document.body.innerHTML = '';
    render(shellOf(A));
    await waitFor(() => expect(density()).toBe('regular'));
  });
  it.each(['banana', '', 'COMPACT ', '<script>', 'regular;x'])('a bad stored value %j falls back to compact', async (bad) => {
    // write under the key the app would use: learn it first through a real choice, then corrupt it
    render(shellOf());
    const { u, menu } = await openMenu();
    await u.click(within(menu).getByRole('menuitemradio', { name: /regular/i }));
    const key = keys()[0]!;
    localStorage.setItem(key, bad);
    document.body.innerHTML = '';
    render(shellOf());
    await act(async () => {});
    expect(density()).toBe('compact');
  });
  it('a throwing getItem (blocked storage) falls back to compact and the shell still renders', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    render(shellOf());
    await act(async () => {});
    expect(density()).toBe('compact');
    expect(screen.getByRole('main')).toBeTruthy();
  });
  it('a throwing setItem (quota or blocked) does not crash: the screen still switches for this page view', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    render(shellOf());
    const { u, menu } = await openMenu();
    await u.click(within(menu).getByRole('menuitemradio', { name: /regular/i }));
    expect(density()).toBe('regular');
    expect(screen.getByRole('main')).toBeTruthy();
  });
  it('the stored value holds no personal data beyond the id: no name, no tenant code', async () => {
    render(shellOf());
    const { u, menu } = await openMenu();
    await u.click(within(menu).getByRole('menuitemradio', { name: /regular/i }));
    for (const k of keys()) expect(`${k}=${localStorage.getItem(k)}`).not.toMatch(/Synthetic Technologist|syn\b/);
  });
});

describe('auth screens and the root layout keep regular (done_when 1)', () => {
  const APP = join(import.meta.dirname, '..', '..', '..', 'app');
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' || n === 'node_modules' ? [] : walk(p)) : [p]; });
  it('the root layout and every file under app/(auth) never set data-density (they would turn the sign-in screens compact)', () => {
    const files = [join(APP, 'layout.tsx'), ...walk(join(APP, '(auth)')).filter((f) => /\.(tsx?|css)$/.test(f))];
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/data-density/);
  });
  it('the default is applied by the shell (staff layout), not by <html> or <body>', () => {
    const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');
    expect(layout).not.toMatch(/density/i);
  });
});
