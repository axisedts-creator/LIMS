// @vitest-environment jsdom
// C12.T-21 — S4 Stores (+ Reorder settings) and S14 Analyser bindings (04-UI-UX §3 S4, S14; AC-03.1, AC-03.2, AC-03.3; REQ-SEC-017/040-042 UI side).
// LD-140 (2026-11-13): kit components only, masters = list + right Drawer + per-section Save, ONE primary button per page, every status shows tone + icon + word.
// Pinned seams: t21.harness.tsx header (?store=<id> opens the drawer; ?tab=analysers is S14).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, api, binding, hit, hits, page, problem, resetHits, router, setting, state, store } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/stores'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const S1 = ID(301), S2 = ID(302);
const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/stores/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const tf = (name: RegExp) => screen.getByRole('textbox', { name });
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const storePosts = () => hit('POST', /^\/v1\/inventory\/stores$/);
const storePatches = () => hit('PATCH', /^\/v1\/inventory\/stores\/[^/]+$/);

describe('S4 list (04-UI-UX §3 S4)', () => {
  it('columns Code, Name, Branch, Kind, Default consumption, Active; the default store carries a Badge with a word', async () => {
    await mount();
    const table = await screen.findByRole('grid', { name: /stores/i }).catch(() => screen.findByRole('grid'));
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Code', 'Name', 'Branch', 'Kind', 'Default consumption', 'Active']) expect(heads, h).toContain(h);
    const row1 = within(table).getByText('BR1-ST1').closest('tr')!;
    expect(within(row1).getByText(/default/i)).toBeTruthy();
    expect(within(table).getByText('BR1-ST2').closest('tr')!.textContent).not.toMatch(/\bdefault\b/i);
  });

  it('AC-03.2 (UI side): shows exactly the stores the API returned (branch scope is server-side) and never adds others', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/stores`, () => page([store(1)])));
    await mount();
    await screen.findByText('BR1-ST1');
    expect(screen.queryByText('BR1-ST2')).toBeNull();
  });

  it('AC-03.2: opening a store the API 404s (other branch) -> notFound(), no store data rendered', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/stores/:id`, () => problem('common.not_found', 404)));
    await expect(mount({ store: ID(399) })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('exactly ONE primary button "New store" with manage; read-only users get none', async () => {
    await mount();
    expect((await screen.findAllByRole('button', { name: /^new store$/i })).length).toBe(1);
    cleanup(); state.permissions = PERM_READ;
    await mount();
    await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /new store/i })).toBeNull();
  });

  it('no inventory.item.read: permission-denied, no API call', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });
});

describe('AC-03.1 create store with default consumption', () => {
  const openCreate = async () => { await mount(); await userEvent.click(await screen.findByRole('button', { name: /^new store$/i })); return screen.findByRole('dialog'); };

  it('Drawer fields: Branch (visible branches), Code, Name, Kind, Default consumption switch with the help text', async () => {
    const dlg = await openCreate();
    expect(within(dlg).getByRole('button', { name: /branch/i })).toBeTruthy();
    expect(within(dlg).getByRole('textbox', { name: /^code/i }).getAttribute('maxlength')).toBe('16');
    expect(within(dlg).getByRole('textbox', { name: /^name/i }).getAttribute('maxlength')).toBe('120');
    expect(within(dlg).getByRole('button', { name: /kind/i })).toBeTruthy();
    expect(within(dlg).getByRole('switch', { name: /default consumption/i })).toBeTruthy();
    expect(within(dlg).getByText('Tests and QC from analysers without their own store are deducted here.')).toBeTruthy();
  });

  it('POSTs {branch_id, store_code, name, store_kind, is_default_consumption:true} (code upper-cased)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stores`, () => HttpResponse.json(store(3, { store_code: 'BR1-MAIN' }), { status: 201 })));
    const dlg = await openCreate();
    await choose(dlg, /branch/i, /BR-1/);
    await userEvent.type(tf(/^code/i), 'br1-main');
    await userEvent.tab();
    await userEvent.type(tf(/^name/i), 'Synthetic main store');
    await choose(dlg, /kind/i, /main/i);
    await userEvent.click(within(dlg).getByRole('switch', { name: /default consumption/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(storePosts()).toHaveLength(1));
    expect(storePosts()[0]!.json).toEqual({ branch_id: ID(401), store_code: 'BR1-MAIN', name: 'Synthetic main store', store_kind: 'main', is_default_consumption: true });
    expect(storePosts()[0]!.search).toBe('');
    const key = storePosts()[0]!.headers.get('idempotency-key');
    if (key) expect(key).toMatch(IDEM_RE); // contract: Idem = optional
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it.each([
    ['code with a space', 'BAD CODE', 'Synthetic'],
    ['code starting with a dash', '-BAD', 'Synthetic'],
    ['empty name', 'OK-1', ''],
  ])('invalid: %s -> no POST', async (_n, code, name) => {
    const dlg = await openCreate();
    await choose(dlg, /branch/i, /BR-1/);
    await userEvent.type(tf(/^code/i), code);
    if (name) await userEvent.type(tf(/^name/i), name);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(storePosts()).toHaveLength(0);
  });

  it('Branch is required (no POST without one)', async () => {
    const dlg = await openCreate();
    await userEvent.type(tf(/^code/i), 'OK-2');
    await userEvent.type(tf(/^name/i), 'Synthetic');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(storePosts()).toHaveLength(0);
  });

  it('409 inventory.code_duplicate -> Banner with the registry title, Drawer stays open', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stores`, () => problem('inventory.code_duplicate', 409, { title: 'Code already used' })));
    const dlg = await openCreate();
    await choose(dlg, /branch/i, /BR-1/);
    await userEvent.type(tf(/^code/i), 'BR1-ST1');
    await userEvent.type(tf(/^name/i), 'Dup');
    await choose(dlg, /kind/i, /bench/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Code already used/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('AC-03.1 moving the default flag in ONE call', () => {
  it('turning Default consumption on for store 2 sends one PATCH {is_default_consumption:true} with If-Match, and does not PATCH store 1', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/inventory/stores/:id`, () => HttpResponse.json(store(2, { is_default_consumption: false }))),
      http.patch(`${ORIGIN}/v1/inventory/stores/:id`, () => HttpResponse.json(store(2, { is_default_consumption: true, version: 2 }))),
    );
    await mount({ store: S2 });
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('switch', { name: /default consumption/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(storePatches()).toHaveLength(1));
    const p = storePatches()[0]!;
    expect(p.path).toBe(`/v1/inventory/stores/${S2}`);
    expect(p.headers.get('if-match')).toBe('"1"');
    expect(p.json).toEqual({ is_default_consumption: true });
  });

  it('edit never sends branch_id or store_code (create-only fields)', async () => {
    api.use(http.patch(`${ORIGIN}/v1/inventory/stores/:id`, () => HttpResponse.json(store(1, { name: 'Renamed', version: 2 }))));
    await mount({ store: S1 });
    const dlg = await screen.findByRole('dialog');
    const name = within(dlg).getByRole('textbox', { name: /^name/i });
    await userEvent.clear(name); await userEvent.type(name, 'Renamed');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(storePatches()).toHaveLength(1));
    expect(storePatches()[0]!.json).toEqual({ name: 'Renamed' });
  });
});

describe('AC-03.3 deactivate a store', () => {
  const deactivate = async () => {
    await mount({ store: S1 });
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /^deactivate$/i }));
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findAllByRole('dialog').then((d) => d[d.length - 1]!));
    await userEvent.click(within(confirm).getByRole('button', { name: /deactivate|confirm|yes/i }));
  };

  it('Deactivate -> ConfirmDialog -> PATCH {is_active:false} with If-Match "<version>"', async () => {
    api.use(http.patch(`${ORIGIN}/v1/inventory/stores/:id`, () => HttpResponse.json(store(1, { is_active: false, version: 2 }))));
    await deactivate();
    await waitFor(() => expect(storePatches()).toHaveLength(1));
    expect(storePatches()[0]!.json).toEqual({ is_active: false });
    expect(storePatches()[0]!.headers.get('if-match')).toBe('"1"');
  });

  it('409 inventory.store_not_empty -> danger Banner with the registry title + request_id; store stays active in the list', async () => {
    api.use(http.patch(`${ORIGIN}/v1/inventory/stores/:id`, () => problem('inventory.store_not_empty', 409, { title: 'Store not empty' })));
    await deactivate();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Store not empty/);
    expect(alert.textContent).toMatch(/req-syn-0001/);
  });
});

describe('S4 Reorder settings tab (04-UI-UX §3 S4: per-row save on blur with If-Match)', () => {
  const open = async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/items`, () => page([
      { id: ID(11), item_code: 'GLU-R1', name: 'Synthetic glucose reagent 1', category: 'reagent', base_uom_code: 'test', is_lot_tracked: true, requires_expiry: true, is_active: true, version: 1 },
      { id: ID(12), item_code: 'GLU-R2', name: 'Synthetic glucose reagent 2', category: 'kit', base_uom_code: 'test', is_lot_tracked: true, requires_expiry: true, is_active: true, version: 1 },
    ])));
    await mount({ store: S1 });
    await userEvent.click(await screen.findByRole('tab', { name: /reorder settings/i }));
  };
  const rowOf = (code: string) => screen.getByText(code).closest('tr')!;
  const puts = () => hit('PUT', /\/item-settings\/[^/]+$/);

  it('one row per item with Reorder level, Reorder qty, Max level, Preferred supplier, Stocked', async () => {
    await open();
    const table = await screen.findByRole('grid');
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Item', 'Reorder level', 'Reorder qty', 'Max level', 'Preferred supplier', 'Stocked']) expect(heads, h).toContain(h);
    const r = rowOf('GLU-R1');
    expect((within(r).getByRole('textbox', { name: /reorder level/i }) as HTMLInputElement).value).toBe('100');
    expect((within(r).getByRole('textbox', { name: /reorder qty/i }) as HTMLInputElement).value).toBe('400');
    expect((within(r).getByRole('switch', { name: /stocked/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('changing Reorder level and blurring PUTs the row with If-Match "<version>" and DecimalString values', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/stores/:sid/item-settings/:iid`, () => HttpResponse.json(setting(1, { reorder_level_base: '150', version: 3 }))));
    await open();
    const f = within(rowOf('GLU-R1')).getByRole('textbox', { name: /reorder level/i });
    await userEvent.clear(f); await userEvent.type(f, '150'); await userEvent.tab();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const p = puts()[0]!;
    expect(p.path).toBe(`/v1/inventory/stores/${S1}/item-settings/${ID(11)}`);
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(p.json).toMatchObject({ reorder_level_base: '150', is_stocked: true });
    expect(Object.keys(p.json)).not.toContain('id');
  });

  it('blurring without a change sends nothing', async () => {
    await open();
    const f = within(rowOf('GLU-R1')).getByRole('textbox', { name: /reorder level/i });
    await userEvent.click(f); await userEvent.tab();
    await new Promise((r) => setTimeout(r, 50));
    expect(puts()).toHaveLength(0);
  });

  it('a negative or non-numeric entry is rejected locally (allowNegative=false) and never PUT', async () => {
    await open();
    const f = within(rowOf('GLU-R1')).getByRole('textbox', { name: /reorder level/i }) as HTMLInputElement;
    await userEvent.clear(f); await userEvent.type(f, '-5abc'); await userEvent.tab();
    await new Promise((r) => setTimeout(r, 50));
    for (const p of puts()) expect(String(p.json.reorder_level_base ?? '')).not.toMatch(/[-a-z]/i);
  });

  it('toggling Stocked PUTs is_stocked:false', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/stores/:sid/item-settings/:iid`, () => HttpResponse.json(setting(1, { is_stocked: false, version: 3 }))));
    await open();
    await userEvent.click(within(rowOf('GLU-R1')).getByRole('switch', { name: /stocked/i }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json.is_stocked).toBe(false);
  });

  it('409 common.version_conflict on a row shows a danger Banner with the title', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/stores/:sid/item-settings/:iid`, () => problem('common.version_conflict', 409, { title: 'Version conflict' })));
    await open();
    const f = within(rowOf('GLU-R1')).getByRole('textbox', { name: /reorder level/i });
    await userEvent.clear(f); await userEvent.type(f, '9'); await userEvent.tab();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Version conflict/);
  });

  it('read-only users see the values but no editable fields', async () => {
    state.permissions = PERM_READ;
    await open();
    const r = rowOf('GLU-R1');
    expect(within(r).queryAllByRole('textbox').length).toBe(0);
    expect(r.textContent).toMatch(/100/);
  });
});

describe('S14 Analyser bindings (tab "Analysers")', () => {
  const open = async () => { await mount({ tab: 'analysers' }); await screen.findByRole('grid'); };
  const puts = () => hit('PUT', /\/instrument-bindings\/[^/]+$/);

  it('Table Analyser, Store, Since; analyser label comes from the instrument directory (display name), not the raw id', async () => {
    await open();
    const table = screen.getByRole('grid');
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Analyser', 'Store', 'Since']) expect(heads, h).toContain(h);
    expect(within(table).getByText(/Synthetic chemistry analyser 1/)).toBeTruthy();
    expect(within(table).getByText(/Synthetic store 1/)).toBeTruthy();
  });

  it('falls back to the id text when the instrument lookup fails (page still renders)', async () => {
    api.use(http.get(`${ORIGIN}/v1/instruments/instruments`, () => problem('auth.forbidden', 403)));
    await open();
    expect(within(screen.getByRole('grid')).getByText(new RegExp(ID(901)))).toBeTruthy();
  });

  it('Bind: choose Analyser (Combobox) + Store (Select) -> PUT /instrument-bindings/{instrument_id} {store_id} (no If-Match for a new binding) -> success Toast', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/instrument-bindings/:iid`, ({ params }) => HttpResponse.json(binding(2, { instrument_id: String(params['iid']), store_id: S2 }))));
    await open();
    await userEvent.type(screen.getByRole('combobox', { name: /analyser/i }), 'Synthetic chemistry analyser 2');
    await userEvent.click(await screen.findByRole('option', { name: /analyser 2/i }));
    await userEvent.click(screen.getByRole('button', { name: /^store/i }));
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic store 2/ }));
    await userEvent.click(screen.getByRole('button', { name: /^(bind|link|save)$/i }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const p = puts()[0]!;
    expect(p.path).toBe(`/v1/inventory/instrument-bindings/${ID(902)}`);
    expect(p.json).toEqual({ store_id: S2 });
    expect(p.headers.get('if-match')).toBeNull();
    expect(await screen.findByText('Linked. Waiting records for this analyser will be posted shortly.')).toBeTruthy();
  });

  it('re-binding an analyser that already has a binding sends If-Match "<version>"', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/instrument-bindings/:iid`, () => HttpResponse.json(binding(1, { store_id: S2, version: 2 }))));
    await open();
    await userEvent.type(screen.getByRole('combobox', { name: /analyser/i }), 'Synthetic chemistry analyser 1');
    await userEvent.click(await screen.findByRole('option', { name: /analyser 1/i }));
    await userEvent.click(screen.getByRole('button', { name: /^store/i }));
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic store 2/ }));
    await userEvent.click(screen.getByRole('button', { name: /^(bind|link|save)$/i }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.headers.get('if-match')).toBe('"1"');
  });

  it('404 (unknown / other-tenant instrument) shows a danger Banner and NO success toast', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/instrument-bindings/:iid`, () => problem('common.not_found', 404, { title: 'Not found' })));
    await open();
    await userEvent.type(screen.getByRole('combobox', { name: /analyser/i }), 'Synthetic chemistry analyser 2');
    await userEvent.click(await screen.findByRole('option', { name: /analyser 2/i }));
    await userEvent.click(screen.getByRole('button', { name: /^store/i }));
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic store 1/ }));
    await userEvent.click(screen.getByRole('button', { name: /^(bind|link|save)$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not found/);
    expect(screen.queryByText(/^Linked\./)).toBeNull();
  });

  it('Bind needs both fields: no PUT when the store is missing', async () => {
    await open();
    await userEvent.type(screen.getByRole('combobox', { name: /analyser/i }), 'Synthetic chemistry analyser 2');
    await userEvent.click(await screen.findByRole('option', { name: /analyser 2/i }));
    await userEvent.click(screen.getByRole('button', { name: /^(bind|link|save)$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(puts()).toHaveLength(0);
  });

  it('Unbind: POST /instrument-bindings/{instrument_id}/deactivate with If-Match "<version>"', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/instrument-bindings/:iid/deactivate`, () => HttpResponse.json(binding(1, { is_active: false, version: 2 }))));
    await open();
    const row = screen.getByText(/Synthetic chemistry analyser 1/).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /unlink|unbind|deactivate|remove/i }));
    const dlg = screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /unlink|unbind|deactivate|remove|confirm|yes/i }));
    await waitFor(() => expect(hit('POST', /\/deactivate$/)).toHaveLength(1));
    expect(hit('POST', /\/deactivate$/)[0]!.headers.get('if-match')).toBe('"1"');
  });

  it('read-only users see the table but no bind form and no unlink', async () => {
    state.permissions = PERM_READ;
    await open();
    expect(screen.queryByRole('combobox', { name: /analyser/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unlink|unbind|deactivate|remove/i })).toBeNull();
  });
});
