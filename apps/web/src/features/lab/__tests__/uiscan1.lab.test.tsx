// @vitest-environment jsdom
// T0D-UISCAN-1 (1) lab collect, dispatch and receive — LD-353 template 3 SCAN (rules 5, 6, 8). Scan handling and the API calls do not change (lab-t11, rs-c5 stay the proof).
// done_when under test: ScanPanel (scan input in .lims-scan-input, last result card .lims-scan-result, queue table in .lims-scan-queue, header row always shown + EmptyState);
//   receive: ONE FilterBar with status pills "All n / Received n / Rejected n / Errors n" (replace the "Session log" tablist), Auto-accept switch in the header slot, location select outside the scan box;
//   collect: tabs Collect and Dispatch keep their meaning (role=tab, counts); the denial and failure states keep the page title.
// Harness: lab-t11.fixtures (MSW plays the lab API). Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { BC, CENTRES, CENTRE_A, LAB, ORIGIN, REASONS, calls, problem, rec, specimen } from './lab-t11.fixtures';
import { expectScanScreen, filterBars, h1s, menuLabel, norm, panel, pill, pillTexts, queue, resultCard } from './uiscan1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/x',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/x',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const db = new Map<string, Record<string, unknown>>();
let lookupFails = false;
const api = setupServer(
  http.post(`${LAB}/specimens/lookup`, async ({ request }) => {
    await rec(request);
    if (lookupFails) return problem(500, 'common.internal', 'Synthetic outage');
    const b = (await request.clone().json()) as { barcode?: string };
    const s = b.barcode ? db.get(b.barcode) : undefined;
    return s ? HttpResponse.json(s) : problem(404, 'common.not_found', 'Not found');
  }),
  http.post(`${LAB}/specimens/:id/receive`, async ({ request, params }) => {
    await rec(request);
    const s = [...db.values()].find((x) => x.id === params['id'])!;
    if (['rejected', 'discarded'].includes(s.status as string)) return problem(409, 'lab.specimen_not_receivable', 'Specimen not receivable');
    return HttpResponse.json({ ...s, version: (s.version as number) + 1, status: 'received' });
  }),
  http.post(`${LAB}/specimens/:id/reject`, async ({ request, params }) => {
    await rec(request);
    const s = [...db.values()].find((x) => x.id === params['id'])!;
    return HttpResponse.json({ specimen: { ...s, version: (s.version as number) + 1, status: 'rejected' } });
  }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; db.clear(); lookupFails = false; localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const kb = () => userEvent.setup({ delay: null });
const box = () => screen.getAllByLabelText(/barcode/i)[0] as HTMLInputElement;
const scan = async (v: string) => { await kb().type(box(), `${v}{Enter}`); };
const text = (el: Element | null) => norm(el?.textContent);

describe('receive /lab/receive', () => {
  const PERMS = ['lab.specimen.receive', 'lab.specimen.reject', 'lab.specimen.read'];
  const show = async (permissions: string[] = PERMS) => {
    localStorage.setItem('lims.lab.receive.location', CENTRE_A);
    const { ReceiveScreen } = await import('../components/ReceiveScreen');
    return wrap(<ReceiveScreen centres={CENTRES} rejectionReasons={REASONS} recollectionDefault={false} permissions={permissions} />);
  };

  it('no scan yet: ScanPanel, h1 = menu label, ONE FilterBar with the four pills at 0, queue header row + EmptyState, no result card', async () => {
    const { container } = await show();
    expectScanScreen(container, { title: '/lab/receive', headers: ['Barcode', 'Outcome'], filterBar: 1 });
    expect(pillTexts(container)).toEqual(['All 0', 'Received 0', 'Rejected 0', 'Errors 0']);
    expect(screen.queryByRole('tablist', { name: /session log/i }), 'the pills replace the Session log tablist').toBeNull();
    expect(text(queue(container))).toMatch(/Scan a label to start/);
    expect(resultCard(container)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('Auto-accept stays a switch in the header slot; the location select is outside the scan box', async () => {
    const { container } = await show();
    const actions = container.querySelector('.lims-page-actions') as HTMLElement;
    expect(within(actions).getByRole('switch', { name: /auto-accept/i })).toBeTruthy();
    const loc = screen.getByLabelText(/receiving location/i);
    expect(panel(container)!.querySelector('.lims-scan-input')!.contains(loc), 'location is not inside the scan box').toBe(false);
  });

  it('scan + accept: the result card shows the specimen then "Received"; pills All 1 / Received 1; a pill filters the queue, its header stays', async () => {
    db.set(BC(1), specimen(1, { status: 'collected' }));
    const { container } = await show();
    await scan(BC(1));
    const card = await waitFor(() => { const c = resultCard(container); expect(c).toBeTruthy(); return c!; });
    await within(card).findByRole('region', { name: /current specimen/i });
    expect(text(card)).toContain(BC(1));
    expect(card.getAttribute('role')).toBe('status');
    await kb().keyboard('{Enter}'); // accept
    await waitFor(() => expect(pillTexts(container)).toEqual(['All 1', 'Received 1', 'Rejected 0', 'Errors 0']));
    expect(text(resultCard(container))).toMatch(/Received/);
    expectScanScreen(container, { title: '/lab/receive', headers: ['Barcode', 'Outcome'], filterBar: 1 });
    expect(within(queue(container)!).getByRole('row', { name: new RegExp(BC(1)) })).toBeTruthy();
    await kb().click(pill(container, 'Errors'));
    expect(within(queue(container)!).queryByRole('row', { name: new RegExp(BC(1)) }), 'Errors pill hides the received row').toBeNull();
    expect(queue(container)!.querySelectorAll('thead th, [role="columnheader"]').length, 'header row stays when the pill leaves no row').toBeGreaterThan(0);
    await kb().click(pill(container, 'Received'));
    expect(within(queue(container)!).getByRole('row', { name: new RegExp(BC(1)) })).toBeTruthy();
  });

  it('a refused specimen: Errors 1 and the result card gives the reason', async () => {
    db.set(BC(2), specimen(2, { status: 'discarded' }));
    const { container } = await show();
    await scan(BC(2));
    await screen.findByRole('region', { name: /current specimen/i });
    await kb().keyboard('{Enter}');
    await waitFor(() => expect(pillTexts(container)).toEqual(['All 1', 'Received 0', 'Rejected 0', 'Errors 1']));
    expect(text(resultCard(container))).toContain('Specimen not receivable');
  });

  it('a rejection: the result card names the barcode, "Rejected" and the reason picked in the dialog', async () => {
    db.set(BC(3), specimen(3, { status: 'collected' }));
    const { container } = await show();
    await scan(BC(3));
    await screen.findByRole('region', { name: /current specimen/i });
    await kb().click(screen.getByRole('button', { name: /^reject$/i }));
    const d = await screen.findByRole('dialog');
    await kb().click(within(d).getByRole('radio', { name: /haemolysed/i }));
    await kb().click(within(d).getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(pillTexts(container)).toEqual(['All 1', 'Received 0', 'Rejected 1', 'Errors 0']));
    const t = text(resultCard(container));
    expect(t).toContain(BC(3));
    expect(t).toMatch(/Rejected/);
    expect(t).toMatch(/Haemolysed/);
  });

  it('a failed lookup (500) keeps the title, the ScanPanel and the FilterBar, shows the message in the page', async () => {
    lookupFails = true;
    const { container } = await show();
    await scan(BC(1));
    await waitFor(() => expect(text(container)).toContain('Synthetic outage'));
    expect(h1s(container)).toEqual([menuLabel('/lab/receive')]);
    expectScanScreen(container, { title: '/lab/receive', filterBar: 1 });
    expect(container.textContent).not.toMatch(/Unhandled|at \w+ \(/);
  });

  it('no lab.specimen.receive: the page title stays with the denial text and nothing is requested', async () => {
    const { container } = await show([]);
    expect(h1s(container)).toEqual([menuLabel('/lab/receive')]);
    expect(text(container)).toMatch(/don't have access to this screen/);
    expect(container.querySelector('.lims-scan-panel')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('collect and dispatch /lab/collect', () => {
  const PERMS = ['lab.specimen.collect', 'lab.specimen.read'];
  const show = async (permissions: string[] = PERMS) => {
    const { CollectDispatch } = await import('../components/CollectDispatch');
    return wrap(<CollectDispatch permissions={permissions} />);
  };
  const tab = (re: RegExp) => screen.getByRole('tab', { name: re });

  it('Collect tab, empty: ScanPanel, h1 = menu label, tabs keep their meaning with counts, queue header row + "Scan a label to start"', async () => {
    const { container } = await show();
    expectScanScreen(container, { title: '/lab/collect', headers: ['Barcode'] });
    expect(tab(/^Collect\s*0$/).getAttribute('aria-selected')).toBe('true');
    expect(tab(/^Dispatch\s*0$/)).toBeTruthy();
    expect(text(queue(container))).toMatch(/Scan a label to start/);
    expect(resultCard(container)).toBeNull();
  });

  it('Collect tab, one scan: the result card names the barcode, the queue shows a row with a checkbox, the header row stays, Collect shows 1', async () => {
    db.set(BC(1), specimen(1));
    const { container } = await show();
    await scan(BC(1));
    await waitFor(() => expect(tab(/^Collect\s*1$/)).toBeTruthy());
    expect(text(resultCard(container))).toContain(BC(1));
    expectScanScreen(container, { title: '/lab/collect', headers: ['Barcode'] });
    expect(within(queue(container)!).getByRole('checkbox', { name: new RegExp(BC(1)) })).toBeTruthy();
    expect(screen.getByRole('button', { name: /collect selected/i })).toBeTruthy();
  });

  it('Collect tab, unknown barcode: the result card holds the not-found text; the queue header stays', async () => {
    const { container } = await show();
    await scan(BC(9));
    await waitFor(() => expect(text(resultCard(container))).toContain('No specimen with this barcode in your lab.'));
    expectScanScreen(container, { title: '/lab/collect', headers: ['Barcode'] });
  });

  it('Dispatch tab, empty then one scan: ScanPanel, header Barcode / Type / Status / Note always shown, EmptyState, then the row and the result card', async () => {
    db.set(BC(4), specimen(4, { status: 'collected' }));
    const { container } = await show();
    await kb().click(tab(/^Dispatch/));
    expectScanScreen(container, { title: '/lab/collect', headers: ['Barcode', 'Type', 'Status', 'Note'] });
    expect(text(queue(container))).toMatch(/Scan collected specimens to build a dispatch list/);
    await scan(BC(4));
    await waitFor(() => expect(within(queue(container)!).getByRole('row', { name: new RegExp(BC(4)) })).toBeTruthy());
    expect(text(resultCard(container))).toContain(BC(4));
    expectScanScreen(container, { title: '/lab/collect', headers: ['Barcode', 'Type', 'Status', 'Note'] });
    expect(tab(/^Dispatch\s*1$/)).toBeTruthy();
  });

  it('a failed lookup (500) keeps the title and the ScanPanel', async () => {
    lookupFails = true;
    const { container } = await show();
    await scan(BC(1));
    await waitFor(() => expect(text(container)).toContain('Synthetic outage'));
    expectScanScreen(container, { title: '/lab/collect', headers: ['Barcode'] });
  });

  it('no lab.specimen.collect: the page title stays with the denial text and nothing is requested', async () => {
    const { container } = await show([]);
    expect(h1s(container)).toEqual([menuLabel('/lab/collect')]);
    expect(text(container)).toMatch(/don't have access to this screen/);
    expect(filterBars(container).length).toBeLessThanOrEqual(1);
    expect(calls).toHaveLength(0);
  });
});
