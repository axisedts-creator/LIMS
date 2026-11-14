// @vitest-environment jsdom
// C12.T-21 — S5 Suppliers + supplier Items tab (04-UI-UX §3 S5; AC-04.1, AC-04.2; REQ-SEC-081 money/contact fields, REQ-SEC-098 contact never logged).
// LD-140 (2026-11-13): kit components only, masters = list + right Drawer + per-section Save, ONE primary button per page, every status shows tone + icon + word.
// Pinned seams: t21.harness.tsx header (?supplier=<id> opens the drawer with tabs "Details" | "Items").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, api, hit, hits, item, itemSummary, pack, page, problem, resetHits, router, state, supplier, supplierItem } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

const PERM_COST = [...PERM_MANAGE, 'inventory.cost.read'];
const SUP = ID(601);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/suppliers'; });
afterEach(() => { cleanup(); api.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/suppliers/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const tf = (name: RegExp) => screen.getByRole('textbox', { name });
const posts = () => hit('POST', /^\/v1\/inventory\/suppliers$/);
const openCreate = async () => { await mount(); await userEvent.click(await screen.findByRole('button', { name: /^new supplier$/i })); return screen.findByRole('dialog'); };

describe('S5 list', () => {
  it('columns Code, Name, PAN, Phone, Active; inactive rows show tone + icon + word', async () => {
    await mount();
    const table = await screen.findByRole('grid');
const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Code', 'Name', 'PAN', 'Phone', 'Active']) expect(heads, h).toContain(h);
    const row = within(table).getByText('SUP-02').closest('tr')!;
    expect(within(row).getByText(/inactive/i)).toBeTruthy();
    expect(row.querySelector('svg, [data-icon]')).toBeTruthy();
  });

  it('exactly ONE primary "New supplier" with manage; none for read-only', async () => {
    await mount();
    expect((await screen.findAllByRole('button', { name: /^new supplier$/i })).length).toBe(1);
    cleanup(); state.permissions = PERM_READ;
    await mount();
    await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /new supplier/i })).toBeNull();
  });

  it('no inventory.item.read: permission-denied, no API call', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });

  it('unknown ?supplier id (API 404) -> notFound()', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/suppliers/:id`, () => problem('common.not_found', 404)));
    await expect(mount({ supplier: ID(699) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('AC-04.1 create supplier', () => {
  it('Drawer fields carry the §3 limits and input modes', async () => {
    const dlg = await openCreate();
    expect(within(dlg).getByRole('textbox', { name: /^code/i }).getAttribute('maxlength')).toBe('16');
    expect(within(dlg).getByRole('textbox', { name: /^name/i }).getAttribute('maxlength')).toBe('200');
    const pan = within(dlg).getByRole('textbox', { name: /PAN \/ VAT no\. \(as on supplier invoice\)/i });
    expect(pan.getAttribute('maxlength')).toBe('20');
    expect(within(dlg).getByRole('textbox', { name: /contact name/i }).getAttribute('maxlength')).toBe('120');
    const phone = within(dlg).getByRole('textbox', { name: /phone/i });
    expect(phone.getAttribute('maxlength')).toBe('40');
    expect(phone.getAttribute('inputmode')).toBe('tel');
    const email = within(dlg).getByRole('textbox', { name: /email/i });
    expect(email.getAttribute('maxlength')).toBe('254');
    expect(email.getAttribute('inputmode')).toBe('email');
    expect(within(dlg).getByRole('textbox', { name: /address/i }).getAttribute('maxlength')).toBe('500');
    expect(within(dlg).getByRole('textbox', { name: /notes/i }).getAttribute('maxlength')).toBe('1000');
    expect(within(dlg).getByRole('textbox', { name: /payment terms/i })).toBeTruthy();
  });

  it('POSTs {supplier_code, name, pan_text} with an Idempotency-Key and refreshes the list', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/suppliers`, () => HttpResponse.json(supplier(1, { supplier_code: 'SUP-01' }), { status: 201 })));
    await openCreate();
    await userEvent.type(tf(/^code/i), 'sup-01');
    await userEvent.tab();
    await userEvent.type(tf(/^name/i), 'Synthetic supplier one');
    await userEvent.type(tf(/PAN \/ VAT/i), 'SYNPAN0001');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.json).toEqual({ supplier_code: 'SUP-01', name: 'Synthetic supplier one', pan_text: 'SYNPAN0001' });
    expect(posts()[0]!.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('optional fields left empty are omitted from the body (no empty strings, no nulls: CV §4.2)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/suppliers`, () => HttpResponse.json(supplier(1), { status: 201 })));
    await openCreate();
    await userEvent.type(tf(/^code/i), 'SUP-03');
    await userEvent.type(tf(/^name/i), 'Only required');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.json).toEqual({ supplier_code: 'SUP-03', name: 'Only required' });
  });

  it.each([
    ['PAN with a dash/space (^[A-Za-z0-9]{1,20}$)', async () => { await userEvent.type(tf(/PAN \/ VAT/i), 'AB-12 34'); }],
    ['payment terms 366 (0–365)', async () => { await userEvent.type(tf(/payment terms/i), '366'); }],
    ['code with a space', async () => { await userEvent.clear(tf(/^code/i)); await userEvent.type(tf(/^code/i), 'BAD CODE'); }],
  ])('invalid: %s -> no POST', async (_n, act) => {
    await openCreate();
    await userEvent.type(tf(/^code/i), 'SUP-04');
    await userEvent.type(tf(/^name/i), 'Synthetic');
    await act();
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toHaveLength(0);
  });

  it('409 inventory.code_duplicate -> danger Banner with registry title; typed values kept', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/suppliers`, () => problem('inventory.code_duplicate', 409, { title: 'Code already used' })));
    await openCreate();
    await userEvent.type(tf(/^code/i), 'SUP-01');
    await userEvent.type(tf(/^name/i), 'Dup');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Code already used/);
    expect((tf(/^name/i) as HTMLInputElement).value).toBe('Dup');
  });

  it('contact fields are personal data: never logged, never in a URL, never in the toast (07 §5, REQ-SEC-098)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    api.use(http.post(`${ORIGIN}/v1/inventory/suppliers`, () => HttpResponse.json(supplier(1), { status: 201 })));
    await openCreate();
    await userEvent.type(tf(/^code/i), 'SUP-05');
    await userEvent.type(tf(/^name/i), 'Synthetic');
    await userEvent.type(tf(/contact name/i), 'Synthetic Contactperson');
    await userEvent.type(tf(/phone/i), '01-5551234');
    await userEvent.type(tf(/email/i), 'secret-contact@example.test');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.json).toMatchObject({ contact_name: 'Synthetic Contactperson', phone_display: '01-5551234', email: 'secret-contact@example.test' });
    for (const h of hits) expect(h.path + h.search).not.toMatch(/secret-contact|5551234|Contactperson/);
    for (const s of spies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toMatch(/secret-contact|5551234|Contactperson/);
    for (const f of Object.values(router)) for (const c of f.mock.calls) expect(JSON.stringify(c)).not.toMatch(/secret-contact|5551234|Contactperson/);
  });
});

describe('S5 edit', () => {
  it('?supplier=<id> opens the Drawer; Save sends PATCH with If-Match and only the changed field; clearing goes in `unset`', async () => {
    api.use(http.patch(`${ORIGIN}/v1/inventory/suppliers/:id`, () => HttpResponse.json(supplier(1, { version: 2 }))));
    await mount({ supplier: SUP });
    const dlg = await screen.findByRole('dialog');
    const name = within(dlg).getByRole('textbox', { name: /^name/i });
    await userEvent.clear(name); await userEvent.type(name, 'Renamed supplier');
    await userEvent.clear(within(dlg).getByRole('textbox', { name: /email/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(hit('PATCH', /suppliers\/[^/]+$/)).toHaveLength(1));
    const p = hit('PATCH', /suppliers\/[^/]+$/)[0]!;
    expect(p.headers.get('if-match')).toBe('"1"');
    expect(p.json).toEqual({ name: 'Renamed supplier', unset: ['email'] });
  });

  it('409 common.version_conflict -> danger Banner with the title', async () => {
    api.use(http.patch(`${ORIGIN}/v1/inventory/suppliers/:id`, () => problem('common.version_conflict', 409, { title: 'Version conflict' })));
    await mount({ supplier: SUP });
    const dlg = await screen.findByRole('dialog');
    await userEvent.type(within(dlg).getByRole('textbox', { name: /notes/i }), ' x');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Version conflict/);
  });
});

describe('AC-04.2 supplier items (item + pack + supplier code + last price + lead time + default tax)', () => {
  const itemsTab = async () => {
    api.use(
      http.get(`${ORIGIN}/v1/inventory/items`, () => page([itemSummary(1)])),
      http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item({ packs: [pack(1)] }))),
    );
    await mount({ supplier: SUP });
    await userEvent.click(await screen.findByRole('tab', { name: /^items$/i }));
  };
  const puts = () => hit('PUT', /\/suppliers\/[^/]+\/items\/[^/]+\/packs\/[^/]+$/);

  it('lists the supplier items; the last price renders as money (lakh grouping) only with inventory.cost.read', async () => {
    state.permissions = PERM_COST;
    await itemsTab();
    const table = await screen.findByRole('grid');
const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Item', 'Pack', 'Supplier code', 'Last price', 'Lead time']) expect(heads, h).toContain(h);
    expect(within(table).getByText(/4,500/)).toBeTruthy(); // 450000 paisa
    expect(within(table).getByText(/7/)).toBeTruthy();
  });

  it('without inventory.cost.read: no price column, price text absent from the DOM, no price field (REQ-SEC-081)', async () => {
    state.permissions = PERM_MANAGE;
    await itemsTab();
    const table = await screen.findByRole('grid');
expect(within(table).queryByRole('columnheader', { name: /price/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/4,500|450000/);
    await userEvent.click(screen.getByRole('button', { name: /add item|set item|link item/i }));
    expect(screen.queryByRole('textbox', { name: /last price/i })).toBeNull();
  });

  it('manage without inventory.cost.read: existing rows get no Edit (PUT #22 is a full replace and would wipe the hidden last price); Add stays', async () => {
    state.permissions = PERM_MANAGE;
    await itemsTab();
    const row = (await screen.findByText('SYN-CODE-1')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.getByRole('button', { name: /add item|set item|link item/i })).toBeTruthy();
  });

  it('set (SUP, GLU-R1, BOX) with last price Rs 4,500 (=450000 paisa) and lead time 7 -> PUT .../items/{item}/packs/{pack} with integer paisa; new row has no If-Match', async () => {
    state.permissions = PERM_COST;
    api.use(http.put(`${ORIGIN}/v1/inventory/suppliers/:sid/items/:iid/packs/:pid`, () => HttpResponse.json(supplierItem({ version: 1 }))));
    api.use(http.get(`${ORIGIN}/v1/inventory/suppliers/:id/items`, () => page([])));
    await itemsTab();
    await userEvent.click(await screen.findByRole('button', { name: /add item|set item|link item/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.type(within(dlg).getByRole('combobox', { name: /item/i }), 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: /pack/i }));
    await userEvent.click(await screen.findByRole('option', { name: /BOX/ }));
    await userEvent.type(within(dlg).getByRole('textbox', { name: /last price/i }), '4500');
    await userEvent.type(within(dlg).getByRole('textbox', { name: /lead time/i }), '7');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const p = puts()[0]!;
    expect(p.path).toBe(`/v1/inventory/suppliers/${SUP}/items/${ID(11)}/packs/${ID(101)}`);
    expect(p.json.last_unit_price_paisa).toBe(450000); // JSON integer, not "4500" / 4500.00 / a float
    expect(Number.isInteger(p.json.last_unit_price_paisa)).toBe(true);
    expect(p.json.lead_time_days).toBe(7);
    expect(p.json.is_active).toBe(true);
    expect(p.headers.get('if-match')).toBeNull();
  });

  it('editing an existing supplier item sends If-Match "<version>"', async () => {
    state.permissions = PERM_COST;
    api.use(http.put(`${ORIGIN}/v1/inventory/suppliers/:sid/items/:iid/packs/:pid`, () => HttpResponse.json(supplierItem({ lead_time_days: 9, version: 2 }))));
    await itemsTab();
    const row = (await screen.findByText('SYN-CODE-1')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }));
    const dlg = await screen.findByRole('dialog');
    const lead = within(dlg).getByRole('textbox', { name: /lead time/i });
    await userEvent.clear(lead); await userEvent.type(lead, '9');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.headers.get('if-match')).toBe('"1"');
    expect(puts()[0]!.json.lead_time_days).toBe(9);
  });

  it.each([['lead time 366 (0–365)', '366'], ['lead time with letters', 'abc']])('invalid %s -> no PUT', async (_n, v) => {
    state.permissions = PERM_COST;
    api.use(http.get(`${ORIGIN}/v1/inventory/suppliers/:id/items`, () => page([])));
    await itemsTab();
    await userEvent.click(await screen.findByRole('button', { name: /add item|set item|link item/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.type(within(dlg).getByRole('combobox', { name: /item/i }), 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: /pack/i }));
    await userEvent.click(await screen.findByRole('option', { name: /BOX/ }));
    await userEvent.type(within(dlg).getByRole('textbox', { name: /lead time/i }), v);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 50));
    for (const p of puts()) expect(p.json.lead_time_days).not.toBe(366);
    if (v === '366') expect(puts()).toHaveLength(0);
  });

  it('supplier code is capped at 64; 422 inventory.uom_mismatch shows the registry title', async () => {
    state.permissions = PERM_COST;
    api.use(
      http.get(`${ORIGIN}/v1/inventory/suppliers/:id/items`, () => page([])),
      http.put(`${ORIGIN}/v1/inventory/suppliers/:sid/items/:iid/packs/:pid`, () => problem('inventory.uom_mismatch', 422, { title: 'Unit does not match' })),
    );
    await itemsTab();
    await userEvent.click(await screen.findByRole('button', { name: /add item|set item|link item/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('textbox', { name: /supplier code/i }).getAttribute('maxlength')).toBe('64');
    await userEvent.type(within(dlg).getByRole('combobox', { name: /item/i }), 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: /pack/i }));
    await userEvent.click(await screen.findByRole('option', { name: /BOX/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Unit does not match/);
  });
});
