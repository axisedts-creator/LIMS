// @vitest-environment jsdom
// T0D-UISCAN-1 (4) inventory stock count entry — LD-353 template 3 SCAN (rules 5, 6, 8). Scan handling, calls and blind count rules do not change (t23.counts stays the proof). Receipts: uiscan1.receipts.test.tsx.
// done_when under test:
//   count entry (/inventory/counts/[count_id]): ScanPanel with the scan input first, last scan result card (item found / "No item has this barcode." / "This item is not on this count."), the count lines table is the queue (header row always shown);
//     BLIND count: no system quantity in the card or the table until "Show system quantity" is on; a viewer without manage rights has no scan input, the lines table and the title stay.
//   receipt editor (New receipt drawer): the scan box is a ScanPanel scan input (.lims-scan-input); a scanned item shows as the last scan result card; an unknown barcode puts SCAN_UNKNOWN in the card (the toast stays: t22.receipts pins it).
//   Judgement: the receipt editor's line rows are an entry form (template 6), not a queue table: no queue is required there.
// Harness: t23.harness (counts) and t22.harness (receipts); MSW plays the inventory API; the page.tsx server components run for real. Both set the shared session state, so the two groups mount one after the other.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_ADJUST, PERM_MANAGE, PERM_READ, api, count, countLine, problem, resetHits, router, state } from './t23.harness';
import { expectScanScreen, h1s, norm, queue, resultCard } from '../../lab/__tests__/uiscan1.helpers';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const C1 = ID(900);
const text = (el: Element | null) => norm(el?.textContent);
const mountCount = async () => {
  state.path = `/inventory/counts/${C1}`;
  const mod = await import('../../../app/(staff)/inventory/counts/[count_id]/page');
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve({ count_id: C1 }), searchParams: Promise.resolve({}) } as never)}</ToastProvider>);
};
const useCount = (over: Record<string, unknown> = {}) => api.use(http.get(`${ORIGIN}/v1/inventory/stock-counts/:id`, () => HttpResponse.json(count({ lines: [countLine(1), countLine(2)], ...over }))));
const lookup = (item: Record<string, unknown> | undefined) => api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => (item ? HttpResponse.json({ item }) : problem('common.not_found', 404))));
const itemOf = (n: number) => ({ id: ID(10 + n), item_code: `TIPS-${n}`, name: `Synthetic pipette tips ${n}`, category: 'consumable', base_uom_code: 'piece', is_lot_tracked: true, requires_expiry: true, is_active: true, version: 1 });
const box = () => screen.getByLabelText(/scan item barcode/i) as HTMLInputElement;
const scan = async (v: string) => { await userEvent.type(box(), `${v}{Enter}`); };
const HEADS = ['Item', 'Lot', 'Counted', 'Line'];

describe('count entry', () => {
  it('open count, may count: ScanPanel, one h1, the lines table is the queue with its header row, no result card, no system quantity', async () => {
    useCount();
    const { container } = await mountCount();
    await screen.findByLabelText(/scan item barcode/i);
    expectScanScreen(container, { headers: HEADS });
    expect(h1s(container)).toHaveLength(1);
    expect(h1s(container)[0]).toMatch(/^Stock count in /);
    expect(resultCard(container)).toBeNull();
    expect(within(queue(container)!).queryByRole('columnheader', { name: /system qty/i })).toBeNull();
    expect(text(container)).not.toMatch(/\b37\b|\b58\b/);
  });

  it('a scanned item that is on the count: the result card names the item; the header row stays; blind: no book quantity in the card', async () => {
    useCount();
    state.permissions = PERM_ADJUST;
    lookup(itemOf(1));
    const { container } = await mountCount();
    await screen.findByLabelText(/scan item barcode/i);
    await scan('SYNITEM0001');
    await waitFor(() => expect(resultCard(container)).toBeTruthy());
    const t = text(resultCard(container));
    expect(t).toContain('TIPS-1');
    expect(t).not.toMatch(/\b37\b|\b58\b/);
    expectScanScreen(container, { headers: HEADS });
    expect(text(container), 'system quantity stays hidden until the switch is on').not.toMatch(/\b37\b|\b58\b/);
  });

  it('unknown barcode and an item that is not on this count: each is the result card text', async () => {
    useCount();
    lookup(undefined);
    const { container } = await mountCount();
    await screen.findByLabelText(/scan item barcode/i);
    await scan('SYNNOPE0001');
    await waitFor(() => expect(text(resultCard(container))).toContain('No item has this barcode.'));
    api.resetHandlers();
    useCount();
    lookup(itemOf(7));
    await scan('SYNITEM0007');
    await waitFor(() => expect(text(resultCard(container))).toContain('This item is not on this count.'));
    expectScanScreen(container, { headers: HEADS });
  });

  it('a count with no lines: the table header row and the empty message stay inside the queue', async () => {
    useCount({ lines: [] });
    const { container } = await mountCount();
    await screen.findByLabelText(/scan item barcode/i);
    expectScanScreen(container, { headers: HEADS });
    expect(text(queue(container))).toMatch(/This count has no lines/);
  });

  it('a viewer without stock.manage: no scan input, no panel; the title and the lines table with its header row stay', async () => {
    useCount();
    state.permissions = PERM_READ;
    const { container } = await mountCount();
    await screen.findAllByRole('columnheader');
    expect(screen.queryByLabelText(/scan item barcode/i)).toBeNull();
    expect(container.querySelector('.lims-scan-panel')).toBeNull();
    expect(h1s(container)[0]).toMatch(/^Stock count in /);
    expect([...container.querySelectorAll('[role="columnheader"], thead th')].map((h) => norm(h.textContent))).toEqual(expect.arrayContaining(['Item', 'Lot']));
  });
});
