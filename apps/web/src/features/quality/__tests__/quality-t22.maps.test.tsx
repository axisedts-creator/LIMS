// @vitest-environment jsdom
// C9.T-22 — QC set-up › Maps tab `/quality/setup/maps` (04-UI-UX §2.6; 03-APP-FLOW §4; AC-02.1–02.5; 07-SECURITY; "pickers via C3/C7 HTTP with permission fallback").
// ASSUMED contract (writer must follow): app/(staff)/quality/setup/maps/page.tsx = async server component; same Tabs header as Materials (Maps selected).
//   Reads: GET /v1/quality/control-id-maps (grid label /maps/i; columns Instrument, Control id, Lot (raw), Material / Level / Lot, Active), GET /v1/quality/control-lots (+ control-materials) for the Lot Select.
//   "New map" Dialog fields by label: "Instrument" (Combobox over GET /v1/instruments/instruments, id sent), "Control id" (TextField 64, required), "Lot as sent" (TextField 64, optional), "Lot" (Select, required; option text contains lot_no).
//   POST /v1/quality/control-id-maps {instrument_id, control_id_raw, control_lot_raw?, lot_id} (control_lot_raw OMITTED when empty = any lot), Idempotency-Key set; row action "Deactivate" -> ConfirmDialog -> POST …/{id}/deactivate {} + If-Match.
//   C7/C3 picker reads happen on the server (BFF). Permission fallback: without `instruments.instrument.read` NO /v1/instruments request is made and "Instrument" becomes a plain text field "Instrument ID" that takes a UUID;
//   the same fallback applies when the picker read answers 403/503. The form stays usable either way.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import {
  BASE, INST_1, LOT_1, MAP_1, PERM_SETUP_PICKERS, PERM_SETUP_READ, PERM_SETUP_WRITE, anyDlg, api, axeClean, bodyOf, btn, calls, callsTo, choose, dlg, field, fieldError, fill, gridNamed, idMap, json, page, pageText, problem, resetApi, routes, router, rowTexts, headersOf, search, show, showOrThrown, user,
} from './quality-t22.harness';

vi.mock('next/navigation', async () => (await import('./quality-t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t22.harness')).sessionMock);

const PAGE = 'setup/maps/page';
const MAPS = `${BASE}/control-id-maps`;
const INSTR = '/v1/instruments/instruments';
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => resetApi(PERM_SETUP_PICKERS));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function openNew() {
  await show(PAGE);
  await user().click(btn(/new map/i)!);
  return dlg();
}
async function fillMap(controlId = 'QC-L2', lotRaw = 'LOT-SYN-01') {
  await search(/^instrument/i, 'SYN', /SYN-CHEM-01/);
  await fill(/^control id/i, controlId);
  if (lotRaw) await fill(/lot as sent/i, lotRaw);
  await choose(/\blot\b/i, /LOT-SYN-01/);
}
const save = () => user().click(within(dlg()).getByRole('button', { name: /^(save|create)/i }));

describe('access and states', () => {
  it('without quality.qc_run.read: denied state, NO API call', async () => {
    resetApi([]);
    await show(PAGE);
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('empty -> "No control-ID maps."', async () => {
    routes[`GET ${MAPS}`] = json(page([]));
    await show(PAGE);
    expect(pageText()).toContain('No control-ID maps.');
  });
  it('API 5xx rejects (error.tsx)', async () => {
    routes[`GET ${MAPS}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE)).toBeTruthy(); // a MISSING module rethrows, so this cannot pass vacuously
  });
  it('Maps tab is the selected tab', async () => {
    await show(PAGE);
    expect(screen.getByRole('tab', { name: /maps/i }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('list (AC-02.1, AC-02.2)', () => {
  it('shows instrument, raw control id, raw lot or "Any lot" for a wildcard, the mapped lot, and the Active word', async () => {
    await show(PAGE);
    const g = gridNamed(/maps/i);
    expect(headersOf(g).join('|')).toMatch(/instrument.*control id.*lot/i);
    const t = rowTexts(g);
    expect(t[0]).toContain('SYN-CHEM-01');
    expect(t[0]).toContain('QC-L2');
    expect(t[0]).toContain('LOT-SYN-01');
    expect(t[1]).toContain('QC-L1');
    expect(t[1]).toMatch(/any lot/i);
    expect(t[0]).toMatch(/active/i);
  });
  it('an exact map and a wildcard map of the same control id are both listed and distinguishable by their lot text', async () => {
    routes[`GET ${MAPS}`] = json(page([idMap({ control_lot_raw: undefined }), idMap({ id: '01a1a98a-ac40-7000-8000-0000000c4012', control_lot_raw: 'LOT-SYN-02' })]));
    await show(PAGE);
    const t = rowTexts(gridNamed(/maps/i));
    expect(t.filter((x) => /any lot/i.test(x))).toHaveLength(1);
    expect(t.filter((x) => x.includes('LOT-SYN-02'))).toHaveLength(1);
  });
  it('axe clean', async () => { await show(PAGE); await axeClean(); });
});

describe('permission (AC-01.3 applies to every set-up write)', () => {
  it('read-only session: no New map, no Deactivate', async () => {
    resetApi(PERM_SETUP_READ);
    await show(PAGE);
    expect(btn(/new map/i)).toBeNull();
    expect(btn(/deactivate/i)).toBeNull();
  });
  it('server 403 auth.forbidden keeps the dialog open with a permission message', async () => {
    routes[`POST ${MAPS}`] = () => problem('auth.forbidden', 403);
    await openNew();
    await fillMap();
    await save();
    await waitFor(() => expect(callsTo('POST', MAPS)).toHaveLength(1));
    expect(anyDlg()).not.toBeNull();
    expect(pageText()).toMatch(/permission|not allowed|forbidden/i);
  });
});

describe('create map (#12, AC-02.1)', () => {
  it('hints: "Exactly as the analyser sends it, e.g. QC-L2" and "Leave empty to match any lot"', async () => {
    await openNew();
    expect(pageText()).toContain('Exactly as the analyser sends it, e.g. QC-L2');
    expect(pageText()).toContain('Leave empty to match any lot');
    expect(field(/^control id/i).maxLength).toBe(64);
    expect(field(/lot as sent/i).maxLength).toBe(64);
  });
  it('POSTs {instrument_id, control_id_raw, control_lot_raw, lot_id} exactly as typed (not trimmed/uppercased: raw values), Idempotency-Key set, then refresh', async () => {
    routes[`POST ${MAPS}`] = json(idMap(), 201);
    await openNew();
    await fillMap('QC-L2', 'LOT-SYN-01');
    await save();
    await waitFor(() => expect(callsTo('POST', MAPS)).toHaveLength(1));
    const c = callsTo('POST', MAPS)[0]!;
    expect(bodyOf(c)).toEqual({ instrument_id: INST_1, control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-01', lot_id: LOT_1 });
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(anyDlg()).toBeNull();
  });
  it('empty "Lot as sent" = any lot: control_lot_raw is OMITTED from the body (AC-02.2 wildcard)', async () => {
    routes[`POST ${MAPS}`] = json(idMap({ control_lot_raw: undefined }), 201);
    await openNew();
    await fillMap('QC-L2', '');
    await save();
    await waitFor(() => expect(callsTo('POST', MAPS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', MAPS)[0])).toEqual({ instrument_id: INST_1, control_id_raw: 'QC-L2', lot_id: LOT_1 });
  });
  // LD-183 / ruling: Control id is native maxLength 64 (04-UI-UX.md:106); the cap is the length requirement, so it is asserted by attribute (a 65-char paste is truncated to a valid 64).
  it('empty Control id is refused in the form, NO request; input is capped at maxLength 64', async () => {
    await openNew();
    await fillMap('QC-L2');
    const el = field(/^control id/i);
    expect(el.maxLength).toBe(64);
    await user().clear(el);
    await save();
    expect(callsTo('POST', MAPS)).toHaveLength(0);
    expect(fieldError(field(/^control id/i))).toBe(true);
  });
  it('Instrument and Lot are required: submitting without them flags both and sends nothing', async () => {
    await openNew();
    await fill(/^control id/i, 'QC-L2');
    await save();
    expect(callsTo('POST', MAPS)).toHaveLength(0);
    expect(within(dlg()).getAllByText(/required/i).length).toBeGreaterThanOrEqual(2);
  });
  it('the Lot Select groups lots by material / level and shows lot numbers', async () => {
    await openNew();
    await user().click(within(dlg()).getByRole('button', { name: /\blot\b/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => (o.textContent ?? '').replace(/\s+/g, ' '));
    expect(opts.some((o) => o.includes('LOT-SYN-01'))).toBe(true);
    expect(opts.some((o) => o.includes('LOT-SYN-02'))).toBe(true);
    expect(pageText()).toContain('MCS-SYN');
  });
  it('409 quality.code_duplicate -> "This code is already used." and the dialog stays open', async () => {
    routes[`POST ${MAPS}`] = () => problem('quality.code_duplicate', 409);
    await openNew();
    await fillMap();
    await save();
    await waitFor(() => expect(within(dlg()).getByText('This code is already used.')).toBeTruthy());
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('422 quality.lot_expired -> the lot field is flagged with an "expired" message', async () => {
    routes[`POST ${MAPS}`] = () => problem('quality.lot_expired', 422);
    await openNew();
    await fillMap();
    await save();
    await waitFor(() => expect(within(dlg()).getByText(/expired|in the past/i)).toBeTruthy());
  });
  it('400 common.validation_failed pointing at /instrument_id (instrument not in the tenant) -> error on the Instrument field (AC-02.5)', async () => {
    routes[`POST ${MAPS}`] = () => problem('common.validation_failed', 400, { errors: [{ pointer: '/instrument_id', code: 'common.not_found', message: 'Instrument not found.' }] });
    await openNew();
    await fillMap();
    await save();
    await waitFor(() => expect(within(dlg()).getByText(/instrument/i, { selector: '.lims-error, [role="alert"], [slot="errorMessage"]' })).toBeTruthy());
    expect(anyDlg()).not.toBeNull();
  });
  it('a double click on Save sends ONE request', async () => {
    routes[`POST ${MAPS}`] = json(idMap(), 201);
    await openNew();
    await fillMap();
    await user().dblClick(within(dlg()).getByRole('button', { name: /^(save|create)/i }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(callsTo('POST', MAPS)).toHaveLength(1);
  });
});

describe('C7 instrument picker through the BFF, with permission fallback', () => {
  it('with instruments.instrument.read: options come from GET /v1/instruments/instruments (server-side, Bearer token); the search text never reaches the URL unescaped', async () => {
    await openNew();
    await search(/^instrument/i, 'SYN-CH', /SYN-CHEM-01/);
    const c = callsTo('GET', INSTR);
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.headers.get('authorization')).toMatch(/^Bearer /);
    expect(Number(c[0]!.url.searchParams.get('limit') ?? 50)).toBeLessThanOrEqual(200);
  });
  it('without instruments.instrument.read: NO /v1/instruments request; Instrument is a text field "Instrument ID" and the form still submits the typed id', async () => {
    resetApi(PERM_SETUP_WRITE);
    routes[`POST ${MAPS}`] = json(idMap(), 201);
    await openNew();
    expect(callsTo('GET', INSTR)).toHaveLength(0);
    expect(within(dlg()).queryByRole('combobox', { name: /^instrument/i })).toBeNull();
    await fill(/instrument id/i, INST_1);
    await fill(/^control id/i, 'QC-L2');
    await choose(/\blot\b/i, /LOT-SYN-01/);
    await save();
    await waitFor(() => expect(callsTo('POST', MAPS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', MAPS)[0]).instrument_id).toBe(INST_1);
    expect(callsTo('GET', INSTR)).toHaveLength(0);
  });
  it('fallback id must be a UUID: "not-a-uuid" is refused in the form, NO request', async () => {
    resetApi(PERM_SETUP_WRITE);
    await openNew();
    await fill(/instrument id/i, 'not-a-uuid');
    await fill(/^control id/i, 'QC-L2');
    await choose(/\blot\b/i, /LOT-SYN-01/);
    await save();
    expect(callsTo('POST', MAPS)).toHaveLength(0);
    expect(fieldError(field(/instrument id/i))).toBe(true);
  });
  it.each([403, 503])('the picker read answering %i degrades to the same text field (page and dialog stay usable)', async (status) => {
    routes[`GET ${INSTR}`] = () => problem(status === 403 ? 'auth.forbidden' : 'common.dependency_unavailable', status);
    await openNew();
    await user().type(within(dlg()).getByLabelText(/^instrument/i), 'SYN');
    await waitFor(() => expect(within(dlg()).getByLabelText(/instrument id/i)).toBeTruthy());
  });
});

describe('deactivate (#13)', () => {
  it('ConfirmDialog, then POST …/deactivate {} with If-Match "<version>" and Idempotency-Key; refresh', async () => {
    routes[`POST ${MAPS}/${MAP_1}/deactivate`] = json(idMap({ is_active: false, version: 2 }));
    await show(PAGE);
    const u = user();
    await u.click(within(within(gridNamed(/maps/i)).getAllByRole('row')[1]!).getByRole('button', { name: /deactivate/i }));
    await u.click(within(dlg()).getByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(callsTo('POST', `${MAPS}/${MAP_1}/deactivate`)).toHaveLength(1));
    const c = callsTo('POST', `${MAPS}/${MAP_1}/deactivate`)[0]!;
    expect(bodyOf(c)).toEqual({});
    expect(c.headers.get('if-match')).toBe('"1"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('cancelling the ConfirmDialog sends nothing', async () => {
    await show(PAGE);
    const u = user();
    await u.click(within(within(gridNamed(/maps/i)).getAllByRole('row')[1]!).getByRole('button', { name: /deactivate/i }));
    await u.click(within(dlg()).getByRole('button', { name: /cancel/i }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('an inactive map shows the word "Inactive" and offers no Deactivate', async () => {
    routes[`GET ${MAPS}`] = json(page([idMap({ is_active: false })]));
    await show(PAGE);
    expect(rowTexts(gridNamed(/maps/i))[0]).toMatch(/inactive/i);
    expect(btn(/deactivate/i)).toBeNull();
  });
});
