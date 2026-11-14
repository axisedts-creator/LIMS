// @vitest-environment jsdom
// C12.T-23 — S9 Transfers (04-UI-UX §3 S9). ACs: AC-10.1 (dispatch), AC-10.2 (receive with discrepancy), AC-10.3 (scope gating), AC-10.4 (forbidden transitions).
// LD-140 (2026-11-13): kit components only, list + Drawer, ONE primary button, status = tone + icon + word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, api, hit, hits, isoAgo, page, problem, resetHits, router, state, store, transfer } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/transfers'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/transfers/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const T1 = ID(701);
const dispatched = (over: Record<string, unknown> = {}) => transfer(1, { status: 'dispatched', dispatched_at: isoAgo(3), version: 2, ...over });
const useTransfer = (t: unknown) => api.use(http.get(`${ORIGIN}/v1/inventory/transfers/:id`, () => HttpResponse.json(t)));
const posts = (action: string) => hit('POST', new RegExp(`^/v1/inventory/transfers/[^/]+/${action}$`));

describe('S9 list', () => {
  it('columns No., From, To, Status, Lines, Dispatched, Received; status is a Badge with a word', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['No.', 'From', 'To', 'Status', 'Lines', 'Dispatched', 'Received']) expect(heads, h).toContain(h);
    expect(within(within(grid).getByText('TRF-000001').closest('tr')!).getByText(/dispatched/i)).toBeTruthy();
    expect(within(within(grid).getByText('TRF-000002').closest('tr')!).getByText(/draft/i)).toBeTruthy();
  });
  it('no inventory.item.read: permission-denied, no API call; the only primary button is "New transfer" and only with stock.manage', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
    cleanup(); state.permissions = PERM_READ;
    await mount();
    await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /new transfer/i })).toBeNull();
    cleanup(); state.permissions = PERM_MANAGE;
    await mount();
    expect(await screen.findAllByRole('button', { name: /^new transfer$/i })).toHaveLength(1);
  });
});

describe('S9 New transfer (draft)', () => {
  it('To store comes from GET /stores?purpose=transfer_target (all tenant stores, even outside the sender scope); From from the visible stores', async () => {
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /^new transfer$/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /^to store/i }));
    expect(await screen.findByRole('option', { name: /remote store 1/i })).toBeTruthy();
    expect(hit('GET', /^\/v1\/inventory\/stores$/).some((h) => new URLSearchParams(h.search).get('purpose') === 'transfer_target')).toBe(true);
  });

  it('POST /transfers {from_store_id, to_store_id, lines:[{item_id, qty}]} with an Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/transfers`, () => HttpResponse.json(transfer(3), { status: 201 })));
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /^new transfer$/i }));
    const dlg = await screen.findByRole('dialog');
    await choose(dlg, /^from store/i, /BR1-ST1|synthetic store 1/i);
    await choose(dlg, /^to store/i, /remote store 1/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /add line/i }));
    await userEvent.type(within(dlg).getAllByRole('textbox', { name: /^qty|quantity/i })[0]!, '100');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save( draft)?$/i }));
    const p = await waitFor(() => { const h = hit('POST', /^\/v1\/inventory\/transfers$/); expect(h).toHaveLength(1); return h[0]!; });
    expect(p.json).toMatchObject({ from_store_id: ID(301), to_store_id: ID(321) });
    expect(p.json.lines[0]).toMatchObject({ qty: '100' });
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
  });

  it('From and To must differ and at least one line is required: nothing is sent', async () => {
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /^new transfer$/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save( draft)?$/i }));
    expect(hit('POST', /^\/v1\/inventory\/transfers$/)).toHaveLength(0);
  });
});

describe('S9 Dispatch (AC-10.1, AC-10.3, AC-10.4)', () => {
  it('Dispatch needs stock.manage; draft detail shows it, with the confirmation copy; POST /dispatch sends If-Match "<version>" and an Idempotency-Key', async () => {
    useTransfer(transfer(1, { version: 7 }));
    api.use(http.post(`${ORIGIN}/v1/inventory/transfers/:id/dispatch`, () => HttpResponse.json(dispatched(), { status: 200 })));
    await mount({ transfer: T1 });
    await userEvent.click(await screen.findByRole('button', { name: /^dispatch$/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog', { name: /dispatch/i }));
    expect(dlg.textContent).toMatch(/Dispatch\? Stock leaves .+ now and shows as in transit\./);
    await userEvent.click(within(dlg).getByRole('button', { name: /^(dispatch|confirm)/i }));
    await waitFor(() => expect(posts('dispatch')).toHaveLength(1));
    expect(posts('dispatch')[0]!.headers.get('if-match')).toBe('"7"');
    expect(posts('dispatch')[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('read-only user: no Dispatch / Receive / Cancel buttons', async () => {
    state.permissions = PERM_READ;
    useTransfer(transfer(1));
    await mount({ transfer: T1 });
    await screen.findByText('TRF-000001');
    for (const a of ['Dispatch', 'Receive', 'Cancel']) expect(screen.queryByRole('button', { name: new RegExp(`^${a}$`, 'i') }), a).toBeNull();
  });

  it('AC-10.4: 409 inventory.document_invalid_transition -> Banner with request_id', async () => {
    useTransfer(transfer(1));
    api.use(http.post(`${ORIGIN}/v1/inventory/transfers/:id/dispatch`, () => problem('inventory.document_invalid_transition', 409)));
    await mount({ transfer: T1 });
    await userEvent.click(await screen.findByRole('button', { name: /^dispatch$/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog', { name: /dispatch/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(dispatch|confirm)/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
  });

  it.each(['received', 'cancelled'])('AC-10.4: a %s transfer offers no state-changing action', async (status) => {
    useTransfer(transfer(1, { status, version: 3 }));
    await mount({ transfer: T1 });
    await screen.findByText('TRF-000001');
    for (const a of ['Dispatch', 'Receive', 'Cancel']) expect(screen.queryByRole('button', { name: new RegExp(`^${a}$`, 'i') }), a).toBeNull();
  });

  it('AC-10.3: 403 auth.forbidden from the API -> Banner, nothing refreshed', async () => {
    useTransfer(transfer(1));
    api.use(http.post(`${ORIGIN}/v1/inventory/transfers/:id/dispatch`, () => problem('auth.forbidden', 403)));
    await mount({ transfer: T1 });
    await userEvent.click(await screen.findByRole('button', { name: /^dispatch$/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog', { name: /dispatch/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(dispatch|confirm)/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('S9 Receive (AC-10.2, AC-10.3)', () => {
  const lineId = ID(711);
  const open = async () => {
    useTransfer(dispatched());
    await mount({ transfer: T1 });
    await userEvent.click(await screen.findByRole('button', { name: /^receive$/i }));
    return screen.findByRole('dialog');
  };
  const recv = (dlg: HTMLElement) => within(dlg).getAllByRole('textbox', { name: /received/i })[0]!;

  it('AC-10.3: POST /transfers/:id/receive -> 403 auth.forbidden -> Banner with request_id, no refresh', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/transfers/:id/receive`, () => problem('auth.forbidden', 403)));
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /^(receive|confirm|save)$/i }));
    await waitFor(() => expect(posts('receive')).toHaveLength(1));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('per line: Received qty (prefilled with the dispatched qty) + Discrepancy reason (coded set transfer_discrepancy)', async () => {
    const dlg = await open();
    expect((recv(dlg) as HTMLInputElement).value).toBe('100');
    expect(within(dlg).getByRole('button', { name: /discrepancy/i })).toBeTruthy();
    expect(hit('GET', /coded-sets\/transfer_discrepancy$/).length).toBeGreaterThan(0);
  });

  it('AC-10.2: receiving 98 of 100 without a reason sends nothing (reason required when less)', async () => {
    const dlg = await open();
    await userEvent.clear(recv(dlg));
    await userEvent.type(recv(dlg), '98');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(receive|confirm|save)$/i }));
    expect(posts('receive')).toHaveLength(0);
  });

  it('AC-10.2: 98 of 100 with reason transit_loss -> POST /receive {lines:[{line_id, received_qty_base:"98", discrepancy_reason_code}]} with If-Match and Idempotency-Key; success refreshes', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/transfers/:id/receive`, () => HttpResponse.json(dispatched({ status: 'received', version: 3 }))));
    const dlg = await open();
    await userEvent.clear(recv(dlg));
    await userEvent.type(recv(dlg), '98');
    await userEvent.click(within(dlg).getByRole('button', { name: /discrepancy/i }));
    await userEvent.click(await screen.findByRole('option', { name: /transit loss/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(receive|confirm|save)$/i }));
    await waitFor(() => expect(posts('receive')).toHaveLength(1));
    const p = posts('receive')[0]!;
    expect(p.json).toEqual({ lines: [{ line_id: lineId, received_qty_base: '98', discrepancy_reason_code: 'transit_loss' }] });
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('a full receipt (100 of 100) needs no reason and sends no discrepancy_reason_code', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/transfers/:id/receive`, () => HttpResponse.json(dispatched({ status: 'received', version: 3 }))));
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /^(receive|confirm|save)$/i }));
    await waitFor(() => expect(posts('receive')).toHaveLength(1));
    expect(posts('receive')[0]!.json.lines[0]).toEqual({ line_id: lineId, received_qty_base: '100' });
  });

  it.each(['101', '-1', '1.2345', 'abc'])('received qty %s is above the dispatched qty or malformed (3 decimals) -> nothing is sent', async (bad) => {
    const dlg = await open();
    await userEvent.clear(recv(dlg));
    await userEvent.type(recv(dlg), bad);
    await userEvent.click(within(dlg).getByRole('button', { name: /^(receive|confirm|save)$/i }));
    expect(posts('receive')).toHaveLength(0);
  });
});
