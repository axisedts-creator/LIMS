// @vitest-environment jsdom
// C12.T-22 — S7 Goods receipt: list, new receipt from a PO ("Receive") or standalone, line editor keyboard flows, scan to add lines, lot/expiry capture, post with ConfirmDialog.
// ACs: AC-06.1 (post against a PO lot), AC-06.2 (rest received later), AC-06.3 (over_receipt), AC-06.4 (server value; UI never computes), AC-06.5 (posted = immutable), AC-06.6 (PO required, /po_id),
//      AC-06.7 (opening balance only with stock.adjust; aal2 step-up), AC-06.8 (replay with the same key; second post with a new key), AC-06.9 (lot_expired). Security: PE-1 (#53 opening balance at aal1 -> auth.mfa_required), REQ-SEC-098.
// LD-140 (2026-11-13): kit components only, ONE primary button per page, every status shows tone + icon + word.
// Pinned seams: t22.harness.tsx header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_NONE, PERM_READ, PERM_STOCK, PERM_STOCK_ADJUST, api, grn, grnLine, grnSummary, hit, hits, inDays, item, itemSummary, page, po, poLine, problem, resetHits, router, state } from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_STOCK; state.path = '/inventory/receipts'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const PO2 = ID(602);
const GRN1 = ID(701);
const mountGrn = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/receipts/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const dialogNamed = async (name: RegExp) => {
  const all = () => [...screen.queryAllByRole('dialog'), ...screen.queryAllByRole('alertdialog')];
  const label = (d: Element) => d.getAttribute('aria-label') ?? d.querySelector('h1,h2,h3')?.textContent ?? '';
  await waitFor(() => expect(all().some((d) => name.test(label(d)))).toBe(true));
  return all().find((d) => name.test(label(d)))!;
};
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const disabled = (el: HTMLElement) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr')!;
const creates = () => hit('POST', /^\/v1\/inventory\/goods-receipts$/);
const puts = () => hit('PUT', /^\/v1\/inventory\/goods-receipts\/[^/]+$/);
const postsOf = () => hit('POST', /^\/v1\/inventory\/goods-receipts\/[^/]+\/post$/);
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const lotBox = (dlg: HTMLElement, line = 0) => within(dlg).getAllByRole('textbox', { name: /lot no/i })[line]!;
const expiryBox = (dlg: HTMLElement, line = 0) => within(dlg).getAllByRole('textbox', { name: /^expiry/i })[line]!;
const qtyBox = (dlg: HTMLElement, line = 0) => within(dlg).getAllByRole('textbox', { name: /^qty/i })[line]!;
const saveBtn = (dlg: HTMLElement) => within(dlg).getByRole('button', { name: /^save draft$/i });
const postBtn = (dlg: HTMLElement) => within(dlg).getByRole('button', { name: /^post receipt$/i });

/** open PO #2 (partially received: line 1 has 400 base = 1 BOX open; line 2 fully received) */
const POPARTIAL = () => po(2, { status: 'partially_received', version: 4, lines: [poLine(1, { qty_base: '800', received_qty_base: '400', open_qty_base: '400' }), poLine(2, { received_qty_base: '800', open_qty_base: '0' })] });
const receiveFromPo = async (perms = PERM_STOCK) => {
  state.permissions = perms;
  api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id`, () => HttpResponse.json(POPARTIAL())));
  await mountGrn({ po: PO2 });
  return dialogNamed(/new receipt/i);
};
const fillLot = async (dlg: HTMLElement, lot = 'L-SYN-001', expiry = '30/06/2027') => {
  await userEvent.type(lotBox(dlg), lot);
  await userEvent.type(expiryBox(dlg), `${expiry}{Tab}`);
};
const drafted = (over: Record<string, unknown> = {}) => http.post(`${ORIGIN}/v1/inventory/goods-receipts`, () => HttpResponse.json(grn(5, { id: GRN1, ...over }), { status: 201 }));

describe('S7 list (04-UI-UX §3 S7)', () => {
  it('columns GRN no., Kind, Store, Supplier, Status, Received at, Total; store and supplier ids are joined to names', async () => {
    await mountGrn();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['GRN no.', 'Kind', 'Store', 'Supplier', 'Status', 'Received at', 'Total']) expect(heads, h).toContain(h);
    const row = await rowOf('GRN-000001');
    expect(row.textContent).toMatch(/Synthetic store 1/);
    expect(row.textContent).toMatch(/Synthetic Supplier 1/);
    expect(row.textContent).toMatch(/1,412\.50/);
  });

  it('every status is a chip with a WORD (Draft / Posted) and the kind is a word (Purchase / Opening balance)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/goods-receipts`, () => page([grnSummary(1, { status: 'posted' }), grnSummary(2, { kind: 'opening_balance', status: 'draft' }), grnSummary(3, { status: 'cancelled' })])));
    await mountGrn();
    expect(within(await rowOf('GRN-000001')).getByText(/^posted$/i)).toBeTruthy();
    const r2 = await rowOf('GRN-000002');
    expect(within(r2).getByText(/^draft$/i)).toBeTruthy();
    expect(within(r2).getByText(/opening balance/i)).toBeTruthy();
    expect(within(await rowOf('GRN-000003')).getByText(/^cancelled$/i)).toBeTruthy();
  });

  it('without inventory.cost.read there is no Total column (money columns need cost.read)', async () => {
    state.permissions = ['inventory.item.read', 'inventory.stock.manage'];
    api.use(http.get(`${ORIGIN}/v1/inventory/goods-receipts`, () => page([(({ total_paisa: _t, ...s }) => s)(grnSummary(1))])));
    await mountGrn();
    const grid = await screen.findByRole('grid');
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim())).not.toContain('Total');
  });

  it('filters are query params (status, store, supplier, po_id) forwarded to the API as status / store_id / supplier_id / po_id', async () => {
    await mountGrn({ status: 'posted', store: ID(301), supplier: ID(501), po_id: PO2 });
    await screen.findByRole('grid');
    const q = new URLSearchParams(hit('GET', /^\/v1\/inventory\/goods-receipts$/)[0]!.search);
    expect(q.get('status')).toBe('posted');
    expect(q.get('store_id')).toBe(ID(301));
    expect(q.get('supplier_id')).toBe(ID(501));
    expect(q.get('po_id')).toBe(PO2);
  });

  it('empty list shows "No receipts"', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/goods-receipts`, () => page([])));
    await mountGrn();
    expect(await screen.findByText('No receipts')).toBeTruthy();
  });

  it('"New receipt" needs inventory.stock.manage; ONE primary button; no item.read -> permission-denied and no API call', async () => {
    await mountGrn();
    expect(await screen.findByRole('button', { name: /^new receipt$/i })).toBeTruthy();
    expect(document.querySelectorAll('[data-variant="primary"],[data-tone="primary"],button.primary').length).toBeLessThanOrEqual(1);
    cleanup(); state.permissions = PERM_READ;
    await mountGrn();
    await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /^new receipt$/i })).toBeNull();
    cleanup(); resetHits(); state.permissions = PERM_NONE;
    await mountGrn();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });

  it('a read-only user opening ?po=<id> does not get the receipt form', async () => {
    state.permissions = PERM_READ;
    await mountGrn({ po: PO2 });
    await screen.findByRole('grid');
    expect(screen.queryByRole('dialog', { name: /new receipt/i })).toBeNull();
  });
});

describe('S7 receive against a PO (F-04 step 6, F-05; AC-06.1, AC-06.2)', () => {
  it('?po=<id> prefills store, supplier and ONLY the lines with an open quantity, in packs (open 400 base / BOX 400 = 1)', async () => {
    const dlg = await receiveFromPo();
    expect(hit('GET', new RegExp(`/purchase-orders/${PO2}$`))).toHaveLength(1);
    expect(within(dlg).getByRole('button', { name: /^store/i }).textContent).toMatch(/Synthetic store 1/);
    expect((within(dlg).getByRole('combobox', { name: /^supplier/i }) as HTMLInputElement).value).toMatch(/Synthetic Supplier 1/);
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(1);
    expect((within(dlg).getAllByRole('combobox', { name: /^item/i })[0] as HTMLInputElement).value).toMatch(/GLU-R1/);
    expect((qtyBox(dlg) as HTMLInputElement).value).toBe('1');
  });

  it('AC-06.1 Save draft POSTs /goods-receipts {kind: purchase, store_id, supplier_id, po_id, lines[po_line_id, item_id, pack_id, qty_packs, lot_no, expiry_on]} with an Idempotency-Key and NO client totals', async () => {
    api.use(drafted());
    const dlg = await receiveFromPo();
    await fillLot(dlg);
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(creates()).toHaveLength(1));
    const p = creates()[0]!;
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
    expect(p.json).toMatchObject({ kind: 'purchase', store_id: ID(301), supplier_id: ID(501), po_id: PO2 });
    expect(p.json.lines).toHaveLength(1);
    expect(p.json.lines[0]).toMatchObject({ po_line_id: ID(611), item_id: ID(11), pack_id: ID(101), qty_packs: '1', lot_no: 'L-SYN-001', expiry_on: '2027-06-30' });
    for (const k of ['net_paisa', 'vat_paisa', 'total_paisa', 'subtotal_paisa', 'line_total_paisa', 'capitalised_value_paisa', 'qty_base', 'grn_no', 'status']) expect(p.body, k).not.toContain(`"${k}"`);
  });

  it('"Post receipt" is DISABLED until the draft is saved (and again after an edit); the totals shown after save are the server\'s', async () => {
    api.use(drafted());
    const dlg = await receiveFromPo();
    expect(disabled(postBtn(dlg))).toBe(true);
    await fillLot(dlg);
    expect(dlg.textContent).not.toMatch(/1,412|1,250\.00|162\.50/); // never computed client-side
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(creates()).toHaveLength(1));
    await waitFor(() => expect(disabled(postBtn(dlg))).toBe(false));
    expect(screen.getAllByText(/1,412\.50/).length).toBeGreaterThan(0); // server total_paisa 141250
    await userEvent.type(lotBox(dlg), 'X');
    expect(disabled(postBtn(dlg))).toBe(true);
  });

  it('saving again PUTs /goods-receipts/{id} with If-Match "<version>" (no new POST)', async () => {
    api.use(drafted({ version: 3 }), http.put(`${ORIGIN}/v1/inventory/goods-receipts/:id`, () => HttpResponse.json(grn(5, { id: GRN1, version: 4 }))));
    const dlg = await receiveFromPo();
    await fillLot(dlg);
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(creates()).toHaveLength(1));
    await userEvent.type(within(dlg).getByRole('textbox', { name: /notes/i }), 'x');
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.headers.get('if-match')).toBe('"3"');
    expect(puts()[0]!.path).toBe(`/v1/inventory/goods-receipts/${GRN1}`);
    expect(creates()).toHaveLength(1);
    // contract PUT /v1/inventory/goods-receipts/{grn_id} = GrnDraft minus kind, store_id (additionalProperties: false)
    expect(puts()[0]!.json).not.toHaveProperty('kind');
    expect(puts()[0]!.json).not.toHaveProperty('store_id');
    expect(puts()[0]!.json).toMatchObject({ lines: expect.any(Array) });
  });


  it('AC-06.1 Post receipt: ConfirmDialog "Post this receipt? Stock will be added and the receipt can no longer be edited."; confirm POSTs /post with Idempotency-Key + If-Match; toast "Receipt posted — 1 lots"', async () => {
    api.use(drafted({ version: 2 }), http.post(`${ORIGIN}/v1/inventory/goods-receipts/:id/post`, () => HttpResponse.json(grn(5, { id: GRN1, status: 'posted', posted_at: new Date().toISOString(), version: 3 }))));
    const dlg = await receiveFromPo();
    await fillLot(dlg);
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(disabled(postBtn(dlg))).toBe(false));
    await userEvent.click(postBtn(dlg));
    expect(await screen.findByText('Post this receipt? Stock will be added and the receipt can no longer be edited.')).toBeTruthy();
    expect(postsOf()).toHaveLength(0); // nothing until confirmed
    const d = await dialogNamed(/post (this )?receipt/i);
    await userEvent.click(within(d).getByRole('button', { name: /^post receipt$/i }));
    await waitFor(() => expect(postsOf()).toHaveLength(1));
    const p = postsOf()[0]!;
    expect(p.path).toBe(`/v1/inventory/goods-receipts/${GRN1}/post`);
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
    expect((await screen.findAllByText(/Receipt posted — 1 lots?/)).length).toBeGreaterThan(0);
    expect(router.refresh).toHaveBeenCalled();
  });

  it('AC-06.8 a failed post is retried with the SAME Idempotency-Key (replay); a double click sends ONE post', async () => {
    let n = 0;
    api.use(drafted({ version: 2 }), http.post(`${ORIGIN}/v1/inventory/goods-receipts/:id/post`, async () => { await new Promise((r) => setTimeout(r, 40)); return ++n === 1 ? problem('common.internal', 500) : HttpResponse.json(grn(5, { id: GRN1, status: 'posted', version: 3 })); }));
    const dlg = await receiveFromPo();
    await fillLot(dlg);
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(disabled(postBtn(dlg))).toBe(false));
    await userEvent.click(postBtn(dlg));
    await userEvent.dblClick(within(await dialogNamed(/post (this )?receipt/i)).getByRole('button', { name: /^post receipt$/i }));
    await waitFor(() => expect(postsOf()).toHaveLength(1));
    await screen.findAllByText(/req-syn-0022/);
    await userEvent.click(postBtn(dlg));
    await userEvent.click(within(await dialogNamed(/post (this )?receipt/i)).getByRole('button', { name: /^post receipt$/i }));
    await waitFor(() => expect(postsOf()).toHaveLength(2));
    expect(postsOf()[1]!.headers.get('idempotency-key')).toBe(postsOf()[0]!.headers.get('idempotency-key'));
  });

  it('AC-06.8 409 inventory.document_invalid_transition (second post, new key) -> Banner with title and request id', async () => {
    api.use(drafted({ version: 2 }), http.post(`${ORIGIN}/v1/inventory/goods-receipts/:id/post`, () => problem('inventory.document_invalid_transition', 409, { title: 'This document is already posted' })));
    const dlg = await receiveFromPo();
    await fillLot(dlg);
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(disabled(postBtn(dlg))).toBe(false));
    await userEvent.click(postBtn(dlg));
    await userEvent.click(within(await dialogNamed(/post (this )?receipt/i)).getByRole('button', { name: /^post receipt$/i }));
    const banners = await screen.findAllByRole('alert');
    expect(banners.map((b) => b.textContent).join(' ')).toMatch(/This document is already posted/);
    expect(banners.map((b) => b.textContent).join(' ')).toMatch(/req-syn-0022/);
  });

  it('AC-06.3 422 inventory.over_receipt at /lines/0/qty_packs -> inline "More than ordered (open: 400 …)." on that line', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/goods-receipts`, () => problem('inventory.over_receipt', 422, { title: 'Receipt is above the ordered quantity', errors: [{ path: '/lines/0/qty_packs', code: 'inventory.over_receipt', message: 'over' }] })));
    const dlg = await receiveFromPo();
    await userEvent.clear(qtyBox(dlg)); await userEvent.type(qtyBox(dlg), '5');
    await fillLot(dlg);
    await userEvent.click(saveBtn(dlg));
    expect(await within(dlg).findByText(/More than ordered \(open: 400/)).toBeTruthy();
  });

  it('AC-06.9 409 inventory.lot_expired at /lines/0/expiry_on -> inline "This lot has already expired. It cannot be received." (dialog stays, values kept)', async () => {
    api.use(drafted({ version: 2 }), http.post(`${ORIGIN}/v1/inventory/goods-receipts/:id/post`, () => problem('inventory.lot_expired', 409, { title: 'Lot expired', errors: [{ path: '/lines/0/expiry_on', code: 'inventory.lot_expired', message: 'expired' }] })));
    const dlg = await receiveFromPo();
    await fillLot(dlg);
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(disabled(postBtn(dlg))).toBe(false));
    await userEvent.click(postBtn(dlg));
    await userEvent.click(within(await dialogNamed(/post (this )?receipt/i)).getByRole('button', { name: /^post receipt$/i }));
    expect(await within(dlg).findByText('This lot has already expired. It cannot be received.')).toBeTruthy();
    expect((lotBox(dlg) as HTMLInputElement).value).toBe('L-SYN-001');
  });

  it('AC-06.2 receiving the rest: a fully received line is not prefilled; a PO with nothing open shows no lines to receive', async () => {
    state.permissions = PERM_STOCK;
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id`, () => HttpResponse.json(po(2, { status: 'received', version: 6, lines: [poLine(1, { received_qty_base: '800', open_qty_base: '0' })] }))));
    await mountGrn({ po: PO2 });
    const dlg = await dialogNamed(/new receipt/i);
    expect(within(dlg).queryAllByRole('combobox', { name: /^item/i }).every((c) => (c as HTMLInputElement).value === '')).toBe(true);
  });
});

describe('S7 inline validation (AC-06.x line errors)', () => {
  it('missing lot number for a lot-tracked item: "Enter the lot number printed on the pack." and no POST', async () => {
    const dlg = await receiveFromPo();
    await userEvent.type(expiryBox(dlg), '30/06/2027{Tab}');
    await userEvent.click(saveBtn(dlg));
    expect(await within(dlg).findByText('Enter the lot number printed on the pack.')).toBeTruthy();
    expect(creates()).toHaveLength(0);
  });

  it('expiry before the receipt date: "This lot has already expired. It cannot be received." and no POST', async () => {
    const dlg = await receiveFromPo();
    await userEvent.type(lotBox(dlg), 'L-OLD-1');
    await userEvent.type(expiryBox(dlg), `${ddmmyyyy(inDays(-1))}{Tab}`);
    await userEvent.click(saveBtn(dlg));
    expect(await within(dlg).findByText('This lot has already expired. It cannot be received.')).toBeTruthy();
    expect(creates()).toHaveLength(0);
  });

  it('an item that is not lot-tracked needs no lot and no expiry', async () => {
    api.use(drafted(), http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item(1, { is_lot_tracked: false, requires_expiry: false }))));
    const dlg = await receiveFromPo();
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.json.lines[0].lot_no).toBeUndefined();
  });

  it('the lot number follows ^[\\x21-\\x7E]{1,64}$: a space or 65 characters is refused, no POST', async () => {
    const dlg = await receiveFromPo();
    for (const bad of ['L SYN 1', 'L'.repeat(65)]) {
      await userEvent.clear(lotBox(dlg));
      await userEvent.type(lotBox(dlg), bad);
      await userEvent.type(expiryBox(dlg), '30/06/2027{Tab}');
      await userEvent.click(saveBtn(dlg));
      expect(creates(), bad).toHaveLength(0);
    }
  });

  it('qty packs allows at most 3 decimals and 9 integer digits; > 0', async () => {
    const dlg = await receiveFromPo();
    await fillLot(dlg);
    for (const bad of ['0', '1.2345', '1234567890']) {
      await userEvent.clear(qtyBox(dlg));
      await userEvent.type(qtyBox(dlg), bad);
      await userEvent.click(saveBtn(dlg));
      expect(creates(), bad).toHaveLength(0);
    }
  });

  it('AC-06.6 400 common.validation_failed at /po_id (grn_without_po_allowed = false) is shown in the form', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/goods-receipts`, () => problem('common.validation_failed', 400, { errors: [{ path: '/po_id', message: 'A purchase order is required for a purchase receipt' }] })));
    state.permissions = PERM_STOCK;
    await mountGrn();
    await userEvent.click(await screen.findByRole('button', { name: /^new receipt$/i }));
    const dlg = await dialogNamed(/new receipt/i);
    await userEvent.type(within(dlg).getByRole('combobox', { name: /^supplier/i }), 'Synthetic Supplier 1');
    await userEvent.click(await screen.findByRole('option', { name: /synthetic supplier 1/i }));
    await choose(dlg, /^store/i, /synthetic store 1/i);
    await userEvent.type(within(dlg).getAllByRole('combobox', { name: /^item/i })[0]!, 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await userEvent.clear(qtyBox(dlg)); await userEvent.type(qtyBox(dlg), '1');
    await fillLot(dlg);
    await userEvent.click(saveBtn(dlg));
    expect(await within(dlg).findByText(/A purchase order is required for a purchase receipt/)).toBeTruthy();
  });
});

describe('S7 line editor keyboard flows and scan to add lines (04-UI-UX §2)', () => {
  const openStandalone = async () => {
    state.permissions = PERM_STOCK;
    await mountGrn();
    await userEvent.click(await screen.findByRole('button', { name: /^new receipt$/i }));
    return dialogNamed(/new receipt/i);
  };

  it('standalone "New receipt" is kind purchase with Store, Supplier, Received at, Supplier invoice no., Invoice date, Invoice total, Notes', async () => {
    const dlg = await openStandalone();
    for (const [role, name] of [['button', /^store/i], ['combobox', /^supplier/i], ['textbox', /supplier invoice no/i], ['textbox', /invoice date/i], ['textbox', /invoice total/i], ['textbox', /notes/i], ['textbox', /received at/i]] as const)
      expect(within(dlg).getByRole(role, { name }), String(name)).toBeTruthy();
  });

  it('Alt+L adds a line and focuses the Item field of the NEW line; Ctrl+Delete removes the focused line', async () => {
    const dlg = await openStandalone();
    await userEvent.click(qtyBox(dlg, 0));
    await userEvent.keyboard('{Alt>}l{/Alt}');
    const items = within(dlg).getAllByRole('combobox', { name: /^item/i });
    expect(items).toHaveLength(2);
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    await userEvent.click(qtyBox(dlg, 1));
    await userEvent.keyboard('{Control>}{Delete}{/Control}');
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(1);
  });

  it('Enter in Qty packs moves to the next field (Lot no.) instead of submitting', async () => {
    const dlg = await openStandalone();
    await userEvent.type(qtyBox(dlg), '2{Enter}');
    expect(document.activeElement).toBe(lotBox(dlg));
    expect(creates()).toHaveLength(0);
  });

  it('scan adds a line (POST /barcodes/lookup {barcode_value}); a second scan of the same item adds 1 pack; unknown barcode shows the toast', async () => {
    let unknown = false;
    api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => (unknown ? problem('common.not_found', 404) : HttpResponse.json({ item: itemSummary(1) }))));
    const dlg = await openStandalone();
    const scan = () => within(dlg).getByRole('textbox', { name: /scan or type barcode/i });
    await userEvent.type(scan(), 'syn-gl-0001{Enter}');
    await waitFor(() => expect((within(dlg).getAllByRole('combobox', { name: /^item/i })[0] as HTMLInputElement).value).toMatch(/GLU-R1/));
    expect(hit('POST', /\/barcodes\/lookup$/)[0]!.json).toEqual({ barcode_value: 'syn-gl-0001' });
    const before = Number((qtyBox(dlg) as HTMLInputElement).value || '0');
    await userEvent.type(scan(), 'syn-gl-0001{Enter}');
    await waitFor(() => expect(Number((qtyBox(dlg) as HTMLInputElement).value)).toBe(before + 1));
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(1);
    unknown = true;
    await userEvent.type(scan(), 'SYN-NOPE{Enter}');
    expect((await screen.findAllByText('This barcode is not linked to an item. Link it from the item page.')).length).toBeGreaterThan(0);
  });

  it('the scanned value never appears in any URL, query string or router call (REQ-SEC-098)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => HttpResponse.json({ item: itemSummary(1) })));
    const dlg = await openStandalone();
    await userEvent.type(within(dlg).getByRole('textbox', { name: /scan or type barcode/i }), 'SYN-SECRET-22{Enter}');
    await waitFor(() => expect(hit('POST', /\/barcodes\/lookup$/)).toHaveLength(1));
    for (const h of hits) expect(h.path + h.search).not.toMatch(/SYN-SECRET-22/i);
    for (const f of Object.values(router)) for (const c of f.mock.calls) expect(JSON.stringify(c)).not.toMatch(/SYN-SECRET-22/i);
  });
});

describe('S7 opening balance and step-up (AC-06.7, PE-1)', () => {
  const openNew = async (perms: string[]) => {
    state.permissions = perms;
    await mountGrn();
    await userEvent.click(await screen.findByRole('button', { name: /^new receipt$/i }));
    return dialogNamed(/new receipt/i);
  };

  it('after the first save the Kind radio is gone and the Store cannot be changed (kind and store_id are fixed once a draft exists)', async () => {
    api.use(drafted({ kind: 'opening_balance', supplier_id: undefined, po_id: undefined }));
    const dlg = await openNew(PERM_STOCK_ADJUST);
    expect(within(dlg).getByRole('radio', { name: /opening balance/i })).toBeTruthy(); // editable before the first save
    await userEvent.click(within(dlg).getByRole('radio', { name: /opening balance/i }));
    await choose(dlg, /^store/i, /synthetic store 1/i);
    await userEvent.type(within(dlg).getAllByRole('combobox', { name: /^item/i })[0]!, 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await userEvent.clear(qtyBox(dlg)); await userEvent.type(qtyBox(dlg), '3');
    await fillLot(dlg, 'L-OPEN-1');
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(creates()).toHaveLength(1));
    await waitFor(() => expect(within(dlg).queryByRole('radio', { name: /opening balance/i })).toBeNull());
    expect(within(dlg).queryByRole('radio', { name: /^purchase$/i })).toBeNull();
    const store = within(dlg).queryByRole('button', { name: /^store/i }); // read-only text, or a disabled Select
    expect(store === null || disabled(store)).toBe(true);
  });

  it('"Opening balance" is offered only with inventory.stock.adjust', async () => {
    const plain = await openNew(PERM_STOCK);
    expect(within(plain).queryByRole('radio', { name: /opening balance/i })).toBeNull();
    cleanup();
    const adj = await openNew(PERM_STOCK_ADJUST);
    expect(within(adj).getByRole('radio', { name: /^purchase$/i })).toBeTruthy();
    expect(within(adj).getByRole('radio', { name: /opening balance/i })).toBeTruthy();
  });

  it('an opening-balance receipt is created with kind opening_balance, no supplier and no po_id', async () => {
    api.use(drafted({ kind: 'opening_balance', supplier_id: undefined, po_id: undefined }));
    const dlg = await openNew(PERM_STOCK_ADJUST);
    await userEvent.click(within(dlg).getByRole('radio', { name: /opening balance/i }));
    expect(within(dlg).queryByRole('combobox', { name: /^supplier/i })).toBeNull();
    await choose(dlg, /^store/i, /synthetic store 1/i);
    await userEvent.type(within(dlg).getAllByRole('combobox', { name: /^item/i })[0]!, 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await userEvent.clear(qtyBox(dlg)); await userEvent.type(qtyBox(dlg), '3');
    await fillLot(dlg, 'L-OPEN-1');
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.json.kind).toBe('opening_balance');
    expect('supplier_id' in creates()[0]!.json).toBe(false);
    expect('po_id' in creates()[0]!.json).toBe(false);
  });

  it('403 auth.mfa_required on posting an opening balance -> Banner mentioning verification; the form stays; the retry reuses the Idempotency-Key', async () => {
    let n = 0;
    api.use(
      drafted({ kind: 'opening_balance', version: 2 }),
      http.post(`${ORIGIN}/v1/inventory/goods-receipts/:id/post`, () => (++n === 1 ? problem('auth.mfa_required', 403) : HttpResponse.json(grn(5, { id: GRN1, kind: 'opening_balance', status: 'posted', version: 3 })))),
    );
    const dlg = await openNew(PERM_STOCK_ADJUST);
    await userEvent.click(within(dlg).getByRole('radio', { name: /opening balance/i }));
    await choose(dlg, /^store/i, /synthetic store 1/i);
    await userEvent.type(within(dlg).getAllByRole('combobox', { name: /^item/i })[0]!, 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await userEvent.clear(qtyBox(dlg)); await userEvent.type(qtyBox(dlg), '3');
    await fillLot(dlg, 'L-OPEN-1');
    await userEvent.click(saveBtn(dlg));
    await waitFor(() => expect(disabled(postBtn(dlg))).toBe(false));
    await userEvent.click(postBtn(dlg));
    await userEvent.click(within(await dialogNamed(/post (this )?receipt/i)).getByRole('button', { name: /^post receipt$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/verif/i);
    expect(router.refresh).not.toHaveBeenCalled();
    await userEvent.click(postBtn(dlg));
    await userEvent.click(within(await dialogNamed(/post (this )?receipt/i)).getByRole('button', { name: /^post receipt$/i }));
    await waitFor(() => expect(postsOf()).toHaveLength(2));
    expect(postsOf()[1]!.headers.get('idempotency-key')).toBe(postsOf()[0]!.headers.get('idempotency-key'));
  });

  it('403 auth.forbidden on an opening balance -> Banner with the registry title and request id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/goods-receipts`, () => problem('auth.forbidden', 403, { title: 'You do not have permission to do this' })));
    const dlg = await openNew(PERM_STOCK_ADJUST);
    await userEvent.click(within(dlg).getByRole('radio', { name: /opening balance/i }));
    await choose(dlg, /^store/i, /synthetic store 1/i);
    await userEvent.type(within(dlg).getAllByRole('combobox', { name: /^item/i })[0]!, 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await userEvent.clear(qtyBox(dlg)); await userEvent.type(qtyBox(dlg), '3');
    await fillLot(dlg, 'L-OPEN-2');
    await userEvent.click(saveBtn(dlg));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/You do not have permission to do this/);
    expect(banner.textContent).toMatch(/req-syn-0022/);
  });
});

describe('S7 posted receipt detail and invoice mismatch (AC-06.4, AC-06.5)', () => {
  const openGrn = async (over: Record<string, unknown> = {}) => {
    api.use(http.get(`${ORIGIN}/v1/inventory/goods-receipts/:id`, () => HttpResponse.json(grn(1, { id: GRN1, ...over }))));
    await mountGrn({ grn: GRN1 });
    return dialogNamed(/goods receipt GRN-000001/i);
  };

  it('AC-06.5 a posted receipt is read-only: lot and expiry as text, no Save draft, no Post receipt, no editable fields', async () => {
    const dlg = await openGrn({ status: 'posted', posted_at: new Date().toISOString(), version: 3 });
    expect(dlg.textContent).toMatch(/L-SYN-001/);
    expect(dlg.textContent).toMatch(/posted/i);
    expect(within(dlg).queryByRole('button', { name: /^save draft$/i })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: /^post receipt$/i })).toBeNull();
    expect(within(dlg).queryAllByRole('textbox', { name: /lot no/i })).toHaveLength(0);
  });

  it('AC-06.5 409 common.immutable_record on a save is shown as a Banner with title and request id', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/goods-receipts/:id`, () => problem('common.immutable_record', 409, { title: 'This record can no longer be changed' })));
    const dlg = await openGrn({ status: 'draft', version: 2 });
    await userEvent.type(within(dlg).getByRole('textbox', { name: /notes/i }), 'x');
    await userEvent.click(saveBtn(dlg));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/can no longer be changed/);
    expect(banner.textContent).toMatch(/req-syn-0022/);
  });

  it('AC-06.4 shows the server\'s total on a saved receipt and the mismatch Banner "Invoice total {invoice} differs from the calculated total {calc} by {diff}."', async () => {
    const dlg = await openGrn({ supplier_invoice_total_paisa: 150000, invoice_total_mismatch_paisa: 8750, total_paisa: 141250, version: 2 });
    const warn = await within(dlg).findByText(/Invoice total .*1,500\.00.* differs from the calculated total .*1,412\.50.* by .*87\.50/);
    expect(warn).toBeTruthy();
  });

  it('no mismatch Banner when the invoice total equals the calculated total', async () => {
    const dlg = await openGrn({ supplier_invoice_total_paisa: 141250, version: 2 });
    expect(within(dlg).queryByText(/differs from the calculated total/)).toBeNull();
  });

  it('without inventory.cost.read the receipt shows no money', async () => {
    state.permissions = ['inventory.item.read', 'inventory.stock.manage'];
    const dlg = await openGrn({ ...{ total_paisa: undefined, net_paisa: undefined, vat_paisa: undefined, lines: [(({ unit_price_paisa: _a, net_paisa: _b, vat_paisa: _c, line_total_paisa: _d, ...l }) => l)(grnLine(1))] } });
    expect(dlg.textContent).not.toMatch(/1,412|1,250\.00/);
    expect(within(dlg).queryByRole('textbox', { name: /unit price/i })).toBeNull();
  });
});
