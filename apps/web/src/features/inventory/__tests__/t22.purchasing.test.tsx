// @vitest-environment jsdom
// C12.T-22 — S6 Purchase orders: list, editor (line editor keyboard flows, scan to add lines), step-up on approve, lifecycle actions, print view S6-P.
// ACs: AC-05.1 (server-computed totals, no client totals), AC-05.2 (approve; frozen), AC-05.3 (self-approval), AC-05.4 (mark sent), AC-05.5 (cancel), AC-05.6 (close), AC-05.7 (forbidden transition shown),
//      AC-05.8 (tax code / exempt wire shape, tax_config_missing on the line). Security: 07-SECURITY PE-1 (po.approve at aal1 -> auth.mfa_required -> step-up), cost fields only with inventory.cost.read, REQ-SEC-098 (scanned value never in a URL).
// LD-140 (2026-11-13): kit components only, ONE primary button per page, every status shows tone + icon + word.
// Pinned seams: t22.harness.tsx header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_NONE, PERM_PO_ALL, PERM_PO_APPROVE, PERM_PO_MANAGE, PERM_PO_MANAGE_NO_COST, PERM_READ, api, hit, hits, item, itemSummary, page, po, poLine, poSummary, printView, problem, resetHits, router, state } from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_PO_MANAGE; state.path = '/inventory/purchase-orders'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const PO2 = ID(602);
const mountPos = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/purchase-orders/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const dialogNamed = async (name: RegExp) => {
  await waitFor(() => expect([...screen.queryAllByRole('dialog'), ...screen.queryAllByRole('alertdialog')].some((d) => name.test(d.getAttribute('aria-label') ?? d.querySelector('h1,h2,h3')?.textContent ?? ''))).toBe(true));
  return [...screen.queryAllByRole('dialog'), ...screen.queryAllByRole('alertdialog')].find((d) => name.test(d.getAttribute('aria-label') ?? d.querySelector('h1,h2,h3')?.textContent ?? ''))!;
};
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const disabled = (el: HTMLElement) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr')!;
const creates = () => hit('POST', /^\/v1\/inventory\/purchase-orders$/);
const puts = () => hit('PUT', /^\/v1\/inventory\/purchase-orders\/[^/]+$/);
const posts = (suffix: string) => hit('POST', new RegExp(`^/v1/inventory/purchase-orders/[^/]+/${suffix}$`));
const created = (over: Record<string, unknown> = {}) => http.post(`${ORIGIN}/v1/inventory/purchase-orders`, () => HttpResponse.json(po(5, { id: ID(605), ...over }), { status: 201 }));

const openNew = async () => {
  await mountPos();
  await userEvent.click(await screen.findByRole('button', { name: /^new po$/i }));
  return dialogNamed(/new purchase order/i);
};
const pickItem = async (dlg: HTMLElement, line: number, text: string, optionRe: RegExp) => {
  await userEvent.type(within(dlg).getAllByRole('combobox', { name: /^item/i })[line]!, text);
  await userEvent.click(await screen.findByRole('option', { name: optionRe }));
};
const qtyBox = (dlg: HTMLElement, line = 0) => within(dlg).getAllByRole('textbox', { name: /^qty/i })[line]!;
const priceBox = (dlg: HTMLElement, line = 0) => within(dlg).getAllByRole('textbox', { name: /unit price/i })[line]!;
const fillHeader = async (dlg: HTMLElement) => {
  await userEvent.type(within(dlg).getByRole('combobox', { name: /^supplier/i }), 'Synthetic Supplier 1');
  await userEvent.click(await screen.findByRole('option', { name: /synthetic supplier 1/i }));
  await choose(dlg, /receiving store/i, /synthetic store 1/i);
};
/** supplier + store + one GLU-R1 line, qty 2, price Rs. 1250 */
const fillValid = async (dlg: HTMLElement) => {
  await fillHeader(dlg);
  await pickItem(dlg, 0, 'GLU', /GLU-R1/);
  await userEvent.clear(qtyBox(dlg)); await userEvent.type(qtyBox(dlg), '2');
  await userEvent.type(priceBox(dlg), '1250');
};
const save = (dlg: HTMLElement) => userEvent.click(within(dlg).getByRole('button', { name: /^save draft$/i }));

describe('S6 list (04-UI-UX §3 S6)', () => {
  it('columns PO no., Supplier, Store, Status, Total, Created, Expected; supplier and store ids are joined to names', async () => {
    await mountPos();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['PO no.', 'Supplier', 'Store', 'Status', 'Total', 'Created', 'Expected']) expect(heads, h).toContain(h);
    const row = await rowOf('PO-000001');
    expect(row.textContent).toMatch(/Synthetic Supplier 1/);
    expect(row.textContent).toMatch(/Synthetic store 1/);
    expect(row.textContent).toMatch(/2,825\.00/); // total_paisa 282500, lakh grouping, cost.read held
  });

  it('every status is a chip with a WORD (Draft / Approved / Partially received)', async () => {
    await mountPos();
    expect(within(await rowOf('PO-000001')).getByText(/^draft$/i)).toBeTruthy();
    expect(within(await rowOf('PO-000002')).getByText(/^approved$/i)).toBeTruthy();
    expect(within(await rowOf('PO-000003')).getByText(/^partially received$/i)).toBeTruthy();
  });

  it('without inventory.cost.read there is no Total column and no money text (the server omits it too)', async () => {
    state.permissions = PERM_PO_MANAGE_NO_COST;
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders`, () => page([(({ total_paisa: _t, ...s }) => s)(poSummary(1))])));
    await mountPos();
    const grid = await screen.findByRole('grid');
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim())).not.toContain('Total');
    expect(grid.textContent).not.toMatch(/2,825/);
  });

  it('filters are query params (status, supplier, branch, created range) forwarded to the API as status / supplier_id / branch_id / created_at_from / created_at_to', async () => {
    await mountPos({ status: 'approved', supplier: ID(501), branch: ID(401), created_from: '2026-11-01T00:00:00.000Z', created_to: '2026-11-30T00:00:00.000Z' });
    await screen.findByRole('grid');
    const q = new URLSearchParams(hit('GET', /^\/v1\/inventory\/purchase-orders$/)[0]!.search);
    expect(q.get('status')).toBe('approved');
    expect(q.get('supplier_id')).toBe(ID(501));
    expect(q.get('branch_id')).toBe(ID(401));
    expect(q.get('created_at_from')).toBe('2026-11-01T00:00:00.000Z');
    expect(q.get('created_at_to')).toBe('2026-11-30T00:00:00.000Z');
  });

  it('empty list shows "No purchase orders"', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders`, () => page([])));
    await mountPos();
    expect(await screen.findByText('No purchase orders')).toBeTruthy();
  });

  it('"New PO" needs inventory.po.manage; exactly ONE primary button on the page', async () => {
    await mountPos();
    expect(await screen.findByRole('button', { name: /^new po$/i })).toBeTruthy();
    expect(document.querySelectorAll('[data-variant="primary"],[data-tone="primary"],button.primary').length).toBeLessThanOrEqual(1);
    cleanup(); state.permissions = PERM_READ;
    await mountPos();
    await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /^new po$/i })).toBeNull();
  });

  it('no inventory.item.read: permission-denied and no API call', async () => {
    state.permissions = PERM_NONE;
    await mountPos();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });
});

describe('S6 editor — create (AC-05.1, AC-05.8; F-04 steps 1–3)', () => {
  it('header fields Supplier (Combobox), Receiving store (Select), Expected on, Notes; the copy "Amounts are calculated by the system when you save."', async () => {
    const dlg = await openNew();
    expect(within(dlg).getByRole('combobox', { name: /^supplier/i })).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: /receiving store/i })).toBeTruthy();
    expect(within(dlg).getByRole('textbox', { name: /expected on/i })).toBeTruthy();
    expect(within(dlg).getByRole('textbox', { name: /notes/i })).toBeTruthy();
    expect(within(dlg).getByText('Amounts are calculated by the system when you save.')).toBeTruthy();
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(1); // opens with one empty line
  });

  it('Save draft POSTs /purchase-orders: ids, qty_packs as a decimal STRING, price in paisa, tax_code, is_exempt; Idempotency-Key header; NO client totals (CV §4.7)', async () => {
    api.use(created());
    const dlg = await openNew();
    await fillValid(dlg);
    await userEvent.type(within(dlg).getByRole('textbox', { name: /notes/i }), 'Synthetic order note');
    await save(dlg);
    await waitFor(() => expect(creates()).toHaveLength(1));
    const p = creates()[0]!;
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
    expect(p.json.supplier_id).toBe(ID(501));
    expect(p.json.store_id).toBe(ID(301));
    expect(p.json.notes).toBe('Synthetic order note');
    expect(p.json.lines).toHaveLength(1);
    expect(p.json.lines[0]).toMatchObject({ item_id: ID(11), pack_id: ID(101), qty_packs: '2', unit_price_paisa: 125000, tax_code: 'VAT', is_exempt: false });
    expect(typeof p.json.lines[0].qty_packs).toBe('string');
    for (const k of ['subtotal_paisa', 'discount_total_paisa', 'net_paisa', 'vat_paisa', 'total_paisa', 'line_total_paisa', 'tax_rate_bp', 'qty_base', 'status', 'po_no'])
      expect(p.body, k).not.toContain(`"${k}"`);
  });

  it('the UI never shows an amount it computed: before save no net/VAT/total appears; after save the SERVER totals and the rate snapshot ("VAT 13%") are shown', async () => {
    api.use(created());
    const dlg = await openNew();
    await fillValid(dlg);
    expect(dlg.textContent).not.toMatch(/2,500|2,825|325\.00/); // 2 x 1250 = 2,500; +13% = 2,825 — must not be computed client-side
    await save(dlg);
    await waitFor(() => expect(creates()).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText(/2,825\.00/).length).toBeGreaterThan(0)); // server total_paisa 282500
    expect(screen.getAllByText(/325\.00/).length).toBeGreaterThan(0); // server vat_paisa 32500
    expect(screen.getAllByText(/VAT 13%/).length).toBeGreaterThan(0);
    expect(router.refresh).toHaveBeenCalled();
    expect((await screen.findAllByText(/PO saved/)).length).toBeGreaterThan(0);
  });

  it('defaults after choosing an item: purchase-default pack, tax VAT, and the supplier item last price (F-04 step 2)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/suppliers/:id/items`, () => page([{ id: ID(2000), supplier_id: ID(501), item_id: ID(11), pack_id: ID(101), last_unit_price_paisa: 99900, is_active: true, version: 1 }])));
    const dlg = await openNew();
    await fillHeader(dlg);
    await pickItem(dlg, 0, 'GLU', /GLU-R1/);
    expect(within(dlg).getByRole('button', { name: /pack/i }).textContent).toMatch(/BOX \(400 test\)/);
    expect(within(dlg).getByRole('button', { name: /^tax/i }).textContent).toMatch(/VAT/);
    expect((priceBox(dlg) as HTMLInputElement).value).toMatch(/999(\.00)?/);
  });

  it('the item default tax code is preselected (item.default_tax_code = EXC) and sent', async () => {
    api.use(created(), http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item(1, { default_tax_code: 'EXC' }))));
    const dlg = await openNew();
    await fillValid(dlg);
    expect(within(dlg).getByRole('button', { name: /^tax/i }).textContent).toMatch(/Excise/);
    await save(dlg);
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.json.lines[0].tax_code).toBe('EXC');
  });

  it('AC-05.8 "Exempt (no tax code)" sends is_exempt: true and NO tax_code key (no null on the wire)', async () => {
    api.use(created());
    const dlg = await openNew();
    await fillValid(dlg);
    await choose(dlg, /^tax/i, /exempt \(no tax code\)/i);
    await save(dlg);
    await waitFor(() => expect(creates()).toHaveLength(1));
    const l = creates()[0]!.json.lines[0];
    expect(l.is_exempt).toBe(true);
    expect('tax_code' in l).toBe(false);
    expect(creates()[0]!.body).not.toContain('null');
  });

  it('AC-05.8 422 catalog.tax_config_missing is shown on THAT line\'s Tax field; the dialog stays open and keeps its values', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders`, () => problem('catalog.tax_config_missing', 422, { title: 'Tax rate is not configured', errors: [{ path: '/lines/0/tax_code', code: 'catalog.tax_config_missing', message: 'Tax rate is not configured for VAT' }] })));
    const dlg = await openNew();
    await fillValid(dlg);
    await save(dlg);
    expect(await within(dlg).findByText(/Tax rate is not configured for VAT/)).toBeTruthy();
    expect(creates()).toHaveLength(1);
    expect((qtyBox(dlg) as HTMLInputElement).value).toBe('2');
  });

  it('AC-05.8 400 validation_failed at /lines/0/tax_code (inactive code) is shown on the Tax field', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders`, () => problem('common.validation_failed', 400, { errors: [{ path: '/lines/0/tax_code', message: 'Tax code is not active' }] })));
    const dlg = await openNew();
    await fillValid(dlg);
    await save(dlg);
    expect(await within(dlg).findByText(/Tax code is not active/)).toBeTruthy();
  });

  it('client validation: supplier, store and a line item are required; qty must be > 0 with at most 3 decimals and 9 integer digits — no POST until valid', async () => {
    const dlg = await openNew();
    await save(dlg);
    expect(creates()).toHaveLength(0);
    expect((await within(dlg).findAllByText(/is required|required/i)).length).toBeGreaterThan(0);
    await fillHeader(dlg);
    await pickItem(dlg, 0, 'GLU', /GLU-R1/);
    for (const bad of ['0', '1.2345', '1234567890']) {
      await userEvent.clear(qtyBox(dlg));
      await userEvent.type(qtyBox(dlg), bad);
      await save(dlg);
      expect(creates(), bad).toHaveLength(0);
    }
  });

  it('the Idempotency-Key is generated when the form opens and REUSED on retry; a successful save resets it', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders`, () => (++n === 1 ? problem('common.internal', 500) : HttpResponse.json(po(5, { id: ID(605) }), { status: 201 }))));
    const dlg = await openNew();
    await fillValid(dlg);
    await save(dlg);
    await within(dlg).findAllByText(/req-syn-0022/);
    await save(dlg);
    await waitFor(() => expect(creates()).toHaveLength(2));
    expect(creates()[1]!.headers.get('idempotency-key')).toBe(creates()[0]!.headers.get('idempotency-key'));
    cleanup();
    api.use(created());
    const dlg2 = await openNew();
    await fillValid(dlg2);
    await save(dlg2);
    await waitFor(() => expect(creates()).toHaveLength(3));
    expect(creates()[2]!.headers.get('idempotency-key')).not.toBe(creates()[0]!.headers.get('idempotency-key'));
  });

  it('without inventory.cost.read the editor has NO price, discount or tax fields and the POST carries no money', async () => {
    state.permissions = PERM_PO_MANAGE_NO_COST;
    api.use(created());
    const dlg = await openNew();
    expect(within(dlg).queryByRole('textbox', { name: /unit price/i })).toBeNull();
    expect(within(dlg).queryByRole('textbox', { name: /^discount/i })).toBeNull();
    await fillHeader(dlg);
    await pickItem(dlg, 0, 'GLU', /GLU-R1/);
    await userEvent.clear(qtyBox(dlg)); await userEvent.type(qtyBox(dlg), '2');
    await save(dlg);
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.body).not.toContain('unit_price_paisa');
    expect(creates()[0]!.body).not.toContain('discount_paisa');
  });
});

describe('S6 line editor — keyboard flows and scan to add lines (04-UI-UX §2)', () => {
  it('Alt+L adds a line and focuses the Item field of the NEW line', async () => {
    const dlg = await openNew();
    await userEvent.click(qtyBox(dlg, 0));
    await userEvent.keyboard('{Alt>}l{/Alt}');
    const items = within(dlg).getAllByRole('combobox', { name: /^item/i });
    expect(items).toHaveLength(2);
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
  });

  it('Ctrl+Delete removes the focused line (the last remaining line is kept)', async () => {
    const dlg = await openNew();
    await userEvent.keyboard('{Alt>}l{/Alt}');
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(2);
    await userEvent.click(qtyBox(dlg, 1));
    await userEvent.keyboard('{Control>}{Delete}{/Control}');
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(1);
    await userEvent.click(qtyBox(dlg, 0));
    await userEvent.keyboard('{Control>}{Delete}{/Control}');
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('Enter in a Qty field moves to the next field of the line (Unit price) instead of submitting', async () => {
    const dlg = await openNew();
    await userEvent.type(qtyBox(dlg), '3{Enter}');
    expect(document.activeElement).toBe(priceBox(dlg));
    expect(creates()).toHaveLength(0);
  });

  it('Ctrl+Enter submits the form (Form default)', async () => {
    api.use(created());
    const dlg = await openNew();
    await fillValid(dlg);
    await userEvent.click(qtyBox(dlg));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(creates()).toHaveLength(1));
  });

  it('scan: a barcode in "Scan or type barcode" is looked up with POST /barcodes/lookup {barcode_value} (value in the BODY only) and adds a line for the item', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => HttpResponse.json({ item: itemSummary(1) })));
    const dlg = await openNew();
    await userEvent.type(within(dlg).getByRole('textbox', { name: /scan or type barcode/i }), 'syn-gl-0001{Enter}');
    await waitFor(() => expect(hit('POST', /\/barcodes\/lookup$/)).toHaveLength(1));
    expect(hit('POST', /\/barcodes\/lookup$/)[0]!.json).toEqual({ barcode_value: 'syn-gl-0001' });
    await waitFor(() => expect((within(dlg).getAllByRole('combobox', { name: /^item/i })[0] as HTMLInputElement).value).toMatch(/GLU-R1/));
    expect((within(dlg).getByRole('textbox', { name: /scan or type barcode/i }) as HTMLInputElement).value).toBe(''); // clearAfterScan
  });

  it('scanning the same item again focuses its line and adds 1 pack (no second line)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => HttpResponse.json({ item: itemSummary(1) })));
    const dlg = await openNew();
    const scan = () => within(dlg).getByRole('textbox', { name: /scan or type barcode/i });
    await userEvent.type(scan(), 'SYN-GL-0001{Enter}');
    await waitFor(() => expect((within(dlg).getAllByRole('combobox', { name: /^item/i })[0] as HTMLInputElement).value).toMatch(/GLU-R1/));
    const before = Number((qtyBox(dlg) as HTMLInputElement).value || '0');
    await userEvent.type(scan(), 'SYN-GL-0001{Enter}');
    await waitFor(() => expect(Number((qtyBox(dlg) as HTMLInputElement).value)).toBe(before + 1));
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(1);
  });

  it('unknown barcode (404): toast "This barcode is not linked to an item. Link it from the item page." and no line is added', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => problem('common.not_found', 404)));
    const dlg = await openNew();
    await userEvent.type(within(dlg).getByRole('textbox', { name: /scan or type barcode/i }), 'SYN-UNKNOWN-1{Enter}');
    expect((await screen.findAllByText('This barcode is not linked to an item. Link it from the item page.')).length).toBeGreaterThan(0);
    expect((within(dlg).getAllByRole('combobox', { name: /^item/i })[0] as HTMLInputElement).value).toBe('');
  });

  it('the scanned value never appears in any URL, query string or router call (REQ-SEC-098)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/barcodes/lookup`, () => HttpResponse.json({ item: itemSummary(1) })));
    const dlg = await openNew();
    await userEvent.type(within(dlg).getByRole('textbox', { name: /scan or type barcode/i }), 'SYN-SECRET-22{Enter}');
    await waitFor(() => expect(hit('POST', /\/barcodes\/lookup$/)).toHaveLength(1));
    for (const h of hits) expect(h.path + h.search).not.toMatch(/SYN-SECRET-22/i);
    for (const f of Object.values(router)) for (const c of f.mock.calls) expect(JSON.stringify(c)).not.toMatch(/SYN-SECRET-22/i);
  });
});

describe('S6 editor — edit a draft (?po=<id>)', () => {
  const openDraft = async (over: Record<string, unknown> = {}, perms = PERM_PO_ALL) => {
    state.permissions = perms;
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id`, () => HttpResponse.json(po(2, over))));
    await mountPos({ po: PO2 });
    return dialogNamed(/edit purchase order/i);
  };

  it('Save draft PUTs /purchase-orders/{id} with If-Match "<version>" (no Idempotency-Key required) and the full replacement body', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/purchase-orders/:id`, () => HttpResponse.json(po(2, { version: 2 }))));
    const dlg = await openDraft({ version: 3 });
    await userEvent.type(within(dlg).getByRole('textbox', { name: /notes/i }), ' more');
    await save(dlg);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.headers.get('if-match')).toBe('"3"');
    expect(puts()[0]!.path).toBe(`/v1/inventory/purchase-orders/${PO2}`);
    expect(puts()[0]!.json.supplier_id).toBe(ID(501));
    expect(puts()[0]!.json.lines[0]).toMatchObject({ item_id: ID(11), pack_id: ID(101), qty_packs: '2' });
    expect(puts()[0]!.body).not.toContain('total_paisa');
  });

  it('"Approve" is DISABLED while there are unsaved changes and enabled when the form is clean', async () => {
    const dlg = await openDraft();
    const approve = () => within(dlg).getByRole('button', { name: /^approve$/i });
    expect(disabled(approve())).toBe(false);
    await userEvent.type(within(dlg).getByRole('textbox', { name: /notes/i }), 'x');
    expect(disabled(approve())).toBe(true);
  });

  it('a 409 on save (version_conflict) shows the banner with the request id and keeps the form', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/purchase-orders/:id`, () => problem('common.version_conflict', 409, { title: 'Someone else changed this record' })));
    const dlg = await openDraft();
    await userEvent.type(within(dlg).getByRole('textbox', { name: /notes/i }), 'x');
    await save(dlg);
    expect((await within(dlg).findAllByText(/Someone else changed this record/)).length).toBeGreaterThan(0);
    expect(within(dlg).getAllByText(/req-syn-0022/).length).toBeGreaterThan(0);
  });

  it('"Delete line" removes a line of the draft', async () => {
    const dlg = await openDraft({ lines: [poLine(1), poLine(2)] });
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(2);
    await userEvent.click(within(dlg).getAllByRole('button', { name: /delete line/i })[0]!);
    expect(within(dlg).getAllByRole('combobox', { name: /^item/i })).toHaveLength(1);
  });
});

describe('S6 approve — step-up MFA (AC-05.2, AC-05.3, PE-1; F-04 step 4)', () => {
  const openForApprove = async (perms = PERM_PO_ALL, over: Record<string, unknown> = {}) => {
    state.permissions = perms;
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id`, () => HttpResponse.json(po(2, { version: 3, ...over }))));
    await mountPos({ po: PO2 });
    return dialogNamed(/edit purchase order/i);
  };

  it('Approve needs inventory.po.approve — hidden for a po.manage-only user', async () => {
    const dlg = await openForApprove(PERM_PO_MANAGE);
    expect(within(dlg).queryByRole('button', { name: /^approve$/i })).toBeNull();
  });

  it('POST /approve with Idempotency-Key and If-Match "<version>"; success toast "PO approved" and a refresh', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/approve`, () => HttpResponse.json(po(2, { status: 'approved', version: 4, approved_at: new Date().toISOString() }))));
    const dlg = await openForApprove();
    await userEvent.click(within(dlg).getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(posts('approve')).toHaveLength(1));
    const p = posts('approve')[0]!;
    expect(p.path).toBe(`/v1/inventory/purchase-orders/${PO2}/approve`);
    expect(p.headers.get('if-match')).toBe('"3"');
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
    expect((await screen.findAllByText(/PO approved/)).length).toBeGreaterThan(0);
    expect(router.refresh).toHaveBeenCalled();
  });

  it('403 auth.mfa_required -> Banner mentioning verification, the dialog stays open, nothing refreshed; the retry REUSES the same Idempotency-Key', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/approve`, () => (++n === 1 ? problem('auth.mfa_required', 403) : HttpResponse.json(po(2, { status: 'approved', version: 4 })))));
    const dlg = await openForApprove();
    await userEvent.click(within(dlg).getByRole('button', { name: /^approve$/i }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/verif/i);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /edit purchase order/i })).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(posts('approve')).toHaveLength(2));
    expect(posts('approve')[1]!.headers.get('idempotency-key')).toBe(posts('approve')[0]!.headers.get('idempotency-key'));
    expect(posts('approve')[1]!.headers.get('if-match')).toBe('"3"');
  });

  it('AC-05.3 403 inventory.po_self_approval_forbidden -> Banner with the registry title and request id; no refresh', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/approve`, () => problem('inventory.po_self_approval_forbidden', 403, { title: 'You cannot approve a purchase order you created' })));
    const dlg = await openForApprove();
    await userEvent.click(within(dlg).getByRole('button', { name: /^approve$/i }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/You cannot approve a purchase order you created/);
    expect(banner.textContent).toMatch(/req-syn-0022/);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('AC-05.7 409 inventory.po_invalid_transition -> Banner with title and request id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/approve`, () => problem('inventory.po_invalid_transition', 409, { title: 'This purchase order cannot change to that state' })));
    const dlg = await openForApprove();
    await userEvent.click(within(dlg).getByRole('button', { name: /^approve$/i }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/cannot change to that state/);
    expect(banner.textContent).toMatch(/req-syn-0022/);
  });

  it('a double click sends ONE approve request', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/approve`, async () => { await new Promise((r) => setTimeout(r, 60)); return HttpResponse.json(po(2, { status: 'approved', version: 4 })); }));
    const dlg = await openForApprove();
    const b = within(dlg).getByRole('button', { name: /^approve$/i });
    await userEvent.dblClick(b);
    await new Promise((r) => setTimeout(r, 150));
    expect(posts('approve')).toHaveLength(1);
  });

  it('the browser never receives the access token (BFF only)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/approve`, () => HttpResponse.json(po(2, { status: 'approved', version: 4 }))));
    const dlg = await openForApprove();
    await userEvent.click(within(dlg).getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(posts('approve')).toHaveLength(1));
    expect(document.documentElement.innerHTML).not.toContain('jwt-synthetic');
  });
});

describe('S6 detail of a non-draft PO and its actions (AC-05.2 frozen, AC-05.4, AC-05.5, AC-05.6)', () => {
  const PERM_FULL = [...PERM_PO_ALL, 'inventory.stock.manage'];
  const openPo = async (status: string, over: Record<string, unknown> = {}, perms = PERM_FULL) => {
    state.permissions = perms;
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id`, () => HttpResponse.json(po(2, { status, version: 5, approved_at: isoAt(-30), ...over }))));
    await mountPos({ po: PO2 });
    return dialogNamed(/purchase order PO-000002/i);
  };
  const isoAt = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const btn = (dlg: HTMLElement, re: RegExp) => within(dlg).queryByRole('button', { name: re });

  it.each([
    ['approved', ['mark as sent', 'receive', 'cancel'], ['approve', 'close', 'save draft']],
    ['sent', ['receive', 'cancel'], ['mark as sent', 'approve', 'close']],
    ['partially_received', ['receive', 'close'], ['cancel', 'mark as sent', 'approve']],
    ['received', ['close'], ['receive', 'cancel', 'mark as sent', 'approve']],
    ['closed', [], ['receive', 'cancel', 'close', 'mark as sent', 'approve']],
    ['cancelled', [], ['receive', 'cancel', 'close', 'mark as sent', 'approve']],
  ])('status %s shows exactly the actions of the S6 state table', async (status, present, absent) => {
    const dlg = await openPo(status);
    for (const a of present) expect(btn(dlg, new RegExp(`^${a}$`, 'i')), `${status}: ${a}`).toBeTruthy();
    for (const a of absent) expect(btn(dlg, new RegExp(`^${a}$`, 'i')), `${status}: no ${a}`).toBeNull();
  });

  it.each(['approved', 'sent'])('%s has a Print link to the S6-P print view', async (status) => {
    const dlg = await openPo(status);
    const link = within(dlg).getByRole('link', { name: /^print$/i });
    expect(link.getAttribute('href')).toBe(`/inventory/purchase-orders/${PO2}/print`);
  });

  it('shows the lines with Ordered / Received / Open / Closed-short and a Timeline of approve, sent, receipts and close', async () => {
    const dlg = await openPo('partially_received', {
      sent_at: isoAt(-20), sent_channel: 'email', sent_reference: 'SYN-REF-1', receipts: [{ id: ID(701), grn_no: 'GRN-000001', kind: 'purchase', store_id: ID(301), status: 'posted', received_at: isoAt(-5), posted_at: isoAt(-5), total_paisa: 141250, version: 2 }],
      lines: [poLine(1, { received_qty_base: '400', open_qty_base: '400' }), poLine(2, { received_qty_base: '800', open_qty_base: '0', is_closed_short: true })],
    });
    const heads = within(dlg).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Ordered', 'Received', 'Open', 'Closed short']) expect(heads.some((x) => new RegExp(`^${h.replace(' ', '[ -]')}$`, 'i').test(x ?? '')), h).toBe(true);
    expect(dlg.textContent).toMatch(/approved/i);
    expect(dlg.textContent).toMatch(/sent/i);
    expect(dlg.textContent).toMatch(/GRN-000001/);
    expect(within(dlg).getAllByText(/closed short/i).length).toBeGreaterThan(0);
  });

  it('AC-05.2 a frozen PO has no editable line fields and no Save draft', async () => {
    const dlg = await openPo('approved');
    expect(within(dlg).queryByRole('button', { name: /^save draft$/i })).toBeNull();
    expect(within(dlg).queryAllByRole('combobox', { name: /^item/i })).toHaveLength(0);
  });

  it('"Receive" goes to the receipt screen against this PO: /inventory/receipts?po=<id>', async () => {
    const dlg = await openPo('approved');
    await userEvent.click(btn(dlg, /^receive$/i)!);
    expect(router.push).toHaveBeenCalledWith(`/inventory/receipts?po=${PO2}`);
  });

  it('AC-05.4 Mark as sent: Channel RadioGroup (email / phone / in person / portal / other) is required; POST /mark-sent {sent_channel, sent_reference} with If-Match', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/mark-sent`, () => HttpResponse.json(po(2, { status: 'sent', version: 6 }))));
    const dlg = await openPo('approved');
    await userEvent.click(btn(dlg, /^mark as sent$/i)!);
    const d = await dialogNamed(/mark as sent/i);
    for (const r of ['Email', 'Phone', 'In person', 'Portal', 'Other']) expect(within(d).getByRole('radio', { name: new RegExp(`^${r}$`, 'i') }), r).toBeTruthy();
    await userEvent.type(within(d).getByRole('textbox', { name: /reference/i }), 'SYN-MAIL-77');
    await userEvent.click(within(d).getByRole('button', { name: /^mark as sent$/i }));
    expect(posts('mark-sent')).toHaveLength(0); // channel is required
    expect((await within(d).findAllByText(/channel is required|required/i)).length).toBeGreaterThan(0);
    await userEvent.click(within(d).getByRole('radio', { name: /^email$/i }));
    await userEvent.click(within(d).getByRole('button', { name: /^mark as sent$/i }));
    await waitFor(() => expect(posts('mark-sent')).toHaveLength(1));
    expect(posts('mark-sent')[0]!.json).toEqual({ sent_channel: 'email', sent_reference: 'SYN-MAIL-77' });
    expect(posts('mark-sent')[0]!.headers.get('if-match')).toBe('"5"');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('Mark as sent needs inventory.po.manage — hidden for an approve-only user', async () => {
    const dlg = await openPo('approved', {}, [...PERM_PO_APPROVE, 'inventory.stock.manage']);
    expect(btn(dlg, /^mark as sent$/i)).toBeNull();
  });

  it('AC-05.5 Cancel: ConfirmDialog with a REQUIRED reason from the po_cancel coded set (GET /coded-sets/reasons?reason_group=po_cancel); POST /cancel {reason_code} with Idempotency-Key + If-Match', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/cancel`, () => HttpResponse.json(po(2, { status: 'cancelled', version: 6 }))));
    const dlg = await openPo('approved');
    await userEvent.click(btn(dlg, /^cancel$/i)!);
    const d = await dialogNamed(/cancel purchase order/i);
    const q = hit('GET', /\/coded-sets\/reasons$/).map((h) => new URLSearchParams(h.search).get('reason_group'));
    expect(q).toContain('po_cancel');
    await userEvent.click(within(d).getByRole('button', { name: /^cancel po$/i }));
    expect(posts('cancel')).toHaveLength(0); // reason required
    await choose(d, /reason/i, /no longer needed/i);
    await userEvent.click(within(d).getByRole('button', { name: /^cancel po$/i }));
    await waitFor(() => expect(posts('cancel')).toHaveLength(1));
    const p = posts('cancel')[0]!;
    expect(p.json.reason_code).toBe('no_longer_needed');
    expect(p.headers.get('if-match')).toBe('"5"');
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
  });

  it('AC-05.5 cancel of a PO with a posted receipt: 409 inventory.po_invalid_transition is shown as a banner (title + request id)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/cancel`, () => problem('inventory.po_invalid_transition', 409, { title: 'This purchase order cannot change to that state' })));
    const dlg = await openPo('sent');
    await userEvent.click(btn(dlg, /^cancel$/i)!);
    const d = await dialogNamed(/cancel purchase order/i);
    await choose(d, /reason/i, /supplier unavailable/i);
    await userEvent.click(within(d).getByRole('button', { name: /^cancel po$/i }));
    const banner = await screen.findAllByRole('alert');
    expect(banner.map((b) => b.textContent).join(' ')).toMatch(/cannot change to that state.*req-syn-0022|req-syn-0022.*cannot change/s);
  });

  it('AC-05.6 Close of a partially received PO: reasons from po_close; POST /close {reason_code: "short_supply"} with Idempotency-Key + If-Match', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/purchase-orders/:id/close`, () => HttpResponse.json(po(2, { status: 'closed', version: 6 }))));
    const dlg = await openPo('partially_received');
    await userEvent.click(btn(dlg, /^close$/i)!);
    const d = await dialogNamed(/close purchase order/i);
    expect(hit('GET', /\/coded-sets\/reasons$/).map((h) => new URLSearchParams(h.search).get('reason_group'))).toContain('po_close');
    await choose(d, /reason/i, /short supply/i);
    await userEvent.click(within(d).getByRole('button', { name: /^close po$/i }));
    await waitFor(() => expect(posts('close')).toHaveLength(1));
    const p = posts('close')[0]!;
    expect(p.json.reason_code).toBe('short_supply');
    expect(p.headers.get('if-match')).toBe('"5"');
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
    expect(router.refresh).toHaveBeenCalled();
  });

  it('Cancel / Close need inventory.po.manage — hidden for an approve-only user', async () => {
    const dlg = await openPo('partially_received', {}, [...PERM_PO_APPROVE, 'inventory.stock.manage']);
    expect(btn(dlg, /^close$/i)).toBeNull();
  });
});

describe('S6-P print view (/inventory/purchase-orders/[po_id]/print)', () => {
  const mountPrint = async (id = PO2) => {
    state.path = `/inventory/purchase-orders/${id}/print`;
    const mod = await import('../../../app/(staff)/inventory/purchase-orders/[po_id]/print/page');
    return render(await mod.default({ params: Promise.resolve({ po_id: id }) } as never));
  };

  it('shows tenant display name, branch name, PO no., supplier block (PAN, address), lines and totals from GET /print-view', async () => {
    state.permissions = PERM_PO_ALL;
    await mountPrint();
    expect(await screen.findByText(/Synthetic Lab Pvt Ltd/)).toBeTruthy();
    for (const t of [/Synthetic Branch BR-1/, /PO-000002/, /Synthetic Supplier 1/, /SYN123456/, /Synthetic Street 1/, /GLU-R1/, /Synthetic glucose reagent/, /BOX \(400 test\)/, /2,825\.00/]) expect(document.body.textContent, String(t)).toMatch(t);
    expect(hit('GET', /\/print-view$/)).toHaveLength(1);
  });

  it('a draft carries the "DRAFT — NOT APPROVED" watermark; an approved PO does not; no QR code and no signature block', async () => {
    state.permissions = PERM_PO_ALL;
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id/print-view`, () => HttpResponse.json(printView({ is_draft: true, status: 'draft' }))));
    await mountPrint();
    expect(await screen.findByText('DRAFT — NOT APPROVED')).toBeTruthy();
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id/print-view`, () => HttpResponse.json(printView())));
    await mountPrint();
    await screen.findByText(/Synthetic Lab Pvt Ltd/);
    expect(screen.queryByText('DRAFT — NOT APPROVED')).toBeNull();
    expect(document.body.textContent).not.toMatch(/signature|authori[sz]ed by/i);
    expect(document.querySelector('canvas,svg[data-qr],img[alt*="QR" i]')).toBeNull();
  });

  it('without inventory.cost.read (the print view is cost-gated): permission-denied, no print-view call', async () => {
    state.permissions = PERM_READ;
    await mountPrint();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hit('GET', /\/print-view$/)).toHaveLength(0);
  });

  it('an unknown PO (404) goes to notFound()', async () => {
    state.permissions = PERM_PO_ALL;
    api.use(http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id/print-view`, () => problem('common.not_found', 404)));
    await expect(mountPrint()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a malformed id never reaches the API', async () => {
    state.permissions = PERM_PO_ALL;
    await expect(mountPrint('not-a-uuid')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(hits.length).toBe(0);
  });
});
