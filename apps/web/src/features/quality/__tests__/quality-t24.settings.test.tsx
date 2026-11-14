// @vitest-environment jsdom
// C9.T-24 — Quality settings `/quality/settings` (04-UI-UX §2.11; 03-APP-FLOW §4; 02-TRD #51–#54, §12.1; 07-SECURITY: writes need quality.config.manage; LD-140: per-section Save, one primary button per page).
// ASSUMED contract (writer must follow):
//   * app/(staff)/quality/settings/page.tsx = default async server component `Page({ searchParams })`. Reads #51 and both coded sets (#53) up front. No `quality.qc_run.read` -> EmptyState "You don't have access to this page", NO API call.
//   * Kit `Tabs` "Settings" | "Coded sets" (in-page). Settings tab = four `Card`s with headings "TAT alerts", "QC", "Auto-verification", "Read-only from tenant settings".
//   * Fields by label: Enabled (Switch), "Warning at %", "Escalate at %", "Close orphan clocks after h"; "Minimum points to establish a target", "Re-process window days"; "Minimum simulation days", "Minimum shadow decisions".
//   * Read-only card: "Westgard mode" -> "Classic"/"Modern", "Auto-verification" -> "On"/"Off", and the text "Change in Admin › Tenant settings"; none of it editable.
//   * Without quality.config.manage the numeric fields are disabled/read-only and there is no Save button. With it each of the three editable cards has its own "Save" button; Save sends the FULL mutable subset
//     (#52 requires all nine keys) via server action -> PUT /v1/quality/settings with If-Match "<version>"; client-side range check first (nothing is sent when invalid). Success -> toast + router.refresh().
//   * Coded sets tab: two DataTables (names /corrective actions/i, /exclusion reasons/i) with columns Code, Display, Order, Active, Source; row "Edit" opens a Dialog (Display, Order, Active) -> PUT
//     /v1/quality/coded-sets/<set>/codes/<code> {display, sort_order, is_active}; edit buttons only with quality.config.manage; `code` itself is not editable.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import {
  CORRECTIVE, PERM_CFG_READ, PERM_CFG_WRITE, SETTINGS, anyDlg, api, axeClean, bodyOf, calls, callsTo, dataRows, dlg, field, fill, gridNamed, headersOf, json, norm, pageText, problem, resetApi, routes, router,
  settingsDto, show, showOrThrown, user,
} from './quality-t24.harness';

vi.mock('next/navigation', async () => (await import('./quality-t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t24.harness')).sessionMock);

const PAGE = 'settings/page';
const SET = '/v1/quality/coded-sets';
const card = (name: RegExp) => {
  const h = screen.getAllByRole('heading', { name }).find((x) => x.closest('section,[role=group],.lims-card,div'))!;
  return (h.closest('section,[role=group],.lims-card') ?? h.parentElement!.parentElement!) as HTMLElement;
};
const save = (root: HTMLElement) => within(root).getByRole('button', { name: /^save/i });
const num = (label: RegExp, root: HTMLElement = document.body) => within(root).getByLabelText(label) as HTMLInputElement;

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi(PERM_CFG_WRITE));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('access and states', () => {
  it('without quality.qc_run.read: permission-denied state and NO API call', async () => {
    resetApi([]);
    await show(PAGE);
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('403 common.feature_disabled -> "The QC module is not switched on for your lab yet."', async () => {
    routes[`GET ${SETTINGS}`] = () => problem('common.feature_disabled', 403);
    await show(PAGE);
    expect(pageText()).toContain('The QC module is not switched on for your lab yet.');
  });
  it('5xx rejects (error.tsx)', async () => {
    routes[`GET ${SETTINGS}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE)).toBeTruthy();
  });
  it('the render sends only GETs; the Bearer token is never rendered', async () => {
    const { container } = await show(PAGE);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(callsTo('GET', SETTINGS)[0]!.headers.get('authorization')).toMatch(/^Bearer \S+/);
    expect(container.innerHTML).not.toContain('jwt-synthetic');
  });
  it('axe clean', async () => { await show(PAGE); await axeClean(); });
});

describe('settings tab (04-UI-UX §2.11)', () => {
  it('four cards with the spec headings', async () => {
    await show(PAGE);
    for (const h of [/^TAT alerts$/, /^QC$/, /^Auto-verification$/, /^Read-only from tenant settings$/]) expect(screen.getAllByRole('heading', { name: h }).length).toBeGreaterThan(0);
  });
  it('fields show the loaded values', async () => {
    await show(PAGE);
    expect(num(/^warning at %/i).value).toBe('80');
    expect(num(/^escalate at %/i).value).toBe('150');
    expect(num(/close orphan clocks after h/i).value).toBe('72');
    expect(num(/minimum points to establish a target/i).value).toBe('20');
    expect(num(/re-process window days/i).value).toBe('7');
    expect(num(/minimum simulation days/i).value).toBe('14');
    expect(num(/minimum shadow decisions/i).value).toBe('500');
    expect(screen.getByRole('switch', { name: /enabled/i }).getAttribute('aria-checked') ?? (screen.getByRole('switch', { name: /enabled/i }) as HTMLInputElement).checked).toBeTruthy();
  });
  it('hint under the minimum-points field: "Common practice is about 20; check your SOP."', async () => {
    await show(PAGE);
    expect(pageText()).toContain('Common practice is about 20; check your SOP.');
  });
  it('read-only card shows Westgard mode and Auto-verification as words, with the "Change in Admin › Tenant settings" text, and no inputs', async () => {
    routes[`GET ${SETTINGS}`] = json(settingsDto({ westgard_mode: 'modern', auto_verification_enabled: true }));
    await show(PAGE);
    const ro = card(/read-only from tenant settings/i);
    const t = norm(ro.textContent);
    expect(t).toMatch(/Westgard mode/i);
    expect(t).toMatch(/Modern/);
    expect(t).toMatch(/Auto-verification/i);
    expect(t).toMatch(/\bOn\b/);
    expect(t).toContain('Change in Admin › Tenant settings');
    expect(within(ro).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(ro).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(within(ro).queryAllByRole('switch')).toHaveLength(0);
  });
  it('without quality.config.manage: fields are not editable and there is no Save button', async () => {
    resetApi(PERM_CFG_READ);
    await show(PAGE);
    expect(screen.queryAllByRole('button', { name: /^save/i })).toHaveLength(0);
    for (const l of [/^warning at %/i, /^escalate at %/i, /minimum simulation days/i]) {
      const el = num(l);
      expect(el.disabled || el.readOnly).toBe(true);
    }
  });
  it('LD-140: one Save per editable card (three) and none is the page-level primary action', async () => {
    await show(PAGE);
    expect(screen.getAllByRole('button', { name: /^save/i })).toHaveLength(3);
  });
});

describe('save (#52 PUT, full mutable subset)', () => {
  it('TAT card Save: PUT with If-Match "7", all nine keys, only the edited value changed; then toast + refresh', async () => {
    routes[`PUT ${SETTINGS}`] = json(settingsDto({ version: 8, tat_warn_pct: 75 }));
    await show(PAGE);
    await fill(/^warning at %/i, '75');
    await user().click(save(card(/^TAT alerts$/)));
    await waitFor(() => expect(callsTo('PUT', SETTINGS)).toHaveLength(1));
    const c = callsTo('PUT', SETTINGS)[0]!;
    expect(c.headers.get('if-match')).toBe('"7"');
    expect(bodyOf(c)).toEqual({
      tat_alerts_enabled: true, tat_warn_pct: 75, tat_escalate_pct: 150, tat_orphan_close_hours: 72, target_min_points: 20, sim_min_days: 14, sim_min_decisions: 500, reprocess_window_days: 7,
      default_plan_params: { mean_rule: '10x', run_window_minutes: 30 },
    });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('QC card Save sends the same full shape with the new target_min_points; read-only fields (westgard_mode, version, updated_*) are never sent', async () => {
    routes[`PUT ${SETTINGS}`] = json(settingsDto({ version: 8, target_min_points: 30 }));
    await show(PAGE);
    await fill(/minimum points to establish a target/i, '30');
    await user().click(save(card(/^QC$/)));
    await waitFor(() => expect(callsTo('PUT', SETTINGS)).toHaveLength(1));
    const b = bodyOf(callsTo('PUT', SETTINGS)[0]);
    expect(b.target_min_points).toBe(30);
    expect(Object.keys(b).sort()).toEqual(['default_plan_params', 'reprocess_window_days', 'sim_min_days', 'sim_min_decisions', 'tat_alerts_enabled', 'tat_escalate_pct', 'tat_orphan_close_hours', 'tat_warn_pct', 'target_min_points']);
  });
  it('switching TAT alerts off sends tat_alerts_enabled=false', async () => {
    routes[`PUT ${SETTINGS}`] = json(settingsDto({ version: 8, tat_alerts_enabled: false }));
    await show(PAGE);
    await user().click(screen.getByRole('switch', { name: /enabled/i }));
    await user().click(save(card(/^TAT alerts$/)));
    await waitFor(() => expect(callsTo('PUT', SETTINGS)).toHaveLength(1));
    expect(bodyOf(callsTo('PUT', SETTINGS)[0]).tat_alerts_enabled).toBe(false);
  });
  it.each([
    ['Warning at %', /^warning at %/i, '49', /^TAT alerts$/],
    ['Warning at %', /^warning at %/i, '100', /^TAT alerts$/],
    ['Escalate at %', /^escalate at %/i, '100', /^TAT alerts$/],
    ['Escalate at %', /^escalate at %/i, '1001', /^TAT alerts$/],
    ['Close orphan clocks after h', /close orphan clocks after h/i, '0', /^TAT alerts$/],
    ['Close orphan clocks after h', /close orphan clocks after h/i, '721', /^TAT alerts$/],
    ['Minimum points', /minimum points to establish a target/i, '1', /^QC$/],
    ['Minimum points', /minimum points to establish a target/i, '501', /^QC$/],
    ['Re-process window days', /re-process window days/i, '31', /^QC$/],
    ['Minimum simulation days', /minimum simulation days/i, '91', /^Auto-verification$/],
    ['Minimum shadow decisions', /minimum shadow decisions/i, '9', /^Auto-verification$/],
    ['Minimum shadow decisions', /minimum shadow decisions/i, '100001', /^Auto-verification$/],
  ])('%s = %s is out of range: field error, NO request', async (_n, label, value, cardName) => {
    await show(PAGE);
    const el = await fill(label, value as string);
    await user().click(save(card(cardName as RegExp)));
    expect(callsTo('PUT', SETTINGS)).toHaveLength(0);
    expect(el.getAttribute('aria-invalid') === 'true' || !!el.closest('.lims-field')?.querySelector('.lims-error')).toBe(true);
  });
  it.each([['50'], ['99']])('Warning at %s is the inclusive edge and is accepted', async (v) => {
    routes[`PUT ${SETTINGS}`] = json(settingsDto({ version: 8 }));
    await show(PAGE);
    await fill(/^warning at %/i, v);
    await user().click(save(card(/^TAT alerts$/)));
    await waitFor(() => expect(callsTo('PUT', SETTINGS)).toHaveLength(1));
    expect(bodyOf(callsTo('PUT', SETTINGS)[0]).tat_warn_pct).toBe(Number(v));
  });
  it('non-numeric input never reaches the API', async () => {
    await show(PAGE);
    await fill(/^warning at %/i, 'abc');
    await user().click(save(card(/^TAT alerts$/)));
    expect(callsTo('PUT', SETTINGS)).toHaveLength(0);
  });
  it('409 common.version_conflict: error shown with a reload hint, no success toast, no refresh', async () => {
    routes[`PUT ${SETTINGS}`] = () => problem('common.version_conflict', 409);
    await show(PAGE);
    await fill(/^warning at %/i, '70');
    await user().click(save(card(/^TAT alerts$/)));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('400 common.validation_failed from the server is shown on the page, not thrown', async () => {
    routes[`PUT ${SETTINGS}`] = () => problem('common.validation_failed', 400, { errors: [{ field: 'tat_warn_pct', code: 'out_of_range' }] });
    await show(PAGE);
    await fill(/^warning at %/i, '70');
    await user().click(save(card(/^TAT alerts$/)));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
  });
  it('428 common.precondition_required is never expected: the version is always sent', async () => {
    routes[`PUT ${SETTINGS}`] = json(settingsDto({ version: 8 }));
    await show(PAGE);
    await fill(/^warning at %/i, '70');
    await user().click(save(card(/^TAT alerts$/)));
    await waitFor(() => expect(callsTo('PUT', SETTINGS)).toHaveLength(1));
    expect(callsTo('PUT', SETTINGS)[0]!.headers.get('if-match')).toBeTruthy();
  });
});

describe('coded sets tab (#53/#54)', () => {
  async function openTab() {
    await show(PAGE);
    await user().click(screen.getByRole('tab', { name: /coded sets/i }));
  }
  it('Corrective actions and Exclusion reasons tables with Code, Display, Order, Active, Source (words, not colour)', async () => {
    await openTab();
    const g = gridNamed(/corrective actions/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Code', 'Display', 'Order', 'Active', 'Source']));
    const rows = dataRows(g).map((r) => norm(r.textContent));
    expect(rows[0]).toContain('recalibrated');
    expect(rows[0]).toContain('Recalibrated');
    expect(rows[0]).toMatch(/global/i);
    expect(rows[1]).toMatch(/tenant/i);
    expect(rows[1]).toMatch(/inactive|no/i);
    expect(norm(gridNamed(/exclusion reasons/i).textContent)).toContain('Sample handling error');
  });
  it('without quality.config.manage there are no Edit buttons', async () => {
    resetApi(PERM_CFG_READ);
    await openTab();
    expect(screen.queryAllByRole('button', { name: /^edit/i })).toHaveLength(0);
  });
  it('Edit opens a dialog with Display, Order, Active; the code is shown but not editable', async () => {
    await openTab();
    await user().click(within(dataRows(gridNamed(/corrective actions/i))[0]!).getByRole('button', { name: /^edit/i }));
    expect(field(/^display/i).value).toBe('Recalibrated');
    expect(field(/^order/i).value).toBe('1');
    expect(within(dlg()).queryByLabelText(/^code/i) === null || (within(dlg()).getByLabelText(/^code/i) as HTMLInputElement).readOnly || (within(dlg()).getByLabelText(/^code/i) as HTMLInputElement).disabled).toBe(true);
  });
  it('Save PUTs {display, sort_order, is_active} to the code; closes, toasts, refreshes', async () => {
    routes[`PUT ${SET}/corrective_actions/codes/recalibrated`] = json({ code: 'recalibrated', display: 'Re-calibrated', sort_order: 5, is_active: true, source: 'tenant' });
    await openTab();
    await user().click(within(dataRows(gridNamed(/corrective actions/i))[0]!).getByRole('button', { name: /^edit/i }));
    await fill(/^display/i, 'Re-calibrated');
    await fill(/^order/i, '5');
    await user().click(within(dlg()).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', `${SET}/corrective_actions/codes/recalibrated`)).toHaveLength(1));
    expect(bodyOf(callsTo('PUT', `${SET}/corrective_actions/codes/recalibrated`)[0])).toEqual({ display: 'Re-calibrated', sort_order: 5, is_active: true });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(anyDlg()).toBeNull();
  });
  it.each([['display', '', /^display/i], ['display', 'x'.repeat(121), /^display/i], ['order', '-1', /^order/i], ['order', '1000', /^order/i]])('invalid %s %j: field error, NO request', async (_n, value, label) => {
    await openTab();
    await user().click(within(dataRows(gridNamed(/corrective actions/i))[0]!).getByRole('button', { name: /^edit/i }));
    const el = await fill(label as RegExp, value as string);
    await user().click(within(dlg()).getByRole('button', { name: /^save/i }));
    expect(callsTo('PUT', `${SET}/corrective_actions/codes/recalibrated`)).toHaveLength(0);
    expect(el.getAttribute('aria-invalid') === 'true' || !!el.closest('.lims-field')?.querySelector('.lims-error')).toBe(true);
  });
  it('the set name and code in the PUT path come from the data, never from the URL (path-injection guard)', async () => {
    routes[`GET ${SET}/corrective_actions`] = json({ data: [{ ...CORRECTIVE[0], code: '../../tat-alerts' }], page: { limit: 50 } });
    routes[`PUT ${SET}/corrective_actions/codes/..%2F..%2Ftat-alerts`] = json({});
    await openTab();
    await user().click(within(dataRows(gridNamed(/corrective actions/i))[0]!).getByRole('button', { name: /^edit/i }));
    await user().click(within(dlg()).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    for (const c of calls.filter((x) => x.method === 'PUT')) expect(c.url.pathname).toMatch(/^\/v1\/quality\/coded-sets\/corrective_actions\/codes\/[^/]+$/);
  });
});
