// @vitest-environment jsdom
// C12.T-20 — S1 Inventory home (04-UI-UX §3 S1; AC-20.1 UI side; AC-22.2 UI side). LD-140 (2026-11-13): kit only, ONE primary button per page, status = tone + icon + word.
// Pinned seams: t20.harness.tsx header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, alert, api, db, fact, hits, problem, resetDb, resetHits, router, settings, state } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  resetHits(); resetDb(); Object.values(router).forEach((f) => f.mockReset());
  state.permissions = PERM_MANAGE; state.path = '/inventory';
  db.alerts = [
    ...[1, 2, 3].map((n) => alert(n, { alert_kind: 'below_reorder' })),
    alert(4, { alert_kind: 'below_reorder', status: 'acknowledged' }), // not "open": must not be counted
    ...[5, 6].map((n) => alert(n, { alert_kind: 'expiry_soon' })),
    alert(7, { alert_kind: 'expired_on_hand' }),
  ];
  db.facts = [1, 2, 3, 4].map((n) => fact(n));
});
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async () => {
  const mod = await import('../../../app/(staff)/inventory/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve({}) } as never)}</ToastProvider>);
};
const tile = (label: RegExp) => screen.getByText(label).closest('a, div.lims-stat') as HTMLElement;

describe('S1 stat tiles (AC-20.1 UI side)', () => {
  it('four tiles with the spec labels and counts of OPEN alerts / unresolved facts only', async () => {
    await mount();
    await screen.findByText('Below reorder');
    expect(tile(/^below reorder$/i).textContent).toMatch(/3/);
    expect(tile(/^below reorder$/i).textContent).not.toMatch(/4/);
    expect(tile(/^expiring in 30 days$/i).textContent).toMatch(/2/);
    expect(tile(/^expired on hand$/i).textContent).toMatch(/1/);
    expect(tile(/^waiting consumption$/i).textContent).toMatch(/4/);
  });

  it('the N in "Expiring in N days" comes from settings.expiry_alert_days', async () => {
    db.settings = settings({ expiry_alert_days: 45 });
    await mount();
    expect(await screen.findByText(/^expiring in 45 days$/i)).toBeTruthy();
  });

  it('each tile links to the filtered S16 / S15', async () => {
    await mount();
    await screen.findByText('Below reorder');
    expect(tile(/^below reorder$/i).getAttribute('href')).toMatch(/^\/inventory\/alerts\?.*alert_kind=below_reorder/);
    expect(tile(/^expiring in/i).getAttribute('href')).toMatch(/^\/inventory\/alerts\?.*alert_kind=expiry_soon/);
    expect(tile(/^expired on hand$/i).getAttribute('href')).toMatch(/^\/inventory\/alerts\?.*alert_kind=expired_on_hand/);
    expect(tile(/^waiting consumption$/i).getAttribute('href')).toMatch(/^\/inventory\/unresolved/);
  });

  it('AC-20.1: one open below_reorder alert for a pair shows as ONE row with its occurrences count, not a second row', async () => {
    db.alerts = [alert(1, { occurrences: 3 })];
    db.facts = [];
    await mount();
    const grid = await screen.findByRole('grid');
    const rows = within(grid).getAllByRole('row').filter((r) => within(r).queryAllByRole('columnheader').length === 0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toMatch(/3/);
    expect(tile(/^below reorder$/i).textContent).toMatch(/1/);
  });
});

describe('S1 banner "Automatic consumption is off"', () => {
  const COPY = 'Automatic consumption is off. Stock is not deducted for tests, QC or reruns until a manager turns it on in Settings.';
  it('shown with the spec copy when consumption_enabled_at is unset; manager gets "Open settings" which goes to /inventory/settings', async () => {
    db.settings = settings({ consumption_enabled_at: undefined });
    await mount();
    expect(await screen.findByText(COPY, { exact: false })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^open settings$/i }));
    expect(router.push).toHaveBeenCalledWith('/inventory/settings');
  });
  it('AC-22.2 UI: a user without master.manage sees the banner but no "Open settings"', async () => {
    db.settings = settings({ consumption_enabled_at: undefined }); state.permissions = PERM_READ;
    await mount();
    await screen.findByText(COPY, { exact: false });
    expect(screen.queryByRole('button', { name: /open settings/i })).toBeNull();
  });
  it('not shown when automatic consumption is on', async () => {
    await mount();
    await screen.findByText('Below reorder');
    expect(screen.queryByText(/automatic consumption is off/i)).toBeNull();
  });
});

describe('S1 newest alerts table, actions, checklist', () => {
  it('lists at most the 10 newest open alerts with columns kind, store, item, lot, raised, occurrences; labels resolved (store code, item code)', async () => {
    db.alerts = Array.from({ length: 12 }, (_, i) => alert(i + 1, { last_raised_at: `2026-11-${String(i + 1).padStart(2, '0')}T04:30:00.000Z` }));
    await mount();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim().toLowerCase());
    for (const h of ['kind', 'store', 'item', 'lot', 'raised', 'occurrences']) expect(heads.some((x) => x?.includes(h)), h).toBe(true);
    const rows = within(grid).getAllByRole('row').filter((r) => within(r).queryAllByRole('columnheader').length === 0);
    expect(rows.length).toBe(10);
    expect(within(rows[0]!).getByText(/BR1-ST1/)).toBeTruthy();
    expect(within(rows[0]!).getByText(/GLU-R1/)).toBeTruthy();
    expect(within(rows[0]!).getByText(/below reorder level/i)).toBeTruthy();
  });

  it('header actions follow permissions: "New PO" needs inventory.po.manage, "Receive goods" needs inventory.stock.manage; exactly one primary button', async () => {
    state.permissions = ['inventory.item.read', 'inventory.po.manage', 'inventory.stock.manage'];
    await mount();
    expect(await screen.findByRole('button', { name: /^new po$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^receive goods$/i })).toBeTruthy();
    expect(document.querySelectorAll('button.lims-btn-primary').length).toBe(1);
    cleanup(); state.permissions = PERM_READ;
    await mount();
    await screen.findByText('Below reorder');
    expect(screen.queryByRole('button', { name: /new po/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /receive goods/i })).toBeNull();
  });

  it('set-up checklist card lists the seven steps', async () => {
    db.settings = settings({ consumption_enabled_at: undefined });
    await mount();
    await screen.findByText('Below reorder');
    for (const step of [/stores per branch/i, /items/i, /packs/i, /rules/i, /analyser bindings/i, /opening balances/i, /consumption switched on/i]) expect(screen.getAllByText(step).length, String(step)).toBeGreaterThan(0);
  });
});

describe('S1 access and failure (AC-22.2 UI side)', () => {
  it('no inventory.item.read: permission-denied and no API call', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });
  it('API 403 on the alert list -> permission-denied (no partial data)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/alerts`, () => problem('auth.forbidden', 403)));
    await mount();
    expect(await screen.findByTestId('permission-denied')).toBeTruthy();
    expect(screen.queryByText('Below reorder')).toBeNull();
  });
  it('API 500 on the alert list propagates to error.tsx (page throws; no swallowed failure showing zero counts)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/alerts`, () => problem('common.internal', 500)));
    await expect(mount()).rejects.toThrow();
  });
  it('a failing consumption-facts call does not render a fake "0": it throws too', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-facts`, () => problem('common.internal', 500)));
    await expect(mount()).rejects.toThrow();
  });
  it('never sends a token to the browser: the rendered HTML has no JWT', async () => {
    const { container } = await mount();
    await screen.findByText('Below reorder');
    expect(container.innerHTML).not.toContain('jwt-synthetic');
  });
});
