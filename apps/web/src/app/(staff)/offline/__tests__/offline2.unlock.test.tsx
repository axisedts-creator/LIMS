// @vitest-environment jsdom
// T0D-OFFLINE-2 done_when 4: OFFLINE UNLOCK is an overlay inside the staff shell (not a route under app/(auth)): PIN entry, attempts left,
// a clear message when the retention window has passed or the device was revoked; the PIN is set after an online sign in.
// Contract (see offline2.fixtures.tsx for the controller):
//   snapshot.storeState 'locked'  -> a modal role="dialog" named /unlock/i with a password field labelled exactly "PIN" and a button "Unlock"; focus starts in the field.
//        online: a "Not now" button hides it for this page view; offline: no way to dismiss it.
//   controller.unlock(pin) -> { ok: true }: the controller moves storeState to 'unlocked' and the overlay goes.
//        { ok:false, reason:'wrong_pin', attemptsLeft: n }: text "n attempts left" ("1 attempt left"), field cleared and focused again.
//        'expired': text naming the retention window and that a sign in online is needed; no PIN field.
//        'wiped': text that the local data was wiped (too many wrong PINs); no PIN field.
//        'revoked' (also storeState 'revoked' at the start): text that the device was revoked; no PIN field.
//   While unlock runs (PBKDF2 is slow) the button is disabled and a second submit is ignored.
//   snapshot.storeState 'empty' (no PIN yet) and conn online -> dialog named /set.*pin/i, fields "New PIN" and "Confirm new PIN", buttons "Set PIN" and "Skip for now".
//        Different PINs or an empty PIN: error text, controller.setupPin not called. Offline + empty: no overlay (a PIN is set online only).
//        A 'wiped' store while online is offered the same set up dialog (a new PIN starts a fresh store); 'revoked' is never offered one.
//   'unlocked': no overlay.
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { ALL_PERMS, session, user } from '@/core/shell/__tests__/r04.harness';
import { AppShell } from '@/core/shell/AppShell';
import { fakeController, withProvider } from './offline2.fixtures';

vi.mock('next/navigation', async () => (await import('@/core/shell/__tests__/r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('@/core/shell/__tests__/r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('@/core/shell/__tests__/r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('@/core/shell/__tests__/r04.harness')).actionsMock);
vi.mock('@/core/nav/generated', async () => (await import('@/core/shell/__tests__/r04.harness')).generatedMock);

const shell = () => <AppShell session={session(ALL_PERMS) as never} pathname="/lab/worklist"><p>page body</p></AppShell>;
const mount = async (c: ReturnType<typeof fakeController>) => render(await withProvider(c, shell()));
const dialog = () => screen.getByRole('dialog', { name: /unlock/i });
const pinField = () => screen.getByLabelText('PIN') as HTMLInputElement;

describe('locked store', () => {
  it('shows a modal PIN dialog inside the shell; the field is a password field and has focus', async () => {
    await mount(fakeController({ storeState: 'locked', conn: 'offline' }));
    expect(screen.getByTestId('app-shell').contains(dialog())).toBe(true);
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(pinField().type).toBe('password');
    expect(document.activeElement).toBe(pinField());
    expect(within(dialog()).getByRole('button', { name: 'Unlock' })).toBeTruthy();
  });
  it('a correct PIN calls unlock once with the PIN and the overlay goes', async () => {
    const c = fakeController({ storeState: 'locked', conn: 'offline' });
    await mount(c);
    const u = user();
    await u.type(pinField(), '481516');
    await u.click(within(dialog()).getByRole('button', { name: 'Unlock' }));
    expect(c.unlock).toHaveBeenCalledTimes(1);
    expect(c.unlock).toHaveBeenCalledWith('481516');
    expect(screen.queryByRole('dialog', { name: /unlock/i })).toBeNull();
  });
  it('Enter submits the same way', async () => {
    const c = fakeController({ storeState: 'locked', conn: 'offline' });
    await mount(c);
    const u = user();
    await u.type(pinField(), '481516{Enter}');
    expect(c.unlock).toHaveBeenCalledWith('481516');
  });
  it('a wrong PIN shows the attempts left (singular at 1), clears the field and focuses it again', async () => {
    const c = fakeController({ storeState: 'locked', conn: 'offline' });
    c.unlock.mockResolvedValueOnce({ ok: false, reason: 'wrong_pin', attemptsLeft: 7 });
    c.unlock.mockResolvedValueOnce({ ok: false, reason: 'wrong_pin', attemptsLeft: 1 });
    await mount(c);
    const u = user();
    await u.type(pinField(), '000000{Enter}');
    expect(dialog().textContent).toMatch(/7 attempts left/i);
    expect(pinField().value).toBe('');
    expect(document.activeElement).toBe(pinField());
    await u.type(pinField(), '111111{Enter}');
    expect(dialog().textContent).toMatch(/1 attempt left/i);
    expect(dialog().textContent).not.toMatch(/1 attempts left/i);
  });
  it('an empty PIN is not sent', async () => {
    const c = fakeController({ storeState: 'locked', conn: 'offline' });
    await mount(c);
    const u = user();
    await u.click(within(dialog()).getByRole('button', { name: 'Unlock' }));
    expect(c.unlock).not.toHaveBeenCalled();
  });
  it('while the check runs the button is disabled and a second submit is ignored', async () => {
    const c = fakeController({ storeState: 'locked', conn: 'offline' });
    let release!: (v: { ok: true }) => void;
    c.unlock.mockImplementationOnce(() => new Promise((res) => { release = res as never; }));
    await mount(c);
    const u = user();
    await u.type(pinField(), '481516{Enter}');
    expect((within(dialog()).getByRole('button', { name: 'Unlock' }) as HTMLButtonElement).disabled).toBe(true);
    await u.type(pinField(), '{Enter}');
    expect(c.unlock).toHaveBeenCalledTimes(1);
    await act(async () => { release({ ok: true }); });
  });
  it('the retention window has passed: clear message, no PIN field', async () => {
    const c = fakeController({ storeState: 'locked', conn: 'offline' });
    c.unlock.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    await mount(c);
    await user().type(pinField(), '481516{Enter}');
    expect(dialog().textContent).toMatch(/retention/i);
    expect(dialog().textContent).toMatch(/sign in online/i);
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });
  it('too many wrong PINs: the data was wiped, no PIN field', async () => {
    const c = fakeController({ storeState: 'locked', conn: 'offline' });
    c.unlock.mockResolvedValueOnce({ ok: false, reason: 'wiped' });
    await mount(c);
    await user().type(pinField(), '000000{Enter}');
    expect(dialog().textContent).toMatch(/wiped|erased/i);
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });
  it('a revoked device says so from the start and offers no PIN field', async () => {
    await mount(fakeController({ storeState: 'revoked', conn: 'offline' }));
    const d = screen.getByRole('dialog');
    expect(d.textContent).toMatch(/revoked/i);
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });
  it('a wiped store says so from the start', async () => {
    await mount(fakeController({ storeState: 'wiped', conn: 'offline' }));
    expect(screen.getByRole('dialog').textContent).toMatch(/wiped|erased/i);
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });
  it('online the dialog can be dismissed with "Not now"', async () => {
    await mount(fakeController({ storeState: 'locked', conn: 'online' }));
    await user().click(within(dialog()).getByRole('button', { name: /not now/i }));
    expect(screen.queryByRole('dialog', { name: /unlock/i })).toBeNull();
  });
  it('offline there is no way out: no "Not now", Escape does not close it', async () => {
    await mount(fakeController({ storeState: 'locked', conn: 'offline' }));
    expect(within(dialog()).queryByRole('button', { name: /not now/i })).toBeNull();
    await user().keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: /unlock/i })).toBeTruthy();
  });
  it('the PIN is never written into the page outside the field', async () => {
    await mount(fakeController({ storeState: 'locked', conn: 'offline' }));
    await user().type(pinField(), '481516');
    expect(document.body.innerHTML.replace(/value="[^"]*"/g, '')).not.toContain('481516');
  });
  it('an unlocked or empty (offline) store shows no overlay', async () => {
    const c = fakeController({ storeState: 'unlocked' });
    await mount(c);
    expect(screen.queryByRole('dialog')).toBeNull();
    c.set({ storeState: 'empty', conn: 'offline' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('PIN set up after an online sign in', () => {
  const setup = () => screen.getByRole('dialog', { name: /set.*pin/i });
  it('an empty store while online asks for a PIN with a confirmation field', async () => {
    await mount(fakeController({ storeState: 'empty', conn: 'online' }));
    expect(screen.getByLabelText('New PIN')).toBeTruthy();
    expect(screen.getByLabelText('Confirm new PIN')).toBeTruthy();
    expect(within(setup()).getByRole('button', { name: 'Set PIN' })).toBeTruthy();
    expect(within(setup()).getByRole('button', { name: 'Skip for now' })).toBeTruthy();
  });
  it('matching PINs call setupPin once and the overlay goes', async () => {
    const c = fakeController({ storeState: 'empty', conn: 'online' });
    await mount(c);
    const u = user();
    await u.type(screen.getByLabelText('New PIN'), '2468');
    await u.type(screen.getByLabelText('Confirm new PIN'), '2468');
    await u.click(within(setup()).getByRole('button', { name: 'Set PIN' }));
    expect(c.setupPin).toHaveBeenCalledTimes(1);
    expect(c.setupPin).toHaveBeenCalledWith('2468');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('different PINs, or none, show an error and call nothing', async () => {
    const c = fakeController({ storeState: 'empty', conn: 'online' });
    await mount(c);
    const u = user();
    await u.click(within(setup()).getByRole('button', { name: 'Set PIN' }));
    expect(c.setupPin).not.toHaveBeenCalled();
    await u.type(screen.getByLabelText('New PIN'), '2468');
    await u.type(screen.getByLabelText('Confirm new PIN'), '1357');
    await u.click(within(setup()).getByRole('button', { name: 'Set PIN' }));
    expect(c.setupPin).not.toHaveBeenCalled();
    expect(within(setup()).getByRole('alert').textContent).toMatch(/match/i);
  });
  it('"Skip for now" closes it without a PIN', async () => {
    const c = fakeController({ storeState: 'empty', conn: 'online' });
    await mount(c);
    await user().click(within(setup()).getByRole('button', { name: 'Skip for now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(c.setupPin).not.toHaveBeenCalled();
  });
  it('a wiped store while online is offered a new PIN as well', async () => {
    await mount(fakeController({ storeState: 'wiped', conn: 'online' }));
    expect(screen.getByRole('dialog', { name: /set.*pin/i })).toBeTruthy();
  });
});
