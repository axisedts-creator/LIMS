// @vitest-environment jsdom
// C3.T-34 — SCR-13 Price lists (+ detail), SCR-14 Price-list version editor, SCR-15 Price simulator, SCR-16 Urgent surcharge rules, SCR-17 Tax rules & tax types
// (04-UI-UX §4; 03-APP-FLOW §5 states; ACs AC-13.4…13.8, AC-14.1…14.5, AC-15.2, AC-15.4 as seen from the UI). Component tests + MSW (server actions run for real) + axe.
// done_when: "Grid batching <= 200; unsaved guard; tax disclaimer everywhere". Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + kit components only; writer may dispute a name via the ruling flow). Types = contracts/openapi/catalog.yaml schemas.
//   components/PriceListsList.tsx      PriceListsList({priceLists: PriceList[], permissions})                                         SCR-13 list (+ "New price list" dialog)
//   components/PriceListDetail.tsx     PriceListDetail({priceList: PriceListDetail, ownerLabels: Record<id,string>, permissions})    SCR-13 detail: General form, Assignments, Versions, header actions
//   components/PriceVersionEditor.tsx  PriceVersionEditor({priceList:{id,code,name}, version: PriceListVersion, items: PriceItem[], currentItems: PriceItem[], orderables: OrderableSummary[], departments: Department[], permissions})
//                                      SCR-14: EditableGrid (columns Code · Name · Kind · Department · Price (NPR) · Current published price · Change · Status), toolbar Save / Add orderable / Publish…
//   components/PriceSimulator.tsx      PriceSimulator({permissions})                                                                  SCR-15 (button "Get price"; Orderables/Centre/Credit party/Doctor/Price list comboboxes)
//   components/SurchargeRulesScreen.tsx SurchargeRulesScreen({rules: SurchargeRule[], departments, orderables, priceLists, permissions})  SCR-16 ("New rule", row action "End rule")
//   components/TaxScreen.tsx           TaxScreen({rules: TaxRule[], taxTypes: TaxType[], departments, orderables, permissions})       SCR-17 (tabs "Rules" / "Tax types"; "New rule", "New tax type")
//   shared copy (exact): TAX_DISCLAIMER = "Tax treatment of lab services is pending confirmation by your auditor."
//   Edit/New/Publish/End are role="dialog". Large-change badge text matches /large change/i. Row removal = Delete key on the row, saved via bulk-remove with the row's orderable_id.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/catalog/price-lists',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/catalog',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;
const READ = ['catalog.price_list.read'];
const MANAGE = ['catalog.price_list.read', 'catalog.price_list.manage'];
const MANAGE_CENTRES = [...MANAGE, 'identity.centre.read'];
const DISCLAIMER = /Tax treatment of lab services is pending confirmation by your auditor/;
session.permissions = MANAGE;

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------
const money = (amount_paisa: number) => ({ amount_paisa, currency: 'NPR' });
const ref = (n: number, no: number, from = '2026-10-01T12:00:00.000Z') => ({ id: ID(n), version_no: no, effective_from: from });
const pl = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), code: 'DEFAULT', name: 'Default price list', owner_kind: 'default', falls_through: false, assignments: [], current_version: ref(70, 2), is_active: true, version: 3, ...o });
const LISTS = [
  pl(60),
  pl(61, { code: 'HOSP_A', name: 'Synthetic General Hospital list', owner_kind: 'credit_party', falls_through: true, assignments: [{ owner_id: ID(90) }, { owner_id: ID(91) }], current_version: ref(71, 1), scheduled_version: ref(72, 2, '2027-01-01T12:00:00.000Z'), draft_version_id: ID(73) }),
  pl(62, { code: 'DR_X', name: 'Dr Synthetic Alpha list', owner_kind: 'referrer', assignments: [{ owner_id: ID(92) }] }),
  pl(63, { code: 'C2', name: 'Synthetic Centre 2 list', owner_kind: 'centre', current_version: undefined, is_active: false }),
];
const ver = (n: number, no: number, status: string, o: Record<string, unknown> = {}) => ({ id: ID(n), price_list_id: ID(61), version_no: no, status, item_count: 3, version: 5, ...o });
const DETAIL = {
  ...LISTS[1],
  versions: [
    ver(73, 3, 'draft', { item_count: 4 }),
    ver(72, 2, 'published', { effective_from: '2027-01-01T12:00:00.000Z', change_reason: 'Synthetic yearly revision', source_import_id: ID(99) }),
    ver(71, 1, 'published', { effective_from: '2026-10-01T12:00:00.000Z', change_reason: 'Initial prices' }),
  ],
};
const OWNER_LABELS = { [ID(90)]: 'Synthetic General Hospital', [ID(91)]: 'Synthetic Affiliate Clinic', [ID(92)]: 'Dr Synthetic Alpha' };
const DEPTS = [{ id: ID(1), code: 'HAEM', name: 'Hematology', report_order: 10, is_active: true, version: 1 }, { id: ID(2), code: 'BIOC', name: 'Biochemistry', report_order: 20, is_active: true, version: 1 }];
const ord = (n: number, o: Record<string, unknown>) => ({ id: ID(n), kind: 'test', is_orderable: true, is_active: true, revision: 1, department_id: ID(1), ...o });
const CBC = ord(101, { code: 'CBC', name: 'Complete blood count' });
const HB = ord(102, { code: 'HB', name: 'Hemoglobin' });
const FBS = ord(103, { code: 'FBS', name: 'Fasting blood sugar', department_id: ID(2) });
const LIPID = ord(104, { kind: 'panel', code: 'LIPID', name: 'Lipid profile', department_id: ID(2), panel_kind: 'clinical' });
const ORDERABLES = [CBC, HB, FBS, LIPID];
const item = (o: Record<string, unknown>, paisa: number) => ({ orderable_id: o.id, orderable_code: o.code, orderable_kind: o.kind, unit_price: money(paisa) });

// ---- MSW --------------------------------------------------------------------------------------------------------------------------------
const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: ['POST', 'PATCH', 'PUT'].includes(r.method) ? await r.clone().json().catch(() => undefined) : undefined }); };
const prob = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const sent = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url.pathname));
const writes = () => calls.filter((c) => c.method !== 'GET' && !/\/prices\/quote$/.test(c.url.pathname));
const api = setupServer(
  http.get(`${ORIGIN}/v1/catalog/orderables`, async ({ request }) => { await rec(request); const q = new URL(request.url).searchParams.get('q')!.toLowerCase(); return HttpResponse.json({ data: ORDERABLES.filter((o) => (o.code as string).toLowerCase().startsWith(q) || (o.name as string).toLowerCase().includes(q)), page: { limit: 20 } }); }),
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ centre_id: ID(80), code: 'C2', name: 'Synthetic Centre 2', branch_id: ID(81), kind: 'own', is_active: true, version: 1 }] }); }),
  http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/items/bulk-upsert`, async ({ request }) => { await rec(request); const b: any = await request.clone().json(); return HttpResponse.json({ results: b.items.map((i: any) => ({ orderable_id: i.orderable_id, outcome: 'updated' })) }); }),
  http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/items/bulk-remove`, async ({ request }) => { await rec(request); return HttpResponse.json({ results: [] }); }),
  http.post(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: ID(500), version: 6, status: 'published', price_list_id: ID(61), version_no: 3, item_count: 4 }, { status: 201 }); }),
  http.patch(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: ID(500), version: 7 }); }),
  http.put(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: ID(500), version: 7 }); }),
  http.get(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); session.permissions = MANAGE; });
afterAll(() => api.close());
beforeEach(() => { document.body.innerHTML = ''; });

// ---- helpers ----------------------------------------------------------------------------------------------------------------------------
const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const rowOf = (text: string | RegExp) => screen.getByRole('row', { name: typeof text === 'string' ? new RegExp(`\\b${text}\\b`) : text });
const dialog = () => screen.getByRole('dialog');
const press = async (name: RegExp, root: HTMLElement = document.body) => userEvent.click(within(root).getByRole('button', { name }));
const choose = async (root: HTMLElement, label: RegExp, option: string | RegExp) => { await userEvent.click(within(root).getByLabelText(label)); await userEvent.click(await screen.findByRole('option', { name: option })); };
const pick = async (root: HTMLElement, label: RegExp, query: string, option: string | RegExp) => { await userEvent.type(within(root).getByLabelText(label), query); await userEvent.click(await screen.findByRole('option', { name: option })); };
// ruling C3.T-34 D2: pick fields by role, not label (a label starting with "Department"/"Percent" also matches the radio of the same name; kit DateTimePicker adds "Open calendar for Effective from").
const chooseDept = async (root: HTMLElement, option: string | RegExp) => { await userEvent.click(within(root).getByRole('button', { name: /department/i, expanded: false })); await userEvent.click(await screen.findByRole('option', { name: option })); };
const percentField = (root: HTMLElement) => (within(root).queryByRole('spinbutton', { name: /^percent/i }) ?? within(root).getByRole('textbox', { name: /^percent/i })) as HTMLInputElement;
const text = (root: HTMLElement = document.body) => root.textContent ?? '';
const load = async (name: string) => (await import(`../components/${name}`))[name];
const PRICE_COL = 4; // Code · Name · Kind · Department · Price (NPR) · Current published price · Change · Status

// ================================================================================================================ SCR-13
describe('SCR-13 PriceListsList (AC-13.6 default list; 03-APP-FLOW §5)', () => {
  const show = async (priceLists: unknown[] = LISTS, permissions: string[] = MANAGE) => { const C = await load('PriceListsList'); return wrap(<C priceLists={priceLists} permissions={permissions} />); };

  it('columns Code · Name · Applies to · Assigned to · Current version · Scheduled · Draft · Status; kinds shown as text; counts; badges carry text', async () => {
    await show();
    for (const h of ['Code', 'Name', 'Applies to', 'Assigned to', 'Current version', 'Scheduled', 'Draft', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(within(rowOf('DEFAULT')).getByText('Default')).toBeTruthy();
    expect(within(rowOf('HOSP_A')).getByText(/Hospital.?company/i)).toBeTruthy();
    expect(within(rowOf('DR_X')).getByText('Doctor')).toBeTruthy();
    expect(within(rowOf('C2')).getByText('Centre')).toBeTruthy();
    expect(within(rowOf('HOSP_A')).getByText('2')).toBeTruthy(); // assigned to (count)
    expect(within(rowOf('HOSP_A')).getByText(/scheduled/i)).toBeTruthy();
    expect(within(rowOf('HOSP_A')).getByText(/draft/i)).toBeTruthy();
    expect(within(rowOf('DEFAULT')).queryByText(/scheduled|draft/i)).toBeNull();
    expect(within(rowOf('C2')).getByText('Inactive')).toBeTruthy();
    expect(within(rowOf('HOSP_A')).getByRole('link', { name: /HOSP_A|Synthetic General Hospital list/ }).getAttribute('href')).toBe(`/catalog/price-lists/${ID(61)}`);
  });

  it('empty: "No price list yet — create the default list first."; only default: "Only the default price list exists."', async () => {
    const a = await show([]);
    expect(screen.getByText('No price list yet — create the default list first.')).toBeTruthy();
    a.unmount();
    await show([LISTS[0]]);
    expect(screen.getByText('Only the default price list exists.')).toBeTruthy();
  });

  it('read-only (catalog.price_list.read): table only — no New / Edit controls', async () => {
    await show(LISTS, READ);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new price list|edit|save/i })).toBeNull();
  });

  it('New price list: "Applies to" is create-only choice; POST carries Idempotency-Key and code is sent as typed-upper', async () => {
    await show([]);
    await press(/new price list/i);
    const d = dialog();
    await userEvent.type(within(d).getByLabelText(/^code/i), 'dr_y');
    await userEvent.type(within(d).getByLabelText(/^name/i), 'Dr Y list');
    await userEvent.click(within(d).getByRole('radio', { name: /^doctor$/i }));
    await press(/^save$/i, d);
    await waitFor(() => expect(sent('POST', /\/price-lists$/)).toHaveLength(1));
    const c = sent('POST', /\/price-lists$/)[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body).toMatchObject({ code: 'DR_Y', name: 'Dr Y list', owner_kind: 'referrer' });
  });

  it('AC-13.6: a second default list → API 409 catalog.code_duplicate → banner (not a raw error), dialog stays open', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/price-lists`, async ({ request }) => { await rec(request); return prob(409, 'catalog.code_duplicate'); }));
    await show([LISTS[0]]);
    await press(/new price list/i);
    const d = dialog();
    await userEvent.type(within(d).getByLabelText(/^code/i), 'D2');
    await userEvent.type(within(d).getByLabelText(/^name/i), 'Second default');
    await userEvent.click(within(d).getByRole('radio', { name: /^default$/i }));
    await press(/^save$/i, d);
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(text(dialog())).not.toMatch(/catalog\.code_duplicate|urn:lims/);
  });

  it('axe: no violations (read-only and manager)', async () => {
    const a = await show(LISTS, READ);
    await noAxeViolations();
    a.unmount();
    await show();
    await noAxeViolations();
  });
});

describe('SCR-13 PriceListDetail (general, assignments, versions, header actions; AC-13.7)', () => {
  const show = async (detail: unknown = DETAIL, permissions: string[] = MANAGE) => { const C = await load('PriceListDetail'); return wrap(<C priceList={detail as never} ownerLabels={OWNER_LABELS} permissions={permissions} />); };

  it('General: code read-only; "Applies to" disabled (create only); Falls through switch with the exact help text', async () => {
    await show();
    expect(screen.getByDisplayValue('HOSP_A').hasAttribute('readonly') || (screen.getByDisplayValue('HOSP_A') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByDisplayValue('Synthetic General Hospital list')).toBeTruthy();
    expect(screen.getByRole('switch', { name: /falls through/i }).getAttribute('aria-checked') ?? (screen.getByRole('switch', { name: /falls through/i }) as HTMLInputElement).checked).toBeTruthy();
    expect(screen.getByText('When an item is missing here, use the next price list (doctor → centre → default)')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^doctor$/i })).toBeNull();
  });

  it('Save → PATCH /price-lists/{id} with If-Match "<version>", body only name / falls_through / is_active', async () => {
    await show();
    const name = screen.getByLabelText(/^name/i);
    await userEvent.clear(name);
    await userEvent.type(name, 'Hospital A list v2');
    await press(/^save$/i);
    await waitFor(() => expect(sent('PATCH', new RegExp(`/price-lists/${ID(61)}$`))).toHaveLength(1));
    const c = sent('PATCH', /price-lists/)[0]!;
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(Object.keys(c.body).sort()).toEqual(expect.arrayContaining(['name']));
    expect(Object.keys(c.body).every((k) => ['name', 'falls_through', 'is_active'].includes(k))).toBe(true);
  });

  it('Assignments table shows owner labels; Versions table: Version · Status · Effective from · Effective to · Items · Source · Change reason · Published by', async () => {
    await show();
    expect(screen.getByText('Synthetic General Hospital')).toBeTruthy();
    expect(screen.getByText('Synthetic Affiliate Clinic')).toBeTruthy();
    for (const h of ['Version', 'Status', 'Effective from', 'Effective to', 'Items', 'Source', 'Change reason', 'Published by']) expect(screen.getAllByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }).length).toBeGreaterThan(0);
    expect(within(rowOf(/Initial prices/)).getByText('Published')).toBeTruthy();
    expect(within(rowOf(/Synthetic yearly revision/)).getByText('Import')).toBeTruthy();
    expect(within(rowOf(/Initial prices/)).getByText('Manual')).toBeTruthy();
    expect(within(rowOf(/Draft/)).getByText('Draft')).toBeTruthy();
  });

  it('AC-13.7: removing/adding an assignment → PUT /assignments with If-Match and {owner_ids}; 409 catalog.code_duplicate → banner', async () => {
    api.use(http.put(`${ORIGIN}/v1/catalog/price-lists/:id/assignments`, async ({ request }) => { await rec(request); return prob(409, 'catalog.code_duplicate'); }));
    await show();
    await press(/remove/i, rowOf(/Synthetic Affiliate Clinic/));
    await press(/save assignments|^save$/i, screen.getAllByRole('region').find((r) => /assignments/i.test(r.getAttribute('aria-label') ?? '')) ?? document.body);
    await waitFor(() => expect(sent('PUT', /assignments$/)).toHaveLength(1));
    const c = sent('PUT', /assignments$/)[0]!;
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.body).toEqual({ owner_ids: [ID(90)] });
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
  });

  it('"Edit prices" with an existing draft opens it (no POST); without a draft it POSTs /versions (Idempotency-Key) and navigates to the new version', async () => {
    const a = await show();
    await press(/edit prices/i);
    expect(sent('POST', /versions$/)).toHaveLength(0);
    expect(push).toHaveBeenCalledWith(`/catalog/price-lists/${ID(61)}/versions/${ID(73)}`);
    a.unmount();
    push.mockReset();
    api.use(http.post(`${ORIGIN}/v1/catalog/price-lists/:id/versions`, async ({ request }) => { await rec(request); return HttpResponse.json(ver(74, 3, 'draft', { item_count: 4 }), { status: 201 }); }));
    await show({ ...DETAIL, draft_version_id: undefined, versions: DETAIL.versions.slice(1) });
    await press(/edit prices/i);
    await waitFor(() => expect(sent('POST', /versions$/)).toHaveLength(1));
    expect(sent('POST', /versions$/)[0]!.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/catalog/price-lists/${ID(61)}/versions/${ID(74)}`));
  });

  it('header actions "Export to Excel", "Import from Excel", "Compare versions" exist for managers; read-only users have no Edit prices / Import / Save', async () => {
    const a = await show();
    for (const n of [/export to excel/i, /import from excel/i, /compare versions/i, /edit prices/i]) expect(screen.getAllByRole('button', { name: n }).length + screen.queryAllByRole('link', { name: n }).length).toBeGreaterThan(0);
    a.unmount();
    await show(DETAIL, READ);
    expect(screen.queryByRole('button', { name: /edit prices|import from excel|^save/i })).toBeNull();
    expect(screen.getByDisplayValue('Synthetic General Hospital list').hasAttribute('readonly') || (screen.getByDisplayValue('Synthetic General Hospital list') as HTMLInputElement).disabled).toBe(true);
  });

  it('Centre list: assignments pick centres from C2 only with identity.centre.read (no /identity/centres call without it)', async () => {
    const centreList = { ...DETAIL, owner_kind: 'centre', assignments: [] };
    const a = await show(centreList, MANAGE);
    expect(calls.filter((c) => c.url.pathname === '/v1/identity/centres')).toHaveLength(0);
    a.unmount();
    session.permissions = MANAGE_CENTRES;
    await show(centreList, MANAGE_CENTRES);
    await userEvent.type(screen.getByLabelText(/add|centre/i), 'C');
    await waitFor(() => expect(calls.filter((c) => c.url.pathname === '/v1/identity/centres').length).toBeGreaterThan(0));
  });

  it('axe: no violations', async () => { await show(); await noAxeViolations(); });
});

// ================================================================================================================ SCR-14
const bulk = (n: number) => Array.from({ length: n }, (_, i) => ord(2000 + i, { code: `T${String(i).padStart(4, '0')}`, name: `Synthetic test ${i}` }));
describe('SCR-14 PriceVersionEditor (grid, batching ≤ 200, unsaved guard, publish; AC-13.4, 13.5, 13.8)', () => {
  const PLREF = { id: ID(61), code: 'HOSP_A', name: 'Synthetic General Hospital list' };
  const baseItems = [item(CBC, 90000), item(HB, 80000), item(FBS, 20000)];
  const current = [item(CBC, 90000), item(HB, 80000), item(FBS, 20000)];
  const editor = async (o: Record<string, unknown> = {}, permissions: string[] = MANAGE) => {
    const C = await load('PriceVersionEditor');
    return wrap(<C priceList={PLREF} version={ver(73, 3, 'draft')} items={baseItems} currentItems={current} orderables={ORDERABLES} departments={DEPTS} permissions={permissions} {...o} />);
  };
  const editPrice = (row: HTMLElement, value: string) => {
    fireEvent.doubleClick(within(row).getAllByRole('gridcell')[PRICE_COL]!);
    const input = within(row).getByRole('textbox');
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };
  const beforeUnload = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };

  it('columns, NPR formatting, department names and the Current published price are shown; names come from `orderables`', async () => {
    await editor();
    expect(screen.getByRole('grid', { name: /price/i })).toBeTruthy();
    for (const h of ['Code', 'Name', 'Kind', 'Department', 'Price (NPR)', 'Current published price', 'Change', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h.replace(/[()]/g, '\\$&')}`, 'i') })).toBeTruthy();
    const r = rowOf('CBC');
    expect(text(r)).toMatch(/Complete blood count/);
    expect(text(r)).toMatch(/Hematology/);
    expect(text(r)).toMatch(/900\.00/);
    expect(text(r)).toMatch(/Saved|Unchanged|—/i);
  });

  it('empty version: "This version has no prices. Add rows or import from Excel."', async () => {
    await editor({ items: [], currentItems: [] });
    expect(screen.getByText('This version has no prices. Add rows or import from Excel.')).toBeTruthy();
  });

  it('editing a price marks the row "Unsaved changes", shows ±% change; > 50 % shows a "large change" warning with text, exactly 50 % does not', async () => {
    await editor();
    editPrice(rowOf('CBC'), '1500.00'); // +66.7 %
    editPrice(rowOf('HB'), '1200.00'); // +50.0 %
    expect(text(rowOf('CBC'))).toMatch(/Unsaved changes/);
    expect(text(rowOf('CBC'))).toMatch(/66\.7\s?%/);
    expect(text(rowOf('CBC'))).toMatch(/large change/i);
    expect(text(rowOf('HB'))).toMatch(/50(\.0)?\s?%/);
    expect(text(rowOf('HB'))).not.toMatch(/large change/i);
  });

  it('Save → ONE bulk-upsert with only the changed rows, amount_paisa integers, Idempotency-Key; rows go back to Saved; no price from the client for unchanged rows', async () => {
    await editor();
    editPrice(rowOf('CBC'), '1500.50');
    editPrice(rowOf('FBS'), '250');
    await press(/^save$/i);
    await waitFor(() => expect(sent('POST', /bulk-upsert$/)).toHaveLength(1));
    const c = sent('POST', /bulk-upsert$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/catalog/price-list-versions/${ID(73)}/items/bulk-upsert`);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body.items).toHaveLength(2);
    expect(c.body.items).toEqual(expect.arrayContaining([{ orderable_id: ID(101), unit_price: money(150050) }, { orderable_id: ID(103), unit_price: money(25000) }]));
    await waitFor(() => expect(text(rowOf('CBC'))).toMatch(/Saved/));
  });

  it('done_when: 201 changed rows are saved in batches of ≤ 200 (200 + 1), each with its own Idempotency-Key', async () => {
    const many = bulk(201);
    await editor({ items: many.map((o) => item(o, 10000)), currentItems: many.map((o) => item(o, 10000)), orderables: many });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(201);
    rows.forEach((r, i) => editPrice(r, `${101 + i}.00`)); // base price is 100.00: 101+ so every edit is a real change
    await press(/^save$/i);
    await waitFor(() => expect(sent('POST', /bulk-upsert$/)).toHaveLength(2), { timeout: 15000 });
    const sizes = sent('POST', /bulk-upsert$/).map((c) => c.body.items.length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 200]);
    const keys = sent('POST', /bulk-upsert$/).map((c) => c.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(2);
    const ids = sent('POST', /bulk-upsert$/).flatMap((c) => c.body.items.map((i: any) => i.orderable_id));
    expect(new Set(ids).size).toBe(201); // no row lost or duplicated
  }, 420000); // ruling D4: ~1.1 s per kit EditableGrid edit × 201 edits

  it('exactly 200 changed rows → a single request', async () => {
    const many = bulk(200);
    await editor({ items: many.map((o) => item(o, 10000)), currentItems: many.map((o) => item(o, 10000)), orderables: many });
    screen.getAllByRole('row').slice(1).forEach((r, i) => editPrice(r, `${101 + i}.00`));
    await press(/^save$/i);
    await waitFor(() => expect(sent('POST', /bulk-upsert$/)).toHaveLength(1), { timeout: 15000 });
    expect(sent('POST', /bulk-upsert$/)[0]!.body.items).toHaveLength(200);
  }, 420000); // ruling D4

  it('per-row error_code from the API is shown in that row only; the other rows are saved; the failed row stays unsaved', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/items/bulk-upsert`, async ({ request }) => {
      await rec(request);
      return HttpResponse.json({ results: [{ orderable_id: ID(101), outcome: 'error', error_code: 'catalog.test_inactive' }, { orderable_id: ID(103), outcome: 'updated' }] });
    }));
    await editor();
    editPrice(rowOf('CBC'), '1000');
    editPrice(rowOf('FBS'), '300');
    await press(/^save$/i);
    await waitFor(() => expect(text(rowOf('CBC'))).toMatch(/catalog\.test_inactive/));
    expect(text(rowOf('FBS'))).not.toMatch(/catalog\.test_inactive/);
    expect(text(rowOf('FBS'))).toMatch(/Saved/);
    expect(beforeUnload()).toBe(true); // CBC is still dirty
  });

  it('AC-13.8: negative, > NPR 9,999,999.99, > 2 decimals and non-numeric prices are rejected in the row and never sent', async () => {
    await editor();
    for (const bad of ['-5', '10000000.00', '12.345', 'abc']) {
      editPrice(rowOf('CBC'), bad);
      await press(/^save$/i);
      await waitFor(() => expect(text(rowOf('CBC'))).toMatch(/error|invalid|must|between|decimal|price/i));
    }
    expect(sent('POST', /bulk-upsert$/)).toHaveLength(0);
    editPrice(rowOf('CBC'), '9999999.99'); // the maximum is accepted
    await press(/^save$/i);
    await waitFor(() => expect(sent('POST', /bulk-upsert$/)).toHaveLength(1));
    expect(sent('POST', /bulk-upsert$/)[0]!.body.items[0].unit_price).toEqual(money(999999999));
  });

  it('unsaved guard: beforeunload is blocked while there are unsaved edits, released after a successful Save, and never armed without edits', async () => {
    await editor();
    expect(beforeUnload()).toBe(false);
    editPrice(rowOf('CBC'), '1000');
    expect(beforeUnload()).toBe(true);
    await press(/^save$/i);
    await waitFor(() => expect(sent('POST', /bulk-upsert$/)).toHaveLength(1));
    await waitFor(() => expect(beforeUnload()).toBe(false));
  });

  it('unsaved guard: unmounting the editor removes the beforeunload listener (no stale prompt on other screens)', async () => {
    const a = await editor();
    editPrice(rowOf('CBC'), '1000');
    expect(beforeUnload()).toBe(true);
    a.unmount();
    expect(beforeUnload()).toBe(false);
  });

  it('Ctrl+S saves (and the browser default is prevented)', async () => {
    await editor();
    editPrice(rowOf('CBC'), '1000');
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(sent('POST', /bulk-upsert$/)).toHaveLength(1));
  });

  it('double click on Save sends one request while in flight', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/items/bulk-upsert`, async ({ request }) => { await rec(request); await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json({ results: [{ orderable_id: ID(101), outcome: 'updated' }] }); }));
    await editor();
    editPrice(rowOf('CBC'), '1000');
    await userEvent.dblClick(screen.getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 400));
    expect(sent('POST', /bulk-upsert$/)).toHaveLength(1);
  });

  it('Delete on a selected row marks it for removal; Save sends bulk-remove with its orderable_id and no upsert', async () => {
    await editor();
    const cell = within(rowOf('HB')).getAllByRole('gridcell')[0]!;
    cell.focus();
    await userEvent.keyboard('{Delete}');
    expect(text(rowOf('HB'))).toMatch(/remov/i);
    await press(/^save$/i);
    await waitFor(() => expect(sent('POST', /bulk-remove$/)).toHaveLength(1));
    expect(sent('POST', /bulk-remove$/)[0]!.body).toEqual({ ids: [ID(102)] });
    expect(sent('POST', /bulk-upsert$/)).toHaveLength(0);
  });

  it('"Add orderable" (Combobox → searchOrderables) adds an unsaved row; saving upserts it', async () => {
    await editor({ items: [item(CBC, 90000)], currentItems: [item(CBC, 90000)] });
    await pick(document.body, /add orderable/i, 'fas', /FBS/);
    expect(calls.filter((c) => c.url.pathname === '/v1/catalog/orderables').length).toBeGreaterThan(0);
    expect(text(rowOf('FBS'))).toMatch(/Unsaved changes/);
    editPrice(rowOf('FBS'), '250');
    await press(/^save$/i);
    await waitFor(() => expect(sent('POST', /bulk-upsert$/)).toHaveLength(1));
    expect(sent('POST', /bulk-upsert$/)[0]!.body.items).toEqual([{ orderable_id: ID(103), unit_price: money(25000) }]);
  });

  it('toolbar search filters loaded rows client-side (no request)', async () => {
    await editor();
    await userEvent.type(screen.getByRole('searchbox'), 'hemo');
    expect(screen.queryByRole('row', { name: /\bCBC\b/ })).toBeNull();
    expect(rowOf('HB')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('AC-13.4: published version opens read-only; "Create new version" POSTs /versions with copy_from_version_no + Idempotency-Key and opens the new draft', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/price-lists/:id/versions`, async ({ request }) => { await rec(request); return HttpResponse.json(ver(75, 4, 'draft'), { status: 201 }); }));
    await editor({ version: ver(72, 3, 'published', { effective_from: '2027-01-01T12:00:00.000Z' }) });
    expect(screen.getByRole('grid').getAttribute('aria-readonly')).toBe('true');
    expect(screen.queryByRole('button', { name: /^save$|^publish|add orderable|remove selected/i })).toBeNull();
    await press(/create new version/i);
    await waitFor(() => expect(sent('POST', /versions$/)).toHaveLength(1));
    const c = sent('POST', /versions$/)[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body).toEqual({ copy_from_version_no: 3 });
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/catalog/price-lists/${ID(61)}/versions/${ID(75)}`));
    expect(beforeUnload()).toBe(false);
  });

  it('AC-13.4: 409 catalog.version_in_use on Save → "This version is already published." (+ Create new version); no raw code', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/items/bulk-upsert`, async ({ request }) => { await rec(request); return prob(409, 'catalog.version_in_use'); }));
    await editor();
    editPrice(rowOf('CBC'), '1000');
    await press(/^save$/i);
    expect(await screen.findByText(/This version is already published\./)).toBeTruthy();
    expect(text()).not.toMatch(/catalog\.version_in_use|urn:lims/);
    expect(screen.getByRole('button', { name: /create new version/i })).toBeTruthy();
  });

  it('read-only (catalog.price_list.read): grid read-only, no Save / Add / Publish / Remove', async () => {
    await editor({}, READ);
    expect(screen.getByRole('grid').getAttribute('aria-readonly')).toBe('true');
    expect(screen.queryByRole('button', { name: /^save$|^publish|add orderable|remove selected/i })).toBeNull();
  });

  describe('Publish… dialog (AC-13.5, F-12 step 4)', () => {
    const open = async (o: Record<string, unknown> = {}, permissions: string[] = MANAGE) => { await editor(o, permissions); await press(/^publish/i); return dialog(); };

    it('lock icon + "Requires two-step verification"; change reason required (1–500); effective from defaults to now', async () => {
      const d = await open();
      expect(within(d).getByText(/Requires two-step verification/i)).toBeTruthy();
      expect((within(d).getByLabelText(/change reason/i) as HTMLTextAreaElement).required || within(d).getByLabelText(/change reason/i).getAttribute('aria-required') === 'true').toBe(true);
      await press(/^publish$/i, d);
      expect(sent('POST', /publish$/)).toHaveLength(0);
      expect((await within(dialog()).findAllByText(/required|enter a reason|change reason/i)).length).toBeGreaterThan(0);
    });

    it('sends ONE POST /price-list-versions/{id}/publish with If-Match "<version>", Idempotency-Key, change_reason and a UTC-ISO effective_from ≈ now', async () => {
      api.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/publish`, async ({ request }) => { await rec(request); return HttpResponse.json(ver(73, 3, 'published', { version: 6 })); }));
      const d = await open();
      await userEvent.type(within(d).getByLabelText(/change reason/i), 'Synthetic yearly revision');
      await press(/^publish$/i, d);
      await waitFor(() => expect(sent('POST', /publish$/)).toHaveLength(1));
      const c = sent('POST', /publish$/)[0]!;
      expect(c.url.pathname).toBe(`/v1/catalog/price-list-versions/${ID(73)}/publish`);
      expect(c.headers.get('if-match')).toBe('"5"');
      expect(c.headers.get('idempotency-key')).toBeTruthy();
      expect(c.body.change_reason).toBe('Synthetic yearly revision');
      expect(Math.abs(Date.parse(c.body.effective_from) - Date.now())).toBeLessThan(5 * 60_000);
      expect(c.body.effective_from).toMatch(/Z$/);
      expect(await screen.findByText(/published/i)).toBeTruthy();
    });

    it('403 auth.mfa_required → "Confirm with your authenticator to continue"; the retry re-sends the SAME Idempotency-Key', async () => {
      let n = 0;
      api.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/publish`, async ({ request }) => { await rec(request); return ++n === 1 ? prob(403, 'auth.mfa_required') : HttpResponse.json(ver(73, 3, 'published', { version: 6 })); }));
      const d = await open();
      await userEvent.type(within(d).getByLabelText(/change reason/i), 'r');
      await press(/^publish$/i, d);
      expect(await screen.findByText(/Confirm with your authenticator to continue/i)).toBeTruthy();
      await press(/^publish$/i, dialog());
      await waitFor(() => expect(sent('POST', /publish$/)).toHaveLength(2));
      const [a, b] = sent('POST', /publish$/);
      expect(a!.headers.get('idempotency-key')).toBeTruthy();
      expect(b!.headers.get('idempotency-key')).toBe(a!.headers.get('idempotency-key'));
    });

    it('double click sends exactly one request while in flight; Esc closes without sending', async () => {
      api.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/publish`, async ({ request }) => { await rec(request); await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(ver(73, 3, 'published', { version: 6 })); }));
      const d = await open();
      await userEvent.type(within(d).getByLabelText(/change reason/i), 'r');
      await userEvent.dblClick(within(d).getByRole('button', { name: /^publish$/i }));
      await new Promise((r) => setTimeout(r, 400));
      expect(sent('POST', /publish$/)).toHaveLength(1);
      cleanup();
      calls.length = 0;
      await open();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(writes()).toHaveLength(0);
    });

    it('409 common.version_conflict → "Someone else changed this item. Reload to see their changes." + Reload; reason kept', async () => {
      api.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/publish`, async ({ request }) => { await rec(request); return prob(409, 'common.version_conflict'); }));
      const d = await open();
      await userEvent.type(within(d).getByLabelText(/change reason/i), 'keep me');
      await press(/^publish$/i, d);
      expect(await screen.findByText('Someone else changed this item. Reload to see their changes.')).toBeTruthy();
      expect((within(dialog()).getByLabelText(/change reason/i) as HTMLTextAreaElement).value).toBe('keep me');
      expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
    });

    it('without catalog.price_list.manage the Publish… button is absent (read-only editor)', async () => {
      await editor({}, READ);
      expect(screen.queryByRole('button', { name: /^publish/i })).toBeNull();
    });
  });

  it('axe: no violations (draft, published read-only)', async () => {
    const a = await editor();
    await noAxeViolations();
    a.unmount();
    await editor({ version: ver(72, 3, 'published') }, READ);
    await noAxeViolations();
  });
});

// ================================================================================================================ SCR-15
describe('SCR-15 PriceSimulator (AC-14.1, AB-10, REQ-SEC-046, AC-15.4)', () => {
  const QUOTES = {
    quotes: [
      { orderable_id: ID(101), price_list_id: ID(61), price_list_version: 2, source: 'credit_party', unit_price: money(90000), urgent_surcharge: money(45000), tax: { vat: 'taxable', vat_rate_bp: 1300, other_tax_code: 'CESS', other_tax_rate_bp: 200, hs_code: '9018' } },
      { orderable_id: ID(103), error_code: 'catalog.no_price' },
    ],
  };
  const show = async (permissions: string[] = MANAGE_CENTRES) => { session.permissions = permissions; const C = await load('PriceSimulator'); return wrap(<C permissions={permissions} />); };
  const fill = async () => {
    await pick(document.body, /^orderables/i, 'cb', /CBC/);
    await pick(document.body, /^orderables/i, 'fas', /FBS/);
  };

  it('empty state "Pick orderables and a context to see the price."; Priority radio Routine (default) / Urgent; tax disclaimer is already visible', async () => {
    await show();
    expect(screen.getByText('Pick orderables and a context to see the price.')).toBeTruthy();
    expect((screen.getByRole('radio', { name: /^routine$/i }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /^urgent$/i })).toBeTruthy();
    expect(screen.getAllByText(DISCLAIMER).length).toBeGreaterThan(0);
  });

  it('hidden without catalog.price_list.read: no form, no request', async () => {
    await show(['catalog.test.read']);
    expect(screen.queryByRole('button', { name: /get price/i })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('quote request: POST /prices/quote with items [{orderable_id, priority}], only the context ids that were chosen, no unit_price / tenant_id', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/prices/quote`, async ({ request }) => { await rec(request); return HttpResponse.json(QUOTES); }));
    await show();
    await fill();
    await userEvent.click(screen.getByRole('radio', { name: /^urgent$/i }));
    await press(/get price/i);
    await waitFor(() => expect(sent('POST', /prices\/quote$/)).toHaveLength(1));
    const b = sent('POST', /prices\/quote$/)[0]!.body;
    expect(b.items).toEqual([{ orderable_id: ID(101), priority: 'urgent' }, { orderable_id: ID(103), priority: 'urgent' }]);
    expect(b.context ?? {}).toEqual({}); // nothing chosen → no empty keys
    expect(JSON.stringify(b)).not.toMatch(/unit_price|tenant_id|amount_paisa/);
    expect(sent('POST', /prices\/quote$/)[0]!.headers.get('if-match')).toBeNull();
  });

  it('result table: columns, source/priced-by labels, NPR amounts, urgent surcharge, VAT "Taxable 13 %", other tax, HS code; per-item error shown in its own row', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/prices/quote`, async ({ request }) => { await rec(request); return HttpResponse.json(QUOTES); }));
    await show();
    await fill();
    await press(/get price/i);
    const table = await screen.findByRole('table');
    for (const h of ['Orderable', 'Price list used', 'Source', 'Version', 'Unit price', 'Urgent surcharge', 'VAT', 'Other tax', 'HS code', 'Error']) expect(within(table).getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    const ok = within(table).getByRole('row', { name: /CBC/ });
    expect(text(ok)).toMatch(/Hospital/i);
    expect(text(ok)).toMatch(/NPR\s?900\.00/);
    expect(text(ok)).toMatch(/NPR\s?450\.00/); // AC-14.1: 50 % of 900.00
    expect(text(ok)).toMatch(/Taxable 13\s?%/);
    expect(text(ok)).toMatch(/CESS/);
    expect(text(ok)).toMatch(/9018/);
    const bad = within(table).getByRole('row', { name: /FBS/ });
    expect(text(bad)).toMatch(/catalog\.no_price|No price/i);
    expect(text(bad)).not.toMatch(/NPR\s?\d/);
  });

  it('routine quote shows no urgent surcharge (column empty); tax_config_missing is shown in the row, not as a crash', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/prices/quote`, async ({ request }) => { await rec(request); return HttpResponse.json({ quotes: [{ orderable_id: ID(101), error_code: 'catalog.tax_config_missing' }, { orderable_id: ID(103), price_list_id: ID(60), price_list_version: 1, source: 'tenant_default', unit_price: money(20000), tax: { vat: 'exempt' } }] }); }));
    await show();
    await fill();
    await press(/get price/i);
    const table = await screen.findByRole('table');
    expect(text(within(table).getByRole('row', { name: /CBC/ }))).toMatch(/catalog\.tax_config_missing|tax/i);
    const r = within(table).getByRole('row', { name: /FBS/ });
    expect(text(r)).toMatch(/Default/);
    expect(text(r)).toMatch(/Exempt/);
    expect(text(r)).not.toMatch(/450\.00/);
  });

  it('AC-15.4: the tax disclaimer sits under the result table', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/prices/quote`, async ({ request }) => { await rec(request); return HttpResponse.json(QUOTES); }));
    await show();
    await fill();
    await press(/get price/i);
    const table = await screen.findByRole('table');
    const note = screen.getAllByText(DISCLAIMER).find((n) => table.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(note, 'disclaimer after the table').toBeTruthy();
  });

  it('Centre picker is fed by C2 listCentres and only with identity.centre.read', async () => {
    const a = await show(MANAGE);
    expect(screen.queryByLabelText(/^centre/i)).toBeNull();
    expect(calls.filter((c) => c.url.pathname === '/v1/identity/centres')).toHaveLength(0);
    a.unmount();
    await show(MANAGE_CENTRES);
    await userEvent.type(screen.getByLabelText(/^centre/i), 'c');
    await waitFor(() => expect(calls.filter((c) => c.url.pathname === '/v1/identity/centres').length).toBeGreaterThan(0));
    expect(await screen.findByRole('option', { name: /C2|Synthetic Centre 2/ })).toBeTruthy();
  });

  it('axe: no violations', async () => { await show(); await noAxeViolations(); });
});

// ================================================================================================================ SCR-16
describe('SCR-16 SurchargeRulesScreen (AC-14.1…14.5, 03-APP-FLOW §5)', () => {
  const rule = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), scope: 'all', amount_kind: 'flat', amount: money(20000), effective_from: '2026-10-01T12:00:00.000Z', version: 2, ...o });
  const RULES = [
    rule(300),
    rule(301, { scope: 'department', department_id: ID(1), amount_kind: 'percent', percent_bp: 5000, amount: undefined, price_list_id: ID(61) }),
    rule(302, { scope: 'orderable', orderable_id: ID(101), amount_kind: 'flat', amount: money(15050), effective_to: '2026-09-30T12:00:00.000Z', effective_from: '2026-01-01T12:00:00.000Z' }),
  ];
  const PRICE_LISTS = [LISTS[0], LISTS[1]];
  const show = async (rules: unknown[] = RULES, permissions: string[] = MANAGE) => { const C = await load('SurchargeRulesScreen'); return wrap(<C rules={rules as never} departments={DEPTS as never} orderables={ORDERABLES as never} priceLists={PRICE_LISTS as never} permissions={permissions} />); };

  it('table: Applies to (All tests / Department X / Orderable Y) · Price list · Amount (NPR 200.00 or 50 %) · Effective from/to · Status; help text exact', async () => {
    await show();
    for (const h of ['Applies to', 'Price list', 'Amount', 'Effective from', 'Effective to', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(text(screen.getAllByRole('row')[1]!)).toMatch(/All tests/);
    expect(text(screen.getAllByRole('row')[1]!)).toMatch(/NPR\s?200\.00/);
    expect(text(screen.getAllByRole('row')[2]!)).toMatch(/Hematology/);
    expect(text(screen.getAllByRole('row')[2]!)).toMatch(/50\s?%/);
    expect(text(screen.getAllByRole('row')[2]!)).toMatch(/Synthetic General Hospital list|HOSP_A/);
    expect(text(screen.getAllByRole('row')[3]!)).toMatch(/CBC|Complete blood count/);
    expect(text(screen.getAllByRole('row')[3]!)).toMatch(/NPR\s?150\.50/);
    expect(screen.getByText('Applies only when the order item is marked Urgent. The most specific rule wins: orderable, then department, then all tests.')).toBeTruthy();
  });

  it('empty: "No urgent surcharge rules. Urgent tests are charged at the normal price." (AC-14.4: no rule is not an error)', async () => {
    await show([]);
    expect(screen.getByText('No urgent surcharge rules. Urgent tests are charged at the normal price.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('read-only: no New rule / End rule', async () => {
    await show(RULES, READ);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new rule|end rule/i })).toBeNull();
  });

  it('flat rule: scope "All tests", amount 200.00 → amount {20000, NPR}; no percent_bp, no price_list_id; Idempotency-Key; effective_from ≈ now (UTC ISO)', async () => {
    await show([]);
    await press(/new rule/i);
    const d = dialog();
    await userEvent.click(within(d).getByRole('radio', { name: /all tests/i }));
    await userEvent.click(within(d).getByRole('radio', { name: /^flat$/i }));
    await userEvent.type(within(d).getByLabelText(/^amount/i), '200');
    await press(/^save$/i, d);
    await waitFor(() => expect(sent('POST', /surcharge-rules$/)).toHaveLength(1));
    const c = sent('POST', /surcharge-rules$/)[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body).toMatchObject({ scope: 'all', amount_kind: 'flat', amount: money(20000) });
    expect(c.body).not.toHaveProperty('percent_bp');
    expect(c.body).not.toHaveProperty('price_list_id');
    expect(Math.abs(Date.parse(c.body.effective_from) - Date.now())).toBeLessThan(5 * 60_000);
  });

  it('percent rule: scope Department + Hematology, 50 % → percent_bp 5000 (AC-14.1), no `amount`; optional price list sent when chosen', async () => {
    await show([]);
    await press(/new rule/i);
    const d = dialog();
    await userEvent.click(within(d).getByRole('radio', { name: /^department$/i }));
    await chooseDept(d, /Hematology/);
    await userEvent.click(within(d).getByRole('radio', { name: /^percent$/i }));
    await userEvent.type(percentField(d), '50');
    await choose(d, /price list/i, /HOSP_A|Synthetic General Hospital list/);
    await press(/^save$/i, d);
    await waitFor(() => expect(sent('POST', /surcharge-rules$/)).toHaveLength(1));
    const b = sent('POST', /surcharge-rules$/)[0]!.body;
    expect(b).toMatchObject({ scope: 'department', department_id: ID(1), amount_kind: 'percent', percent_bp: 5000, price_list_id: ID(61) });
    expect(b).not.toHaveProperty('amount');
  });

  it('percent outside 0.01–1000 % (and negative flat amounts) are rejected in the form: no request', async () => {
    await show([]);
    await press(/new rule/i);
    const d = dialog();
    await userEvent.click(within(d).getByRole('radio', { name: /all tests/i }));
    await userEvent.click(within(d).getByRole('radio', { name: /^percent$/i }));
    for (const bad of ['0', '0.005', '1000.01', '-5']) {
      const f = percentField(d);
      await userEvent.clear(f);
      await userEvent.type(f, bad);
      await press(/^save$/i, d);
    }
    expect(sent('POST', /surcharge-rules$/)).toHaveLength(0);
    expect(within(d).getAllByText(/0\.01|1000|between|invalid/i).length).toBeGreaterThan(0);
  });

  it('AC-14.5: overlapping window → 400 /effective_from shown as an overlap message in the dialog; dialog stays open', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/surcharge-rules`, async ({ request }) => { await rec(request); return prob(400, 'common.validation_failed', { errors: [{ path: '/effective_from', code: 'overlap', message: 'Overlaps an existing rule' }] }); }));
    await show([]);
    await press(/new rule/i);
    const d = dialog();
    await userEvent.click(within(d).getByRole('radio', { name: /all tests/i }));
    await userEvent.click(within(d).getByRole('radio', { name: /^percent$/i }));
    await userEvent.type(percentField(d), '10');
    await press(/^save$/i, d);
    expect(await within(dialog()).findByText(/overlap/i)).toBeTruthy();
    expect(text(dialog())).not.toMatch(/urn:lims|common\.validation_failed/);
  });

  it('End rule → POST /surcharge-rules/{id}/end with If-Match "<rule version>" and effective_to; double click = 1 request', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/surcharge-rules/:id/end`, async ({ request }) => { await rec(request); await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(rule(300, { version: 3 })); }));
    await show();
    await press(/end rule/i, screen.getAllByRole('row')[1]!);
    const d = dialog();
    await userEvent.dblClick(within(d).getByRole('button', { name: /^end rule$/i }));
    await new Promise((r) => setTimeout(r, 300));
    expect(sent('POST', /\/end$/)).toHaveLength(1);
    const c = sent('POST', /\/end$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/catalog/surcharge-rules/${ID(300)}/end`);
    expect(c.headers.get('if-match')).toBe('"2"');
    if (c.body && c.body.effective_to) expect(c.body.effective_to).toMatch(/Z$/);
  });

  it('axe: no violations', async () => { const a = await show(); await noAxeViolations(); a.unmount(); await show(RULES, READ); await noAxeViolations(); });
});

// ================================================================================================================ SCR-17
describe('SCR-17 TaxScreen (AC-15.2, AC-15.4, D-C3-04, 03-APP-FLOW §5)', () => {
  const trule = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), scope: 'tenant_default', vat_treatment: 'exempt', effective_from: '2026-10-01T12:00:00.000Z', version: 4, ...o });
  const RULES = [
    trule(400, { hs_code: '9018' }),
    trule(401, { scope: 'department', department_id: ID(1), vat_treatment: 'taxable', other_tax_code: 'CESS' }),
    trule(402, { scope: 'orderable', orderable_id: ID(101), vat_treatment: 'taxable' }),
  ];
  const ttype = (n: number, o: Record<string, unknown>) => ({ id: ID(n), effective_from: '2026-10-01T12:00:00.000Z', is_active: true, version: 2, ...o });
  const TYPES = [
    ttype(410, { code: 'VAT', display: 'Value added tax', rate_bp: 1300, scope: 'global', version: 1 }),
    ttype(411, { code: 'CESS', display: 'Synthetic cess', rate_bp: 200, scope: 'tenant' }),
    ttype(412, { code: 'HST', display: 'Synthetic HST', scope: 'tenant' }), // rate not entered → cannot be used in rules
  ];
  const show = async (rules: unknown[] = RULES, taxTypes: unknown[] = TYPES, permissions: string[] = MANAGE) => { const C = await load('TaxScreen'); return wrap(<C rules={rules as never} taxTypes={taxTypes as never} departments={DEPTS as never} orderables={ORDERABLES as never} permissions={permissions} />); };

  it('AC-15.4: info Banner with the full disclaimer is always visible — on the Rules tab, the Tax types tab, the empty state and read-only', async () => {
    const FULL = 'Tax treatment of lab services is pending confirmation by your auditor. Configure what your auditor confirms.';
    const a = await show();
    expect(screen.getByText(FULL)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /tax types/i }));
    expect(screen.getByText(FULL)).toBeTruthy();
    a.unmount();
    const b = await show([], [], MANAGE);
    expect(screen.getByText(FULL)).toBeTruthy();
    b.unmount();
    await show(RULES, TYPES, READ);
    expect(screen.getByText(FULL)).toBeTruthy();
  });

  it('empty rules: "No tax rules. Prices cannot be quoted until a tenant default rule exists." + error banner "Prices cannot be quoted until a lab default tax rule exists."', async () => {
    await show([]);
    expect(screen.getByText('No tax rules. Prices cannot be quoted until a tenant default rule exists.')).toBeTruthy();
    expect(screen.getByText('Prices cannot be quoted until a lab default tax rule exists.')).toBeTruthy();
  });

  it('with a lab-default rule the error banner is gone; with only a department rule it is shown (AC-15.3, D-C3-04: nothing is assumed)', async () => {
    const a = await show();
    expect(screen.queryByText('Prices cannot be quoted until a lab default tax rule exists.')).toBeNull();
    a.unmount();
    await show([RULES[1]]);
    expect(screen.getByText('Prices cannot be quoted until a lab default tax rule exists.')).toBeTruthy();
  });

  it('Rules table: Applies to (Lab default / Department / Orderable) · VAT (Exempt / Taxable 13 %) · Other tax · HS code · Effective from/to', async () => {
    await show();
    for (const h of ['Applies to', 'VAT', 'Other tax', 'HS code', 'Effective from', 'Effective to']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    const rows = screen.getAllByRole('row');
    expect(text(rows[1]!)).toMatch(/Lab default/);
    expect(text(rows[1]!)).toMatch(/Exempt/);
    expect(text(rows[1]!)).toMatch(/9018/);
    expect(text(rows[2]!)).toMatch(/Hematology/);
    expect(text(rows[2]!)).toMatch(/Taxable 13\s?%/);
    expect(text(rows[2]!)).toMatch(/CESS/);
    expect(text(rows[3]!)).toMatch(/CBC|Complete blood count/);
  });

  it('rule form: disclaimer next to the setting; VAT RadioGroup has NO pre-selection (D-C3-04); saving without a choice sends nothing', async () => {
    await show([]);
    await press(/new rule/i);
    const d = dialog();
    expect(within(d).getAllByText(DISCLAIMER).length).toBeGreaterThan(0);
    const radios = within(d).getAllByRole('radio', { name: /exempt|taxable/i }) as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.some((r) => r.checked)).toBe(false);
    await press(/^save$/i, d);
    expect(sent('POST', /tax-rules$/)).toHaveLength(0);
    expect((await within(dialog()).findAllByText(/required|choose|select/i)).length).toBeGreaterThan(0);
  });

  it('create the lab default rule: scope tenant_default, vat_treatment exempt, Idempotency-Key, effective_from ≈ now; optional hs_code omitted when empty', async () => {
    await show([]);
    await press(/new rule/i);
    const d = dialog();
    await choose(d, /applies to/i, /lab default/i);
    await userEvent.click(within(d).getByRole('radio', { name: /^exempt$/i }));
    await press(/^save$/i, d);
    await waitFor(() => expect(sent('POST', /tax-rules$/)).toHaveLength(1));
    const c = sent('POST', /tax-rules$/)[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body).toMatchObject({ scope: 'tenant_default', vat_treatment: 'exempt' });
    expect(c.body).not.toHaveProperty('hs_code');
    expect(c.body).not.toHaveProperty('other_tax_code');
    expect(Math.abs(Date.parse(c.body.effective_from) - Date.now())).toBeLessThan(5 * 60_000);
  });

  it('Other tax type Select lists only types that have a rate (CESS yes, HST no); HS code must be 4–8 digits and shows the "not confirmed" help', async () => {
    await show([]);
    await press(/new rule/i);
    const d = dialog();
    await userEvent.click(within(d).getByLabelText(/other tax/i));
    expect(await screen.findByRole('option', { name: /CESS/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /HST/ })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(within(dialog()).getByText('Optional. Applicability to lab services is not confirmed.')).toBeTruthy();
    await choose(dialog(), /applies to/i, /lab default/i);
    await userEvent.click(within(dialog()).getByRole('radio', { name: /^taxable/i }));
    await userEvent.type(within(dialog()).getByLabelText(/hs code/i), '123');
    await press(/^save$/i, dialog());
    expect(sent('POST', /tax-rules$/)).toHaveLength(0);
    await userEvent.type(within(dialog()).getByLabelText(/hs code/i), '4');
    await press(/^save$/i, dialog());
    await waitFor(() => expect(sent('POST', /tax-rules$/)).toHaveLength(1));
    expect(sent('POST', /tax-rules$/)[0]!.body).toMatchObject({ vat_treatment: 'taxable', hs_code: '1234' });
  });

  it('AC-15.2: 400 path /other_tax_code → "tax type has no rate" shown at the field', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tax-rules`, async ({ request }) => { await rec(request); return prob(400, 'common.validation_failed', { errors: [{ path: '/other_tax_code', code: 'tax_type_no_rate', message: 'tax type has no rate' }] }); }));
    await show([]);
    await press(/new rule/i);
    const d = dialog();
    await choose(d, /applies to/i, /lab default/i);
    await userEvent.click(within(d).getByRole('radio', { name: /^exempt$/i }));
    await press(/^save$/i, d);
    expect(await within(dialog()).findByText(/tax type has no rate/i)).toBeTruthy();
  });

  it('End rule → POST /tax-rules/{id}/end with If-Match "<version>"', async () => {
    await show();
    await press(/end rule/i, screen.getAllByRole('row')[2]!);
    await press(/^end rule$/i, dialog());
    await waitFor(() => expect(sent('POST', /tax-rules\/.*\/end$/)).toHaveLength(1));
    expect(sent('POST', /\/end$/)[0]!.headers.get('if-match')).toBe('"4"');
  });

  it('Tax types tab: Code · Name · Rate · Effective from/to · Scope (System/Lab); VAT is system, read-only, 13 %; unset rate says "Not configured — cannot be used in rules"', async () => {
    await show();
    await userEvent.click(screen.getByRole('tab', { name: /tax types/i }));
    for (const h of ['Code', 'Name', 'Rate', 'Effective from', 'Effective to', 'Scope']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    const vat = rowOf('VAT');
    expect(text(vat)).toMatch(/13(\.00)?\s?%/);
    expect(text(vat)).toMatch(/System/);
    expect(within(vat).queryByRole('button')).toBeNull();
    expect(text(rowOf('CESS'))).toMatch(/Lab/);
    expect(text(rowOf('CESS'))).toMatch(/2(\.00)?\s?%/);
    expect(text(rowOf('HST'))).toContain('Not configured — cannot be used in rules');
  });

  it('new lab tax type: code upper-cased (regex hint), name, rate 13.5 % → rate_bp 1350, disclaimer in the form; empty rate → rate_bp omitted', async () => {
    await show();
    await userEvent.click(screen.getByRole('tab', { name: /tax types/i }));
    await press(/new tax type/i);
    let d = dialog();
    expect(within(d).getAllByText(DISCLAIMER).length).toBeGreaterThan(0);
    await userEvent.type(within(d).getByLabelText(/^code/i), 'eco_fee');
    expect((within(d).getByLabelText(/^code/i) as HTMLInputElement).value).toBe('ECO_FEE');
    await userEvent.type(within(d).getByLabelText(/^name/i), 'Synthetic eco fee');
    await userEvent.type(within(d).getByLabelText(/^rate/i), '13.5');
    await press(/^save$/i, d);
    await waitFor(() => expect(sent('POST', /tax-types$/)).toHaveLength(1));
    expect(sent('POST', /tax-types$/)[0]!.body).toMatchObject({ code: 'ECO_FEE', display: 'Synthetic eco fee', rate_bp: 1350 });
    expect(sent('POST', /tax-types$/)[0]!.headers.get('idempotency-key')).toBeTruthy();
    cleanup();
    calls.length = 0;
    await show();
    await userEvent.click(screen.getByRole('tab', { name: /tax types/i }));
    await press(/new tax type/i);
    d = dialog();
    await userEvent.type(within(d).getByLabelText(/^code/i), 'norate');
    await userEvent.type(within(d).getByLabelText(/^name/i), 'No rate yet');
    await press(/^save$/i, d);
    await waitFor(() => expect(sent('POST', /tax-types$/)).toHaveLength(1));
    expect(sent('POST', /tax-types$/)[0]!.body).not.toHaveProperty('rate_bp');
  });

  it('rate outside 0–100 % or with > 2 decimals is rejected in the form', async () => {
    await show();
    await userEvent.click(screen.getByRole('tab', { name: /tax types/i }));
    await press(/new tax type/i);
    const d = dialog();
    await userEvent.type(within(d).getByLabelText(/^code/i), 'bad');
    await userEvent.type(within(d).getByLabelText(/^name/i), 'Bad');
    for (const bad of ['100.01', '-1', '1.005']) {
      const f = within(d).getByLabelText(/^rate/i);
      await userEvent.clear(f);
      await userEvent.type(f, bad);
      await press(/^save$/i, d);
    }
    expect(sent('POST', /tax-types$/)).toHaveLength(0);
  });

  it('changing the rate of an existing lab type asks for "Effective from" and PATCHes with If-Match + rate_bp + effective_from; the disclaimer is shown there too', async () => {
    await show();
    await userEvent.click(screen.getByRole('tab', { name: /tax types/i }));
    await press(/edit/i, rowOf('CESS'));
    const d = dialog();
    expect(within(d).getByRole('textbox', { name: /effective from/i })).toBeTruthy();
    expect(within(d).getAllByText(DISCLAIMER).length).toBeGreaterThan(0);
    const rate = within(d).getByLabelText(/^rate/i);
    await userEvent.clear(rate);
    await userEvent.type(rate, '3');
    await press(/^save$/i, d);
    await waitFor(() => expect(sent('PATCH', /tax-types\//)).toHaveLength(1));
    const c = sent('PATCH', /tax-types\//)[0]!;
    expect(c.url.pathname).toBe(`/v1/catalog/tax-types/${ID(411)}`);
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.body.rate_bp).toBe(300);
    expect(c.body.effective_from).toMatch(/Z$/);
    expect(c.body).not.toHaveProperty('code');
  });

  it('read-only: no New rule / New tax type / End rule / Edit', async () => {
    await show(RULES, TYPES, READ);
    expect(screen.queryByRole('button', { name: /new rule|end rule|edit/i })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: /tax types/i }));
    expect(screen.queryByRole('button', { name: /new tax type|edit/i })).toBeNull();
  });

  it('axe: no violations (rules, tax types, dialog)', async () => {
    await show();
    await noAxeViolations();
    await userEvent.click(screen.getByRole('tab', { name: /tax types/i }));
    await noAxeViolations();
    await userEvent.click(screen.getByRole('tab', { name: /^rules/i }));
    await press(/new rule/i);
    await noAxeViolations();
  });
});

// ================================================================================================================ cross-screen
describe('wording + safety guards across SCR-13…17', () => {
  it('no text node on any SCR-13…17 screen contains "commission" (AC-11.5 / S-17), and raw error codes / urn:lims never reach the DOM on a 500', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/surcharge-rules`, async ({ request }) => { await rec(request); return prob(500, 'common.internal'); }));
    const C = await load('SurchargeRulesScreen');
    wrap(<C rules={[]} departments={DEPTS as never} orderables={ORDERABLES as never} priceLists={LISTS as never} permissions={MANAGE} />);
    await press(/new rule/i);
    const d = dialog();
    await userEvent.click(within(d).getByRole('radio', { name: /all tests/i }));
    await userEvent.click(within(d).getByRole('radio', { name: /^percent$/i }));
    await userEvent.type(percentField(d), '10');
    await press(/^save$/i, d);
    await waitFor(() => expect(sent('POST', /surcharge-rules$/)).toHaveLength(1));
    expect(text()).not.toMatch(/commission/i);
    expect(text()).not.toMatch(/urn:lims|common\.internal|stack|<script/i);
  });

  it('XSS: a hostile price-list name / change reason is rendered as text, never as markup', async () => {
    const evil = '<img src=x onerror="window.__pwn=1">';
    const C = await load('PriceListDetail');
    wrap(<C priceList={{ ...DETAIL, name: evil, versions: [ver(71, 1, 'published', { change_reason: evil })] } as never} ownerLabels={OWNER_LABELS} permissions={READ} />);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect((window as any).__pwn).toBeUndefined();
    expect(text()).toContain(evil);
  });
});
