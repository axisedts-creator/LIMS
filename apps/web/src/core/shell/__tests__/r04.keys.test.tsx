// @vitest-environment jsdom
// T0D-UI-R04: Ctrl+K anywhere focuses the global search; a scanner (keyboard wedge) typing into an empty page lands in search (10-DESIGN-SYSTEM §3).
//
// CONTRACT chosen by the tester (writer: follow it, or dispute via .orchestra/notes):
//   Ctrl+K or Cmd+K (keydown on document, from any target incl. other inputs) -> focus + select the searchbox, preventDefault (stops the browser's own Ctrl+K).
//   Scanner capture: a keydown of ONE printable char matching /^[A-Z0-9]$/ (barcode charset, IC §9.3) with no ctrl/alt/meta, while focus is on <body>
//     (or any non-editable, non-interactive element), moves focus to the searchbox and the char lands in it (the FIRST char is not lost). The rest of the burst
//     and the scanner's trailing Enter then work normally (Enter submits). Lowercase letters are NOT captured (g-chords, shortcut letters stay free).
//   Never captured: focus in an input/textarea/select/contenteditable, an open dialog, modified keys (Ctrl+C...), Tab/Escape/arrows/function keys.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ALL_PERMS, SPECIMEN_LOOKUP, api, calls, ID, resetHits, router, session, user } from './r04.harness';
import { AppShell } from '../AppShell';

vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('./r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock);
vi.mock('@/core/nav/generated', async () => (await import('./r04.harness')).generatedMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { resetHits(); router.push.mockClear(); });
afterEach(() => api.resetHandlers());

const PERMS = [...ALL_PERMS, 'frontdesk.patient.read', 'lab.specimen.read', 'frontdesk.order.read'];
const mount = () => render(
  <AppShell session={session(PERMS) as any} pathname="/lab/worklist">
    <label>Free text <input data-testid="other" /></label>
    <div contentEditable suppressContentEditableWarning data-testid="rte" tabIndex={0} />
    <button>Some button</button>
  </AppShell>,
);
const box = () => screen.getByRole('searchbox', { name: /search/i }) as HTMLInputElement;

describe('Ctrl+K', () => {
  it('focuses the search from the page body and prevents the browser default', () => {
    mount();
    expect(document.activeElement).toBe(document.body);
    const notPrevented = fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(box());
  });
  it('Cmd+K works too', () => {
    mount();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(box());
  });
  it('works from inside another input and selects what was typed in the search', async () => {
    mount();
    const u = user();
    await u.type(box(), 'abc');
    screen.getByTestId('other').focus();
    await u.keyboard('{Control>}k{/Control}');
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe(0);
    expect(box().selectionEnd).toBe(3);
  });
  it('plain K, Ctrl+Shift+K and Alt+K do not hijack focus', () => {
    mount();
    fireEvent.keyDown(document.body, { key: 'k' });
    fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'k', altKey: true });
    expect(document.activeElement).toBe(document.body);
  });
});

describe('scanner wedge on an empty page', () => {
  it('a burst typed with focus on <body> lands in the search whole (first char kept) and Enter looks the barcode up', async () => {
    mount();
    const u = user();
    expect(document.activeElement).toBe(document.body);
    await u.keyboard('E2600000101');
    expect(document.activeElement).toBe(box());
    expect(box().value).toBe('E2600000101');
    await u.keyboard('{Enter}');
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith(`/frontdesk/orders/${ID(201)}`));
    expect(calls(SPECIMEN_LOOKUP)[0]!.json).toEqual({ barcode: 'E2600000101' });
  });
  it('also when focus rests on a non-editable element (e.g. the page heading area)', async () => {
    mount();
    const main = screen.getByRole('main');
    main.focus();
    await user().keyboard('E2600000102');
    expect(box().value).toBe('E2600000102');
  });
  it('digits (mobile number / patient id) are captured too', async () => {
    mount();
    await user().keyboard('9841234567');
    expect(box().value).toBe('9841234567');
  });
  it('does not steal typing from another input, a textarea or contenteditable', async () => {
    mount();
    const u = user();
    const other = screen.getByTestId('other') as HTMLInputElement;
    await u.click(other);
    await u.keyboard('E2600000101');
    expect(document.activeElement).toBe(other);
    expect(other.value).toBe('E2600000101');
    expect(box().value).toBe('');
    const rte = screen.getByTestId('rte');
    rte.focus();
    fireEvent.keyDown(rte, { key: 'A' });
    expect(document.activeElement).toBe(rte);
  });
  it('lowercase letters, modified keys and navigation keys are not captured (g-chords stay free)', async () => {
    mount();
    for (const init of [{ key: 'g' }, { key: 'h' }, { key: 'C', ctrlKey: true }, { key: 'A', altKey: true }, { key: 'V', metaKey: true }, { key: 'Tab' }, { key: 'Escape' }, { key: 'ArrowDown' }, { key: 'F5' }, { key: 'Enter' }, { key: ' ' }])
      fireEvent.keyDown(document.body, init);
    expect(document.activeElement).toBe(document.body);
    expect(box().value).toBe('');
  });
  it('an open dialog is never hijacked (focus stays in the dialog)', async () => {
    mount();
    const dlg = document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.innerHTML = '<button id="in-dialog">OK</button>';
    document.body.appendChild(dlg);
    try {
      const b = dlg.querySelector('button') as HTMLButtonElement;
      b.focus();
      await user().keyboard('E26');
      expect(document.activeElement).toBe(b);
      expect(box().value).toBe('');
    } finally {
      dlg.remove();
    }
  });
  it('after the search is submitted and the field is left, the next scan starts a fresh query (field is replaced, not appended)', async () => {
    mount();
    const u = user();
    await u.keyboard('E2600000101{Enter}');
    await vi.waitFor(() => expect(router.push).toHaveBeenCalled());
    (document.activeElement as HTMLElement).blur();
    await u.keyboard('E2600000102');
    expect(box().value).toBe('E2600000102');
  });
});
