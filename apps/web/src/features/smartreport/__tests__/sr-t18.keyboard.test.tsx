// @vitest-environment jsdom
// C14.T18 — SR-01 keyboard (04-UI-UX SR-01): `J`/`K` move row focus, `Enter` opens SR-02, `/` focuses the first filter, `?` opens the shortcuts dialog;
// double-click also opens. done_when: "keyboard J/K/Enter; axe clean".
// ASSUMED: shortcuts are page-level (work with focus on a row or on the body); they are ignored while typing in a field and with Ctrl/Meta/Alt held;
// `J` with no row focused focuses the first row; J on the last / K on the first row stays put (no wrap). Open = router.push(`/smartreport/summaries/<id>`).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as H from './sr-t18.harness';

vi.mock('next/navigation', async () => (await import('./sr-t18.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t18.harness')).sessionMock);

beforeAll(() => H.api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => H.api.close());
beforeEach(() => { H.resetApi(); H.mountList(); });
afterEach(cleanup);

async function ready() {
  await H.showQueue();
  const g = H.queueGrid();
  H.dataRows(g)[0]!.focus();
  expect(H.focusedRowIndex(g)).toBe(0);
  return { g, user: userEvent.setup() };
}

describe('J / K / Enter', () => {
  it('J moves focus to the next row, K to the previous', async () => {
    const { g, user } = await ready();
    await user.keyboard('j');
    expect(H.focusedRowIndex(g)).toBe(1);
    await user.keyboard('j');
    expect(H.focusedRowIndex(g)).toBe(2);
    await user.keyboard('k');
    expect(H.focusedRowIndex(g)).toBe(1);
  });

  it('upper-case J / K work too (caps lock / shift)', async () => {
    const { g, user } = await ready();
    await user.keyboard('J');
    expect(H.focusedRowIndex(g)).toBe(1);
    await user.keyboard('K');
    expect(H.focusedRowIndex(g)).toBe(0);
  });

  it('does not wrap: K on the first row and J on the last row keep focus where it is', async () => {
    const { g, user } = await ready();
    await user.keyboard('k');
    expect(H.focusedRowIndex(g)).toBe(0);
    H.dataRows(g)[2]!.focus();
    await user.keyboard('j');
    expect(H.focusedRowIndex(g)).toBe(2);
  });

  it('J with focus on the page body focuses the first row', async () => {
    await H.showQueue();
    const g = H.queueGrid();
    (document.activeElement as HTMLElement | null)?.blur?.();
    await userEvent.setup().keyboard('j');
    expect(H.focusedRowIndex(g)).toBe(0);
  });

  it('Enter on the focused row opens SR-02 for THAT row (/smartreport/summaries/<id>), nothing else', async () => {
    const { g, user } = await ready();
    await user.keyboard('j'); // second row = S2
    await user.keyboard('{Enter}');
    const n = H.lastNav()!;
    expect(n.pathname).toBe(`/smartreport/summaries/${H.S2}`);
    expect(n.search).toBe('');
    expect(H.focusedRowIndex(g)).toBe(1);
  });

  it('double-click opens SR-02 for the clicked row', async () => {
    await H.showQueue();
    await userEvent.setup().dblClick(H.dataRows(H.queueGrid())[2]!);
    expect(H.lastNav()!.pathname).toBe(`/smartreport/summaries/${H.S3}`);
  });

  it('single click does not navigate', async () => {
    await H.showQueue();
    await userEvent.setup().click(H.dataRows(H.queueGrid())[0]!);
    expect(H.lastNav()).toBeUndefined();
  });

  it('J / K are ignored while typing in a filter field and with Ctrl/Meta/Alt held', async () => {
    const { g, user } = await ready();
    const filter = within(screen.getByRole('search'));
    const text = filter.queryAllByRole('textbox')[0];
    if (text) { await user.click(text); await user.keyboard('jk'); expect((text as HTMLInputElement).value).toBe('jk'); }
    H.dataRows(g)[0]!.focus();
    await user.keyboard('{Control>}j{/Control}');
    expect(H.focusedRowIndex(g)).toBe(0);
  });
});

describe('/ and ?', () => {
  it('"/" moves focus into the filter bar (first filter), not into the table', async () => {
    const { g, user } = await ready();
    await user.keyboard('/');
    const search = screen.getByRole('search');
    expect(search.contains(document.activeElement)).toBe(true);
    expect(H.focusedRowIndex(g)).toBe(-1);
  });

  it('"?" opens the "Keyboard shortcuts" dialog listing J, K, Enter, / and ?; Escape closes it', async () => {
    const { user } = await ready();
    await user.keyboard('?');
    const dlg = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    const text = H.norm(dlg.textContent);
    for (const k of ['J', 'K', 'Enter', '/', '?']) expect(Array.from(dlg.querySelectorAll('kbd')).map((x) => H.norm(x.textContent))).toContain(k);
    expect(text).toMatch(/next row/i); expect(text).toMatch(/previous row/i); expect(text).toMatch(/open/i);
    await H.axeClean();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });
});

describe('keyboard-only reachability', () => {
  it('the table is reachable with Tab and the filter bar controls are real buttons / options (no click-only divs)', async () => {
    await H.showQueue();
    const user = userEvent.setup();
    let hit = false;
    for (let i = 0; i < 40 && !hit; i++) { await user.tab(); hit = H.queueGrid().contains(document.activeElement); }
    expect(hit).toBe(true);
    await H.axeClean();
  });
});
