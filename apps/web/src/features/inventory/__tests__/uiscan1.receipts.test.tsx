// @vitest-environment jsdom
// T0D-UISCAN-1 (5) inventory goods receipt editor ("New receipt" drawer) scan box — LD-353 template 3 SCAN. Scan handling and calls do not change (t22.receipts stays the proof).
// done_when under test: the scan box is the ScanPanel scan input (.lims-scan-input, at most 28rem, light ring); a scanned item is the last scan result card (item code and name);
//   an unknown barcode puts the "not linked to an item" text in the card (the toast stays: t22.receipts pins it).
// Judgement: the editor's line rows are an entry form (template 6), not a queue table: no queue is required here.
// Harness: t22.harness (MSW plays the inventory API; the receipts page.tsx server component runs for real).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, PERM_STOCK, api, itemSummary, problem, resetHits, router, state } from './t22.harness';
import { norm, resultCard } from '../../lab/__tests__/uiscan1.helpers';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const text = (el: Element | null) => norm(el?.textContent);
const mountGrn = async () => {
  state.permissions = PERM_STOCK;
  state.path = '/inventory/receipts';
  const mod = await import('../../../app/(staff)/inventory/receipts/page');
  render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve({}) } as never)}</ToastProvider>);
  await userEvent.click(await screen.findByRole('button', { name: /^new receipt$/i }));
  return screen.findByRole('dialog', { name: /new receipt/i });
};
const barcodeBox = (d: HTMLElement) => within(d).getByRole('textbox', { name: /scan or type barcode/i });

describe('receipt editor scan box', () => {
  it('is the ScanPanel scan input: one panel, the input first, no result card before a scan', async () => {
    const d = await mountGrn();
    expect(d.querySelectorAll('.lims-scan-panel')).toHaveLength(1);
    const p = d.querySelector('.lims-scan-panel') as HTMLElement;
    expect(p.firstElementChild?.classList.contains('lims-scan-input')).toBe(true);
    expect(p.querySelector('.lims-scan-input')!.contains(barcodeBox(d))).toBe(true);
    expect(resultCard(d)).toBeNull();
  });

  it('a scanned item is the last scan result card (code and name); the line is added as before', async () => {
    const d = await mountGrn();
    api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => HttpResponse.json({ item: itemSummary(1) })));
    await userEvent.type(barcodeBox(d), 'PACK-GLU-1{Enter}');
    await waitFor(() => expect(resultCard(d)).toBeTruthy());
    expect(text(resultCard(d))).toContain('GLU-R1');
    expect(text(resultCard(d))).toContain('Synthetic glucose reagent');
    expect(within(d).getAllByRole('combobox', { name: /^item/i }).length).toBeGreaterThan(0);
  });

  it('an unknown barcode: the card carries the "not linked to an item" text', async () => {
    const d = await mountGrn();
    api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => problem('common.not_found', 404)));
    await userEvent.type(barcodeBox(d), 'NOPE-0001{Enter}');
    await waitFor(() => expect(text(resultCard(d))).toContain('This barcode is not linked to an item. Link it from the item page.'));
  });
});
