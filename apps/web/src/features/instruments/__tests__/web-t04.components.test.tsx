// @vitest-environment jsdom
// WEB-T04 — SCR-08 Mappings `/instruments/instruments/{instrument_id}/mappings` (04-UI-UX §3 SCR-08, 03-APP-FLOW F-14; data owned by C3 — X4).
// ACs: AC-17.1 (lists C3 maps + observed codes with mapping status), AC-17.2 (create via C3, C3 errors on the form, step-up banner),
//      AC-17.4 / 08 A13 D-39 (without catalog.instrument_code_map.manage: observed panel only, text, NO C3 call), AC-17.3 UI side (status comes from E32; page refreshes after a save).
//      done_when: create / edit / deactivate / copy; step-up on auth.mfa_required.
// Component tests + MSW (server actions run for real against MSW; the session mock supplies the permissions) + axe. Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + copy + kit components only; dispute to rename):
//   components/InstrumentMappings.tsx   export InstrumentMappings({instrument, observed, maps?, tests?, instruments?, permissions})
//        observed: ObservedCode[] (E32, all statuses; the "Unmapped only" Switch, default ON, filters client-side)
//        maps: InstrumentCodeMap[] — passed ONLY when the user holds catalog.instrument_code_map.manage
//        tests: Record<test_id, {id, code, name, analytes: {id, code, name}[]}> (page resolves via C3 getTestDetail #25, once per distinct test_id)
//        instruments: InstrumentSummary[] (E23, for "Copy from instrument…"; manage only)   permissions: readonly string[]
//   app/(staff)/instruments/instruments/[instrument_id]/mappings/page.tsx   default async Page({params: Promise<{instrument_id}>}) → element with props above
//   Editor = Drawer (role dialog). Fields (labels = 04-UI-UX): "Direction" radios Inbound/Outbound/Both, "Instrument code", "Test" (Combobox → searchOrderables kind=test),
//   "Analyte" (Select from the chosen test's analytes), "Unit from (instrument)", "Unit to" (Select ← listUnits), "Factor"; button "Save".
//   Header actions "Add mapping", "Copy from instrument…"; observed row action "Map…"; map row actions "Edit", "Deactivate" (a confirm step is allowed: tests click a Deactivate/Confirm button if a dialog appears).
//   Copy dialog: Select "Source instrument" → button "Copy"; outcome table shows per-row instrument code + outcome (+ error_code).
//   bulk-upsert row result shape ASSUMED: {direction, instrument_code, outcome: created|updated|unchanged|error, error_code?}.
// NOT tested (spec silent): flag-map editor interactions (KeyValueListEditor), reactivation row action, the list-time (not save-time) mfa_required, copy with 0 source maps, sorting/paging of the tables.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/instruments/instruments/x/mappings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/instruments/x/mappings',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const MAN = 'catalog.instrument_code_map.manage';
const READ = ['instruments.instrument.read'];
const MANAGE = ['instruments.instrument.read', MAN];
session.permissions = MANAGE;

const INST = '01a1a98a-ac40-7000-8000-0000000e0001';
const INST2 = '01a1a98a-ac40-7000-8000-0000000e0002';
const T_HGB = '01a1a98a-ac40-7000-8000-0000000b0001';
const T_WBC = '01a1a98a-ac40-7000-8000-0000000b0003';
const A_HGB = '01a1a98a-ac40-7000-8000-0000000b0002';
const A_HCT = '01a1a98a-ac40-7000-8000-0000000b0004';
const A_WBC = '01a1a98a-ac40-7000-8000-0000000b0005';
const M1 = '01a1a98a-ac40-7000-8000-0000000a0001';
const M2 = '01a1a98a-ac40-7000-8000-0000000a0002';
const M3 = '01a1a98a-ac40-7000-8000-0000000a0003';
const MAPS = `${ORIGIN}/v1/catalog/instrument-code-maps`;
const IM = `${ORIGIN}/v1/instruments/instruments`;

const instrument = { id: INST, instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', state: 'live', version: 4, protocol: 'astm', centre_id: '01a1a98a-ac40-7000-8000-0000000c0001', agent_id: '01a1a98a-ac40-7000-8000-0000000d0101', driver_code: 'astm_generic_e1394', driver_status: 'generic', link_state: 'up', unmapped_code_count: 2, vendor: 'Synthetic Vendor', model: 'SV-100' };
const other = { ...instrument, id: INST2, instrument_code: 'SIM-CHEM-2', display_name: 'Verified chem' };
const oc = (o: Record<string, unknown> = {}) => ({ instrument_id: INST, record_class: 'patient', instrument_analyte_code: 'HGB', first_seen_at: '2026-11-01T03:00:00.000Z', last_seen_at: '2026-11-07T03:58:00.000Z', seen_count: 42, last_mapping_status: 'unmapped', last_mapping_checked_at: '2026-11-07T04:00:00.000Z', ...o });
const OBSERVED = [
  oc(),
  oc({ instrument_analyte_code: 'QC1', record_class: 'qc', seen_count: 7 }),
  oc({ instrument_analyte_code: 'WBC', last_mapping_status: 'mapped', last_analyte_id: A_WBC, seen_count: 40 }),
  oc({ instrument_analyte_code: 'CAL9', record_class: 'calibrator', last_mapping_status: 'mapped', last_analyte_id: A_HGB, seen_count: 3 }),
];
const cm = (o: Record<string, unknown> = {}) => ({ id: M1, instrument_id: INST, direction: 'both', instrument_code: 'WBC', analyte_id: A_WBC, test_id: T_WBC, unit_from_raw: 'g/L', unit_to_code: 'g/dL', unit_factor: '0.1', flag_map: JSON.stringify({ H: 'HIGH', L: 'LOW' }), is_active: true, version: 5, ...o });
const MAPROWS = [
  cm(),
  cm({ id: M2, instrument_code: 'GLU', analyte_id: A_HCT, test_id: T_HGB, direction: 'inbound', unit_from_raw: undefined, unit_to_code: undefined, unit_factor: undefined, flag_map: undefined, version: 2 }),
  cm({ id: M3, instrument_code: 'OLD', direction: 'outbound', is_active: false, flag_map: undefined, unit_from_raw: undefined, unit_to_code: undefined, unit_factor: undefined, version: 8 }),
];
const TESTS = {
  [T_HGB]: { id: T_HGB, code: 'HGBT', name: 'Hemoglobin panel test', analytes: [{ id: A_HGB, code: 'HGB', name: 'Haemoglobin conc' }, { id: A_HCT, code: 'HCT', name: 'Haematocrit frac' }] },
  [T_WBC]: { id: T_WBC, code: 'WBCT', name: 'White cell count test', analytes: [{ id: A_WBC, code: 'WBC', name: 'White cells' }] },
};
const UNITS = [{ code: 'g/dL', display: 'g/dL', scope: 'global', is_active: true }, { code: 'g/L', display: 'g/L', scope: 'global', is_active: true }, { code: 'mmol/L', display: 'mmol/L', scope: 'global', is_active: true }];

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });
const sent = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url.pathname));
const creates = () => sent('POST', /\/instrument-code-maps$/);
const patches = () => sent('PATCH', /\/instrument-code-maps\/[^/]+$/);
const bulks = () => sent('POST', /\/bulk-upsert$/);
const c3Calls = () => calls.filter((c) => c.url.pathname.startsWith('/v1/catalog/instrument-code-maps'));
const api = setupServer(
  http.get(`${ORIGIN}/v1/catalog/orderables`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ id: T_HGB, kind: 'test', code: 'HGBT', name: 'Hemoglobin panel test', is_orderable: true, is_active: true, revision: 1 }, { id: T_WBC, kind: 'test', code: 'WBCT', name: 'White cell count test', is_orderable: true, is_active: true, revision: 1 }] }); }),
  http.get(`${ORIGIN}/v1/catalog/tests/:id`, async ({ request, params }) => { await rec(request); const t = (TESTS as any)[String(params.id)]; return t ? HttpResponse.json(t) : problem(404, 'common.not_found'); }),
  http.get(`${ORIGIN}/v1/catalog/units`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: UNITS }); }),
  http.get(MAPS, async ({ request }) => { await rec(request); return HttpResponse.json({ data: MAPROWS, page: { limit: 50 } }); }),
  http.post(MAPS, async ({ request }) => { await rec(request); return HttpResponse.json(cm({ id: M3, version: 1 }), { status: 201 }); }),
  http.patch(`${MAPS}/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(cm({ version: 6 })); }),
  http.post(`${MAPS}/bulk-upsert`, async ({ request }) => { await rec(request); const b = await request.clone().json(); return HttpResponse.json({ results: b.maps.map((m: any) => ({ direction: m.direction, instrument_code: m.instrument_code, outcome: 'created' })) }); }),
  http.get(IM, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [instrument, other], page: { limit: 50 } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); session.permissions = MANAGE; });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const text = (root: HTMLElement = document.body) => root.textContent ?? '';
const bodyHas = (s: string | RegExp) => (typeof s === 'string' ? text().includes(s) : s.test(text()));
const rowOf = (re: RegExp) => screen.getByRole('row', { name: re });
const btn = (root: HTMLElement, re: RegExp) => within(root).getByRole('button', { name: re });
const MFA = 'Confirm with your authenticator to continue';
const DUP = 'This code is already mapped for this instrument.';
const EMPTY_OBS = 'No codes seen yet. Codes appear here after the instrument sends results in commissioning.';
const NO_MANAGE = 'Mappings are visible to users who can manage them';

const load = async () => (await import('../components/InstrumentMappings')).InstrumentMappings;
const show = async (props: Record<string, unknown> = {}) => {
  const C = await load();
  const perms = (props.permissions as string[] | undefined) ?? MANAGE;
  return wrap(<C instrument={instrument as never} observed={OBSERVED as never} {...(perms.includes(MAN) ? { maps: MAPROWS, tests: TESTS, instruments: [instrument, other] } : {})} permissions={perms} {...(props as object)} />);
};
const dialog = () => screen.getByRole('dialog');
const field = (re: RegExp) => within(dialog()).getByLabelText(re) as HTMLInputElement;
const locked = (el: HTMLElement) => (el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly || el.getAttribute('aria-readonly') === 'true' || el.getAttribute('aria-disabled') === 'true';
const choose = async (label: RegExp, option: string | RegExp) => { await userEvent.click(within(dialog()).getByRole('button', { name: label })); await userEvent.click(await screen.findByRole('option', { name: option })); };
const pickTest = async (query: string, option: string | RegExp) => { await userEvent.type(within(dialog()).getByRole('combobox', { name: /^test/i }), query); await userEvent.click(await screen.findByRole('option', { name: option })); };
const saveBtn = () => within(dialog()).getByRole('button', { name: /^save$/i });
const save = () => userEvent.click(saveBtn());
/** Opens the editor from the observed "Map…" action on HGB and fills the mandatory fields. */
const openMapHgb = async () => { await userEvent.click(btn(rowOf(/\bHGB\b/), /^map/i)); await screen.findByRole('dialog'); };
const fillRequired = async () => { await pickTest('hemo', /Hemoglobin panel test/); await choose(/analyte/i, /Haemoglobin conc/); };

// ================================================================================================================ AC-17.1
describe('AC-17.1 — manager sees observed codes and C3 maps', () => {
  it('Observed codes panel: Code · Class · Seen count · Last seen · Mapping status as TEXT; default filter "Unmapped only" hides mapped codes', async () => {
    await show();
    const hgb = rowOf(/\bHGB\b/);
    expect(text(hgb)).toMatch(/Patient/);
    expect(text(hgb)).toMatch(/42/);
    expect(text(hgb)).toMatch(/Unmapped/);
    expect(text(rowOf(/\bQC1\b/))).toMatch(/\bQC\b/);
    expect(screen.queryByRole('row', { name: /\bCAL9\b/ })).toBeNull();
    // the observed table is separate from the maps table: WBC is a MAP (instrument code) but its observed row is "Mapped" → hidden by the default filter
    const sw = screen.getByRole('switch', { name: /unmapped only/i }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
  });

  it('turning "Unmapped only" off shows mapped codes with the text "Mapped" and Class "Calibrator"', async () => {
    await show();
    await userEvent.click(screen.getByRole('switch', { name: /unmapped only/i }));
    expect(text(rowOf(/\bCAL9\b/))).toMatch(/Calibrator/);
    expect(text(rowOf(/\bCAL9\b/))).toMatch(/(^|[^n])Mapped/);
    expect(text(rowOf(/\bCAL9\b/))).not.toMatch(/Unmapped/);
  });

  it('AC-17.3 (UI side): the status shown is E32 last_mapping_status — the component does not recompute it from the loaded maps', async () => {
    // GLU is in the C3 maps list but E32 still says unmapped (refresh task not run yet) → shown as Unmapped
    await show({ observed: [oc({ instrument_analyte_code: 'GLU' })] });
    // scoped to the Observed codes table: the Mappings table also has a GLU row (04-UI-UX.md:148 "Instrument code")
    const observedTable = screen.getByRole('table', { name: /observed codes/i });
    expect(text(within(observedTable).getByRole('row', { name: /\bGLU\b/ }))).toMatch(/Unmapped/);
  });

  it('empty observed list → the verbatim empty state', async () => {
    await show({ observed: [] });
    expect(bodyHas(EMPTY_OBS)).toBe(true);
  });

  it('Mappings panel: Direction · Instrument code · Test · Analyte · Unit conversion · Flag map count · Active; test/analyte names come from the resolved tests', async () => {
    await show();
    const wbc = rowOf(/\bWBC\b/);
    expect(text(wbc)).toMatch(/Both/i);
    expect(text(wbc)).toMatch(/White cell count test/);
    expect(text(wbc)).toMatch(/White cells/);
    expect(text(wbc)).toContain('g/L → g/dL × 0.1');
    expect(text(wbc)).toMatch(/\b2\b/); // flag map count
    expect(text(wbc)).toMatch(/Yes|Active/);
    const glu = rowOf(/\bGLU\b/);
    expect(text(glu)).toMatch(/Inbound/i);
    expect(text(glu)).toMatch(/Hemoglobin panel test/);
    expect(text(glu)).toMatch(/Haematocrit frac/);
    expect(text(glu)).not.toContain('→'); // no unit conversion
    expect(text(rowOf(/\bOLD\b/))).toMatch(/Outbound/i);
  });

  it('inactive maps are marked as text (not colour only); active rows offer Edit and Deactivate, inactive rows no Deactivate', async () => {
    await show();
    expect(text(rowOf(/\bOLD\b/))).toMatch(/Inactive|No/);
    expect(within(rowOf(/\bOLD\b/)).queryByRole('button', { name: /^deactivate/i })).toBeNull();
    expect(btn(rowOf(/\bWBC\b/), /^edit/i)).toBeTruthy();
    expect(btn(rowOf(/\bWBC\b/), /^deactivate/i)).toBeTruthy();
  });

  it('header actions "Add mapping" and "Copy from instrument…" are present with manage', async () => {
    await show();
    expect(screen.getByRole('button', { name: /^add mapping/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^copy from instrument/i })).toBeTruthy();
  });

  it('rendering alone makes no request (data arrives through props from the page)', async () => {
    await show();
    expect(calls).toHaveLength(0);
  });
});

// ================================================================================================================ AC-17.4 / D-39
describe('AC-17.4 / D-39 — without catalog.instrument_code_map.manage', () => {
  const readOnly = () => show({ permissions: READ });

  it('shows the observed panel (read-only) and the text "Mappings are visible to users who can manage them."; no Mappings panel', async () => {
    await readOnly();
    expect(bodyHas(NO_MANAGE)).toBe(true);
    expect(text(rowOf(/\bHGB\b/))).toMatch(/Unmapped/);
    expect(screen.queryByRole('button', { name: /add mapping/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /copy from instrument/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(edit|deactivate)/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^map/i })).toBeNull(); // observed row action "Map…" only with manage
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the observed codes remain usable read-only (filter switch works) and NOTHING is requested while interacting', async () => {
    await readOnly();
    await userEvent.click(screen.getByRole('switch', { name: /unmapped only/i }));
    expect(text(rowOf(/\bWBC\b/))).toMatch(/(^|[^n])Mapped/);
    expect(calls).toHaveLength(0);
    expect(c3Calls()).toHaveLength(0);
  });

  it('SECURITY: even if a caller wrongly passes C3 maps, a non-manager never sees them', async () => {
    await readOnly().then(() => cleanup());
    const C = await load();
    wrap(<C instrument={instrument as never} observed={OBSERVED as never} maps={MAPROWS as never} tests={TESTS as never} permissions={READ} />);
    expect(bodyHas(NO_MANAGE)).toBe(true);
    expect(screen.queryByRole('row', { name: /\bGLU\b/ })).toBeNull();
    expect(bodyHas('g/L → g/dL')).toBe(false);
  });

  it('having catalog.test.manage / instruments.instrument.manage is NOT enough — only catalog.instrument_code_map.manage unlocks the panel', async () => {
    await show({ permissions: ['instruments.instrument.read', 'instruments.instrument.manage', 'catalog.test.manage', 'catalog.price_list.manage'] });
    expect(bodyHas(NO_MANAGE)).toBe(true);
    expect(screen.queryByRole('button', { name: /add mapping/i })).toBeNull();
  });

  it('with manage the explanatory text is NOT shown', async () => {
    await show();
    expect(bodyHas(NO_MANAGE)).toBe(false);
  });
});

// ================================================================================================================ AC-17.2 create
describe('AC-17.2 — create a map (Map… from an observed code, or Add mapping)', () => {
  it('"Map…" on an observed row opens the editor with the instrument code prefilled and Direction defaulting to Both', async () => {
    await show();
    await openMapHgb();
    expect(field(/^instrument code/i).value).toBe('HGB');
    expect((within(dialog()).getByRole('radio', { name: /^both/i }) as HTMLInputElement).checked).toBe(true);
    expect(calls.filter((c) => c.url.pathname.includes('instrument-code-maps'))).toHaveLength(0);
  });

  it('"Add mapping" opens an empty editor; Instrument code is limited to 64 characters', async () => {
    await show();
    await userEvent.click(screen.getByRole('button', { name: /^add mapping/i }));
    expect(field(/^instrument code/i).value).toBe('');
    expect(field(/^instrument code/i).getAttribute('maxlength')).toBe('64');
  });

  it('picking a test searches C3 orderables (kind=test) and loads that test\'s analytes — the Analyte list holds only that test\'s analytes', async () => {
    await show();
    await openMapHgb();
    await pickTest('hemo', /Hemoglobin panel test/);
    const s = calls.find((c) => c.url.pathname === '/v1/catalog/orderables')!;
    expect(s.url.searchParams.get('q')).toBe('hemo');
    expect(s.url.searchParams.get('kind')).toBe('test');
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/catalog/tests/${T_HGB}`)).toBe(true));
    await userEvent.click(within(dialog()).getByRole('button', { name: /analyte/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(opts.some((t) => /Haemoglobin conc/.test(t ?? ''))).toBe(true);
    expect(opts.some((t) => /Haematocrit frac/.test(t ?? ''))).toBe(true);
    expect(opts.some((t) => /White cells/.test(t ?? ''))).toBe(false);
  });

  it('Save sends ONE C3 createInstrumentCodeMap with exactly {instrument_id, direction, instrument_code, analyte_id, test_id} and an Idempotency-Key; no unit keys when none entered', async () => {
    await show();
    await openMapHgb();
    await fillRequired();
    await save();
    await waitFor(() => expect(creates()).toHaveLength(1));
    const c = creates()[0]!;
    expect(c.body).toEqual({ instrument_id: INST, direction: 'both', instrument_code: 'HGB', analyte_id: A_HGB, test_id: T_HGB });
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic'); // recorded request is BFF→C3 (REQ-SEC-068), which carries the JWT
    await waitFor(() => expect(refresh).toHaveBeenCalled()); // AC-17.3 UI side: observed status re-read after C3 changed
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Direction Inbound / Outbound is sent as chosen', async () => {
    await show();
    await openMapHgb();
    await userEvent.click(within(dialog()).getByRole('radio', { name: /^inbound/i }));
    await fillRequired();
    await save();
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.body.direction).toBe('inbound');
  });

  it('unit conversion g/L → g/dL × 0.1 is sent as unit_from_raw / unit_to_code / unit_factor (DecimalString)', async () => {
    await show();
    await openMapHgb();
    await fillRequired();
    await userEvent.type(field(/unit from/i), 'g/L');
    await choose(/unit to/i, 'g/dL');
    await userEvent.type(field(/factor/i), '0.1');
    await save();
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.body).toMatchObject({ unit_from_raw: 'g/L', unit_to_code: 'g/dL', unit_factor: '0.1' });
    expect(typeof creates()[0]!.body.unit_factor).toBe('string');
  });

  it('client validation: nothing is sent without a test+analyte, with an empty code, with a partial unit trio, or with factor ≤ 0 / > 6 decimals', async () => {
    await show();
    await openMapHgb();
    await save(); // no test / analyte yet
    await new Promise((r) => setTimeout(r, 100));
    expect(creates()).toHaveLength(0);
    await fillRequired();
    await userEvent.type(field(/unit from/i), 'g/L'); // trio incomplete
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(creates()).toHaveLength(0);
    await choose(/unit to/i, 'g/dL');
    await userEvent.type(field(/factor/i), '0');
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(creates()).toHaveLength(0);
    expect(field(/factor/i).getAttribute('aria-invalid')).toBe('true');
    await userEvent.clear(field(/factor/i));
    await userEvent.type(field(/factor/i), '0.1234567');
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(creates()).toHaveLength(0);
    await userEvent.clear(field(/^instrument code/i));
    await userEvent.clear(field(/factor/i));
    await userEvent.type(field(/factor/i), '0.1');
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(creates()).toHaveLength(0);
    expect(field(/^instrument code/i).getAttribute('aria-invalid')).toBe('true');
  });

  it('double-click on Save sends ONE POST while in flight', async () => {
    api.use(http.post(MAPS, async ({ request }) => { await rec(request); await delay(150); return HttpResponse.json(cm({ id: M3, version: 1 }), { status: 201 }); }));
    await show();
    await openMapHgb();
    await fillRequired();
    await userEvent.dblClick(saveBtn());
    await new Promise((r) => setTimeout(r, 400));
    expect(creates()).toHaveLength(1);
  });

  it('409 catalog.code_duplicate → field error on Instrument code "This code is already mapped for this instrument."; editor stays open with entries kept', async () => {
    api.use(http.post(MAPS, async ({ request }) => { await rec(request); return problem(409, 'catalog.code_duplicate'); }));
    await show();
    await openMapHgb();
    await fillRequired();
    await save();
    await waitFor(() => expect(bodyHas(DUP)).toBe(true));
    expect(field(/^instrument code/i).getAttribute('aria-invalid')).toBe('true');
    expect(field(/^instrument code/i).value).toBe('HGB');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('400 common.validation_failed → field errors by JSON Pointer (/unit_factor → Factor, /instrument_code → Instrument code)', async () => {
    api.use(http.post(MAPS, async ({ request }) => { await rec(request); return problem(400, 'common.validation_failed', { errors: [{ path: '/unit_factor', code: 'range', message: 'Factor must be greater than 0.' }, { path: '/instrument_code', code: 'pattern', message: 'Bad code.' }] }); }));
    await show();
    await openMapHgb();
    await fillRequired();
    await save();
    await waitFor(() => expect(field(/factor/i).getAttribute('aria-invalid')).toBe('true'));
    expect(field(/^instrument code/i).getAttribute('aria-invalid')).toBe('true');
    expect(bodyHas('Factor must be greater than 0.')).toBe(true);
    expect(bodyHas(MFA)).toBe(false);
  });

  it('403 auth.mfa_required → step-up banner "Confirm with your authenticator to continue" with a link/button to continue; entries kept; the retry re-sends with the SAME Idempotency-Key', async () => {
    let n = 0;
    api.use(http.post(MAPS, async ({ request }) => { await rec(request); return ++n === 1 ? problem(403, 'auth.mfa_required') : HttpResponse.json(cm({ id: M3, version: 1 }), { status: 201 }); }));
    await show();
    await openMapHgb();
    await fillRequired();
    await save();
    expect(await screen.findByText(new RegExp(MFA))).toBeTruthy();
    const banner = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')].find((e) => e.textContent?.includes(MFA));
    expect(banner).toBeTruthy();
    expect(within(document.body).queryAllByRole('link', { name: /authenticator|verify|confirm|step/i }).length + within(document.body).queryAllByRole('button', { name: /authenticator|verify|confirm|continue|step/i }).filter((b) => !/^save$/i.test(b.textContent ?? '')).length).toBeGreaterThan(0);
    expect(field(/^instrument code/i).value).toBe('HGB');
    expect(refresh).not.toHaveBeenCalled();
    await save();
    await waitFor(() => expect(creates()).toHaveLength(2));
    expect(creates()[1]!.headers.get('idempotency-key')).toBe(creates()[0]!.headers.get('idempotency-key'));
  });

  it.each([[403, 'auth.forbidden'], [500, 'common.internal']])('%s %s → visible error naming the code; no success; no mfa banner', async (status, code) => {
    api.use(http.post(MAPS, async ({ request }) => { await rec(request); return problem(status, code); }));
    await show();
    await openMapHgb();
    await fillRequired();
    await save();
    await waitFor(() => expect(bodyHas(code)).toBe(true));
    expect(bodyHas(MFA)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('SECURITY: hostile problem title/detail is rendered as text, never HTML', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    api.use(http.post(MAPS, async ({ request }) => { await rec(request); return HttpResponse.json({ type: 'urn:lims:error:common.internal', title: evil, detail: evil, status: 500, code: 'common.internal' }, { status: 500 }); }));
    await show();
    await openMapHgb();
    await fillRequired();
    await save();
    await waitFor(() => expect(bodyHas('common.internal')).toBe(true));
    expect(document.querySelector('img')).toBeNull();
  });

  it('SECURITY: a hostile instrument code from E32 is rendered as text', async () => {
    await show({ observed: [oc({ instrument_analyte_code: '<img src=x onerror=alert(1)>' })] });
    expect(document.querySelector('img')).toBeNull();
    expect(bodyHas('<img src=x onerror=alert(1)>')).toBe(true);
  });
});

// ================================================================================================================ edit / deactivate
describe('edit a map (instrument, code, analyte immutable)', () => {
  const openEdit = async (code: RegExp = /\bWBC\b/) => { await userEvent.click(btn(rowOf(code), /^edit/i)); await screen.findByRole('dialog'); };

  it('the editor opens prefilled; Instrument code, Direction, Test and Analyte are not editable (deactivate + create instead)', async () => {
    await show();
    await openEdit();
    expect(field(/^instrument code/i).value).toBe('WBC');
    expect(locked(field(/^instrument code/i))).toBe(true);
    for (const r of within(dialog()).getAllByRole('radio')) expect(locked(r), r.getAttribute('value') ?? '').toBe(true);
    expect(field(/unit from/i).value).toBe('g/L');
    expect(field(/factor/i).value).toMatch(/^0\.1/);
    expect(within(dialog()).queryByRole('combobox', { name: /^test/i }) === null || locked(within(dialog()).getByRole('combobox', { name: /^test/i }))).toBe(true);
  });

  it('Save sends ONE PATCH /{map_id} with If-Match "<version>" and only mutable keys', async () => {
    await show();
    await openEdit();
    await userEvent.clear(field(/factor/i));
    await userEvent.type(field(/factor/i), '0.2');
    await save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    const c = patches()[0]!;
    expect(c.url.pathname).toBe(`/v1/catalog/instrument-code-maps/${M1}`);
    expect(c.headers.get('if-match')).toBe('"5"');
    expect(c.body.unit_factor).toBe('0.2');
    for (const k of Object.keys(c.body)) expect(['unit_from_raw', 'unit_to_code', 'unit_factor', 'flag_map', 'unset', 'is_active']).toContain(k);
    for (const k of ['instrument_id', 'instrument_code', 'analyte_id', 'test_id', 'direction', 'id', 'version']) expect(c.body).not.toHaveProperty(k);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('removing the whole unit conversion unsets all three keys', async () => {
    await show();
    await openEdit();
    await userEvent.clear(field(/unit from/i));
    await userEvent.clear(field(/factor/i));
    await choose(/unit to/i, /none|—|no unit|clear/i).catch(async () => { await userEvent.keyboard('{Escape}'); });
    await save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    const b = patches()[0]!.body;
    expect([...(b.unset ?? [])].sort()).toEqual(['unit_factor', 'unit_from_raw', 'unit_to_code']);
    expect(b).not.toHaveProperty('unit_factor');
  });

  it('a second save uses the version returned by the first (no self-inflicted 409)', async () => {
    await show();
    await openEdit();
    await userEvent.clear(field(/factor/i));
    await userEvent.type(field(/factor/i), '0.2');
    await save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.headers.get('if-match')).toBe('"5"');
    if (screen.queryByRole('dialog')) {
      await userEvent.clear(field(/factor/i));
      await userEvent.type(field(/factor/i), '0.3');
      await save();
      await waitFor(() => expect(patches()).toHaveLength(2));
      expect(patches()[1]!.headers.get('if-match')).toBe('"6"');
    }
  });

  it.each([[409, 'common.version_conflict'], [428, 'common.precondition_required'], [500, 'common.internal'], [403, 'auth.forbidden']])('%s %s → visible error naming the code, no success, no step-up banner', async (status, code) => {
    api.use(http.patch(`${MAPS}/:id`, async ({ request }) => { await rec(request); return problem(status, code); }));
    await show();
    await openEdit();
    await userEvent.clear(field(/factor/i));
    await userEvent.type(field(/factor/i), '0.2');
    await save();
    await waitFor(() => expect(bodyHas(code)).toBe(true));
    expect(bodyHas(MFA)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('403 auth.mfa_required on edit → step-up banner; entries kept', async () => {
    api.use(http.patch(`${MAPS}/:id`, async ({ request }) => { await rec(request); return problem(403, 'auth.mfa_required'); }));
    await show();
    await openEdit();
    await userEvent.clear(field(/factor/i));
    await userEvent.type(field(/factor/i), '0.2');
    await save();
    expect(await screen.findByText(new RegExp(MFA))).toBeTruthy();
    expect(field(/factor/i).value).toBe('0.2');
  });

  it('409 catalog.code_duplicate (reactivation clash) is shown as an error, not swallowed', async () => {
    api.use(http.patch(`${MAPS}/:id`, async ({ request }) => { await rec(request); return problem(409, 'catalog.code_duplicate'); }));
    await show();
    await openEdit();
    await userEvent.clear(field(/factor/i));
    await userEvent.type(field(/factor/i), '0.2');
    await save();
    await waitFor(() => expect(bodyHas(DUP) || bodyHas('catalog.code_duplicate')).toBe(true));
  });
});

describe('deactivate a map', () => {
  const deactivate = async (code: RegExp = /\bWBC\b/) => {
    await userEvent.click(btn(rowOf(code), /^deactivate/i));
    const dlg = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /^(deactivate|confirm|yes)/i })); // a confirm step is allowed (not mandated)
  };

  it('sends ONE PATCH {is_active:false} with If-Match "<version>" and refreshes', async () => {
    await show();
    await deactivate();
    await waitFor(() => expect(patches()).toHaveLength(1));
    const c = patches()[0]!;
    expect(c.url.pathname).toBe(`/v1/catalog/instrument-code-maps/${M1}`);
    expect(c.headers.get('if-match')).toBe('"5"');
    expect(c.body).toEqual({ is_active: false });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('double-click sends ONE PATCH', async () => {
    api.use(http.patch(`${MAPS}/:id`, async ({ request }) => { await rec(request); await delay(150); return HttpResponse.json(cm({ is_active: false, version: 6 })); }));
    await show();
    await userEvent.dblClick(btn(rowOf(/\bWBC\b/), /^deactivate/i));
    const dlg = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
    if (dlg) await userEvent.dblClick(within(dlg).getByRole('button', { name: /^(deactivate|confirm|yes)/i }));
    await new Promise((r) => setTimeout(r, 400));
    expect(patches()).toHaveLength(1);
  });

  it('403 auth.mfa_required → step-up banner "Confirm with your authenticator to continue" (no refresh)', async () => {
    api.use(http.patch(`${MAPS}/:id`, async ({ request }) => { await rec(request); return problem(403, 'auth.mfa_required'); }));
    await show();
    await deactivate();
    expect(await screen.findByText(new RegExp(MFA))).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([[409, 'common.version_conflict'], [500, 'common.internal']])('%s %s → visible error naming the code', async (status, code) => {
    api.use(http.patch(`${MAPS}/:id`, async ({ request }) => { await rec(request); return problem(status, code); }));
    await show();
    await deactivate();
    await waitFor(() => expect(bodyHas(code)).toBe(true));
    expect(refresh).not.toHaveBeenCalled();
  });
});

// ================================================================================================================ copy
describe('"Copy from instrument…" (C3 upsertInstrumentCodeMaps with per-row outcome table)', () => {
  const openCopy = async () => { await userEvent.click(screen.getByRole('button', { name: /^copy from instrument/i })); await screen.findByRole('dialog'); };
  const pickSource = async () => { await choose(/source instrument/i, /SIM-CHEM-2/); };
  const copyBtn = () => within(dialog()).getByRole('button', { name: /^copy$/i });

  it('the source list contains the OTHER instruments only (never itself)', async () => {
    await show();
    await openCopy();
    await userEvent.click(within(dialog()).getByRole('button', { name: /source instrument/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(opts.some((t) => /SIM-CHEM-2/.test(t))).toBe(true);
    expect(opts.some((t) => /SIM-CHEM-1/.test(t))).toBe(false);
  });

  it('choosing a source reads ITS maps from C3 (instrument_id = source); Copy sends ONE bulk-upsert to the CURRENT instrument with the source rows minus ids, and an Idempotency-Key', async () => {
    await show();
    await openCopy();
    await pickSource();
    await waitFor(() => expect(sent('GET', /\/instrument-code-maps$/).some((c) => c.url.searchParams.get('instrument_id') === INST2)).toBe(true));
    await waitFor(() => expect((copyBtn() as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(copyBtn());
    await waitFor(() => expect(bulks()).toHaveLength(1));
    const c = bulks()[0]!;
    expect(c.body.instrument_id).toBe(INST);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(Array.isArray(c.body.maps)).toBe(true);
    expect(c.body.maps.length).toBeGreaterThan(0);
    expect(c.body.maps.length).toBeLessThanOrEqual(200);
    for (const m of c.body.maps) {
      expect(m).toMatchObject({ direction: expect.any(String), instrument_code: expect.any(String), analyte_id: expect.any(String), test_id: expect.any(String) });
      for (const k of ['id', 'version', 'is_active', 'instrument_id']) expect(m, k).not.toHaveProperty(k);
    }
    expect(JSON.stringify(c.body)).not.toContain(INST2);
  });

  it('the per-row outcome table shows each code with created / updated / unchanged / error (+ error_code) as TEXT', async () => {
    api.use(http.post(`${MAPS}/bulk-upsert`, async ({ request }) => {
      await rec(request);
      return HttpResponse.json({ results: [{ direction: 'both', instrument_code: 'WBC', outcome: 'created' }, { direction: 'inbound', instrument_code: 'GLU', outcome: 'unchanged' }, { direction: 'outbound', instrument_code: 'OLD', outcome: 'error', error_code: 'catalog.code_duplicate' }] });
    }));
    await show();
    await openCopy();
    await pickSource();
    await waitFor(() => expect((copyBtn() as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(copyBtn());
    await waitFor(() => expect(bulks()).toHaveLength(1));
    const t = await within(dialog()).findByRole('table');
    expect(text(within(t).getByRole('row', { name: /\bWBC\b/ }))).toMatch(/created/i);
    expect(text(within(t).getByRole('row', { name: /\bGLU\b/ }))).toMatch(/unchanged/i);
    const bad = text(within(t).getByRole('row', { name: /\bOLD\b/ }));
    expect(bad).toMatch(/error/i);
    expect(bad).toContain('catalog.code_duplicate');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('403 auth.mfa_required → step-up banner; no outcome table; Copy can be retried with the SAME Idempotency-Key', async () => {
    let n = 0;
    api.use(http.post(`${MAPS}/bulk-upsert`, async ({ request }) => { await rec(request); return ++n === 1 ? problem(403, 'auth.mfa_required') : HttpResponse.json({ results: [{ direction: 'both', instrument_code: 'WBC', outcome: 'created' }] }); }));
    await show();
    await openCopy();
    await pickSource();
    await waitFor(() => expect((copyBtn() as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(copyBtn());
    expect(await screen.findByText(new RegExp(MFA))).toBeTruthy();
    expect(within(dialog()).queryByRole('table')).toBeNull();
    await userEvent.click(copyBtn());
    await waitFor(() => expect(bulks()).toHaveLength(2));
    expect(bulks()[1]!.headers.get('idempotency-key')).toBe(bulks()[0]!.headers.get('idempotency-key'));
  });

  it('500 → visible error naming the code', async () => {
    api.use(http.post(`${MAPS}/bulk-upsert`, async ({ request }) => { await rec(request); return problem(500, 'common.internal'); }));
    await show();
    await openCopy();
    await pickSource();
    await waitFor(() => expect((copyBtn() as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(copyBtn());
    await waitFor(() => expect(bodyHas('common.internal')).toBe(true));
  });
});

// ================================================================================================================ axe
describe('axe', () => {
  it('manager view, read-only view, editor open, editor with step-up banner', async () => {
    const a = await show();
    await noAxeViolations();
    a.unmount();
    const b = await show({ permissions: READ });
    await noAxeViolations();
    b.unmount();
    await show();
    await openMapHgb();
    await noAxeViolations();
    cleanup();
    api.use(http.post(MAPS, async ({ request }) => { await rec(request); return problem(403, 'auth.mfa_required'); }));
    await show();
    await openMapHgb();
    await fillRequired();
    await save();
    await screen.findByText(new RegExp(MFA));
    await noAxeViolations();
  });
});

// ================================================================================================================ page
describe('page → BFF (E25, E32, C3 #92 + test lookups, E23)', () => {
  const INSTR_URL = `${IM}/${INST}`;
  const OBS_URL = `${IM}/${INST}/observed-codes`;
  const baseHandlers = () => api.use(
    http.get(INSTR_URL, async ({ request }) => { await rec(request); return HttpResponse.json(instrument); }),
    http.get(OBS_URL, async ({ request }) => { await rec(request); return HttpResponse.json({ data: OBSERVED, page: { limit: 50 } }); }),
  );
  const page = async (id: string = INST) => {
    baseHandlers();
    const mod = await import('../../../app/(staff)/instruments/instruments/[instrument_id]/mappings/page');
    return (await mod.default({ params: Promise.resolve({ instrument_id: id }) } as never)) as { props: Record<string, any> };
  };
  const catalogCalls = () => calls.filter((c) => c.url.pathname.startsWith('/v1/catalog/'));

  it('manager: reads E25 + E32 once each and C3 listInstrumentCodeMaps once with instrument_id; passes instrument, observed, maps, permissions', async () => {
    const el = await page();
    expect(calls.filter((c) => c.url.pathname === `/v1/instruments/instruments/${INST}`)).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname === `/v1/instruments/instruments/${INST}/observed-codes`)).toHaveLength(1);
    const lists = sent('GET', /\/instrument-code-maps$/);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.url.searchParams.get('instrument_id')).toBe(INST);
    expect(el.props.instrument).toMatchObject({ id: INST });
    expect(el.props.observed).toHaveLength(OBSERVED.length);
    expect(el.props.maps).toHaveLength(MAPROWS.length);
    expect(el.props.permissions).toEqual(MANAGE);
  });

  it('manager: resolves test names via C3 getTestDetail ONCE per distinct test_id (deduped) and passes them as `tests`', async () => {
    const el = await page();
    const gets = calls.filter((c) => /^\/v1\/catalog\/tests\/[^/]+$/.test(c.url.pathname)).map((c) => c.url.pathname.split('/').pop());
    expect([...gets].sort()).toEqual([T_HGB, T_WBC].sort());
    expect(Object.keys(el.props.tests ?? {}).sort()).toEqual([T_HGB, T_WBC].sort());
  });

  it('manager: a failing test lookup (404/500) does NOT take the page down — the maps still render', async () => {
    api.use(http.get(`${ORIGIN}/v1/catalog/tests/:id`, () => problem(500, 'common.internal')));
    const el = await page();
    expect(el.props.maps).toHaveLength(MAPROWS.length);
  });

  it('read-only user: E32 is read, and NOT ONE request goes to /v1/catalog/*; `maps` is not passed (D-39)', async () => {
    session.permissions = READ;
    const el = await page();
    expect(calls.filter((c) => c.url.pathname === `/v1/instruments/instruments/${INST}/observed-codes`)).toHaveLength(1);
    expect(catalogCalls()).toHaveLength(0);
    expect(c3Calls()).toHaveLength(0);
    expect(el.props.maps ?? null).toBeNull();
    expect(el.props.permissions).toEqual(READ);
    expect(el.props.permissions).not.toContain(MAN);
  });

  it('without instruments.instrument.read → forbidden: no request at all (even when the user holds catalog.instrument_code_map.manage)', async () => {
    session.permissions = [MAN];
    const r = await page().then((e) => e, () => 'threw');
    expect(calls).toHaveLength(0);
    if (r !== 'threw') { expect((r as any).props?.observed).toBeUndefined(); expect((r as any).props?.maps).toBeUndefined(); }
    session.permissions = [];
    const r2 = await page().then((e) => e, () => 'threw');
    expect(calls).toHaveLength(0);
    if (r2 !== 'threw') { expect((r2 as any).props?.observed).toBeUndefined(); }
  });

  it.each([['not-a-uuid'], ['../etc'], [`${INST}%00`]])('malformed instrument id %j → notFound, no request', async (id) => {
    await expect(page(id)).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    expect(calls).toHaveLength(0);
  });

  it('E25 404 (also another centre\'s instrument) → notFound', async () => {
    baseHandlers();
    api.use(http.get(INSTR_URL, () => problem(404, 'common.not_found')));
    const mod = await import('../../../app/(staff)/instruments/instruments/[instrument_id]/mappings/page');
    await expect(mod.default({ params: Promise.resolve({ instrument_id: INST }) } as never)).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('E32 500 is NOT turned into an empty list or not-found (error.tsx handles it)', async () => {
    baseHandlers();
    api.use(http.get(OBS_URL, () => problem(500, 'common.internal')));
    const mod = await import('../../../app/(staff)/instruments/instruments/[instrument_id]/mappings/page');
    await expect(mod.default({ params: Promise.resolve({ instrument_id: INST }) } as never)).rejects.toMatchObject({ status: 500 });
  });
});
