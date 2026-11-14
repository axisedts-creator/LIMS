// @vitest-environment jsdom
// C12.T-21 — S2 Items list / S3 Item detail (04-UI-UX §2 scanner, §3 S2/S3; AC-01.1, 01.2, 01.3, 01.4 (switch rule), 01.5; REQ-SEC-080/088/098).
// LD-140 (2026-11-13): kit components only, masters = list + right Drawer + per-section Save, ONE primary button per page, every status shows tone + icon + word.
// Pinned seams: t21.harness.tsx header. Field labels are the 04-UI-UX §3 names. Writes: Idempotency-Key on create/pack/barcode, If-Match "<version>" on PATCH/set-active/deactivate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IDEM_RE, ID, ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, api, barcode, hit, hits, item, itemSummary, pack, page, problem, resetHits, router, state } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/items'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const ITEM = ID(11);
const mountList = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/items/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const mountItem = async (sp: Record<string, string | undefined> = {}) => {
  state.path = `/inventory/items/${ITEM}`;
  const mod = await import('../../../app/(staff)/inventory/items/[item_id]/page');
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve({ item_id: ITEM }), searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const tf = (name: RegExp) => screen.getByRole('textbox', { name });
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const openCreate = async () => { await mountList(); await userEvent.click(await screen.findByRole('button', { name: /^new item$/i })); return screen.findByRole('dialog'); };
const itemPosts = () => hit('POST', /^\/v1\/inventory\/items$/);
const fillMin = async (code = 'glu-r9', name = 'Synthetic glucose reagent 9') => {
  await userEvent.type(tf(/^code/i), code);
  await userEvent.tab(); // blur upper-cases
  await userEvent.type(tf(/^name/i), name);
};

describe('S2 list (04-UI-UX §3 S2)', () => {
  it('columns Code, Name, Category, Base unit, Lot-tracked, Active, Updated; rows from GET /items', async () => {
    await mountList();
    const table = await screen.findByRole('grid');
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Code', 'Name', 'Category', 'Base unit', 'Lot-tracked', 'Active', 'Updated']) expect(heads, h).toContain(h);
    expect(within(table).getByText('GLU-R1')).toBeTruthy();
    expect(within(table).getByText('GLU-R2')).toBeTruthy();
  });

  it('inactive rows show tone + icon + word (StatusChip), not colour alone', async () => {
    await mountList();
    const row = (await screen.findByText('GLU-R2')).closest('tr')!;
    expect(within(row).getByText(/inactive/i)).toBeTruthy();
    expect(row.querySelector('svg, [data-icon]')).toBeTruthy();
  });

  it('forwards filters from the URL: category, is_active, q (code/name prefix)', async () => {
    await mountList({ category: 'kit', is_active: 'true', q: 'GLU' });
    await screen.findByRole('grid');
    const [g] = hit('GET', /^\/v1\/inventory\/items$/);
    const sp = new URLSearchParams(g!.search);
    expect(sp.get('category')).toBe('kit');
    expect(sp.get('is_active')).toBe('true');
    expect(sp.get('q')).toBe('GLU');
  });

  it('text filter caps at 60 characters (04-UI-UX §3 S2)', async () => {
    await mountList();
    const q = await screen.findByRole('searchbox').catch(() => screen.getByRole('textbox', { name: /search|filter|code|name/i }));
    expect(q.getAttribute('maxlength')).toBe('60');
  });

  it('empty list shows the empty state, no table rows', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/items`, () => page([])));
    await mountList();
    expect(await screen.findByText(/no items/i)).toBeTruthy();
  });

  it('exactly ONE primary button "New item" with manage; none without (LD-140 one primary per page)', async () => {
    await mountList();
    expect((await screen.findAllByRole('button', { name: /^new item$/i })).length).toBe(1);
    cleanup(); state.permissions = PERM_READ;
    await mountList();
    await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /new item/i })).toBeNull();
  });

  it('no inventory.item.read: permission-denied state, no API call', async () => {
    state.permissions = PERM_NONE;
    await mountList();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });

  it('API 403 on the list: permission-denied state, no rows', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/items`, () => problem('auth.forbidden', 403)));
    await mountList();
    expect(await screen.findByTestId('permission-denied')).toBeTruthy();
    expect(screen.queryByRole('grid')).toBeNull();
  });
});

describe('AC-01.1 create item in a right Drawer', () => {
  it('opens a Drawer with the §3 fields and defaults: category reagent, base unit test, Track lots on, Expiry required on', async () => {
    const dlg = await openCreate();
    for (const l of [/^code/i, /^name/i, /manufacturer/i, /catalogue no/i, /hs code/i, /notes/i]) expect(within(dlg).getByRole('textbox', { name: l }), String(l)).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: /category/i }).textContent).toMatch(/reagent/i);
    expect(within(dlg).getByRole('button', { name: /base unit/i }).textContent).toMatch(/test/i);
    expect((within(dlg).getByRole('switch', { name: /track lots/i }) as HTMLInputElement).checked).toBe(true); // kit Switch = react-aria input[role=switch]
    expect((within(dlg).getByRole('switch', { name: /expiry required/i }) as HTMLInputElement).checked).toBe(true);
    expect(within(dlg).getByRole('button', { name: /^save$/i })).toBeTruthy();
  });

  it('upper-cases the code on blur and POSTs exactly the ItemCreate fields with an Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items`, () => HttpResponse.json(item({ item_code: 'GLU-R9', version: 1 }), { status: 201 })));
    await openCreate();
    await fillMin();
    expect((tf(/^code/i) as HTMLInputElement).value).toBe('GLU-R9');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(itemPosts()).toHaveLength(1));
    const p = itemPosts()[0]!;
    expect(p.json).toEqual({ item_code: 'GLU-R9', name: 'Synthetic glucose reagent 9', category: 'reagent', base_uom_code: 'test', is_lot_tracked: true, requires_expiry: true });
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
    expect(p.search).toBe('');
    expect(Object.keys(p.json)).not.toContain('tenant_id'); // REQ-SEC-013/027: tenant only from claims
    await waitFor(() => expect(router.refresh).toHaveBeenCalled()); // list re-reads; Drawer closes
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows no money field anywhere on the item form (AC-01.1: money only with inventory.cost.read, and items carry none)', async () => {
    const dlg = await openCreate();
    expect(within(dlg).queryByText(/price|cost|rs\./i)).toBeNull();
  });
});

describe('form validation mirrors the spec (04-UI-UX §3 S2 table) — no POST on invalid input', () => {
  const attempt = async (code: string, name: string, extra?: () => Promise<void>) => {
    await openCreate();
    await userEvent.type(tf(/^code/i), code);
    await userEvent.tab();
    await userEvent.type(tf(/^name/i), name);
    if (extra) await extra();
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(itemPosts()).toHaveLength(0);
  };
  it('Code must match ^[A-Z0-9][A-Z0-9_.\\-]{0,31}$ (space / leading dash / 33 chars)', async () => {
    await attempt('bad code', 'Synthetic');
    expect(screen.getAllByText(/code/i).length).toBeGreaterThan(0);
    expect((tf(/^code/i) as HTMLInputElement).getAttribute('maxlength')).toBe('32');
  });
  it('Code is required', async () => { await openCreate(); await userEvent.type(tf(/^name/i), 'Synthetic'); await userEvent.click(screen.getByRole('button', { name: /^save$/i })); await new Promise((r) => setTimeout(r, 50)); expect(itemPosts()).toHaveLength(0); });
  it('Name is required (1–200) and capped at 200', async () => {
    await openCreate();
    expect((tf(/^name/i) as HTMLInputElement).getAttribute('maxlength')).toBe('200');
    await userEvent.type(tf(/^code/i), 'OK-1');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(itemPosts()).toHaveLength(0);
  });
  it('HS code must be 4–10 digits', async () => { await attempt('OK-2', 'Synthetic', async () => { await userEvent.type(tf(/hs code/i), '12'); }); });
  it('HS code rejects letters', async () => { await attempt('OK-3', 'Synthetic', async () => { await userEvent.type(tf(/hs code/i), '38ab'); }); });
  it('max lengths: manufacturer 120, catalogue no. 64, notes 1000, HS 10', async () => {
    await openCreate();
    expect(tf(/manufacturer/i).getAttribute('maxlength')).toBe('120');
    expect(tf(/catalogue no/i).getAttribute('maxlength')).toBe('64');
    expect(tf(/notes/i).getAttribute('maxlength')).toBe('1000');
    expect(tf(/hs code/i).getAttribute('maxlength')).toBe('10');
  });
  it('Open stability (days) accepts 1–3650 only (0 and 3651 blocked)', async () => {
    await attempt('OK-4', 'Synthetic', async () => { await userEvent.type(screen.getByRole('textbox', { name: /open stability/i }), '0'); });
    cleanup(); resetHits();
    await attempt('OK-5', 'Synthetic', async () => { await userEvent.type(screen.getByRole('textbox', { name: /open stability/i }), '3651'); });
  });
  it('Container size must be > 0', async () => { await attempt('OK-6', 'Synthetic', async () => { await userEvent.type(screen.getByRole('textbox', { name: /container size/i }), '0'); }); });
});

describe('AC-01.4 (form side): Expiry required only when Track lots is on', () => {
  it('turning Track lots off disables Expiry required and the POST does not ask for expiry', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items`, () => HttpResponse.json(item({ is_lot_tracked: false, requires_expiry: false }), { status: 201 })));
    const dlg = await openCreate();
    await userEvent.click(within(dlg).getByRole('switch', { name: /track lots/i }));
    const exp = within(dlg).getByRole('switch', { name: /expiry required/i });
    expect((exp as HTMLInputElement).disabled).toBe(true);
    await fillMin('OK-7', 'Synthetic');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(itemPosts()).toHaveLength(1));
    expect(itemPosts()[0]!.json.is_lot_tracked).toBe(false);
    expect(itemPosts()[0]!.json.requires_expiry).not.toBe(true);
  });
});

describe('AC-01.2 duplicate code', () => {
  it('409 inventory.code_duplicate: Drawer stays open, typed values kept, danger Banner with registry title + request_id; resubmit reuses the same Idempotency-Key', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/inventory/items`, () => (++n === 1 ? problem('inventory.code_duplicate', 409, { title: 'Code already used' }) : HttpResponse.json(item({ item_code: 'GLU-R9' }), { status: 201 }))));
    await openCreate();
    await fillMin();
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Code already used/);
    expect(alert.textContent).toMatch(/req-syn-0001/);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((tf(/^name/i) as HTMLInputElement).value).toBe('Synthetic glucose reagent 9');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(itemPosts()).toHaveLength(2));
    const keys = itemPosts().map((h) => h.headers.get('idempotency-key'));
    expect(keys[0]).toMatch(IDEM_RE);
    expect(keys[1]).toBe(keys[0]); // 04-UI-UX §1 Idempotency: reuse on resubmit
  });

  it('a 400 common.validation_failed with errors[].path maps onto the field (Form problem)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items`, () => problem('common.validation_failed', 400, { errors: [{ path: '/item_code', code: 'pattern', message: 'Code format is wrong.' }] })));
    await openCreate();
    await fillMin();
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect((await screen.findAllByText('Code format is wrong.')).length).toBeGreaterThan(0);
    expect(tf(/^code/i).getAttribute('aria-invalid')).toBe('true');
  });

  it('a successful submit resets the key: the next create uses a different Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items`, () => HttpResponse.json(item(), { status: 201 })));
    await openCreate();
    await fillMin('OK-8', 'One');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: /^new item$/i }));
    await fillMin('OK-9', 'Two');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(itemPosts()).toHaveLength(2));
    expect(itemPosts()[1]!.headers.get('idempotency-key')).not.toBe(itemPosts()[0]!.headers.get('idempotency-key'));
  });
});

describe('S3 detail + inline edit', () => {
  it('tabs Overview, Packs, Barcodes, Stock, Movements, Rules, Suppliers; Overview is a DescriptionList of the item', async () => {
    await mountItem();
    await screen.findByRole('tablist');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    for (const t of ['Overview', 'Packs', 'Barcodes', 'Stock', 'Movements', 'Rules', 'Suppliers']) expect(tabs, t).toContain(t);
    expect(screen.getAllByRole('term').length).toBeGreaterThan(3);
    expect(screen.getAllByText('GLU-R1').length).toBeGreaterThan(0);
  });

  it('GET /items/{id} 404 -> notFound()', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/items/:id`, () => problem('common.not_found', 404)));
    await expect(mountItem()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('edit sends PATCH with If-Match "<version>" and ONLY changed ItemPatch fields (never item_code / base_uom_code / id / version)', async () => {
    api.use(http.patch(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item({ name: 'Renamed synthetic', version: 4 }))));
    await mountItem();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const name = tf(/^name/i);
    await userEvent.clear(name); await userEvent.type(name, 'Renamed synthetic');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(hit('PATCH', /^\/v1\/inventory\/items\/[^/]+$/)).toHaveLength(1));
    const p = hit('PATCH', /^\/v1\/inventory\/items\/[^/]+$/)[0]!;
    expect(p.headers.get('if-match')).toBe('"3"');
    expect(p.json).toEqual({ name: 'Renamed synthetic' });
  });

  it('clearing an optional field sends it in `unset`, never an empty string or null (CV §4.2)', async () => {
    api.use(http.patch(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item({ manufacturer: undefined, version: 4 }))));
    await mountItem();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await userEvent.clear(tf(/manufacturer/i));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(hit('PATCH', /items\/[^/]+$/)).toHaveLength(1));
    const j = hit('PATCH', /items\/[^/]+$/)[0]!.json;
    expect(j.unset).toEqual(['manufacturer']);
    expect(j).not.toHaveProperty('manufacturer');
  });

  it('409 common.version_conflict: Banner with the registry title, form keeps the typed value', async () => {
    api.use(http.patch(`${ORIGIN}/v1/inventory/items/:id`, () => problem('common.version_conflict', 409, { title: 'Version conflict' })));
    await mountItem();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await userEvent.type(tf(/notes/i), ' more');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Version conflict/);
    expect((tf(/notes/i) as HTMLTextAreaElement).value).toMatch(/more$/);
  });

  it('no manage permission: read-only (no Edit, Deactivate, Add pack, barcode input)', async () => {
    state.permissions = PERM_READ;
    await mountItem();
    await screen.findByRole('tablist');
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: /packs/i }));
    expect(screen.queryByRole('button', { name: /add pack/i })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: /barcodes/i }));
    expect(screen.queryByRole('textbox', { name: /scan or type barcode/i })).toBeNull();
  });
});

describe('AC-01.5 base unit is locked once the item has packs, rules or stock', () => {
  it('with a pack: the Base unit control is disabled and the tooltip text is shown', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item({ packs: [pack(1)] }))));
    await mountItem();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const unit = screen.getByRole('button', { name: /base unit/i });
    expect(unit.hasAttribute('disabled') || unit.getAttribute('aria-disabled') === 'true').toBe(true);
    await userEvent.hover(unit.parentElement ?? unit);
    expect((await screen.findAllByText('Used by packs, rules or stock — create a new item to change the unit')).length).toBeGreaterThan(0);
  });

  it('the PATCH body never carries base_uom_code (not in ItemPatch); a server 409 common.immutable_record is shown as a danger Banner', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item({ packs: [pack(1)] }))),
      http.patch(`${ORIGIN}/v1/inventory/items/:id`, () => problem('common.immutable_record', 409, { title: 'Record is immutable' })),
    );
    await mountItem();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await userEvent.type(tf(/notes/i), ' x');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Record is immutable/);
    expect(hit('PATCH', /items\/[^/]+$/)[0]!.json).not.toHaveProperty('base_uom_code');
  });
});

describe('AC-01.3 deactivate / activate', () => {
  it('Deactivate -> ConfirmDialog -> POST /set-active {is_active:false} with If-Match "<version>"', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/set-active`, () => HttpResponse.json(item({ is_active: false, version: 4 }))));
    await mountItem();
    await userEvent.click(await screen.findByRole('button', { name: /^deactivate$/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dlg).getByRole('button', { name: /deactivate|confirm|yes/i }));
    await waitFor(() => expect(hit('POST', /\/set-active$/)).toHaveLength(1));
    const p = hit('POST', /\/set-active$/)[0]!;
    expect(p.json).toEqual({ is_active: false });
    expect(p.headers.get('if-match')).toBe('"3"');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('cancelling the ConfirmDialog sends nothing', async () => {
    await mountItem();
    await userEvent.click(await screen.findByRole('button', { name: /^deactivate$/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dlg).getByRole('button', { name: /cancel|no/i }));
    expect(hit('POST', /set-active/)).toHaveLength(0);
  });

  it('409 inventory.item_in_use shows the registry title in a danger Banner (stock or open PO lines)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/set-active`, () => problem('inventory.item_in_use', 409, { title: 'Item in use' })));
    await mountItem();
    await userEvent.click(await screen.findByRole('button', { name: /^deactivate$/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dlg).getByRole('button', { name: /deactivate|confirm|yes/i }));
    expect((await screen.findAllByText(/Item in use/)).length).toBeGreaterThan(0);
  });

  it('an inactive item shows an Inactive chip and "Activate" (reversible), not "Deactivate"', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item({ is_active: false }))));
    await mountItem();
    expect(await screen.findByRole('button', { name: /^activate$/i })).toBeTruthy();
    expect(screen.getAllByText(/inactive/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^deactivate$/i })).toBeNull();
  });
});

describe('S3 Packs tab', () => {
  const packsTab = async (over: Record<string, unknown> = {}) => {
    api.use(http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item({ packs: [pack(1)], ...over }))));
    await mountItem();
    await userEvent.click(await screen.findByRole('tab', { name: /^packs$/i }));
  };

  it('lists Code, Label, Unit, Qty in base, Default, Active; Qty in base is plain text with the immutability note', async () => {
    await packsTab();
    const table = await screen.findByRole('grid');
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Code', 'Label', 'Unit', 'Qty in base', 'Default', 'Active']) expect(heads, h).toContain(h);
    expect(within(table).getByText('BOX')).toBeTruthy();
    expect(within(table).getByText('400')).toBeTruthy();
    expect(within(table).queryByRole('textbox', { name: /qty in base/i })).toBeNull();
    expect(screen.getByText('Pack size cannot change. Add a new pack instead.')).toBeTruthy();
  });

  it('Add pack POSTs {pack_code,label,uom_code,qty_in_base,is_purchase_default} with an Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/packs`, () => HttpResponse.json(pack(2), { status: 201 })));
    await packsTab();
    await userEvent.click(screen.getByRole('button', { name: /add pack/i }));
    await userEvent.type(tf(/^code/i), 'CASE_4');
    await userEvent.type(tf(/^label/i), 'Case of 4 boxes');
    await choose(screen.getByRole('dialog'), /unit/i, /box/i);
    await userEvent.type(screen.getByRole('textbox', { name: /qty in base/i }), '1600');
    await userEvent.click(screen.getByRole('checkbox', { name: /purchase default/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(hit('POST', /\/packs$/)).toHaveLength(1));
    const p = hit('POST', /\/packs$/)[0]!;
    expect(p.json).toEqual({ pack_code: 'CASE_4', label: 'Case of 4 boxes', uom_code: 'box', qty_in_base: '1600', is_purchase_default: true });
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
  });

  it.each([
    ['pack code with a dash (pattern ^[A-Z0-9_]{1,16}$)', 'BAD-1', 'Label', '10'],
    ['quantity zero (must be > 0)', 'OK_1', 'Label', '0'],
    ['empty label', 'OK_2', '', '10'],
  ])('invalid: %s -> no POST', async (_n, code, label, qty) => {
    await packsTab();
    await userEvent.click(screen.getByRole('button', { name: /add pack/i }));
    await userEvent.type(tf(/^code/i), code);
    if (label) await userEvent.type(tf(/^label/i), label);
    await choose(screen.getByRole('dialog'), /unit/i, /box/i);
    await userEvent.type(screen.getByRole('textbox', { name: /qty in base/i }), qty);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(hit('POST', /\/packs$/)).toHaveLength(0);
  });

  it('pack code and label maxlength: 16 and 60', async () => {
    await packsTab();
    await userEvent.click(screen.getByRole('button', { name: /add pack/i }));
    expect(tf(/^code/i).getAttribute('maxlength')).toBe('16');
    expect(tf(/^label/i).getAttribute('maxlength')).toBe('60');
  });

  it('409 inventory.code_duplicate on a pack shows the title and keeps the form open', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/packs`, () => problem('inventory.code_duplicate', 409, { title: 'Code already used' })));
    await packsTab();
    await userEvent.click(screen.getByRole('button', { name: /add pack/i }));
    await userEvent.type(tf(/^code/i), 'BOX');
    await userEvent.type(tf(/^label/i), 'Dup');
    await choose(screen.getByRole('dialog'), /unit/i, /box/i);
    await userEvent.type(screen.getByRole('textbox', { name: /qty in base/i }), '5');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Code already used/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('S3 Barcodes tab — scanner add-barcode (plan row T-21 "scanner add-barcode"; 04-UI-UX §2; REQ-SEC-098)', () => {
  const barcodesTab = async (over: Record<string, unknown> = {}) => {
    api.use(http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item({ packs: [pack(1)], barcodes: [barcode(1)], ...over }))));
    await mountItem();
    await userEvent.click(await screen.findByRole('tab', { name: /^barcodes$/i }));
  };
  const field = () => screen.getByRole('textbox', { name: /scan or type barcode/i });
  const posts = () => hit('POST', /\/barcodes$/);

  it('has a BarcodeInput "Scan or type barcode" and a pack Select; existing barcodes are listed with their state', async () => {
    await barcodesTab();
    expect(field()).toBeTruthy();
    expect(screen.getByRole('button', { name: /pack/i })).toBeTruthy();
    expect(screen.getByText('SYN-BC-0001')).toBeTruthy();
  });

  it('scan + Enter POSTs {barcode_value} (case kept: the server upper-cases) with an Idempotency-Key, then clears the field', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/barcodes`, () => HttpResponse.json(barcode(2), { status: 201 })));
    await barcodesTab();
    await userEvent.type(field(), 'syn-bc-0002{Enter}');
    await waitFor(() => expect(posts()).toHaveLength(1));
    const p = posts()[0]!;
    expect(String(p.json.barcode_value).toUpperCase()).toBe('SYN-BC-0002');
    expect(Object.keys(p.json).sort()).toEqual(['barcode_value']);
    expect(p.headers.get('idempotency-key') ?? '').toMatch(IDEM_RE);
    await waitFor(() => expect((field() as HTMLInputElement).value).toBe('')); // clearAfterScan
    expect(router.refresh).toHaveBeenCalled();
  });

  it('with a pack chosen the POST carries pack_id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/barcodes`, () => HttpResponse.json(barcode(2), { status: 201 })));
    await barcodesTab();
    await userEvent.click(screen.getByRole('button', { name: /pack/i }));
    await userEvent.click(await screen.findByRole('option', { name: /BOX/i }));
    await userEvent.type(field(), 'SYN-BC-0003{Enter}');
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.json.pack_id).toBe(ID(101));
  });

  it('the scanned value never appears in any URL, query string or router call (REQ-SEC-098)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/barcodes`, () => HttpResponse.json(barcode(2), { status: 201 })));
    await barcodesTab();
    await userEvent.type(field(), 'SYN-SECRET-77{Enter}');
    await waitFor(() => expect(posts()).toHaveLength(1));
    for (const h of hits) { expect(h.path + h.search).not.toMatch(/SYN-SECRET-77/i); }
    for (const f of Object.values(router)) for (const c of f.mock.calls) expect(JSON.stringify(c)).not.toMatch(/SYN-SECRET-77/i);
  });

  it.each([
    ['a space inside', 'ABC DEF 123'],
    ['a non-ASCII character', 'ABCéé123'],
    ['65 characters', 'A'.repeat(65)],
  ])('rejects %s (pattern ^[\\x21-\\x7E]{1,64}$) — no POST', async (_n, v) => {
    await barcodesTab();
    await userEvent.type(field(), `${v}{Enter}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toHaveLength(0);
  });

  it('409 inventory.code_duplicate: the registry title is shown and the value is not re-submitted automatically', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/barcodes`, () => problem('inventory.code_duplicate', 409, { title: 'Code already used' })));
    await barcodesTab();
    await userEvent.type(field(), 'SYN-BC-0001{Enter}');
    expect((await screen.findAllByText(/Code already used/)).length).toBeGreaterThan(0);
    expect(posts()).toHaveLength(1);
  });

  it('deactivate a barcode: POST /barcodes/{id}/deactivate with If-Match "<version>"', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/items/:id/barcodes/:bid/deactivate`, () => HttpResponse.json(barcode(1, { is_active: false, version: 2 }))));
    await barcodesTab();
    const row = screen.getByText('SYN-BC-0001').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /deactivate/i }));
    const dlg = screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /deactivate|confirm|yes/i }));
    await waitFor(() => expect(hit('POST', /\/deactivate$/)).toHaveLength(1));
    expect(hit('POST', /\/deactivate$/)[0]!.headers.get('if-match')).toBe('"1"');
  });
});

describe('list rows open detail (04-UI-UX §1 Tables: onRowAction)', () => {
  it('activating a row navigates to /inventory/items/{id}', async () => {
    await mountList();
    const row = (await screen.findByText('GLU-R1')).closest('tr')!;
    const a = within(row).queryByRole('link', { name: /GLU-R1/ }) as HTMLAnchorElement | null;
    if (a) expect(a.getAttribute('href')).toBe(`/inventory/items/${itemSummary(1).id}`);
    else { await userEvent.click(row); expect(router.push).toHaveBeenCalledWith(`/inventory/items/${itemSummary(1).id}`); }
  });
});
