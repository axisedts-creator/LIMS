// @vitest-environment jsdom
// C9.T-22 — QC set-up › Plans tab `/quality/setup/plans` (04-UI-UX §2.6; 03-APP-FLOW §4; AC-03.1–03.6; 02-TRD §5.3 rule sets; 07-SECURITY).
// ASSUMED contract (writer must follow): app/(staff)/quality/setup/plans/page.tsx = async server component; Tabs header (Plans selected).
//   Reads: GET /v1/quality/qc-plans (grid label /plans/i; columns Instrument, Analyte, N, Composition, Mean rule, Status, Version), GET /v1/quality/control-materials for the composition level options.
//   "New plan" Dialog, fields by label: "Instrument" (Combobox, C7), "Test" (Combobox, C3 GET /v1/catalog/tests), "Analyte" (Select from GET /v1/catalog/tests/{id}, numeric result_type only),
//   "Controls per run (N)" RadioGroup (radios "2","3","4", default 2), composition rows ("Level" Select + "Count" IntegerField 1–4, buttons "Add level"/"Remove level"), "n-x rule" Select,
//   Switches "2-2s also across runs", "Count rules across levels", "Ignore rejected runs in history" (default on), IntegerFields "Run window (minutes)" 5–240 (30), "QC valid for (hours)" 1–168 (24), "Hold look-back (hours)" 1–168 (24).
//   A live preview paragraph (role status, text starts "Rules:") follows 04-UI-UX §2.6 and mentions "Mode:".
//   POST /v1/quality/qc-plans {instrument_id,test_id,analyte_id,params:QcPlanParams}; row actions "Edit" (new version: params + "Reason for change" 1..500 -> POST …/versions + If-Match), "Activate" (POST …/activate + If-Match),
//   "Deactivate" (reason 1..500 -> POST …/deactivate {reason} + If-Match). Success -> close, toast, router.refresh(). C7/C3 pickers: same permission fallback as the Maps tab (text fields "Instrument ID" / "Test ID" / "Analyte ID").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import {
  ANALYTE_1, BASE, INST_1, LEVEL_1, LEVEL_2, PERM_SETUP_PICKERS, PERM_SETUP_READ, PERM_SETUP_WRITE, PLAN_1, PLAN_2, TEST_1, anyDlg, api, axeClean, bodyOf, btn, calls, callsTo, choose, dlg, field, fieldError, fill, gridNamed, headersOf, json, lvl, lot, material,
  page, pageText, planDto, problem, resetApi, routes, router, rowTexts, search, show, user,
} from './quality-t22.harness';

vi.mock('next/navigation', async () => (await import('./quality-t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t22.harness')).sessionMock);

const PAGE = 'setup/plans/page';
const PLANS = `${BASE}/qc-plans`;
const LEVEL_3 = '01a1a98a-ac40-7000-8000-0000000c4003';
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi(PERM_SETUP_PICKERS));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const save = () => user().click(within(dlg()).getByRole('button', { name: /^(save|create)/i }));
const levelButtons = () => within(dlg()).getAllByRole('button', { name: /level/i }).filter((b) => !/add level|remove level/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
const counts = () => screen.getAllByLabelText(/^count/i) as HTMLInputElement[];
const preview = () => (within(dlg()).getByText(/^Rules:/) as HTMLElement).textContent!.replace(/\s+/g, ' ');
async function openNew() {
  await show(PAGE);
  await user().click(btn(/new plan/i)!);
  return dlg();
}
async function pickTarget() {
  await search(/^instrument/i, 'SYN', /SYN-CHEM-01/);
  await search(/^test/i, 'glu', /Glucose/);
  await choose(/^analyte/i, /Glucose/);
}
/** Selects level i (0-based) in composition row i; adds rows as needed. */
async function composeRow(i: number, levelRe: RegExp, count: number) {
  const u = user();
  while (levelButtons().length <= i) await u.click(within(dlg()).getByRole('button', { name: /add level/i }));
  await u.click(levelButtons()[i]!);
  await u.click(await screen.findByRole('option', { name: levelRe }));
  await u.clear(counts()[i]!);
  await u.type(counts()[i]!, String(count));
}
async function fillPlan() {
  await pickTarget();
  await composeRow(0, /Level 1/, 1);
  await composeRow(1, /Level 2/, 1);
}
const threeLevelMaterial = () => material({ levels: [lvl({ lots: [lot()] }), lvl({ id: LEVEL_2, level_code: '2', display_name: 'Level 2', sort_order: 2 }), lvl({ id: LEVEL_3, level_code: '3', display_name: 'Level 3', sort_order: 3 })] });

describe('access and list', () => {
  it('without quality.qc_run.read: denied state, NO API call', async () => {
    resetApi([]);
    await show(PAGE);
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('empty -> "No QC plans."', async () => {
    routes[`GET ${PLANS}`] = json(page([]));
    await show(PAGE);
    expect(pageText()).toContain('No QC plans.');
  });
  it('columns and rows: instrument, analyte, N, composition with ×count, mean rule, status WORD, version', async () => {
    await show(PAGE);
    const g = gridNamed(/plans/i);
    expect(headersOf(g).join('|')).toMatch(/instrument.*analyte.*N.*composition.*mean rule.*status.*version/i);
    const t = rowTexts(g);
    expect(t[0]).toContain('SYN-CHEM-01');
    expect(t[0]).toContain('GLU');
    expect(t[0]).toMatch(/×\s?1.*×\s?1/);
    expect(t[0]).toContain('10x');
    expect(t[0]).toMatch(/active/i);
    expect(t[0]).toMatch(/\b3\b/); // current_version_no
    expect(t[1]).toMatch(/inactive/i);
    expect(t[1]).toMatch(/×\s?2.*×\s?2/);
    expect(t[1]).toContain('8x');
  });
  it('the Plans tab is selected', async () => {
    await show(PAGE);
    expect(screen.getByRole('tab', { name: /plans/i }).getAttribute('aria-selected')).toBe('true');
  });
  it('axe clean', async () => { await show(PAGE); await axeClean(); });
  it('read-only session: no New plan, Edit, Activate or Deactivate (AC-01.3)', async () => {
    resetApi(PERM_SETUP_READ);
    await show(PAGE);
    expect(btn(/new plan|edit|activate|deactivate/i)).toBeNull();
  });
});

describe('create plan: rule-set preview and parameters (AC-03.1–03.3)', () => {
  it('defaults: N=2, n-x rule 10x, three switches on, 30 / 24 / 24', async () => {
    await openNew();
    expect((within(dlg()).getByRole('radio', { name: '2' }) as HTMLInputElement).checked).toBe(true);
    for (const s of [/2-2s also across runs/i, /count rules across levels/i, /ignore rejected runs in history/i]) expect((within(dlg()).getByRole('switch', { name: s }) as HTMLInputElement).checked).toBe(true);
    expect(field(/run window/i).value).toBe('30');
    expect(field(/qc valid for/i).value).toBe('24');
    expect(field(/hold look-back/i).value).toBe('24');
  });
  it('AC-03.1 N=2 preview: "1-2s warning; reject on 1-3s, 2-2s, R-4s, 4-1s, 10x" and states the tenant mode', async () => {
    await openNew();
    expect(preview()).toContain('1-2s warning; reject on 1-3s, 2-2s, R-4s, 4-1s, 10x');
    expect(preview()).toMatch(/Mode:/);
  });
  it('AC-03.2 N=3 preview: 2of3-2s, 3-1s and 6x by default; 9x selectable, 10x not offered', async () => {
    await openNew();
    await user().click(within(dlg()).getByRole('radio', { name: '3' }));
    expect(preview()).toContain('1-2s warning; reject on 1-3s, 2of3-2s, R-4s, 3-1s, 6x');
    await user().click(within(dlg()).getByRole('button', { name: /n-x rule/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    expect(opts).toEqual(expect.arrayContaining(['6x', '9x']));
    expect(opts).not.toContain('10x');
    await user().click(screen.getByRole('option', { name: '9x' }));
    expect(preview()).toContain('9x');
  });
  it('AC-03.3 N=4 preview: the N=2/4 set with 10x by default; 8x / 10x / 12x selectable; no 6x/9x', async () => {
    await openNew();
    await user().click(within(dlg()).getByRole('radio', { name: '4' }));
    expect(preview()).toContain('1-2s warning; reject on 1-3s, 2-2s, R-4s, 4-1s, 10x');
    await user().click(within(dlg()).getByRole('button', { name: /n-x rule/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    expect(opts).toEqual(expect.arrayContaining(['8x', '10x', '12x']));
    expect(opts).not.toContain('6x');
  });
  it('switching N from 2 to 3 resets a no-longer-allowed mean rule (never submits 10x for N=3)', async () => {
    routes[`POST ${PLANS}`] = json({ ...planDto({ status: 'inactive' }), warnings: [] }, 201);
    routes['GET /v1/quality/control-materials'] = json(page([threeLevelMaterial()]));
    await openNew();
    await pickTarget();
    await user().click(within(dlg()).getByRole('radio', { name: '3' }));
    await composeRow(0, /Level 1/, 1); await composeRow(1, /Level 2/, 1); await composeRow(2, /Level 3/, 1);
    await save();
    await waitFor(() => expect(callsTo('POST', PLANS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', PLANS)[0]).params).toMatchObject({ controls_per_run: 3, mean_rule: '6x' });
  });
  it('analyte options are numeric results only (the free-text analyte is not offered)', async () => {
    await openNew();
    await search(/^test/i, 'glu', /Glucose/);
    await user().click(within(dlg()).getByRole('button', { name: /^analyte/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(opts.some((o) => /Glucose/.test(o))).toBe(true);
    expect(opts.some((o) => /Free-text comment/.test(o))).toBe(false);
  });
});

describe('create plan: POST and validation (#15, AC-03.1, AC-03.4)', () => {
  it('POSTs the spec body (defaults included) with an Idempotency-Key, then closes, toasts and refreshes', async () => {
    routes[`POST ${PLANS}`] = json({ ...planDto({ status: 'inactive', version: 1 }), warnings: [] }, 201);
    await openNew();
    await fillPlan();
    await save();
    await waitFor(() => expect(callsTo('POST', PLANS)).toHaveLength(1));
    const c = callsTo('POST', PLANS)[0]!;
    expect(bodyOf(c)).toEqual({
      instrument_id: INST_1, test_id: TEST_1, analyte_id: ANALYTE_1,
      params: {
        controls_per_run: 2, composition: [{ level_id: LEVEL_1, count: 1 }, { level_id: LEVEL_2, count: 1 }], mean_rule: '10x',
        two_two_s_across_runs: true, count_rules_across_materials: true, exclude_rejected_runs_from_history: true, run_window_minutes: 30, qc_validity_hours: 24, hold_lookback_hours: 24,
      },
    });
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(anyDlg()).toBeNull();
  });
  it('AC-03.3 body for N=4 {L1:2, L2:2}: counts 2 and 2, controls_per_run 4', async () => {
    routes[`POST ${PLANS}`] = json({ ...planDto(), warnings: [] }, 201);
    await openNew();
    await pickTarget();
    await user().click(within(dlg()).getByRole('radio', { name: '4' }));
    await composeRow(0, /Level 1/, 2);
    await composeRow(1, /Level 2/, 2);
    await save();
    await waitFor(() => expect(callsTo('POST', PLANS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', PLANS)[0]).params).toMatchObject({ controls_per_run: 4, composition: [{ level_id: LEVEL_1, count: 2 }, { level_id: LEVEL_2, count: 2 }], mean_rule: '10x' });
  });
  it('AC-03.4 counts must add up to N: message "Counts must add up to N = 2", NO request', async () => {
    await openNew();
    await pickTarget();
    await composeRow(0, /Level 1/, 1);
    await composeRow(1, /Level 2/, 2); // 3 != 2
    await save();
    expect(within(dlg()).getByText('Counts must add up to N = 2')).toBeTruthy();
    expect(callsTo('POST', PLANS)).toHaveLength(0);
  });
  it('the same level twice in the composition is refused, NO request', async () => {
    await openNew();
    await pickTarget();
    await composeRow(0, /Level 1/, 1);
    await composeRow(1, /Level 1/, 1);
    await save();
    expect(callsTo('POST', PLANS)).toHaveLength(0);
  });
  it('Instrument, Test, Analyte are required: submitting empty flags them and sends nothing', async () => {
    await openNew();
    await save();
    expect(within(dlg()).getAllByText(/required/i).length).toBeGreaterThanOrEqual(3);
    expect(callsTo('POST', PLANS)).toHaveLength(0);
  });
  it.each([
    ['Run window (minutes)', /run window/i, '4'], ['Run window (minutes)', /run window/i, '241'],
    ['QC valid for (hours)', /qc valid for/i, '0'], ['QC valid for (hours)', /qc valid for/i, '169'],
    ['Hold look-back (hours)', /hold look-back/i, '0'], ['Hold look-back (hours)', /hold look-back/i, '169'],
  ])('%s = %s is out of range -> refused, NO request', async (_n, label, v) => {
    await openNew();
    await fillPlan();
    await fill(label, v);
    await save();
    expect(callsTo('POST', PLANS)).toHaveLength(0);
    expect(fieldError(field(label))).toBe(true);
  });
  it.each([['5', 5], ['240', 240]])('Run window boundary %s is accepted', async (v, n) => {
    routes[`POST ${PLANS}`] = json({ ...planDto(), warnings: [] }, 201);
    await openNew();
    await fillPlan();
    await fill(/run window/i, v);
    await save();
    await waitFor(() => expect(callsTo('POST', PLANS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', PLANS)[0]).params.run_window_minutes).toBe(n);
  });
  it('a count of 0 or 5 is refused (1–4)', async () => {
    for (const bad of ['0', '5']) {
      cleanup();
      await openNew();
      await pickTarget();
      await composeRow(0, /Level 1/, 1);
      await composeRow(1, /Level 2/, 1);
      await fill(/^count/i, bad);
      await save();
      expect(callsTo('POST', PLANS)).toHaveLength(0);
    }
  });
  it('switches off are sent as false (not omitted)', async () => {
    routes[`POST ${PLANS}`] = json({ ...planDto(), warnings: [] }, 201);
    await openNew();
    await fillPlan();
    await user().click(within(dlg()).getByRole('switch', { name: /2-2s also across runs/i }));
    await save();
    await waitFor(() => expect(callsTo('POST', PLANS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', PLANS)[0]).params.two_two_s_across_runs).toBe(false);
  });
  it('AC-03.5 409 quality.code_duplicate (a plan for this instrument and analyte exists) -> message in the dialog, which stays open', async () => {
    routes[`POST ${PLANS}`] = () => problem('quality.code_duplicate', 409);
    await openNew();
    await fillPlan();
    await save();
    await waitFor(() => expect(within(dlg()).getByText(/already/i)).toBeTruthy());
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('400 common.validation_failed from the API names the field (pointer /params/composition) next to the composition', async () => {
    routes[`POST ${PLANS}`] = () => problem('common.validation_failed', 400, { errors: [{ pointer: '/params/composition', code: 'common.invalid', message: 'Composition is invalid for N.' }] });
    await openNew();
    await fillPlan();
    await save();
    await waitFor(() => expect(within(dlg()).getByText('Composition is invalid for N.')).toBeTruthy());
  });
  it('response warning instrument_code_unmapped shows the warning Banner text from 04-UI-UX §2.6', async () => {
    routes[`POST ${PLANS}`] = json({ ...planDto({ status: 'inactive' }), warnings: ['instrument_code_unmapped'] }, 201);
    await openNew();
    await fillPlan();
    await save();
    await waitFor(() => expect(pageText()).toContain('This analyte has no code map for this instrument in Catalog; QC values will arrive unmapped until it is added.'));
  });
  it('a double click on Save sends ONE request', async () => {
    routes[`POST ${PLANS}`] = json({ ...planDto(), warnings: [] }, 201);
    await openNew();
    await fillPlan();
    await user().dblClick(within(dlg()).getByRole('button', { name: /^(save|create)/i }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(callsTo('POST', PLANS)).toHaveLength(1);
  });
  it('server 403 keeps the dialog open with a permission message', async () => {
    routes[`POST ${PLANS}`] = () => problem('auth.forbidden', 403);
    await openNew();
    await fillPlan();
    await save();
    await waitFor(() => expect(pageText()).toMatch(/permission|not allowed|forbidden/i));
    expect(anyDlg()).not.toBeNull();
  });
});

describe('C3 / C7 pickers with permission fallback', () => {
  it('with both read permissions the pickers read C7 then C3 through the BFF; selecting a test loads that test for its analytes', async () => {
    await openNew();
    await pickTarget();
    expect(callsTo('GET', '/v1/instruments/instruments').length).toBeGreaterThan(0);
    expect(callsTo('GET', '/v1/catalog/tests').length).toBeGreaterThan(0);
    expect(callsTo('GET', `/v1/catalog/tests/${TEST_1}`).length).toBeGreaterThan(0);
  });
  it('without catalog.test.read: NO /v1/catalog request; Test ID and Analyte ID become UUID text fields and the form still posts them', async () => {
    resetApi([...PERM_SETUP_WRITE, 'instruments.instrument.read']);
    routes[`POST ${PLANS}`] = json({ ...planDto(), warnings: [] }, 201);
    await openNew();
    await search(/^instrument/i, 'SYN', /SYN-CHEM-01/);
    await fill(/test id/i, TEST_1);
    await fill(/analyte id/i, ANALYTE_1);
    await composeRow(0, /Level 1/, 1);
    await composeRow(1, /Level 2/, 1);
    await save();
    await waitFor(() => expect(callsTo('POST', PLANS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', PLANS)[0])).toMatchObject({ instrument_id: INST_1, test_id: TEST_1, analyte_id: ANALYTE_1 });
    expect(calls.filter((c) => c.url.pathname.startsWith('/v1/catalog'))).toHaveLength(0);
  });
  it('without instruments.instrument.read: NO /v1/instruments request; Instrument ID text field; malformed id refused', async () => {
    resetApi([...PERM_SETUP_WRITE, 'catalog.test.read']);
    await openNew();
    expect(calls.filter((c) => c.url.pathname.startsWith('/v1/instruments'))).toHaveLength(0);
    await fill(/instrument id/i, 'nope');
    await search(/^test/i, 'glu', /Glucose/);
    await choose(/^analyte/i, /Glucose/);
    await composeRow(0, /Level 1/, 1);
    await composeRow(1, /Level 2/, 1);
    await save();
    expect(callsTo('POST', PLANS)).toHaveLength(0);
    expect(fieldError(field(/instrument id/i))).toBe(true);
  });
  it('a 403 from C3 while typing in Test degrades to the text fields without losing what the user already entered', async () => {
    routes['GET /v1/catalog/tests'] = () => problem('auth.forbidden', 403);
    await openNew();
    await search(/^instrument/i, 'SYN', /SYN-CHEM-01/);
    await user().type(within(dlg()).getByRole('combobox', { name: /^test/i }), 'glu');
    await waitFor(() => expect(within(dlg()).getByLabelText(/test id/i)).toBeTruthy());
    expect(within(dlg()).getByText(/SYN-CHEM-01/)).toBeTruthy(); // the instrument chosen before the failure is kept
  });
});

describe('edit = new version (#17), activate (#18), deactivate (#19)', () => {
  const row = (i: number) => within(gridNamed(/plans/i)).getAllByRole('row')[i + 1]!;
  it('Edit opens the form with the plan values; instrument / test / analyte are read-only; Reason for change is required (1–500)', async () => {
    await show(PAGE);
    const u = user();
    await u.click(within(row(0)).getByRole('button', { name: /edit/i }));
    expect(within(dlg()).queryByRole('combobox', { name: /^instrument/i })).toBeNull();
    expect(pageText()).toContain('SYN-CHEM-01');
    expect(field(/reason for change/i).maxLength).toBe(500);
    await save();
    expect(callsTo('POST', `${PLANS}/${PLAN_1}/versions`)).toHaveLength(0);
    expect(fieldError(field(/reason for change/i))).toBe(true);
  });
  it('saving POSTs {params, change_reason} with If-Match "<version>" (4) and Idempotency-Key; refresh', async () => {
    routes[`POST ${PLANS}/${PLAN_1}/versions`] = json(planDto({ version: 5, current_version_no: 4 }));
    await show(PAGE);
    const u = user();
    await u.click(within(row(0)).getByRole('button', { name: /edit/i }));
    await fill(/run window/i, '45');
    await fill(/reason for change/i, 'Widen the window for the night shift');
    await save();
    await waitFor(() => expect(callsTo('POST', `${PLANS}/${PLAN_1}/versions`)).toHaveLength(1));
    const c = callsTo('POST', `${PLANS}/${PLAN_1}/versions`)[0]!;
    expect(bodyOf(c)).toMatchObject({ change_reason: 'Widen the window for the night shift', params: { run_window_minutes: 45, controls_per_run: 2 } });
    expect(c.headers.get('if-match')).toBe('"4"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('only an inactive plan offers Activate; only an active plan offers Deactivate', async () => {
    await show(PAGE);
    expect(btn(/^deactivate/i, row(0))).toBeTruthy(); // plan 1 is active
    expect(btn(/^activate/i, row(0))).toBeNull();
    expect(btn(/^activate/i, row(1))).toBeTruthy(); // plan 2 is inactive
    expect(btn(/^deactivate/i, row(1))).toBeNull();
  });
  it('Activate: POST …/activate {} with If-Match "<version>" and Idempotency-Key', async () => {
    routes[`POST ${PLANS}/${PLAN_2}/activate`] = json(planDto({ id: PLAN_2, status: 'active', version: 2 }));
    await show(PAGE);
    const u = user();
    await u.click(within(row(1)).getByRole('button', { name: /^activate/i }));
    const confirm = screen.queryByRole('alertdialog');
    if (confirm) await u.click(within(confirm).getByRole('button', { name: /activate/i }));
    await waitFor(() => expect(callsTo('POST', `${PLANS}/${PLAN_2}/activate`)).toHaveLength(1));
    const c = callsTo('POST', `${PLANS}/${PLAN_2}/activate`)[0]!;
    expect(bodyOf(c)).toEqual({});
    expect(c.headers.get('if-match')).toBe('"1"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
  });
  it('422 quality.qc_target_missing -> "Add an active target for every level in the plan first." with a link to the Targets tab for THAT plan', async () => {
    routes[`POST ${PLANS}/${PLAN_2}/activate`] = () => problem('quality.qc_target_missing', 422);
    await show(PAGE);
    const u = user();
    await u.click(within(row(1)).getByRole('button', { name: /^activate/i }));
    const confirm = screen.queryByRole('alertdialog');
    if (confirm) await u.click(within(confirm).getByRole('button', { name: /activate/i }));
    await waitFor(() => expect(pageText()).toContain('Add an active target for every level in the plan first.'));
    const link = screen.getAllByRole('link').find((a) => (a.getAttribute('href') ?? '').includes(`/quality/setup/targets?plan_id=${PLAN_2}`));
    expect(link, 'link to /quality/setup/targets?plan_id=<plan>').toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('Deactivate needs a reason (1–500): empty is refused, then POST …/deactivate {reason} with If-Match "<version>"', async () => {
    routes[`POST ${PLANS}/${PLAN_1}/deactivate`] = json(planDto({ status: 'inactive', version: 5 }));
    await show(PAGE);
    const u = user();
    await u.click(within(row(0)).getByRole('button', { name: /deactivate/i }));
    expect(field(/reason/i).maxLength).toBe(500);
    await u.click(within(dlg()).getByRole('button', { name: /deactivate/i }));
    expect(callsTo('POST', `${PLANS}/${PLAN_1}/deactivate`)).toHaveLength(0);
    await fill(/reason/i, 'Analyser under service');
    await u.click(within(dlg()).getByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(callsTo('POST', `${PLANS}/${PLAN_1}/deactivate`)).toHaveLength(1));
    const c = callsTo('POST', `${PLANS}/${PLAN_1}/deactivate`)[0]!;
    expect(bodyOf(c)).toEqual({ reason: 'Analyser under service' });
    expect(c.headers.get('if-match')).toBe('"4"');
  });
  it('a stale If-Match (412) is explained, not swallowed', async () => {
    routes[`POST ${PLANS}/${PLAN_1}/deactivate`] = () => problem('common.version_conflict', 412);
    await show(PAGE);
    const u = user();
    await u.click(within(row(0)).getByRole('button', { name: /deactivate/i }));
    await fill(/reason/i, 'Analyser under service');
    await u.click(within(dlg()).getByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(pageText()).toMatch(/changed by someone else|reload|out of date|newer version/i));
  });
});
