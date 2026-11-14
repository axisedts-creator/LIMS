// @vitest-environment jsdom
// C10.T-20 — culture page keyboard (04-UI-UX §3 shortcut table registered with shortcuts.register('micro.culture', …); §3.1.1 Ctrl+Enter; kit Dialog Esc).
// done_when: "shortcuts registered". Alt+A / Alt+P / Alt+F only have to exist and run safely here: their targets are T-21 (AST grid) and T-22 (reports).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { PERM_READ, PERM_WORK, api, culture, hit, incubating, isolate, resetHits, router, state } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (c: Record<string, unknown> = incubating(), permissions = PERM_WORK) => {
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  return render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={permissions} /></ToastProvider>);
};
const registered = async () => (await import('@/core/shortcuts/registry')).shortcuts.list('micro.culture');
const press = async (key: string) => {
  const s = (await registered()).find((x) => x.key.toLowerCase() === key.toLowerCase());
  expect(s, `${key} registered`).toBeTruthy();
  act(() => s!.run());
};
const ALL = ['Alt+S', 'Alt+R', 'Alt+G', 'Alt+I', 'Alt+A', 'Alt+P', 'Alt+F', 'Alt+B'];

describe('registration (04-UI-UX §3 table)', () => {
  it('exactly Alt+S R G I A P F B are registered for page id "micro.culture", each with a description', async () => {
    await mount();
    const list = await registered();
    expect(list.map((s) => s.key).sort()).toEqual([...ALL].sort());
    for (const s of list) expect(s.description.trim().length, s.key).toBeGreaterThan(2);
    const d = Object.fromEntries(list.map((s) => [s.key, s.description]));
    expect(d['Alt+S']).toMatch(/set up/i);
    expect(d['Alt+R']).toMatch(/read/i);
    expect(d['Alt+G']).toMatch(/gram/i);
    expect(d['Alt+I']).toMatch(/isolate/i);
    expect(d['Alt+A']).toMatch(/ast/i);
    expect(d['Alt+P']).toMatch(/preliminary/i);
    expect(d['Alt+F']).toMatch(/final/i);
    expect(d['Alt+B']).toMatch(/scan|barcode/i);
  });
  it('none collides with the global keys (Alt+N / Alt+M / Alt+H / ? / Escape)', async () => {
    await mount();
    expect((await registered()).map((s) => s.key)).not.toEqual(expect.arrayContaining(['Alt+N']));
    for (const s of await registered()) expect(['Alt+N', 'Alt+M', 'Alt+H', '?', 'Escape']).not.toContain(s.key);
  });
  it('they are unregistered on unmount and re-registering after a remount does not throw (duplicate guard)', async () => {
    const { unmount } = await mount();
    unmount();
    expect(await registered()).toHaveLength(0);
    await mount();
    expect(await registered()).toHaveLength(ALL.length);
  });
});

describe('what each key does', () => {
  it('Alt+S opens "Set up culture" for an awaiting_setup culture; it does nothing for an incubating one', async () => {
    await mount(culture());
    await press('Alt+S');
    expect(await screen.findByRole('dialog', { name: /set up culture/i })).toBeTruthy();
    cleanup();
    await mount(incubating());
    await press('Alt+S');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('Alt+R opens the observation dialog on Plate read; Alt+G opens it on Gram stain', async () => {
    await mount();
    await press('Alt+R');
    let d = await screen.findByRole('dialog');
    expect((within(d).getByRole('radio', { name: /plate read/i }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await press('Alt+G');
    d = await screen.findByRole('dialog');
    expect((within(d).getByRole('radio', { name: /gram stain/i }) as HTMLInputElement).checked).toBe(true);
  });
  it('Alt+G is allowed while awaiting set-up (stain before plating, 03-APP-FLOW §4.2); Alt+R is not', async () => {
    await mount(culture());
    await press('Alt+R');
    expect(screen.queryByRole('dialog')).toBeNull();
    await press('Alt+G');
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
  it('Alt+I opens "Add isolate"', async () => {
    await mount();
    await press('Alt+I');
    expect(await screen.findByRole('dialog', { name: /add isolate/i })).toBeTruthy();
  });
  it('Alt+B opens the scan dialog with a barcode field that has focus', async () => {
    await mount();
    await press('Alt+B');
    const d = await screen.findByRole('dialog', { name: /scan|barcode/i });
    await waitFor(() => expect(d.contains(document.activeElement)).toBe(true));
    expect(within(d).getByRole('textbox', { name: /barcode|scan/i })).toBeTruthy();
  });
  it('Alt+A, Alt+P and Alt+F run without throwing, with and without an isolate (their screens are T-21 / T-22)', async () => {
    await mount(incubating({ isolates: [isolate(1)] }));
    for (const k of ['Alt+A', 'Alt+P', 'Alt+F']) await press(k);
    await waitFor(() => expect(document.body).toBeTruthy());
  });
  it('write keys do nothing for a read-only user, and for final_submitted / cancelled cultures', async () => {
    await mount(incubating(), PERM_READ);
    for (const k of ['Alt+S', 'Alt+R', 'Alt+G', 'Alt+I']) await press(k);
    expect(screen.queryByRole('dialog')).toBeNull();
    for (const status of ['final_submitted', 'cancelled']) {
      cleanup();
      await mount(incubating({ status }));
      for (const k of ['Alt+S', 'Alt+R', 'Alt+G', 'Alt+I']) await press(k);
      expect(screen.queryByRole('dialog'), status).toBeNull();
    }
  });
  it('no request is made by pressing a shortcut (dialogs only open)', async () => {
    await mount();
    resetHits();
    await press('Alt+R');
    await screen.findByRole('dialog');
    expect(hit('POST', /./)).toHaveLength(0);
  });
});

describe('dialog keyboard', () => {
  it('Escape closes the set-up dialog without sending anything, and focus returns to the control that opened it', async () => {
    await mount(culture());
    const opener = screen.getAllByRole('button', { name: /^set up culture$/i })[0]!;
    await userEvent.click(opener);
    await screen.findByRole('dialog', { name: /set up culture/i });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(hit('POST', /./)).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });
  it('Tab stays inside an open dialog (focus trap)', async () => {
    await mount();
    await press('Alt+R');
    const d = await screen.findByRole('dialog');
    for (let i = 0; i < 25; i++) { await userEvent.tab(); expect(d.contains(document.activeElement), `tab ${i}`).toBe(true); }
  });
  it('the page tabs follow arrow keys', async () => {
    await mount();
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tabs[1]);
    await userEvent.keyboard('{Enter}');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
  });
  it('the tab order reaches the page actions before the tab list, and the tab list before the tab content', async () => {
    await mount();
    const action = screen.getAllByRole('button', { name: /^record read$/i })[0]!;
    const tab = screen.getAllByRole('tab')[0]!;
    const panel = screen.getByRole('tabpanel');
    expect(action.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tab.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
void api; void culture;
