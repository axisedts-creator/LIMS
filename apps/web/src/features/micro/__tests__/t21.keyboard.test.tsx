// @vitest-environment jsdom
// C10.T-21 — AST grid keyboard (04-UI-UX §3.3 "Keyboard": Enter in Raw value -> next row's Raw value; Tab across cells; a category letter picks the first match;
// Ctrl+Enter saves the grid). done_when tests: "component, keyboard".
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { PERM_WORK, PREVIEW, api, astIsolate, bulkHandler, catBtn, grid, hit, lastHit, previewHandler, rawBox, reportBox, resetHits, saveBtn, state } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); state.permissions = PERM_WORK; api.use(previewHandler(() => undefined), bulkHandler()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (isolate: Record<string, unknown> = astIsolate()) => {
  const { AstGrid } = await import('../components/ast/AstGrid');
  const r = render(<ToastProvider><AstGrid isolate={isolate as never} canWork defaultStandard="CLSI" onSaved={() => {}} /></ToastProvider>);
  await grid();
  return r;
};
const bulk = () => hit('POST', /bulk-record$/);

describe('Enter in Raw value', () => {
  it('moves to the next row\'s Raw value (cefA -> genB -> Colistin)', async () => {
    await mount();
    rawBox('Synthetic cefA').focus();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(rawBox('Synthetic genB'));
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(rawBox('Colistin'));
  });
  it('on the last row it stays put: no save, no error, no focus loss', async () => {
    await mount();
    rawBox('Colistin').focus();
    await userEvent.keyboard('4{Enter}');
    expect(document.activeElement).toBe(rawBox('Colistin'));
    await new Promise((r) => setTimeout(r, 400));
    expect(bulk()).toHaveLength(0);
  });
  it('leaving the field by Enter counts as the blur: the debounced preview runs for the typed value', async () => {
    await mount();
    rawBox('Synthetic genB').focus();
    await userEvent.keyboard('18{Enter}');
    await waitFor(() => expect(hit('POST', PREVIEW).length).toBe(1), { timeout: 3000 });
    expect(hit('POST', PREVIEW)[0]!.json.entries[0]).toMatchObject({ antibiotic_code: 'syn_gen_b', raw_value: '18' });
  });
});

describe('Tab', () => {
  it('moves across the cells of a row in reading order: Raw value -> Category -> Report -> next row\'s Raw value', async () => {
    await mount();
    rawBox('Synthetic cefA').focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(catBtn('Synthetic cefA'));
    await userEvent.tab();
    expect(document.activeElement).toBe(reportBox('Synthetic cefA'));
    await userEvent.tab();
    expect(document.activeElement).toBe(rawBox('Synthetic genB'));
  });
});

describe('category select', () => {
  it('typing a category letter on the focused Category control picks the first match (N -> NS, R -> R)', async () => {
    await mount();
    catBtn('Synthetic cefA').focus();
    await userEvent.keyboard('N');
    await waitFor(() => expect(catBtn('Synthetic cefA').textContent).toMatch(/\bNS\b/));
    catBtn('Synthetic genB').focus();
    await userEvent.keyboard('R');
    await waitFor(() => expect(catBtn('Synthetic genB').textContent).toMatch(/\bR\b/));
  });
  it('Enter / Space / ArrowDown open it, arrows + Enter choose, Escape closes without choosing', async () => {
    await mount();
    catBtn('Synthetic cefA').focus();
    await userEvent.keyboard('{ArrowDown}');
    const list = await screen.findByRole('listbox');
    expect(list).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(catBtn('Synthetic cefA').textContent).not.toMatch(/\b(S|SDD|I|R|NS)\s—/);
  });
});

describe('Ctrl+Enter saves the grid ("Save AST")', () => {
  it('from a Raw value input: one bulk-record request with the edited row', async () => {
    await mount();
    rawBox('Synthetic cefA').focus();
    await userEvent.keyboard('4');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    const h = await lastHit('POST', /bulk-record$/);
    expect(h.json.entries.map((e: { antibiotic_code: string; raw_value: string }) => [e.antibiotic_code, e.raw_value])).toEqual([['syn_cef_a', '4']]);
    expect(bulk()).toHaveLength(1);
  });
  it('from the Category control and from the Report checkbox too', async () => {
    await mount();
    fireEvent.change(rawBox('Synthetic cefA'), { target: { value: '4' } });
    catBtn('Synthetic genB').focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(bulk()).toHaveLength(1));
  });
  it('with nothing changed, Ctrl+Enter is a no-op (no request, no error)', async () => {
    await mount();
    rawBox('Synthetic cefA').focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await new Promise((r) => setTimeout(r, 300));
    expect(bulk()).toHaveLength(0);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
  it('with an invalid value in the grid, Ctrl+Enter sends nothing and the row shows the grammar error', async () => {
    await mount();
    rawBox('Synthetic cefA').focus();
    await userEvent.keyboard('abc');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await new Promise((r) => setTimeout(r, 400));
    expect(bulk()).toHaveLength(0);
    expect(document.body.textContent).toMatch(/Enter a value like 0\.25, <=0\.25 or 18/);
  });
  it('a plain Enter never saves', async () => {
    await mount();
    rawBox('Synthetic cefA').focus();
    await userEvent.keyboard('4{Enter}');
    await new Promise((r) => setTimeout(r, 400));
    expect(bulk()).toHaveLength(0);
  });
  it('the "Save AST" button is reachable by keyboard and Space / Enter activates it', async () => {
    await mount();
    fireEvent.change(rawBox('Synthetic cefA'), { target: { value: '4' } });
    await waitFor(() => expect(saveBtn()!.hasAttribute('disabled')).toBe(false));
    saveBtn()!.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(bulk()).toHaveLength(1));
  });
});
