// @vitest-environment jsdom
// C9.T-22 — QC set-up › Materials tab `/quality/setup/materials` (04-UI-UX §2.6; 03-APP-FLOW §4; AC-01.1–01.4; 07-SECURITY: writes need quality.qc.manage; LD-140).
// ASSUMED contract (writer must follow): app/(staff)/quality/setup/materials/page.tsx = default async server component `Page({ searchParams })`.
//   Page = PageHeader (helpKey) + kit `Tabs` (tabs "Materials", "Maps", "Plans", "Targets"; changing tab router.push('/quality/setup/<id>')) + a DataTable (role grid, label /materials/i).
//   Reads: GET /v1/quality/control-materials (is_active default true; the "Show inactive" toggle asks is_active=false). No quality.qc_run.read -> EmptyState "You don't have access to this page", NO API call.
//   "New material" Dialog (only with quality.qc.manage), fields by label: Code, Name, Manufacturer, Matrix, and per level row: "Level code", "Level name", "Sort order"; buttons "Add level", "Remove level", "Create".
//   Clicking the material code opens a right Drawer (role dialog) with its levels + lots; each level has "Add lot" (Dialog: "Lot number", "Expires on" DatePicker DD/MM/YYYY, button "Save") and the drawer has "Deactivate material".
//   Writes are server actions -> serverFetch: POST …/control-materials {code,name,manufacturer?,matrix?,levels[]}; POST …/control-levels/{id}/lots {lot_no,expires_on}; POST …/control-materials/{id}/deactivate {} + If-Match "<version>";
//   every POST has an Idempotency-Key; empty optional fields are OMITTED (schema minLength 1). Success -> dialog closes, toast, router.refresh().
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import {
  BASE, LEVEL_1, MAT_1, PERM_SETUP_READ, PERM_SETUP_WRITE, anyDlg, api, axeClean, bodyOf, btn, calls, callsTo, dlg, field, fieldError, fill, json, lastNav, material, page, pageText, problem, resetApi, routes, router, show, showOrThrown, user, gridNamed, headersOf, rowTexts,
} from './quality-t22.harness';

vi.mock('next/navigation', async () => (await import('./quality-t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t22.harness')).sessionMock);

const PAGE = 'setup/materials/page';
const POST_MAT = `${BASE}/control-materials`;
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi(PERM_SETUP_WRITE));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function openNew() {
  await show(PAGE);
  await user().click(btn(/new material/i)!);
  return dlg();
}
async function fillMaterial(code = 'MCS-SYN', name = 'Synthetic multi-control') {
  await fill(/^code/i, code);
  await fill(/^name/i, name);
  const lc = screen.getAllByLabelText(/level code/i) as HTMLInputElement[];
  const ln = screen.getAllByLabelText(/level name/i) as HTMLInputElement[];
  const so = screen.getAllByLabelText(/sort order/i) as HTMLInputElement[];
  const u = user();
  for (const [i, n] of ln.entries()) { await u.clear(n); await u.type(n, `Level ${lc[i]!.value}`); }
  for (const [i, s] of so.entries()) { await u.clear(s); await u.type(s, String(i + 1)); }
}

describe('access and states', () => {
  it('without quality.qc_run.read: permission-denied state and NO API call', async () => {
    resetApi([]);
    await show(PAGE);
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('API 5xx rejects (error.tsx)', async () => {
    routes[`GET ${POST_MAT}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE)).toBeTruthy(); // a MISSING module rethrows, so this cannot pass vacuously
  });
  it('empty list -> "No control materials yet."', async () => {
    routes[`GET ${POST_MAT}`] = json(page([]));
    await show(PAGE);
    expect(pageText()).toContain('No control materials yet.');
  });
  it('header has the four tabs and Materials is selected; clicking Maps navigates to /quality/setup/maps', async () => {
    await show(PAGE);
    const tabs = screen.getAllByRole('tab').map((t) => (t.textContent ?? '').trim());
    expect(tabs.map((t) => t.replace(/\s*\d+$/, ''))).toEqual(['Materials', 'Maps', 'Plans', 'Targets']);
    expect(screen.getByRole('tab', { name: /materials/i }).getAttribute('aria-selected')).toBe('true');
    await user().click(screen.getByRole('tab', { name: /maps/i }));
    expect(lastNav()).toBe('/quality/setup/maps');
  });
});

describe('list (04-UI-UX §2.6 Materials tab)', () => {
  it('columns Code, Name, Manufacturer, Levels, Lots expiring, Active; rows show counts and words, not colour alone', async () => {
    await show(PAGE);
    const g = gridNamed(/materials/i);
    const h = headersOf(g).join(' | ');
    for (const c of [/code/i, /name/i, /manufacturer/i, /levels/i, /expiring/i, /active/i]) expect(h).toMatch(c);
    const t = rowTexts(g);
    expect(t[0]).toContain('MCS-SYN');
    expect(t[0]).toContain('Synthetic multi-control');
    expect(t[0]).toContain('Synthetic Diagnostics');
    expect(t[0]).toMatch(/\b2\b/); // two levels
  });
  it('the page render sends only GETs, and asks for active materials (is_active absent = API default true, or "true")', async () => {
    await show(PAGE);
    expect(callsTo('GET', POST_MAT)[0]!.url.searchParams.get('is_active') ?? 'true').toBe('true');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('?is_active=false in the URL is passed through; any other value is dropped (whitelist)', async () => {
    await show(PAGE, { searchParams: { is_active: 'false', evil: '1' } });
    const u = callsTo('GET', POST_MAT)[0]!.url;
    expect(u.searchParams.get('is_active')).toBe('false');
    expect(u.searchParams.has('evil')).toBe(false);
    cleanup();
    calls.length = 0;
    await show(PAGE, { searchParams: { is_active: "false' OR 1=1" } });
    expect(callsTo('GET', POST_MAT)[0]!.url.searchParams.get('is_active') ?? 'true').toBe('true');
  });
  it('lots_expiring_30d > 0 shows a warning badge with the count and a word (AC-01.2 support)', async () => {
    routes[`GET ${POST_MAT}`] = json(page([material({ lots_expiring_30d: 3 })]));
    await show(PAGE);
    expect(rowTexts(gridNamed(/materials/i))[0]).toMatch(/3/);
    expect(pageText()).toMatch(/expiring/i);
  });
  it('deactivated material stays listed/readable with an "Inactive" word (AC-01.4)', async () => {
    routes[`GET ${POST_MAT}`] = json(page([material({ is_active: false })]));
    await show(PAGE);
    expect(rowTexts(gridNamed(/materials/i))[0]).toMatch(/inactive/i);
  });
  it('axe clean', async () => { await show(PAGE); await axeClean(); });
});

describe('permission: writes need quality.qc.manage (AC-01.3)', () => {
  it('read-only session (lab_technologist): no New material / Add lot / Deactivate controls', async () => {
    resetApi(PERM_SETUP_READ);
    await show(PAGE);
    expect(btn(/new material/i)).toBeNull();
    await user().click(within(gridNamed(/materials/i)).getByText('MCS-SYN'));
    expect(btn(/add lot|add level|deactivate/i)).toBeNull();
    expect(callsTo('POST', POST_MAT)).toHaveLength(0);
  });
  it('server answers 403 auth.forbidden -> the dialog stays open and says the user lacks permission; nothing is closed or refreshed', async () => {
    routes[`POST ${POST_MAT}`] = () => problem('auth.forbidden', 403);
    await openNew();
    await fillMaterial();
    await user().click(within(dlg()).getByRole('button', { name: /^create/i }));
    await waitFor(() => expect(callsTo('POST', POST_MAT)).toHaveLength(1));
    expect(anyDlg()).not.toBeNull();
    expect(pageText()).toMatch(/permission|not allowed|forbidden/i);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('create material (#2, AC-01.1)', () => {
  it('dialog opens on the first field with level rows "1" and "2" pre-filled', async () => {
    await openNew();
    expect(document.activeElement).toBe(field(/^code/i));
    expect((screen.getAllByLabelText(/level code/i) as HTMLInputElement[]).map((e) => e.value)).toEqual(['1', '2']);
  });
  it('Code is upper-cased as typed and capped at 32; Name 120; Manufacturer 120; Matrix 60; level code 16, level name 60 (maxLength)', async () => {
    await openNew();
    await fill(/^code/i, 'mcs-syn');
    expect(field(/^code/i).value).toBe('MCS-SYN');
    expect(field(/^code/i).maxLength).toBe(32);
    expect(field(/^name/i).maxLength).toBe(120);
    expect(field(/manufacturer/i).maxLength).toBe(120);
    expect(field(/matrix/i).maxLength).toBe(60);
    expect((screen.getAllByLabelText(/level code/i)[0] as HTMLInputElement).maxLength).toBe(16);
    expect((screen.getAllByLabelText(/level name/i)[0] as HTMLInputElement).maxLength).toBe(60);
  });
  it('POSTs the spec body: code, name, levels[{level_code,display_name,sort_order}]; empty manufacturer/matrix are omitted; Idempotency-Key set; then closes, toasts, refreshes', async () => {
    routes[`POST ${POST_MAT}`] = json(material({ code: 'MCS-SYN' }), 201);
    await openNew();
    await fillMaterial();
    await user().click(within(dlg()).getByRole('button', { name: /^create/i }));
    await waitFor(() => expect(callsTo('POST', POST_MAT)).toHaveLength(1));
    const c = callsTo('POST', POST_MAT)[0]!;
    expect(bodyOf(c)).toEqual({
      code: 'MCS-SYN', name: 'Synthetic multi-control',
      levels: [{ level_code: '1', display_name: 'Level 1', sort_order: 1 }, { level_code: '2', display_name: 'Level 2', sort_order: 2 }],
    });
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    expect(c.headers.get('authorization')).toMatch(/^Bearer /);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(anyDlg()).toBeNull();
  });
  it('manufacturer and matrix are sent when filled', async () => {
    routes[`POST ${POST_MAT}`] = json(material(), 201);
    await openNew();
    await fillMaterial();
    await fill(/manufacturer/i, 'Synthetic Diagnostics');
    await fill(/matrix/i, 'serum');
    await user().click(within(dlg()).getByRole('button', { name: /^create/i }));
    await waitFor(() => expect(callsTo('POST', POST_MAT)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', POST_MAT)[0])).toMatchObject({ manufacturer: 'Synthetic Diagnostics', matrix: 'serum' });
  });
  it.each(['A', 'bad code', 'ÄÖ-1', 'a/b'])('invalid Code %j is refused in the form (^[A-Z0-9_-]{2,32}$): field flagged, NO request', async (bad) => {
    await openNew();
    await fillMaterial('MCS-SYN');
    // LD-183 / ruling: the 32-char cap is native maxLength (04-UI-UX.md:98); an over-length paste is truncated to a valid code, so the cap is asserted by attribute.
    const code = field(/^code/i);
    expect(code.maxLength).toBe(32);
    const u = user();
    await u.clear(code);
    await u.click(code);
    await u.paste(bad);
    await user().click(within(dlg()).getByRole('button', { name: /^create/i }));
    expect(fieldError(field(/^code/i))).toBe(true);
    expect(callsTo('POST', POST_MAT)).toHaveLength(0);
  });
  it('empty Name is refused; whitespace-only Name is refused', async () => {
    await openNew();
    await fillMaterial('MCS-SYN', '   ');
    await user().click(within(dlg()).getByRole('button', { name: /^create/i }));
    expect(fieldError(field(/^name/i))).toBe(true);
    expect(callsTo('POST', POST_MAT)).toHaveLength(0);
  });
  it('level rules: duplicate level codes refused; code pattern ^[A-Za-z0-9]{1,16}$; sort order 0–99; 1–6 rows', async () => {
    await openNew();
    await fillMaterial();
    const u = user();
    const codes = () => screen.getAllByLabelText(/level code/i) as HTMLInputElement[];
    await u.clear(codes()[1]!); await u.type(codes()[1]!, '1'); // duplicate of row 1
    await u.click(within(dlg()).getByRole('button', { name: /^create/i }));
    expect(callsTo('POST', POST_MAT)).toHaveLength(0);
    expect(fieldError(codes()[1]!) || fieldError(codes()[0]!)).toBe(true);
    await u.clear(codes()[1]!); await u.type(codes()[1]!, 'L-2'); // hyphen not allowed
    await u.click(within(dlg()).getByRole('button', { name: /^create/i }));
    expect(callsTo('POST', POST_MAT)).toHaveLength(0);
    await u.clear(codes()[1]!); await u.type(codes()[1]!, '2');
    const sort = screen.getAllByLabelText(/sort order/i)[0] as HTMLInputElement;
    await u.clear(sort); await u.type(sort, '100');
    await u.click(within(dlg()).getByRole('button', { name: /^create/i }));
    expect(callsTo('POST', POST_MAT)).toHaveLength(0);
  });
  it('rows are limited to 1–6: "Add level" stops at 6, the last row cannot be removed', async () => {
    await openNew();
    const u = user();
    while (btn(/add level/i, dlg()) && !(btn(/add level/i, dlg()) as HTMLButtonElement).disabled && screen.getAllByLabelText(/level code/i).length < 8) await u.click(btn(/add level/i, dlg())!);
    expect(screen.getAllByLabelText(/level code/i)).toHaveLength(6);
    while (screen.getAllByLabelText(/level code/i).length > 1) {
      const rm = within(dlg()).getAllByRole('button', { name: /remove level/i }).find((b) => !(b as HTMLButtonElement).disabled);
      if (!rm) break;
      await u.click(rm);
    }
    expect(screen.getAllByLabelText(/level code/i)).toHaveLength(1);
    expect(within(dlg()).queryAllByRole('button', { name: /remove level/i }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
  it('409 quality.code_duplicate -> field error "This code is already used." on Code; dialog stays open (AC-01.1)', async () => {
    routes[`POST ${POST_MAT}`] = () => problem('quality.code_duplicate', 409);
    await openNew();
    await fillMaterial();
    await user().click(within(dlg()).getByRole('button', { name: /^create/i }));
    await waitFor(() => expect(within(dlg()).getByText('This code is already used.')).toBeTruthy());
    expect(fieldError(field(/^code/i))).toBe(true);
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('400 common.validation_failed with /code pointer -> error shown on the Code field (field errors come from problem+json)', async () => {
    routes[`POST ${POST_MAT}`] = () => problem('common.validation_failed', 400, { errors: [{ pointer: '/code', code: 'common.invalid_format', message: 'Code format is invalid.' }] });
    await openNew();
    await fillMaterial();
    await user().click(within(dlg()).getByRole('button', { name: /^create/i }));
    await waitFor(() => expect(fieldError(field(/^code/i))).toBe(true));
  });
  it('Ctrl+Enter submits and Esc closes the dialog (kit defaults, 04-UI-UX §1)', async () => {
    routes[`POST ${POST_MAT}`] = json(material(), 201);
    await openNew();
    await fillMaterial();
    const u = user();
    await u.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(callsTo('POST', POST_MAT)).toHaveLength(1));
  });
  it('Esc closes the dialog without sending anything', async () => {
    await openNew();
    await user().keyboard('{Escape}');
    await waitFor(() => expect(anyDlg()).toBeNull());
    expect(callsTo('POST', POST_MAT)).toHaveLength(0);
  });
  it('a double click on Create sends ONE request (no duplicate material)', async () => {
    routes[`POST ${POST_MAT}`] = async () => { await new Promise((r) => setTimeout(r, 50)); return HttpResponse.json(material(), { status: 201 }); };
    await openNew();
    await fillMaterial();
    const b = within(dlg()).getByRole('button', { name: /^create/i });
    const u = user();
    await u.dblClick(b);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(callsTo('POST', POST_MAT)).toHaveLength(1);
  });
});

describe('drawer: levels and lots, add lot (#8, AC-01.2), deactivate (#5, AC-01.4)', () => {
  const LOTS = `${BASE}/control-levels/${LEVEL_1}/lots`;
  async function openDrawer() {
    await show(PAGE);
    await user().click(within(gridNamed(/materials/i)).getByText('MCS-SYN'));
    return dlg();
  }
  async function openLot() {
    await openDrawer();
    await user().click(within(dlg()).getAllByRole('button', { name: /add lot/i })[0]!);
    return screen.getAllByRole('dialog').at(-1)!;
  }
  it('lists every level with its lots and expiry dates (DD/MM/YYYY), expired lots flagged with the word "Expired"', async () => {
    routes[`GET ${POST_MAT}`] = json(page([material({ levels: [{ ...material().levels[0], lots: [{ ...material().levels[0]!.lots![0], is_expired: true }] }, material().levels[1]!] })]));
    await openDrawer();
    const t = pageText();
    expect(t).toContain('LOT-SYN-01');
    expect(t).toContain('LOT-SYN-02');
    expect(t).toContain('31/03/2027');
    expect(t).toMatch(/expired/i);
  });
  it('opening the drawer sends no write request', async () => {
    await openDrawer();
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
  it('Add lot: POSTs {lot_no, expires_on:"2027-03-31"} to the level; Idempotency-Key set; refresh', async () => {
    routes[`POST ${LOTS}`] = json({ id: 'x', version: 1, level_id: LEVEL_1, material_id: MAT_1, lot_no: 'LOT-SYN-03', expires_on: '2027-03-31', is_expired: false, is_active: true }, 201);
    const d = await openLot();
    await fill(/lot number/i, 'LOT-SYN-03', d);
    await fillExpires('31/03/2027', d);
    await user().click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('POST', LOTS)).toHaveLength(1));
    const c = callsTo('POST', LOTS)[0]!;
    expect(bodyOf(c)).toEqual({ lot_no: 'LOT-SYN-03', expires_on: '2027-03-31' });
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it.each([[' LOT-1'], ['LOT-1 '], ['LOTé'], ['LOT\t1']])('lot number %j is refused with the spec message; NO request (printable ASCII, no leading/trailing space)', async (bad) => {
    const d = await openLot();
    await fill(/lot number/i, bad, d);
    await fillExpires('31/03/2027', d);
    await user().click(within(d).getByRole('button', { name: /^save/i }));
    expect(within(d).getByText('Use printable characters without spaces at the start or end.')).toBeTruthy();
    expect(callsTo('POST', LOTS)).toHaveLength(0);
  });
  it('lot number is capped at 64 characters; an interior space is allowed ("LOT A 1")', async () => {
    routes[`POST ${LOTS}`] = json(lotOk(), 201);
    const d = await openLot();
    expect(field(/lot number/i, d).maxLength).toBe(64);
    await fill(/lot number/i, 'LOT A 1', d);
    await fillExpires('31/03/2027', d);
    await user().click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('POST', LOTS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', LOTS)[0]).lot_no).toBe('LOT A 1');
  });
  it('an expiry date in the past is refused in the form (min today); NO request (AC-01.2)', async () => {
    const d = await openLot();
    await fill(/lot number/i, 'LOT-SYN-03', d);
    await fillExpires('01/01/2020', d);
    await user().click(within(d).getByRole('button', { name: /^save/i }));
    expect(callsTo('POST', LOTS)).toHaveLength(0);
    expect(within(d).getByText(/expiry date is in the past|on or after today/i)).toBeTruthy();
  });
  it('missing expiry date is refused', async () => {
    const d = await openLot();
    await fill(/lot number/i, 'LOT-SYN-03', d);
    await user().click(within(d).getByRole('button', { name: /^save/i }));
    expect(callsTo('POST', LOTS)).toHaveLength(0);
  });
  it('422 quality.lot_expired -> "Expiry date is in the past." on the date field (server is the authority on tenant-timezone today)', async () => {
    routes[`POST ${LOTS}`] = () => problem('quality.lot_expired', 422);
    const d = await openLot();
    await fill(/lot number/i, 'LOT-SYN-03', d);
    await fillExpires('31/03/2027', d);
    await user().click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(within(d).getByText('Expiry date is in the past.')).toBeTruthy());
  });
  it('409 quality.code_duplicate on a lot -> "This code is already used." on Lot number', async () => {
    routes[`POST ${LOTS}`] = () => problem('quality.code_duplicate', 409);
    const d = await openLot();
    await fill(/lot number/i, 'LOT-SYN-01', d);
    await fillExpires('31/03/2027', d);
    await user().click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(within(d).getByText('This code is already used.')).toBeTruthy());
  });
  it('Deactivate material: ConfirmDialog, then POST …/deactivate {} with If-Match "<version>" (3) and Idempotency-Key; the row stays readable (AC-01.4)', async () => {
    routes[`POST ${POST_MAT}/${MAT_1}/deactivate`] = json(material({ is_active: false, version: 4 }));
    await openDrawer();
    const u = user();
    await u.click(within(dlg()).getByRole('button', { name: /deactivate material/i }));
    const confirm = screen.getAllByRole('dialog').at(-1) ?? dlg(); // LD-183: kit ConfirmDialog is role=dialog, opened last (04-UI-UX.md:71,:73)
    await u.click(within(confirm).getByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(callsTo('POST', `${POST_MAT}/${MAT_1}/deactivate`)).toHaveLength(1));
    const c = callsTo('POST', `${POST_MAT}/${MAT_1}/deactivate`)[0]!;
    expect(bodyOf(c)).toEqual({});
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('a stale If-Match (412 common.version_conflict) is explained, not silently swallowed', async () => {
    routes[`POST ${POST_MAT}/${MAT_1}/deactivate`] = () => problem('common.version_conflict', 412);
    await openDrawer();
    const u = user();
    await u.click(within(dlg()).getByRole('button', { name: /deactivate material/i }));
    await u.click(within(screen.getAllByRole('dialog').at(-1) ?? dlg()).getByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(pageText()).toMatch(/changed by someone else|reload|out of date|newer version/i));
  });
});

// LD-183: kit DatePicker adds a calendar button "Open calendar for Expires on" (DateFieldBase.tsx:120), so pick the textbox by role+name.
async function fillExpires(text: string, root: HTMLElement) {
  const el = within(root).getByRole('textbox', { name: /^expires on/i });
  const u = user();
  await u.clear(el);
  await u.type(el, text);
}

function lotOk() { return { id: 'x', version: 1, level_id: LEVEL_1, material_id: MAT_1, lot_no: 'LOT A 1', expires_on: '2027-03-31', is_expired: false, is_active: true }; }
