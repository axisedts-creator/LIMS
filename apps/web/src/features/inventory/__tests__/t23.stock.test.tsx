// @vitest-environment jsdom
// C12.T-23 — S8 Stock & issue (FEFO preview), S10 Wastage / Adjustment / Expiry write-off.
// ACs: AC-08.1, AC-08.2, AC-07.3, AC-07.4, AC-19.4 (UI side), AC-11.1, AC-11.2, AC-11.3. Security: REQ-SEC (stock.manage / stock.adjust gating, aal2 step-up, no token in browser).
// LD-140 (2026-11-13): kit components only, ONE primary button per page, every status shows tone + icon + word (expiry is TEXT, not colour only).
// Pinned seams: t23.harness.tsx header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_ADJUST, PERM_MANAGE, PERM_NONE, PERM_READ, api, balance, fefo, hit, hits, inDays, page, problem, resetHits, router, state, stockDoc } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/stock'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const ST1 = ID(301);
const mountStock = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/stock/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const mountWastage = async (sp: Record<string, string | undefined> = {}) => {
  state.path = '/inventory/wastage';
  const mod = await import('../../../app/(staff)/inventory/wastage/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr')!;
const issues = () => hit('POST', /^\/v1\/inventory\/issues$/);
const fefoGets = () => hit('GET', /^\/v1\/inventory\/fefo-suggestions$/);

describe('S8 list (04-UI-UX §3 S8)', () => {
  it('loads the balances of the first visible store when ?store is absent; columns per spec', async () => {
    await mountStock();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Item code', 'Item', 'Lot', 'Expiry', 'Lot status', 'Qty', 'Available', 'Open container', 'Reorder level']) expect(heads, h).toContain(h);
    const stockGet = hit('GET', /^\/v1\/inventory\/stock$/)[0]!;
    expect(new URLSearchParams(stockGet.search).get('store_id')).toBe(ST1);
  });

  it('expiry and lot status are TEXT: "Expired" for a past date, "Expires in n days" when near, "Quarantined" word for the status', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/stock`, () => page([
      balance(1, { expiry_on: inDays(-3) }),
      balance(2, { expiry_on: inDays(9) }),
      balance(3, { lot_status: 'quarantined', expiry_on: inDays(300) }),
    ])));
    await mountStock();
    expect(within(await rowOf('SYNLOT-001')).getByText(/expired/i)).toBeTruthy();
    expect(within(await rowOf('SYNLOT-002')).getByText(/expires in \d+ days?/i)).toBeTruthy();
    expect(within(await rowOf('SYNLOT-003')).getByText(/quarantined/i)).toBeTruthy();
  });

  it('open-container lots carry a Badge with a word', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/stock`, () => page([balance(1, { has_open_container: true }), balance(2)])));
    await mountStock();
    expect(within(await rowOf('SYNLOT-001')).getByText(/open/i)).toBeTruthy();
    expect(within(await rowOf('SYNLOT-002')).queryByText(/^open$/i)).toBeNull();
  });

  it('"In transit" Card lists dispatched transfers for this store', async () => {
    await mountStock();
    const card = (await screen.findByText(/in transit/i)).closest('section,div,article')!;
    expect(card.textContent).toMatch(/TRF-000001/);
    const q = new URLSearchParams(hit('GET', /^\/v1\/inventory\/transfers$/)[0]!.search);
    expect(q.get('status')).toBe('dispatched');
  });

  it('row actions Issue / Transfer / Wastage / Movements need stock.manage; read-only users get none (S8 state table)', async () => {
    await mountStock();
    const row = await rowOf('SYNLOT-001');
    for (const a of ['Issue', 'Transfer', 'Wastage', 'Movements']) expect(within(row).getByRole('button', { name: new RegExp(`^${a}$`, 'i') }), a).toBeTruthy();
    cleanup(); state.permissions = PERM_READ;
    await mountStock();
    const ro = await rowOf('SYNLOT-001');
    expect(within(ro).queryByRole('button', { name: /^issue$/i })).toBeNull();
  });

  it('no inventory.item.read: permission-denied and no API call', async () => {
    state.permissions = PERM_NONE;
    await mountStock();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });

  it('filters are query params (Store, Category, Item text, Below reorder, Expiring within days, Show zero) and are forwarded to the API', async () => {
    await mountStock({ store: ID(302), category: 'reagent', q: 'tips', below_reorder: 'true', expiring_within_days: '30', show_zero: 'true' });
    await screen.findByRole('grid');
    const q = new URLSearchParams(hit('GET', /^\/v1\/inventory\/stock$/)[0]!.search);
    expect(q.get('store_id')).toBe(ID(302));
    expect(q.get('category')).toBe('reagent');
    expect(q.get('q')).toBe('tips');
    expect(q.get('below_reorder')).toBe('true');
    expect(q.get('expiring_within_days')).toBe('30');
  });

  it('exactly ONE primary button on the page', async () => {
    await mountStock();
    await screen.findByRole('grid');
    expect(document.querySelectorAll('[data-variant="primary"],[data-tone="primary"],button.primary').length).toBeLessThanOrEqual(1);
  });
});

describe('S8 Issue drawer — FEFO preview (AC-08.1, AC-08.2)', () => {
  const openIssue = async () => {
    await mountStock();
    const row = await rowOf('SYNLOT-001');
    await userEvent.click(within(row).getByRole('button', { name: /^issue$/i }));
    return screen.findByRole('dialog', { name: /issue stock/i });
  };
  const fillDept = async (dlg: HTMLElement) => {
    await userEvent.click(within(dlg).getByRole('radio', { name: /department/i }));
    await choose(dlg, /^department/i, /biochemistry/i);
  };
  const qty = (dlg: HTMLElement) => within(dlg).getAllByRole('textbox', { name: /^qty|quantity/i })[0]!;

  it('RadioGroup Issued to: Department / Analyser / General; Department required when department, Analyser when analyser', async () => {
    const dlg = await openIssue();
    for (const r of ['Department', 'Analyser', 'General']) expect(within(dlg).getByRole('radio', { name: new RegExp(r, 'i') }), r).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('radio', { name: /analyser/i }));
    await userEvent.type(qty(dlg), '10');
    await userEvent.click(within(dlg).getByRole('button', { name: /^issue$/i }));
    expect(issues()).toHaveLength(0);
    expect(await within(dlg).findByText(/analyser is required/i)).toBeTruthy();
  });

  it('typing a quantity requests the FEFO suggestion (#36) for that store+item and shows lot, expiry, open container, take, available', async () => {
    const dlg = await openIssue();
    await userEvent.type(qty(dlg), '10');
    await waitFor(() => expect(fefoGets().length).toBeGreaterThan(0));
    const q = new URLSearchParams(fefoGets().at(-1)!.search);
    expect(q.get('store_id')).toBe(ST1);
    expect(q.get('item_id')).toBe(ID(11));
    expect(q.get('qty_base')).toBe('10');
    expect(await within(dlg).findByText('SYNLOT-001')).toBeTruthy();
    expect(within(dlg).getByText('SYNLOT-002')).toBeTruthy();
    expect(within(dlg).getByText('Lots are taken in the order shown: opened containers first, then earliest expiry.')).toBeTruthy();
    const first = within(dlg).getByText('SYNLOT-001').closest('tr,li')!;
    expect(first.textContent).toMatch(/open/i); // open container first
    expect(first.textContent).toMatch(/6/); // take
  });

  it('shows the shortfall when the server reports one', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/fefo-suggestions`, () => HttpResponse.json({ store_id: ST1, item_id: ID(11), qty_base: '500', lines: [fefo(1, '120', '120')], shortfall_qty_base: '380' })));
    const dlg = await openIssue();
    await userEvent.type(qty(dlg), '500');
    expect(await within(dlg).findByText(/shortfall/i)).toBeTruthy();
    expect(dlg.textContent).toMatch(/380/);
  });

  it('AC-08.1: Auto (FEFO) is the default lot; POST /issues has NO lot_id, department_id, Idempotency-Key, and the per-lot movements returned are shown', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/issues`, () => HttpResponse.json(stockDoc(), { status: 201 })));
    const dlg = await openIssue();
    expect(within(dlg).getByRole('button', { name: /auto \(fefo\)/i })).toBeTruthy();
    await fillDept(dlg);
    await userEvent.type(qty(dlg), '10');
    await userEvent.click(within(dlg).getByRole('button', { name: /^issue$/i }));
    await waitFor(() => expect(issues()).toHaveLength(1));
    const b = issues()[0]!.json;
    expect(b.store_id).toBe(ST1);
    expect(b.issued_to_kind).toBe('department');
    expect(b.department_id).toBe(ID(60));
    expect(b.lines).toEqual([expect.objectContaining({ item_id: ID(11), qty: '10' })]);
    expect(b.lines[0]).not.toHaveProperty('lot_id');
    expect(issues()[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(await screen.findByText('SYNLOT-002')).toBeTruthy(); // one issue movement per lot used
    expect(document.body.textContent).toMatch(/ISS-000001/);
  });

  it('naming a lot sends lot_id; General needs no department; Analyser sends instrument_id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/issues`, () => HttpResponse.json(stockDoc(), { status: 201 })));
    const dlg = await openIssue();
    await userEvent.click(within(dlg).getByRole('radio', { name: /analyser/i }));
    await choose(dlg, /^analyser/i, /BIO-1|analyser 1/i);
    await choose(dlg, /^lot/i, /SYNLOT-002/);
    await userEvent.type(qty(dlg), '4');
    await userEvent.click(within(dlg).getByRole('button', { name: /^issue$/i }));
    await waitFor(() => expect(issues()).toHaveLength(1));
    expect(issues()[0]!.json).toMatchObject({ issued_to_kind: 'instrument', instrument_id: ID(950), lines: [{ item_id: ID(11), lot_id: ID(22), qty: '4' }] });
  });

  it('quantity must be > 0 with at most 3 decimals: invalid input never reaches the API', async () => {
    const dlg = await openIssue();
    await userEvent.click(within(dlg).getByRole('radio', { name: /general/i }));
    for (const bad of ['0', '-1', '1.2345', 'abc']) {
      await userEvent.clear(qty(dlg));
      await userEvent.type(qty(dlg), bad);
      await userEvent.click(within(dlg).getByRole('button', { name: /^issue$/i }));
    }
    expect(issues()).toHaveLength(0);
  });

  it.each([
    ['inventory.insufficient_stock', 'AC-08.2'],
    ['inventory.lot_unavailable', 'AC-07.3'],
    ['inventory.lot_expired', 'AC-07.4'],
    ['inventory.store_locked_for_count', 'AC-19.4'],
  ])('409 %s (%s) -> Banner danger with request_id, the drawer stays open and values are kept', async (code) => {
    api.use(http.post(`${ORIGIN}/v1/inventory/issues`, () => problem(code, 409)));
    const dlg = await openIssue();
    await userEvent.click(within(dlg).getByRole('radio', { name: /general/i }));
    await userEvent.type(qty(dlg), '10');
    await userEvent.click(within(dlg).getByRole('button', { name: /^issue$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('req-syn-0023');
    expect(screen.getByRole('dialog', { name: /issue stock/i })).toBeTruthy();
    expect((qty(dlg) as HTMLInputElement).value).toBe('10');
    expect(router.refresh).not.toHaveBeenCalled(); // nothing was written
  });

  it('resubmitting after a failure reuses the same Idempotency-Key (04-UI-UX §1)', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/inventory/issues`, () => (++n === 1 ? problem('common.internal', 500) : HttpResponse.json(stockDoc(), { status: 201 }))));
    const dlg = await openIssue();
    await userEvent.click(within(dlg).getByRole('radio', { name: /general/i }));
    await userEvent.type(qty(dlg), '10');
    await userEvent.click(within(dlg).getByRole('button', { name: /^issue$/i }));
    await screen.findByRole('alert');
    await userEvent.click(within(dlg).getByRole('button', { name: /^issue$/i }));
    await waitFor(() => expect(issues()).toHaveLength(2));
    expect(issues()[1]!.headers.get('idempotency-key')).toBe(issues()[0]!.headers.get('idempotency-key'));
  });
});

describe('S10 Wastage (AC-11.1)', () => {
  const qtyOf = () => screen.getAllByRole('textbox', { name: /^qty|quantity/i })[0]!;
  const addLine = async () => { await userEvent.click(screen.getByRole('button', { name: /add line/i })); };

  it('tabs: Wastage and Expiry write-off with stock.manage; Adjustment only with stock.adjust', async () => {
    await mountWastage();
    const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent?.trim());
    expect(tabs).toEqual(expect.arrayContaining(['Wastage', 'Expiry write-off']));
    expect(tabs).not.toContain('Adjustment');
    cleanup(); state.permissions = PERM_ADJUST;
    await mountWastage();
    expect((await screen.findAllByRole('tab')).map((t) => t.textContent?.trim())).toContain('Adjustment');
  });

  it('a reason is required: submitting without one sends nothing and marks the field', async () => {
    await mountWastage({ store: ST1 });
    await addLine();
    await userEvent.type(qtyOf(), '2');
    await userEvent.click(screen.getByRole('button', { name: /^(record wastage|save)$/i }));
    expect(hit('POST', /\/v1\/inventory\/wastage$/)).toHaveLength(0);
    expect(await screen.findByText(/reason is required/i)).toBeTruthy();
  });

  it('with reason spillage: POST /wastage {store_id, reason_code:"spillage", lines[]} with an Idempotency-Key; note is capped at 500', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/wastage`, () => HttpResponse.json(stockDoc({ doc_kind: 'wastage', doc_no: 'WST-000001' }), { status: 201 })));
    await mountWastage({ store: ST1 });
    expect(screen.getByRole('textbox', { name: /note/i }).getAttribute('maxlength')).toBe('500');
    await choose(document.body, /reason/i, /spillage/i);
    await addLine();
    await userEvent.type(qtyOf(), '2');
    await userEvent.click(screen.getByRole('button', { name: /^(record wastage|save)$/i }));
    await waitFor(() => expect(hit('POST', /\/v1\/inventory\/wastage$/)).toHaveLength(1));
    const p = hit('POST', /\/v1\/inventory\/wastage$/)[0]!;
    expect(p.json).toMatchObject({ store_id: ST1, reason_code: 'spillage' });
    expect(p.json.lines[0]).toMatchObject({ qty: '2' });
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(await screen.findByText(/WST-000001/)).toBeTruthy(); // toast + document link
  });

  it('server 422 inventory.reason_required -> Banner with request_id (server is the authority)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/wastage`, () => problem('inventory.reason_required', 422)));
    await mountWastage({ store: ST1 });
    await choose(document.body, /reason/i, /breakage/i);
    await addLine();
    await userEvent.type(qtyOf(), '2');
    await userEvent.click(screen.getByRole('button', { name: /^(record wastage|save)$/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
  });
});

describe('S10 Adjustment (AC-11.3) — stock.adjust + aal2', () => {
  const openAdjust = async () => {
    state.permissions = PERM_ADJUST;
    await mountWastage({ store: ST1 });
    await userEvent.click(await screen.findByRole('tab', { name: /^adjustment$/i }));
  };
  const adjustPosts = () => hit('POST', /\/v1\/inventory\/adjustments$/);

  it('direction per line is a RadioGroup in/out; POST /adjustments with reason_code and direction', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/adjustments`, () => HttpResponse.json(stockDoc({ doc_kind: 'adjustment' }), { status: 201 })));
    await openAdjust();
    await choose(document.body, /reason/i, /correction/i);
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await userEvent.click(screen.getByRole('radio', { name: /^out$/i }));
    await userEvent.type(screen.getAllByRole('textbox', { name: /^qty|quantity/i })[0]!, '3');
    await userEvent.click(screen.getByRole('button', { name: /^(post adjustment|save)$/i }));
    await waitFor(() => expect(adjustPosts()).toHaveLength(1));
    expect(adjustPosts()[0]!.json).toMatchObject({ store_id: ST1, reason_code: 'correction' });
    expect(adjustPosts()[0]!.json.lines[0]).toMatchObject({ direction: 'out', qty: '3' });
    expect(adjustPosts()[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
  });

  it('AC-11.3: 403 auth.mfa_required -> step-up banner (mentions verification), form kept open with its values, no refresh', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/adjustments`, () => problem('auth.mfa_required', 403)));
    await openAdjust();
    await choose(document.body, /reason/i, /found stock/i);
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await userEvent.type(screen.getAllByRole('textbox', { name: /^qty|quantity/i })[0]!, '3');
    await userEvent.click(screen.getByRole('button', { name: /^(post adjustment|save)$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/verif/i);
    expect((screen.getAllByRole('textbox', { name: /^qty|quantity/i })[0] as HTMLInputElement).value).toBe('3');
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('S10 Expiry write-off (AC-11.2)', () => {
  const expired = [balance(1, { expiry_on: inDays(-10), qty_base: '12', available_qty_base: '12' }), balance(2, { expiry_on: inDays(-2), qty_base: '7', available_qty_base: '7' })];
  const openWriteoff = async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/stock`, () => page(expired)));
    await mountWastage({ store: ST1 });
    await userEvent.click(await screen.findByRole('tab', { name: /expiry write-off/i }));
  };

  it('lists expired lots with stock (GET /stock?expired_only=true) with checkboxes', async () => {
    await openWriteoff();
    expect(await screen.findByText('SYNLOT-001')).toBeTruthy();
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThanOrEqual(2);
    const q = new URLSearchParams(hit('GET', /^\/v1\/inventory\/stock$/).at(-1)!.search);
    expect(q.get('expired_only')).toBe('true');
    expect(q.get('store_id')).toBe(ST1);
  });

  it('"Write off selected" is disabled until a lot is ticked; ConfirmDialog copy names the count; POST /expiry-writeoffs {store_id, lot_ids}', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/expiry-writeoffs`, () => HttpResponse.json(stockDoc({ doc_kind: 'expiry_writeoff' }), { status: 201 })));
    await openWriteoff();
    await screen.findByText('SYNLOT-001');
    const btn = screen.getByRole('button', { name: /write off selected/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    for (const cb of within(await rowOf('SYNLOT-001')).getAllByRole('checkbox')) await userEvent.click(cb);
    for (const cb of within(await rowOf('SYNLOT-002')).getAllByRole('checkbox')) await userEvent.click(cb);
    await userEvent.click(btn);
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(dlg.textContent).toContain('Write off all remaining stock of 2 expired lots?');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(write off|confirm)/i }));
    await waitFor(() => expect(hit('POST', /expiry-writeoffs$/)).toHaveLength(1));
    const p = hit('POST', /expiry-writeoffs$/)[0]!;
    expect(p.json).toEqual({ store_id: ST1, lot_ids: expect.arrayContaining([ID(21), ID(22)]) });
    expect(p.json.lot_ids).toHaveLength(2);
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
  });

  it('per-line 400 common.validation_failed (a lot is not expired) is shown on that lot; nothing is refreshed as written', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/expiry-writeoffs`, () => problem('common.validation_failed', 400, { errors: [{ path: '/lot_ids/1', code: 'inventory.lot_not_expired', message: 'This lot has not expired.' }] })));
    await openWriteoff();
    await screen.findByText('SYNLOT-001');
    for (const cb of screen.getAllByRole('checkbox').filter((c) => !c.closest('thead'))) await userEvent.click(cb);
    await userEvent.click(screen.getByRole('button', { name: /write off selected/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(write off|confirm)/i }));
    expect(await screen.findByText(/has not expired/i)).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
