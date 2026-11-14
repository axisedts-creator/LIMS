// @vitest-environment jsdom
// C9.T-22 — QC set-up › Targets tab `/quality/setup/targets?plan_id=` (04-UI-UX §2.6; 03-APP-FLOW §4; AC-04.1–04.7; 02-TRD §5.3 #20–#25; 07-SECURITY: targets are integrity-critical, qc.manage only).
// ASSUMED contract (writer must follow): app/(staff)/quality/setup/targets/page.tsx = async server component `Page({ searchParams })`; Tabs header (Targets selected).
//   No (or malformed) plan_id -> a plan picker (Combobox "Plan", options from GET /v1/quality/qc-plans) and the text "Choose a plan to see its targets."; NO GET /qc-targets. Choosing a plan router.push('/quality/setup/targets?plan_id=<id>').
//   With plan_id: GET /v1/quality/qc-targets?plan_id=<id> (+ GET /qc-plans/{id} for decimals/unit, GET /control-materials for level/lot names). Grid label /targets/i, columns Level, Lot, Mean, SD, CV %, Unit, Source, Status, Effective.
//   Source cell: "Manufacturer" or "Established (n = 25)". Row actions by status: draft -> "Activate", "Discard"; active -> "Retire"; others none. There is NO edit of mean/SD anywhere (AC-04.6).
//   "New target" Dialog: "Lot" Select, "Mean" + "SD" DecimalFields (decimals = analyte decimals + 2), "Unit" read-only text, "Source" read-only text "Manufacturer", "Note" TextArea 500.
//     POST /v1/quality/qc-targets {plan_id, lot_id, mean:"<string>", sd:"<string>", unit_code, source:"manufacturer", note?}, Idempotency-Key set. Numbers are STRINGS, never JS numbers (decimal-only rule 02-TRD §7.6).
//   "Establish from data" wizard (Dialog, buttons "Next" / "Back" / "Establish"): step 1 "Lot" Select + period (default: last 30 days, ≤ 92 d), step 2 preview n / mean / SD (n−1) / CV from GET /v1/quality/qc-observations
//     (plan_id, lot_id, observed_at_from/to, status assigned) with a checkbox per point (all checked), step 3 confirm -> POST /v1/quality/qc-targets/establish {plan_id, lot_id, observed_at_from, observed_at_to, exclude_observation_ids? | include_observation_ids?}.
//   Actions: Activate = ConfirmDialog "Activate this target from now? The current target for this lot will be superseded." -> POST …/activate {} + If-Match; Retire = reason 1..500 -> POST …/retire {reason} + If-Match; Discard -> POST …/discard {} + If-Match.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import {
  BASE, LOT_1, OBS, PERM_SETUP_READ, PERM_SETUP_WRITE, PLAN_1, TGT_1, TGT_2, anyDlg, api, axeClean, bodyOf, btn, calls, callsTo, choose, dlg, field, fieldError, fill, gridNamed, headersOf, json, lastNav, page, pageText, planDto, problem, resetApi, routes, router, rowTexts, show, showOrThrown, target, user,
} from './quality-t22.harness';

vi.mock('next/navigation', async () => (await import('./quality-t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t22.harness')).sessionMock);

const PAGE = 'setup/targets/page';
const TARGETS = `${BASE}/qc-targets`;
const OBSERVATIONS = `${BASE}/qc-observations`;
const props = (plan: string | undefined = PLAN_1) => ({ searchParams: plan === undefined ? {} : { plan_id: plan } });
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  resetApi(PERM_SETUP_WRITE);
  routes[`GET ${BASE}/qc-plans/${PLAN_1}`] = json(planDto());
});
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

// 25 synthetic points: 100 + 0.5k for k = -12..12 -> n 25, mean 100.0, sample SD 3.6799 (n-1), CV 3.68 %
const points = () => Array.from({ length: 25 }, (_, i) => ({
  id: OBS(i), version: 1, plan_id: PLAN_1, instrument_id: 'x', analyte_id: 'x', lot_id: LOT_1, control_id_raw: 'QC-L1', value: (100 + (i - 12) * 0.5).toFixed(1), unit_code: 'mg_dl',
  observed_at: `2026-11-${String(1 + (i % 12)).padStart(2, '0')}T0${i % 9}:00:00.000Z`, received_at: '2026-11-13T00:00:00.000Z', observed_at_basis: 'instrument', source: 'instrument', status: 'assigned', z: '0.000',
}));
async function openWizard(pts = points()) {
  routes[`GET ${OBSERVATIONS}`] = json(page(pts));
  await show(PAGE, props());
  await user().click(btn(/establish from data/i)!);
  await choose(/\blot\b/i, /LOT-SYN-01/);
  await user().click(within(dlg()).getByRole('button', { name: /next/i }));
}
const save = () => user().click(within(dlg()).getByRole('button', { name: /^(save|create)/i }));
const row = (i: number) => within(gridNamed(/targets/i)).getAllByRole('row')[i + 1]!;

describe('plan selection and access', () => {
  it('without quality.qc_run.read: denied state, NO API call', async () => {
    resetApi([]);
    await show(PAGE, props());
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('no plan_id: asks for a plan; NO targets request', async () => {
    await show(PAGE, props(undefined));
    expect(pageText()).toContain('Choose a plan to see its targets.');
    expect(callsTo('GET', TARGETS)).toHaveLength(0);
  });
  it.each(['not-a-uuid', '../x', `${PLAN_1}' OR 1=1`])('malformed plan_id %j is ignored like "no plan": NO targets request', async (bad) => {
    await show(PAGE, props(bad));
    expect(pageText()).toContain('Choose a plan to see its targets.');
    expect(callsTo('GET', TARGETS)).toHaveLength(0);
  });
  it('choosing a plan in the picker navigates to ?plan_id=<id>', async () => {
    await show(PAGE, props(undefined));
    const u = user();
    await u.click(screen.getByRole('combobox', { name: /plan/i }));
    await u.keyboard('GLU');
    await u.click(await screen.findByRole('option', { name: /GLU/ }));
    expect(lastNav()).toBe(`/quality/setup/targets?plan_id=${PLAN_1}`);
  });
  it('the request carries plan_id and the Targets tab is selected', async () => {
    await show(PAGE, props());
    expect(callsTo('GET', TARGETS)[0]!.url.searchParams.get('plan_id')).toBe(PLAN_1);
    expect(screen.getByRole('tab', { name: /targets/i }).getAttribute('aria-selected')).toBe('true');
  });
  it('empty plan -> "No targets for this plan."', async () => {
    routes[`GET ${TARGETS}`] = json(page([]));
    await show(PAGE, props());
    expect(pageText()).toContain('No targets for this plan.');
  });
  it('API 5xx rejects (error.tsx)', async () => {
    routes[`GET ${TARGETS}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE, props())).toBeTruthy(); // a MISSING module rethrows, so this cannot pass vacuously
  });
});

describe('list (AC-04.1, AC-04.2, AC-04.5)', () => {
  it('columns Level, Lot, Mean, SD, CV %, Unit, Source, Status, Effective', async () => {
    await show(PAGE, props());
    const h = headersOf(gridNamed(/targets/i)).join('|');
    for (const c of [/level/i, /lot/i, /mean/i, /\bsd\b/i, /cv/i, /unit/i, /source/i, /status/i, /effective/i]) expect(h).toMatch(c);
  });
  it('source reads "Manufacturer" or "Established (n = 25)"; status is a word; mean/SD are the decimal strings', async () => {
    await show(PAGE, props());
    const t = rowTexts(gridNamed(/targets/i));
    expect(t[0]).toContain('Manufacturer');
    expect(t[0]).toMatch(/active/i);
    expect(t[0]).toContain('100.0');
    expect(t[0]).toContain('LOT-SYN-01');
    expect(t[1]).toContain('Established (n = 25)');
    expect(t[1]).toMatch(/draft/i);
    expect(t[2]).toMatch(/superseded/i);
  });
  it('a superseded target shows its effective-from AND effective-to dates (AC-04.5: old points keep that snapshot)', async () => {
    await show(PAGE, props());
    expect(rowTexts(gridNamed(/targets/i))[2]).toMatch(/01\/10\/2026.*01\/11\/2026/);
  });
  it('axe clean', async () => { await show(PAGE, props()); await axeClean(); });
});

describe('actions by status and permission (AC-04.6, AC-01.3)', () => {
  it('draft offers Activate + Discard; active offers Retire only; superseded offers nothing; nothing offers an edit of mean or SD', async () => {
    await show(PAGE, props());
    expect(btn(/^activate/i, row(1))).toBeTruthy();
    expect(btn(/^discard/i, row(1))).toBeTruthy();
    expect(btn(/^retire/i, row(1))).toBeNull();
    expect(btn(/^retire/i, row(0))).toBeTruthy();
    expect(btn(/^activate|^discard/i, row(0))).toBeNull();
    expect(within(row(2)).queryAllByRole('button')).toHaveLength(0);
    expect(btn(/^edit|change mean|change sd/i)).toBeNull();
    for (const t of rowTexts(gridNamed(/targets/i))) expect(t).not.toMatch(/\bedit\b/i);
  });
  it('mean and SD cells of an active target are plain text, not inputs', async () => {
    await show(PAGE, props());
    expect(within(row(0)).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(row(0)).queryAllByRole('spinbutton')).toHaveLength(0);
  });
  it('read-only session (lab_technologist): no New target, Establish, Activate, Retire or Discard', async () => {
    resetApi(PERM_SETUP_READ);
    routes[`GET ${BASE}/qc-plans/${PLAN_1}`] = json(planDto());
    await show(PAGE, props());
    expect(btn(/new target|establish from data|^activate|^retire|^discard/i)).toBeNull();
  });
});

describe('new manual target (#21, AC-04.1, AC-04.4)', () => {
  async function openNew() {
    await show(PAGE, props());
    await user().click(btn(/new target/i)!);
    return dlg();
  }
  const fillTarget = async (mean = '100.0', sd = '2.0') => { await choose(/\blot\b/i, /LOT-SYN-01/); await fill(/^mean/i, mean); await fill(/^sd/i, sd); };
  it('Source is read-only text "Manufacturer" (no way to pick "established"), Unit is read-only from the analyte, Note max 500', async () => {
    await openNew();
    expect(within(dlg()).getByText('Manufacturer')).toBeTruthy();
    expect(within(dlg()).queryByRole('combobox', { name: /source/i })).toBeNull();
    expect(within(dlg()).queryByRole('button', { name: /^source/i })).toBeNull();
    expect(pageText()).toContain('mg_dl');
    expect(within(dlg()).queryByLabelText(/^unit/i, { selector: 'input:not([readonly]):not([disabled])' })).toBeNull();
    expect(field(/note/i).maxLength).toBe(500);
  });
  it('POSTs strings: {plan_id, lot_id, mean:"100.0", sd:"2.0", unit_code:"mg_dl", source:"manufacturer"}; Idempotency-Key; empty note omitted; closes + refresh', async () => {
    routes[`POST ${TARGETS}`] = json(target({ status: 'draft', id: TGT_2 }), 201);
    await openNew();
    await fillTarget();
    await save();
    await waitFor(() => expect(callsTo('POST', TARGETS)).toHaveLength(1));
    const c = callsTo('POST', TARGETS)[0]!;
    expect(bodyOf(c)).toEqual({ plan_id: PLAN_1, lot_id: LOT_1, mean: '100.0', sd: '2.0', unit_code: 'mg_dl', source: 'manufacturer' });
    expect(typeof bodyOf(c).mean).toBe('string');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(anyDlg()).toBeNull();
  });
  it('a note is sent when filled', async () => {
    routes[`POST ${TARGETS}`] = json(target({ status: 'draft' }), 201);
    await openNew();
    await fillTarget();
    await fill(/note/i, 'Package insert, lot 01');
    await save();
    await waitFor(() => expect(callsTo('POST', TARGETS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', TARGETS)[0]).note).toBe('Package insert, lot 01');
  });
  it.each([['0'], ['0.0'], ['-1'], ['-0.5'], ['abc'], ['']])('AC-04.4 SD %j (≤ 0 or not a number) is refused in the form, NO request', async (sd) => {
    await openNew();
    await fillTarget('100.0', sd);
    await save();
    expect(callsTo('POST', TARGETS)).toHaveLength(0);
    expect(fieldError(field(/^sd/i))).toBe(true);
  });
  it.each([[''], ['abc'], ['1e3']])('Mean %j is refused, NO request', async (mean) => {
    await openNew();
    await fillTarget(mean, '2.0');
    await save();
    expect(callsTo('POST', TARGETS)).toHaveLength(0);
  });
  it('more decimals than analyte decimals + 2 (3) are never sent: blocked or cut to 3', async () => {
    routes[`POST ${TARGETS}`] = json(target({ status: 'draft' }), 201);
    await openNew();
    await fillTarget('100.12345', '2.0');
    await save();
    const c = callsTo('POST', TARGETS)[0];
    if (c) expect(bodyOf(c).mean).toMatch(/^\d+(\.\d{1,3})?$/);
    else expect(fieldError(field(/^mean/i))).toBe(true);
  });
  it('Lot is required', async () => {
    await openNew();
    await fill(/^mean/i, '100.0');
    await fill(/^sd/i, '2.0');
    await save();
    expect(callsTo('POST', TARGETS)).toHaveLength(0);
  });
  it('the Lot options are the lots of the levels in the plan only', async () => {
    await openNew();
    await user().click(within(dlg()).getByRole('button', { name: /\blot\b/i }));
    const o = (await screen.findAllByRole('option')).map((x) => x.textContent ?? '');
    expect(o.some((t) => t.includes('LOT-SYN-01'))).toBe(true);
    expect(o.some((t) => t.includes('LOT-SYN-02'))).toBe(true);
  });
  it('400 common.validation_failed on /sd from the API -> error on SD; dialog stays', async () => {
    routes[`POST ${TARGETS}`] = () => problem('common.validation_failed', 400, { errors: [{ pointer: '/sd', code: 'common.out_of_range', message: 'SD must be greater than zero.' }] });
    await openNew();
    await fillTarget();
    await save();
    await waitFor(() => expect(within(dlg()).getByText('SD must be greater than zero.')).toBeTruthy());
  });
  it('422 quality.lot_expired -> "Expiry date is in the past." style message on the lot, dialog stays', async () => {
    routes[`POST ${TARGETS}`] = () => problem('quality.lot_expired', 422);
    await openNew();
    await fillTarget();
    await save();
    await waitFor(() => expect(within(dlg()).getByText(/expired|in the past/i)).toBeTruthy());
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('403 auth.forbidden keeps the dialog open with a permission message', async () => {
    routes[`POST ${TARGETS}`] = () => problem('auth.forbidden', 403);
    await openNew();
    await fillTarget();
    await save();
    await waitFor(() => expect(pageText()).toMatch(/permission|not allowed|forbidden/i));
    expect(anyDlg()).not.toBeNull();
  });
  it('a double click on Save sends ONE request', async () => {
    routes[`POST ${TARGETS}`] = json(target({ status: 'draft' }), 201);
    await openNew();
    await fillTarget();
    await user().dblClick(within(dlg()).getByRole('button', { name: /^(save|create)/i }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(callsTo('POST', TARGETS)).toHaveLength(1);
  });
});

describe('establish from data wizard (#22, AC-04.2, AC-04.3)', () => {
  const EST = `${TARGETS}/establish`;
  it('step 2 reads the lot\'s accepted observations for the plan and previews n, mean, SD (n − 1) and CV for 25 points', async () => {
    await openWizard();
    const q = callsTo('GET', OBSERVATIONS).at(-1)!.url.searchParams;
    expect(q.get('plan_id')).toBe(PLAN_1);
    expect(q.get('lot_id')).toBe(LOT_1);
    expect(q.get('observed_at_from')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const t = pageText();
    expect(within(dlg()).getByText(/\bn\b/i)).toBeTruthy();
    expect(t).toMatch(/\b25\b/);
    expect(t).toContain('100.0');
    expect(t).toContain('3.68');
  });
  it('every point has a checkbox (checked); un-ticking one recalculates the preview to n = 24', async () => {
    await openWizard();
    const boxes = within(dlg()).getAllByRole('checkbox');
    expect(boxes.filter((b) => (b as HTMLInputElement).checked)).toHaveLength(25);
    await user().click(boxes[0]!);
    await waitFor(() => expect(within(dlg()).getByText(/\b24\b/)).toBeTruthy());
  });
  it('confirm POSTs {plan_id, lot_id, observed_at_from, observed_at_to (ISO UTC, ≤ 92 days, from < to)} with Idempotency-Key; closes + refresh', async () => {
    routes[`POST ${EST}`] = json(target({ status: 'draft', source: 'established', basis: { n: 25, from: '2026-10-15T00:00:00.000Z', to: '2026-11-14T00:00:00.000Z', observation_ids_sha256: 'b'.repeat(64) } }), 201);
    await openWizard();
    await user().click(within(dlg()).getByRole('button', { name: /next|establish/i }));
    const confirm = within(dlg()).queryByRole('button', { name: /^establish/i });
    if (confirm) await user().click(confirm);
    await waitFor(() => expect(callsTo('POST', EST)).toHaveLength(1));
    const c = callsTo('POST', EST)[0]!;
    const b = bodyOf(c);
    expect(b).toMatchObject({ plan_id: PLAN_1, lot_id: LOT_1 });
    expect(b.observed_at_from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
    expect(b.observed_at_to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
    const span = Date.parse(b.observed_at_to) - Date.parse(b.observed_at_from);
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThanOrEqual(92 * 86_400_000);
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('un-ticked points are sent: exclude_observation_ids = exactly those two ids (or include_observation_ids = the other 23)', async () => {
    routes[`POST ${EST}`] = json(target({ status: 'draft', source: 'established' }), 201);
    await openWizard();
    const boxes = within(dlg()).getAllByRole('checkbox');
    await user().click(boxes[0]!);
    await user().click(boxes[1]!);
    await user().click(within(dlg()).getByRole('button', { name: /next|establish/i }));
    const confirm = within(dlg()).queryByRole('button', { name: /^establish/i });
    if (confirm) await user().click(confirm);
    await waitFor(() => expect(callsTo('POST', EST)).toHaveLength(1));
    const b = bodyOf(callsTo('POST', EST)[0]);
    if (b.exclude_observation_ids) expect(b.exclude_observation_ids).toHaveLength(2);
    else expect(b.include_observation_ids).toHaveLength(23);
  });
  it('AC-04.3 422 quality.insufficient_qc_data -> inline message in the wizard (not a toast only), wizard stays open, no refresh', async () => {
    routes[`POST ${EST}`] = () => problem('quality.insufficient_qc_data', 422);
    await openWizard();
    await user().click(within(dlg()).getByRole('button', { name: /next|establish/i }));
    const confirm = within(dlg()).queryByRole('button', { name: /^establish/i });
    if (confirm) await user().click(confirm);
    await waitFor(() => expect(within(dlg()).getByText(/not enough|at least|insufficient/i)).toBeTruthy());
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('no observations in the period: preview says so and Establish cannot be sent', async () => {
    await openWizard([]);
    expect(within(dlg()).getByText(/no (accepted )?observations|not enough/i)).toBeTruthy();
    const go = within(dlg()).queryByRole('button', { name: /^establish|next/i });
    if (go) await user().click(go);
    expect(callsTo('POST', EST)).toHaveLength(0);
  });
  it('the wizard offers no way to type mean or SD (established values come only from data, AC-04.1)', async () => {
    await openWizard();
    expect(within(dlg()).queryByLabelText(/^mean/i)).toBeNull();
    expect(within(dlg()).queryByLabelText(/^sd/i)).toBeNull();
  });
  it('Back returns to the lot step; Esc closes without a POST', async () => {
    await openWizard();
    await user().click(within(dlg()).getByRole('button', { name: /back/i }));
    expect(within(dlg()).getByRole('button', { name: /\blot\b/i })).toBeTruthy();
    await user().keyboard('{Escape}');
    await waitFor(() => expect(anyDlg()).toBeNull());
    expect(callsTo('POST', EST)).toHaveLength(0);
  });
});

describe('activate (#23), retire (#24), discard (#25)', () => {
  it('Activate: ConfirmDialog with the spec text, then POST …/activate {} with If-Match "<version>" and Idempotency-Key; refresh', async () => {
    routes[`POST ${TARGETS}/${TGT_2}/activate`] = json(target({ id: TGT_2, status: 'active', version: 3 }));
    await show(PAGE, props());
    const u = user();
    await u.click(within(row(1)).getByRole('button', { name: /^activate/i }));
    expect(screen.getByRole('alertdialog').textContent).toContain('Activate this target from now? The current target for this lot will be superseded.');
    await u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /activate/i }));
    await waitFor(() => expect(callsTo('POST', `${TARGETS}/${TGT_2}/activate`)).toHaveLength(1));
    const c = callsTo('POST', `${TARGETS}/${TGT_2}/activate`)[0]!;
    expect(bodyOf(c)).toEqual({});
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('cancelling the Activate ConfirmDialog sends nothing', async () => {
    await show(PAGE, props());
    const u = user();
    await u.click(within(row(1)).getByRole('button', { name: /^activate/i }));
    await u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /cancel/i }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('AC-04.6 409 common.immutable_record on activate/retire/discard is explained ("can no longer be changed"-style) and the table is refreshed', async () => {
    routes[`POST ${TARGETS}/${TGT_2}/activate`] = () => problem('common.immutable_record', 409);
    await show(PAGE, props());
    const u = user();
    await u.click(within(row(1)).getByRole('button', { name: /^activate/i }));
    await u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /activate/i }));
    await waitFor(() => expect(pageText()).toMatch(/no longer|already|cannot be changed|can't be changed|immutable/i));
  });
  it('Retire needs a reason (1–500): empty refused; then POST …/retire {reason} with If-Match "<version>"', async () => {
    routes[`POST ${TARGETS}/${TGT_1}/retire`] = json(target({ status: 'retired', version: 3 }));
    await show(PAGE, props());
    const u = user();
    await u.click(within(row(0)).getByRole('button', { name: /^retire/i }));
    expect(field(/reason/i).maxLength).toBe(500);
    await u.click(within(dlg()).getByRole('button', { name: /retire/i }));
    expect(callsTo('POST', `${TARGETS}/${TGT_1}/retire`)).toHaveLength(0);
    await fill(/reason/i, 'Lot depleted');
    await u.click(within(dlg()).getByRole('button', { name: /retire/i }));
    await waitFor(() => expect(callsTo('POST', `${TARGETS}/${TGT_1}/retire`)).toHaveLength(1));
    const c = callsTo('POST', `${TARGETS}/${TGT_1}/retire`)[0]!;
    expect(bodyOf(c)).toEqual({ reason: 'Lot depleted' });
    expect(c.headers.get('if-match')).toBe('"2"');
  });
  it('Discard (draft only): ConfirmDialog, then POST …/discard {} with If-Match', async () => {
    routes[`POST ${TARGETS}/${TGT_2}/discard`] = json(target({ id: TGT_2, status: 'discarded', version: 3 }));
    await show(PAGE, props());
    const u = user();
    await u.click(within(row(1)).getByRole('button', { name: /^discard/i }));
    await u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /discard/i }));
    await waitFor(() => expect(callsTo('POST', `${TARGETS}/${TGT_2}/discard`)).toHaveLength(1));
    const c = callsTo('POST', `${TARGETS}/${TGT_2}/discard`)[0]!;
    expect(bodyOf(c)).toEqual({});
    expect(c.headers.get('if-match')).toBe('"2"');
  });
  it('a stale If-Match (412) is explained, not swallowed', async () => {
    routes[`POST ${TARGETS}/${TGT_2}/activate`] = () => problem('common.version_conflict', 412);
    await show(PAGE, props());
    const u = user();
    await u.click(within(row(1)).getByRole('button', { name: /^activate/i }));
    await u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /activate/i }));
    await waitFor(() => expect(pageText()).toMatch(/changed by someone else|reload|out of date|newer version/i));
  });
});
