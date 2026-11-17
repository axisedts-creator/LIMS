// C9.T-22 shared test harness (tester-owned; not a test file). Builds on the T-21 harness (MSW server, session/navigation mocks, DOM helpers).
// Fixtures follow contracts/openapi/quality.yaml (ControlMaterialDto, ControlLevelDto, ControlLotDto, ControlIdMapDto, QcPlanDto, QcTargetDto),
// instruments.yaml (InstrumentSummary, listInstruments) and catalog.yaml (OrderableSummary, Test, Analyte). Synthetic data only.
// Each test file registers the same three mocks as T-21 (see quality-t21.harness.tsx header).
import { expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { ANALYTE_1, ANALYTE_2, INST_1, INST_2, LEVEL_1, LEVEL_2, LOT_1, LOT_2, PLAN_1, PLAN_2, resetApi as resetT21, routes } from './quality-t21.harness';

export * from './quality-t21.harness';

const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
export const MAT_1 = id(4000);
export const MAT_2 = id(4001);
export const MAP_1 = id(4010);
export const MAP_2 = id(4011);
export const TGT_1 = id(4020);
export const TGT_2 = id(4021);
export const TGT_3 = id(4022);
export const TEST_1 = id(4030);
export const TEST_2 = id(4031);
export const OBS = (n: number) => id(4100 + n);

export const PERM_SETUP_READ = ['quality.qc_run.read'];
export const PERM_SETUP_WRITE = ['quality.qc_run.read', 'quality.qc.manage'];
/** Write permission + the C7/C3 read permissions that make the pickers work (x-permission in instruments.yaml / catalog.yaml). */
export const PERM_SETUP_PICKERS = [...PERM_SETUP_WRITE, 'instruments.instrument.read', 'catalog.test.read'];

export const BASE = '/v1/quality';
export const lvl = (over: Record<string, unknown> = {}) => ({ id: LEVEL_1, version: 1, material_id: MAT_1, level_code: '1', display_name: 'Level 1', sort_order: 1, is_active: true, lots: [], ...over });
export const lot = (over: Record<string, unknown> = {}) => ({ id: LOT_1, version: 1, level_id: LEVEL_1, material_id: MAT_1, lot_no: 'LOT-SYN-01', expires_on: '2027-03-31', is_expired: false, is_active: true, ...over });
export const material = (over: Record<string, unknown> = {}) => ({
  id: MAT_1, version: 3, code: 'MCS-SYN', name: 'Synthetic multi-control', manufacturer: 'Synthetic Diagnostics', matrix: 'serum', is_active: true, lots_expiring_30d: 0, created_at: '2026-11-01T03:00:00.000Z',
  levels: [lvl({ lots: [lot()] }), lvl({ id: LEVEL_2, level_code: '2', display_name: 'Level 2', sort_order: 2, lots: [lot({ id: LOT_2, level_id: LEVEL_2, lot_no: 'LOT-SYN-02' })] })], ...over,
});
export const MATERIALS = [
  material(),
  material({ id: MAT_2, version: 1, code: 'MCS-OLD', name: 'Retired control', manufacturer: undefined, matrix: undefined, is_active: false, lots_expiring_30d: 2, levels: [lvl({ id: id(4002), material_id: MAT_2 })] }),
];
export const idMap = (over: Record<string, unknown> = {}) => ({ id: MAP_1, version: 1, instrument_id: INST_1, instrument_label: 'SYN-CHEM-01 Synthetic Chemistry Analyser', control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-01', lot_id: LOT_1, is_active: true, ...over });
export const MAPS = [idMap(), idMap({ id: MAP_2, control_id_raw: 'QC-L1', control_lot_raw: undefined, lot_id: LOT_2, instrument_label: 'SYN-IMM-02 Synthetic Immunoassay', instrument_id: INST_2 })];
export const planDto = (over: Record<string, unknown> = {}) => ({
  id: PLAN_1, version: 4, instrument_id: INST_1, instrument_label: 'SYN-CHEM-01 Synthetic Chemistry Analyser', test_id: TEST_1, analyte_id: ANALYTE_1, analyte_code: 'GLU', analyte_name: 'Glucose', unit_code: 'mg_dl', decimals: 1,
  status: 'active', current_version_no: 3,
  params: { controls_per_run: 2, composition: [{ level_id: LEVEL_1, count: 1 }, { level_id: LEVEL_2, count: 1 }], mean_rule: '10x', two_two_s_across_runs: true, count_rules_across_materials: true, exclude_rejected_runs_from_history: true, run_window_minutes: 30, qc_validity_hours: 24, hold_lookback_hours: 24 },
  rule_set_preview: { warning: ['1-2s'], rejection: ['1-3s', '2-2s', 'R-4s', '4-1s', '10x'] }, effective_from: '2026-11-01T00:00:00.000Z', ...over,
});
export const PLANS = [planDto(), planDto({ id: PLAN_2, version: 1, instrument_id: INST_2, instrument_label: 'SYN-IMM-02 Synthetic Immunoassay', analyte_id: ANALYTE_2, analyte_code: 'TSH', analyte_name: 'TSH', status: 'inactive', current_version_no: 1,
  params: { controls_per_run: 4, composition: [{ level_id: LEVEL_1, count: 2 }, { level_id: LEVEL_2, count: 2 }], mean_rule: '8x' }, rule_set_preview: { warning: ['1-2s'], rejection: ['1-3s', '2-2s', 'R-4s', '4-1s', '8x'] } })];
export const target = (over: Record<string, unknown> = {}) => ({
  id: TGT_1, version: 2, plan_id: PLAN_1, lot_id: LOT_1, level_id: LEVEL_1, mean: '100.00', sd: '2.00', cv_pct: '2.0', unit_code: 'mg_dl', source: 'manufacturer', status: 'active', effective_from: '2026-11-01T00:00:00.000Z', created_by_display: 'Synthetic Manager', ...over,
});
export const TARGETS = [
  target(),
  target({ id: TGT_2, level_id: LEVEL_2, lot_id: LOT_2, mean: '150.00', sd: '4.50', cv_pct: '3.0', source: 'established', basis: { n: 25, from: '2026-10-01T00:00:00.000Z', to: '2026-10-25T00:00:00.000Z', observation_ids_sha256: 'a'.repeat(64) }, status: 'draft', effective_from: undefined }),
  target({ id: TGT_3, mean: '98.00', sd: '2.50', status: 'superseded', effective_from: '2026-10-01T00:00:00.000Z', effective_to: '2026-11-01T00:00:00.000Z' }),
];
export const page = (rows: unknown[]) => ({ data: rows, page: { limit: 50 } });

// C7 / C3 pickers (read through the BFF; the browser never calls them)
export const INSTRUMENT_ROWS = [
  { id: INST_1, instrument_code: 'SYN-CHEM-01', display_name: 'Synthetic Chemistry Analyser', vendor: 'Synthetic', model: 'X1', protocol: 'astm', state: 'live', version: 1 },
  { id: INST_2, instrument_code: 'SYN-IMM-02', display_name: 'Synthetic Immunoassay', vendor: 'Synthetic', model: 'X2', protocol: 'hl7v2', state: 'live', version: 1 },
];
export const TEST_ROWS = [
  { id: TEST_1, kind: 'test', code: 'GLU', name: 'Glucose (synthetic)', is_orderable: true, is_active: true, revision: 1 },
  { id: TEST_2, kind: 'test', code: 'TSH', name: 'TSH (synthetic)', is_orderable: true, is_active: true, revision: 1 },
];
export const testDetail = (testId = TEST_1) => ({
  id: testId, kind: 'test', code: testId === TEST_1 ? 'GLU' : 'TSH', name: 'Synthetic test', is_active: true, version: 1,
  analytes: [
    { id: ANALYTE_1, test_id: testId, code: 'GLU', name: 'Glucose', is_active: true, current_version: { result_type: 'numeric', unit_code: 'mg_dl', decimals: 1 } },
    { id: ANALYTE_2, test_id: testId, code: 'COMMENT', name: 'Free-text comment', is_active: true, current_version: { result_type: 'text' } },
  ],
});

/** Mounts C7/C3 reads. Everything else on /v1/quality answers 503 until a test registers it. */
export function mountPickers() {
  routes['GET /v1/instruments/instruments'] = () => HttpResponse.json(page(INSTRUMENT_ROWS));
  routes['GET /v1/catalog/tests'] = () => HttpResponse.json(page(TEST_ROWS));
  routes[`GET /v1/catalog/tests/${TEST_1}`] = () => HttpResponse.json(testDetail(TEST_1));
  routes[`GET /v1/catalog/tests/${TEST_2}`] = () => HttpResponse.json(testDetail(TEST_2));
}
export function resetApi(permissions: string[] = PERM_SETUP_READ) {
  resetT21(permissions);
  routes[`GET ${BASE}/control-materials`] = () => HttpResponse.json(page(MATERIALS));
  routes[`GET ${BASE}/control-lots`] = () => HttpResponse.json(page(MATERIALS.flatMap((m) => m.levels.flatMap((l) => l.lots ?? []))));
  routes[`GET ${BASE}/control-id-maps`] = () => HttpResponse.json(page(MAPS));
  routes[`GET ${BASE}/qc-plans`] = () => HttpResponse.json(page(PLANS));
  routes[`GET ${BASE}/qc-targets`] = () => HttpResponse.json(page(TARGETS));
  mountPickers();
}

// ---------------------------------------------------------------- interaction helpers (react-aria widgets under jsdom)
export const user = () => userEvent.setup();
export const dlg = () => { const d = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog'); if (!d) throw new Error('no dialog is open'); return d; };
export const anyDlg = () => screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
export const btn = (re: RegExp, root: HTMLElement = document.body) => within(root).queryByRole('button', { name: re });
/** Field by its visible label inside the open dialog (falls back to the page). */
export const field = (label: RegExp, root?: HTMLElement) => within(root ?? anyDlg() ?? document.body).getByLabelText(label) as HTMLInputElement;
export async function fill(label: RegExp, text: string, root?: HTMLElement) {
  const el = field(label, root);
  const u = user();
  await u.clear(el);
  if (text) await u.type(el, text);
  return el;
}
/** Opens a react-aria Select / Combobox by label and chooses the option whose name matches. */
export async function choose(label: RegExp, option: RegExp, root?: HTMLElement) {
  const scope = root ?? anyDlg() ?? document.body;
  const u = user();
  const ctl = within(scope).queryByRole('combobox', { name: label }) ?? within(scope).getByRole('button', { name: label });
  await u.click(ctl);
  await u.click(await screen.findByRole('option', { name: option }));
}
/** Type into an async Combobox and pick the hit. */
export async function search(label: RegExp, text: string, option: RegExp, root?: HTMLElement) {
  const u = user();
  await u.type(within(root ?? anyDlg() ?? document.body).getByRole('combobox', { name: label }), text);
  await u.click(await screen.findByRole('option', { name: option }));
}
export const submit = (label = /^(save|create|add|activate|establish|confirm)/i) => user().click(within(dlg()).getByRole('button', { name: label }));
export const fieldError = (el: HTMLElement) => el.getAttribute('aria-invalid') === 'true' || !!el.closest('.lims-field')?.querySelector('.lims-error');
export const waitCalls = async (n: number, get: () => unknown[]) => waitFor(() => expect(get()).toHaveLength(n));
