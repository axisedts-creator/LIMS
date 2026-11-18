// @vitest-environment jsdom
// T0D-UISCAN-1 (3) home collection tube handover drawer (scan tubes) — LD-353 template 3 SCAN. Scan handling, calls and the confirm flow do not change (hc-t20.handover stays the proof).
// done_when under test: the drawer body is a ScanPanel (scan input in .lims-scan-input, last scan result card, the tubes DataTable as the queue with its header row always shown);
//   a tube of this handover scanned: the card names the barcode and "Received"; a foreign tube: the card says "This tube is not in this handover."; a handled (confirmed) handover has no scan input.
// Harness: hc-t20.helpers (MSW plays the API). Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, HV1, HV2, U, detail, userEvent, wrap } from './hc-t20.helpers';
import { expectScanScreen, norm, queue, resultCard } from '../../lab/__tests__/uiscan1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/homecollection/handovers',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['homecollection.handover.receive'], displayName: 'Synthetic Centre Staff', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/homecollection/handovers',
}));

let body: () => Record<string, unknown> = () => detail(1);
const api = setupServer(http.get(`${API}/handovers/:id`, () => HttpResponse.json(body())));
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); body = () => detail(1); });
afterAll(() => api.close());

const open = async (h: unknown = HV1, barcode = 'HCT200001') => {
  const { HandoverDrawer } = (await import('../components/HandoverDrawer')) as { HandoverDrawer: (p: unknown) => unknown };
  wrap(<HandoverDrawer {...({ handover: h, isOpen: true, onClose: vi.fn() } as object)} />);
  const d = await screen.findByRole('dialog');
  await within(d).findByText(barcode);
  return d;
};
const scan = (d: HTMLElement, code: string) => userEvent.type(within(d).getByLabelText('Scan tube'), `${code}{Enter}`);
const text = (el: Element | null) => norm(el?.textContent);

describe('pending handover', () => {
  it('ScanPanel in the drawer: scan input first, no result card yet, the tubes table is the queue with its header row (Barcode, Specimen type, Received)', async () => {
    const d = await open();
    expectScanScreen(d, { headers: ['Barcode', 'Specimen type', 'Received'] });
    expect(resultCard(d)).toBeNull();
    expect(text(d)).toMatch(/Received 0 of 3/);
  });

  it('a tube of this handover: the result card names the barcode and "Received"; the count moves; the header row stays', async () => {
    const d = await open();
    await scan(d, 'HCT200002');
    await within(d).findByText(/Received 1 of 3/);
    const t = text(resultCard(d));
    expect(t).toContain('HCT200002');
    expect(t).toMatch(/Received/);
    expectScanScreen(d, { headers: ['Barcode', 'Specimen type', 'Received'] });
    expect(within(queue(d)!).getAllByRole('row').length, 'header + 3 tubes').toBe(4);
  });

  it('a foreign tube: the result card says "This tube is not in this handover." and the queue is unchanged', async () => {
    const d = await open();
    await scan(d, 'HCT209999');
    await within(d).findAllByText(/This tube is not in this handover\./);
    expect(text(resultCard(d))).toContain('This tube is not in this handover.');
    expect(text(d)).toMatch(/Received 0 of 3/);
    expectScanScreen(d, { headers: ['Barcode', 'Specimen type', 'Received'] });
  });
});

describe('handled handover', () => {
  it('no scan input and no panel (nothing to scan); the tubes table with its Outcome header stays', async () => {
    body = () => detail(2, { status: 'confirmed', received_by_display: 'Synthetic Centre Staff', received_at: '2026-11-13T05:30:00.000Z' });
    const d = await open(HV2);
    expect(d.querySelector('.lims-scan-input')).toBeNull();
    expect(within(d).queryByLabelText('Scan tube')).toBeNull();
    expect([...d.querySelectorAll('thead th, [role="columnheader"]')].map((h) => norm(h.textContent))).toContain('Outcome');
  });
});
