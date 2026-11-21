// @vitest-environment jsdom
// C12.T-20 — S16 Alerts (04-UI-UX §3 S16; AC-20.1 UI side; AC-22.2 UI hides; TRD #90, #91). LD-140 (2026-11-13): kit only, status = tone + icon + word.
// Pinned seams: t20.harness.tsx header (?status=<csv> ?alert_kind=<kind> ?store_id=<id> pass through to GET /alerts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_NONE, PERM_READ, alert, api, db, hit, hits, problem, resetDb, resetHits, router, state } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

const STOCK_MANAGE = ['inventory.item.read', 'inventory.stock.manage'];
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  resetHits(); resetDb(); Object.values(router).forEach((f) => f.mockReset());
  state.permissions = STOCK_MANAGE; state.path = '/inventory/alerts';
  db.alerts = [
    alert(1, { occurrences: 3, version: 5 }),
    alert(2, { alert_kind: 'expiry_soon', status: 'acknowledged', lot_id: ID(701) }),
    alert(3, { alert_kind: 'expired_on_hand', store_id: ID(302) }),
  ];
});
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/alerts/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const rowOf = (grid: HTMLElement, text: RegExp) => within(grid).getAllByRole('row').find((r) => text.test(r.textContent ?? ''))!;
const acks = () => hit('POST', /^\/v1\/inventory\/alerts\/[^/]+\/acknowledge$/);

describe('S16 list (04-UI-UX §3 S16)', () => {
  it('columns Kind, Store, Item, Lot, First raised, Last raised, Occurrences, Status', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Kind', 'Store', 'Item', 'Lot', 'First raised', 'Last raised', 'Occurrences', 'Status']) expect(heads, h).toContain(h);
  });

  it('kind labels are the spec words; store and item are shown by code, never by raw uuid', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    expect(within(grid).getByText('Below reorder level')).toBeTruthy();
    expect(within(grid).getByText('Expiring soon')).toBeTruthy();
    expect(within(grid).getByText('Expired stock on hand')).toBeTruthy();
    expect(within(rowOf(grid, /below reorder level/i)).getByText(/BR1-ST1/)).toBeTruthy();
    expect(within(rowOf(grid, /below reorder level/i)).getByText(/GLU-R1/)).toBeTruthy();
    expect(grid.textContent).not.toMatch(/01950c12-0000-7000/);
  });

  it('AC-20.1: one alert per pair is one row; occurrences are shown, not repeated rows', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    const reorder = within(grid).getAllByRole('row').filter((r) => /below reorder level/i.test(r.textContent ?? ''));
    expect(reorder.length).toBe(1);
    expect(within(reorder[0]!).getAllByRole('gridcell').map((c) => c.textContent?.trim())).toContain('3');
  });

  it('status shows tone, icon and word (LD-140): word Open / Acknowledged and an svg icon in the status cell', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    const open = rowOf(grid, /below reorder level/i); const ack = rowOf(grid, /expiring soon/i);
    expect(within(open).getByText(/^open$/i)).toBeTruthy();
    expect(within(ack).getByText(/^acknowledged$/i)).toBeTruthy();
    expect(within(open).getByText(/^open$/i).closest('[class*="lims-tone"], [data-tone]')).toBeTruthy();
    expect(within(open).getByText(/^open$/i).closest('td, [role="gridcell"]')!.querySelector('svg')).toBeTruthy();
  });

  it('filters are passed to the API: ?alert_kind, ?status and ?store_id', async () => {
    await mount({ alert_kind: 'expiry_soon', status: 'open,acknowledged', store_id: ID(301) });
    await screen.findByRole('grid');
    const g = hit('GET', /^\/v1\/inventory\/alerts$/).at(-1)!;
    expect(g.search).toContain('alert_kind=expiry_soon');
    expect(g.search).toMatch(/status=open(%2C|,)acknowledged/);
    expect(g.search).toContain(`store_id=${ID(301)}`);
  });

  it('a filter value outside the enum is not forwarded (no query injection)', async () => {
    await mount({ alert_kind: 'x&store_id=evil', status: 'nope' });
    await screen.findByRole('grid');
    const g = hit('GET', /^\/v1\/inventory\/alerts$/).at(-1)!;
    expect(g.search).not.toContain('evil');
    expect(g.search).not.toContain('nope');
  });

  it('empty list shows the kit EmptyState, not an empty grid', async () => {
    db.alerts = [];
    await mount();
    expect(await screen.findByText(/no alerts/i)).toBeTruthy();
  });
});

describe('Acknowledge (TRD #91) and AC-22.2 UI hides', () => {
  it('open row: "Acknowledge" posts with If-Match "<version>"; no button on an already acknowledged row', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    expect(within(rowOf(grid, /expiring soon/i)).queryByRole('button', { name: /acknowledge/i })).toBeNull();
    await userEvent.click(within(rowOf(grid, /below reorder level/i)).getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(acks().length).toBe(1));
    expect(acks()[0]!.path).toBe(`/v1/inventory/alerts/${ID(1001)}/acknowledge`);
    expect(acks()[0]!.headers.get('if-match')).toBe('"5"');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('AC-22.2: without inventory.stock.manage the list renders but no Acknowledge button exists', async () => {
    state.permissions = PERM_READ;
    await mount();
    await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull();
  });

  it('AC-22.2: acknowledging an alert the API hides (404) or forbids (403) shows a danger Banner with the title and request_id, and does not claim success', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/alerts/:id/acknowledge`, () => problem('auth.forbidden', 403)));
    await mount();
    const grid = await screen.findByRole('grid');
    await userEvent.click(within(rowOf(grid, /below reorder level/i)).getByRole('button', { name: /acknowledge/i }));
    const banner = await screen.findByText(/req-syn-0001/);
    expect(banner).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(within(rowOf(grid, /below reorder level/i)).queryByText(/^acknowledged$/i)).toBeNull();
    expect(screen.queryByText(/alert acknowledged/i)).toBeNull();
  });

  it('409 version_conflict is reported with request_id (stale row), row stays', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/alerts/:id/acknowledge`, () => problem('common.version_conflict', 409)));
    await mount();
    const grid = await screen.findByRole('grid');
    await userEvent.click(within(rowOf(grid, /below reorder level/i)).getByRole('button', { name: /acknowledge/i }));
    expect(await screen.findByText(/req-syn-0001/)).toBeTruthy();
  });

  it('a double click sends ONE request (the button is disabled while pending)', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    const b = within(rowOf(grid, /below reorder level/i)).getByRole('button', { name: /acknowledge/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(acks().length).toBeGreaterThan(0));
    expect(acks().length).toBe(1);
  });

  it('no inventory.item.read: permission-denied and no API call', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });

  it('API 403 on the list -> permission-denied; API 500 -> page throws to error.tsx', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/alerts`, () => problem('auth.forbidden', 403)));
    await mount();
    expect(await screen.findByTestId('permission-denied')).toBeTruthy();
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/inventory/alerts`, () => problem('common.internal', 500)));
    await expect(mount()).rejects.toThrow();
  });
});
