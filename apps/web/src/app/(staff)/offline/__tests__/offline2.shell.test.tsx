// @vitest-environment jsdom
// T0D-OFFLINE-2 (LD-322, LD-353; founder 2026-11-17 09:19 NPT) done_when 1 and 6: the status chip, the offline banner, the clock skew warning
// and the sign out warning, all inside the staff shell. Contract: see offline2.fixtures.tsx, plus
//   @/core/offline/chip   exports chipState({ conn, pending, attention, conflicts, prefetch: { ready, fetchedAt }, now })
//                         -> { kind: 'online' | 'offline' | 'syncing' | 'attention' | 'ready', label }   (pure; the label comes from the message catalogue)
//     priority: syncing > attention (attention + conflicts > 0) > offline (offline or degraded) > ready > online
//     labels:   "Online" | "Offline" or "Offline, N pending" | "Syncing" | "Needs attention N" | "Ready for offline, updated <age>"
//     age:      "just now" (< 1 min) | "N min ago" | "N h ago" | "N d ago"
//   The shell (AppShell/ShellFrame) renders, only when an OfflineProvider is above it:
//     the chip   = a link to /offline in the top bar, data-testid="offline-chip", data-state = chip kind, accessible name = the label;
//     a banner   = text "working offline" while the connection is offline or degraded (nothing while online);
//     a warning  = text about the device "clock" while snapshot.skewFlag;
//     the Sign out menu item: with pending + attention + conflicts > 0 the click is prevented and an alertdialog says how many are not synced,
//       that they stay on this device encrypted, and, when snapshot.signedInUsers is 1, that you are the last person signed in;
//       buttons "Sign out anyway" (a link to /auth/logout) and "Stay signed in".
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ALL_PERMS, session, user } from '@/core/shell/__tests__/r04.harness';
import { AppShell } from '@/core/shell/AppShell';
import { attentionItem, conflictItem, fakeController, NOW, op, withProvider } from './offline2.fixtures';

vi.mock('next/navigation', async () => (await import('@/core/shell/__tests__/r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('@/core/shell/__tests__/r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('@/core/shell/__tests__/r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('@/core/shell/__tests__/r04.harness')).actionsMock);
vi.mock('@/core/nav/generated', async () => (await import('@/core/shell/__tests__/r04.harness')).generatedMock);

const NAME = 'Synthetic Technologist';
const shell = () => (
  <AppShell session={session(ALL_PERMS, { actor: { displayName: NAME, tenantCode: 'syn', roles: ['r'], permissions: ALL_PERMS, membershipId: '01a1a98a-ac40-7000-8000-000000000900' } }) as never} pathname="/lab/worklist">
    <p>page body</p>
  </AppShell>
);
const mount = async (c: ReturnType<typeof fakeController>) => render(await withProvider(c, shell()));
const chip = () => screen.getByTestId('offline-chip');

describe('chipState (pure)', () => {
  const base = { conn: 'online' as const, pending: 0, attention: 0, conflicts: 0, prefetch: { ready: false, fetchedAt: null as number | null }, now: NOW };
  it('Online when connected, nothing pending and not yet cached', async () => {
    const { chipState } = await import('@/core/offline/chip');
    const s = chipState(base);
    expect(s.kind).toBe('online');
    expect(s.label).toMatch(/^online$/i);
  });
  it('Offline with N pending (degraded counts as offline); no "0 pending" when nothing waits', async () => {
    const { chipState } = await import('@/core/offline/chip');
    for (const conn of ['offline', 'degraded'] as const) {
      const s = chipState({ ...base, conn, pending: 3 });
      expect(s.kind).toBe('offline');
      expect(s.label).toMatch(/offline/i);
      expect(s.label).toMatch(/3 pending/i);
    }
    const none = chipState({ ...base, conn: 'offline' });
    expect(none.label).toMatch(/offline/i);
    expect(none.label).not.toMatch(/pending/i);
  });
  it('Syncing wins over everything while a batch is in flight', async () => {
    const { chipState } = await import('@/core/offline/chip');
    const s = chipState({ ...base, conn: 'syncing', pending: 2, attention: 1 });
    expect(s.kind).toBe('syncing');
    expect(s.label).toMatch(/syncing/i);
  });
  it('Needs attention N counts attention items and conflicts, and wins over offline and ready', async () => {
    const { chipState } = await import('@/core/offline/chip');
    const s = chipState({ ...base, conn: 'offline', attention: 2, conflicts: 1, pending: 4, prefetch: { ready: true, fetchedAt: NOW } });
    expect(s.kind).toBe('attention');
    expect(s.label).toMatch(/needs attention 3/i);
  });
  it('Ready for offline shows the age of the cached data', async () => {
    const { chipState } = await import('@/core/offline/chip');
    const at = (ms: number) => chipState({ ...base, prefetch: { ready: true, fetchedAt: NOW - ms } });
    expect(at(10_000).kind).toBe('ready');
    expect(at(10_000).label).toMatch(/ready for offline/i);
    expect(at(10_000).label).toMatch(/just now/i);
    expect(at(5 * 60_000).label).toMatch(/5 min ago/i);
    expect(at(3 * 3_600_000).label).toMatch(/3 h ago/i);
    expect(at(2 * 86_400_000).label).toMatch(/2 d ago/i);
  });
  it('not ready stays Online even when an old fetch time exists', async () => {
    const { chipState } = await import('@/core/offline/chip');
    expect(chipState({ ...base, prefetch: { ready: false, fetchedAt: NOW - 1000 } }).kind).toBe('online');
  });
});

describe('the chip in the staff shell', () => {
  it('without a provider the shell shows no chip, no banner and no overlay', () => {
    render(shell());
    expect(screen.queryByTestId('offline-chip')).toBeNull();
    expect(screen.queryByText(/working offline/i)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('is a keyboard reachable link to /offline in the top bar, named by its label', async () => {
    await mount(fakeController({ conn: 'offline', pending: [op(1), op(2), op(3)] }));
    const el = chip();
    expect(screen.getByRole('banner').contains(el)).toBe(true);
    expect(el.getAttribute('data-state')).toBe('offline');
    const link = within(el).queryByRole('link') ?? (el.closest('a') as HTMLElement);
    expect(link.getAttribute('href')).toBe('/offline');
    expect(link.tabIndex).toBeGreaterThanOrEqual(0);
    expect(link.textContent).toMatch(/offline/i);
    expect(link.textContent).toMatch(/3 pending/i);
    link.focus();
    expect(document.activeElement).toBe(link);
  });
  it('shows each state and follows the controller without a remount', async () => {
    const c = fakeController({ conn: 'online' });
    await mount(c);
    expect(chip().getAttribute('data-state')).toBe('online');
    expect(chip().textContent).toMatch(/^\s*online\s*$/i);
    c.set({ conn: 'offline', pending: [op(1)] });
    expect(chip().getAttribute('data-state')).toBe('offline');
    c.set({ conn: 'syncing' });
    expect(chip().getAttribute('data-state')).toBe('syncing');
    c.set({ conn: 'online', pending: [], attention: [attentionItem(2)], conflicts: [conflictItem(3)] });
    expect(chip().getAttribute('data-state')).toBe('attention');
    expect(chip().textContent).toMatch(/needs attention 2/i);
    c.set({ attention: [], conflicts: [], prefetch: { ready: true, fetchedAt: NOW - 5 * 60_000, bytes: 1000, capBytes: 1e8 } });
    expect(chip().getAttribute('data-state')).toBe('ready');
    expect(chip().textContent).toMatch(/ready for offline/i);
    expect(chip().textContent).toMatch(/5 min ago/i);
  });
  it('stops listening when the shell unmounts', async () => {
    const c = fakeController();
    const subscribe = vi.spyOn(c, 'subscribe');
    const view = await mount(c);
    expect(subscribe).toHaveBeenCalled();
    view.unmount();
    expect(() => c.set({ conn: 'offline' })).not.toThrow();
  });
});

describe('banner and clock skew warning', () => {
  it('the banner appears while offline or degraded and is gone while online', async () => {
    const c = fakeController({ conn: 'online' });
    await mount(c);
    expect(screen.queryByText(/working offline/i)).toBeNull();
    c.set({ conn: 'offline' });
    expect(screen.getByText(/working offline/i)).toBeTruthy();
    c.set({ conn: 'degraded' });
    expect(screen.getByText(/working offline/i)).toBeTruthy();
    c.set({ conn: 'online' });
    expect(screen.queryByText(/working offline/i)).toBeNull();
  });
  it('the clock warning shows only when the skew flag is set, in any connection state', async () => {
    const c = fakeController({ conn: 'online', skewFlag: false });
    await mount(c);
    expect(screen.queryByText(/clock/i)).toBeNull();
    c.set({ skewFlag: true });
    expect(screen.getByText(/clock/i)).toBeTruthy();
    c.set({ conn: 'offline' });
    expect(screen.getByText(/clock/i)).toBeTruthy();
  });
});

describe('signing out with unsynced operations (done_when 6)', () => {
  const openMenu = async () => {
    const u = user();
    await u.click(screen.getByRole('button', { name: new RegExp(NAME) }));
    return { u, signOut: screen.getByRole('menuitem', { name: /sign out/i }) };
  };
  it('nothing unsynced: sign out is not intercepted', async () => {
    await mount(fakeController({ conn: 'online' }));
    const { signOut } = await openMenu();
    expect(fireEvent.click(signOut)).toBe(true); // true = default not prevented
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('pending, attention and conflicts all count: the click is stopped and the dialog says how many stay on the device, encrypted', async () => {
    await mount(fakeController({ pending: [op(1), op(2)], attention: [attentionItem(3)], conflicts: [conflictItem(4)], signedInUsers: 2 }));
    const { signOut } = await openMenu();
    expect(fireEvent.click(signOut)).toBe(false);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/4/);
    expect(dialog.textContent).toMatch(/not (yet )?(synced|sent)/i);
    expect(dialog.textContent).toMatch(/encrypted/i);
    expect(dialog.textContent).toMatch(/this device/i);
    expect(dialog.textContent).not.toMatch(/last (person|user)/i); // another person is still signed in
  });
  it('the last person signed in is told so plainly', async () => {
    await mount(fakeController({ pending: [op(1)], signedInUsers: 1 }));
    const { signOut } = await openMenu();
    fireEvent.click(signOut);
    expect(screen.getByRole('alertdialog').textContent).toMatch(/last (person|user)/i);
  });
  it('"Sign out anyway" goes to /auth/logout; "Stay signed in" closes the dialog and keeps the session', async () => {
    await mount(fakeController({ pending: [op(1)] }));
    const first = await openMenu();
    fireEvent.click(first.signOut);
    const anyway = within(screen.getByRole('alertdialog')).getByText(/sign out anyway/i).closest('a');
    expect(anyway?.getAttribute('href')).toBe('/auth/logout');
    await first.u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /stay signed in/i }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('the dialog is keyboard safe: focus moves in, Escape closes it', async () => {
    await mount(fakeController({ pending: [op(1)] }));
    const { u, signOut } = await openMenu();
    fireEvent.click(signOut);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
