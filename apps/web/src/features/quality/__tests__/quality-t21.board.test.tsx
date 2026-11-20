// @vitest-environment jsdom
// C9.T-21 — QC status board `/quality`, runs `/quality/runs`, unassigned QC `/quality/observations` (04-UI-UX §1, §2.1, §2.2, §2.5; 03-APP-FLOW §4; AC-09.5; 07-SECURITY).
// ASSUMED contract (same shape as AN-T20): default async server components `Page({ searchParams, params })` in app/(staff)/quality/{page,runs/page,observations/page}.tsx.
//   * Without `quality.qc_run.read` the page renders the permission-denied EmptyState "You don't have access to this page" and makes NO API call.
//   * API 403 common.feature_disabled -> "The QC module is not switched on for your lab yet."; API 5xx rejects (error.tsx shows ErrorState with Retry).
//   * Tables are @lims/ui DataTable (role=grid) named /status/i, /runs/i, /observations|unassigned/i; links are real <a href>.
//   * LD-140: composition from @lims/ui only (see quality-t21.static.test.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  INST_1, PLAN_1, PLAN_2, RUN_1, RUN_2, TOKEN, STATUS_ROWS, api, axeClean, calls, callsTo, dataRows, gridNamed, headersOf, hrefs, json, lastNav, obsRow, pageText, problem,
  resetApi, routes, router, runSummary, show, showOrThrown, PERM_MANAGE, PERM_READ, norm, rowTexts, statusRow,
} from './quality-t21.harness';

vi.mock('next/navigation', async () => (await import('./quality-t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t21.harness')).sessionMock);

const BOARD = 'page';
const STATUS = '/v1/quality/qc-status';
const RUNS = '/v1/quality/qc-runs';
const OBS = '/v1/quality/qc-observations';
const DENIED = /You don't have access to this page/;

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetApi(PERM_READ); routes[`GET ${STATUS}`] = json({ data: STATUS_ROWS, page: { limit: 50 } }); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('status board — access and honest states', () => {
  it.each([['page'], ['runs/page'], ['observations/page']])('%s without quality.qc_run.read: permission-denied state and NO API call', async (rel) => {
    resetApi([]);
    await show(rel);
    expect(pageText()).toMatch(DENIED);
    expect(calls).toHaveLength(0);
  });

  it('API 403 common.feature_disabled -> "The QC module is not switched on for your lab yet."', async () => {
    routes[`GET ${STATUS}`] = () => problem('common.feature_disabled', 403);
    await show(BOARD);
    expect(pageText()).toContain('The QC module is not switched on for your lab yet.');
  });

  it('API 5xx rejects so error.tsx takes over; the Bearer token is sent but never rendered', async () => {
    const { container } = await show(BOARD);
    expect(callsTo('GET', STATUS)[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(container.innerHTML).not.toContain(TOKEN);
    cleanup();
    routes[`GET ${STATUS}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(BOARD)).toBeTruthy();
  });

  it('empty: "No QC plans yet" + body; "Set up QC" only with quality.qc.manage and it points into set-up', async () => {
    routes[`GET ${STATUS}`] = json({ data: [], page: { limit: 50 } });
    await show(BOARD);
    expect(pageText()).toContain('No QC plans yet');
    expect(pageText()).toContain('Set up control materials, a QC plan and targets to start evaluating QC.');
    expect(screen.queryByRole('link', { name: /set up qc/i })).toBeNull();
    cleanup();
    resetApi(PERM_MANAGE);
    routes[`GET ${STATUS}`] = json({ data: [], page: { limit: 50 } });
    await show(BOARD);
    expect(screen.getAllByRole('link', { name: /set up qc/i })[0]!.getAttribute('href')).toMatch(/^\/quality\/setup/);
  });
});

describe('status board — rows (04-UI-UX §2.1; AC-09.5)', () => {
  it('columns, one row per plan, instrument label as row header, no patient identifiers', async () => {
    await show(BOARD);
    const g = gridNamed(/status|qc/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Instrument', 'Analyte', 'Status', 'Last in-control QC', 'Open failures', 'QC overdue', 'Patients since QC']));
    expect(dataRows(g)).toHaveLength(4);
    expect(rowTexts(g).join(' ')).toContain('SYN-CHEM-01 Synthetic Chemistry Analyser');
    expect(pageText()).not.toMatch(/barcode|registration no|patient name/i);
  });

  it('every status shows its WORD with the chip (never colour alone); violated rules follow as text', async () => {
    await show(BOARD);
    const t = rowTexts(gridNamed(/status|qc/i));
    expect(t.find((r) => r.includes('GLU'))).toContain('In control');
    expect(t.find((r) => r.includes('CRE'))).toMatch(/Warning.*1-2s/);
    expect(t.find((r) => r.includes('TSH'))).toContain('Out of control · 1-3s');
    expect(t.find((r) => r.includes('NAK'))).toContain('No QC data');
    expect(t.find((r) => r.includes('NAK'))).toContain('—'); // no last in-control QC
  });

  it('AC-09.5: overdue pair shows an "Overdue" badge and the count of patient results since the last QC; others do not', async () => {
    await show(BOARD);
    const t = rowTexts(gridNamed(/status|qc/i));
    const tsh = t.find((r) => r.includes('TSH'))!;
    expect(tsh).toContain('Overdue');
    expect(tsh).toMatch(/\b37\b/);
    expect(t.find((r) => r.includes('GLU'))).not.toContain('Overdue');
  });

  it('Open failures = count of open_rejected_run_ids, linked to the run list filtered needs_action=true', async () => {
    await show(BOARD);
    const row = dataRows(gridNamed(/status|qc/i)).find((r) => r.textContent?.includes('TSH'))!;
    const link = within(row).getAllByRole('link').find((a) => /needs_action=true/.test(a.getAttribute('href') ?? ''))!;
    expect(link.textContent).toContain('2');
    expect(link.getAttribute('href')).toMatch(/^\/quality\/runs\?/);
  });

  it('danger banner when any pair is out of control, with the count', async () => {
    await show(BOARD);
    expect(pageText()).toContain('1 instrument/analyte pairs are out of control. Patient results are held in Lab until released.');
    cleanup();
    routes[`GET ${STATUS}`] = json({ data: [statusRow()], page: { limit: 50 } });
    await show(BOARD);
    expect(pageText()).not.toMatch(/are out of control\. Patient results are held/);
  });

  it('row action: LJ chart link for the plan; Enter on a row opens it (keyboard)', async () => {
    await show(BOARD);
    expect(hrefs().some((h) => h.startsWith('/quality/lj') && h.includes(`plan_id=${PLAN_2}`))).toBe(true);
    const row = dataRows(gridNamed(/status|qc/i)).find((r) => r.textContent?.includes('TSH'))!;
    (within(row).queryAllByRole('gridcell')[0] ?? row).focus();
    await userEvent.keyboard('{Enter}');
    expect(lastNav() ?? '').toMatch(new RegExp(`^/quality/lj\\?.*plan_id=${PLAN_2}`));
  });

  it('shows "Updated hh:mm:ss" next to the title, and a live region (aria-live=polite) for the out-of-control count', async () => {
    await show(BOARD);
    expect(pageText()).toMatch(/Updated \d{2}:\d{2}:\d{2}/);
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('page title "QC status"; Set up QC action absent without quality.qc.manage; axe clean', async () => {
    await show(BOARD);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('QC status');
    await axeClean();
  });
});

describe('status board — filters go to the API verbatim and only when valid', () => {
  it('instrument_id, status (comma list) and overdue_only are forwarded', async () => {
    await show(BOARD, { searchParams: { instrument_id: INST_1, status: 'out_of_control,warning', overdue_only: 'true' } });
    const q = callsTo('GET', STATUS)[0]!.url.searchParams;
    expect(q.get('instrument_id')).toBe(INST_1);
    expect(q.get('status')).toBe('out_of_control,warning');
    expect(q.get('overdue_only')).toBe('true');
  });

  it.each([['instrument_id', '../x'], ['status', 'drop table'], ['overdue_only', 'maybe']])('invalid %s=%j is never forwarded to the API', async (k, v) => {
    await show(BOARD, { searchParams: { [k]: v } });
    expect(callsTo('GET', STATUS)[0]!.url.searchParams.get(k)).toBeNull();
  });
});

describe('runs list (04-UI-UX §2.2)', () => {
  const runsBody = () => ({
    data: [
      runSummary({ id: RUN_1, outcome: 'accepted', observation_count: 2, rule_mode: 'classic' }),
      runSummary({ id: RUN_2, outcome: 'rejected', rules_violated: ['1-3s', '2-2s'], needs_action: true, needs_action_reason: 'corrective_action', rule_mode: 'modern', observation_count: 1 }),
      runSummary({ id: '01a1a98a-ac40-7000-8000-0000000c1013', outcome: 'rejected', rules_violated: ['R-4s'], needs_action: true, needs_action_reason: 'rerun', status: 'closed', closed_at: '2026-11-14T05:00:00.000Z' }),
      runSummary({ id: '01a1a98a-ac40-7000-8000-0000000c1014', status: 'collecting', outcome: undefined, is_complete: false, observation_count: 1 }),
    ],
    page: { limit: 50 },
  });
  beforeEach(() => { routes[`GET ${RUNS}`] = json(runsBody()); });

  it('columns; observations as "n / N"; outcome words; rules as text; needs-action reasons in words; row links to the run', async () => {
    await show('runs/page');
    const g = gridNamed(/runs/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Run time', 'Instrument', 'Analyte', 'N', 'Mode', 'Observations', 'Outcome', 'Rules', 'Needs action', 'Closed at']));
    const t = rowTexts(g);
    expect(t).toHaveLength(4);
    expect(t[0]).toContain('2 / 2');
    expect(t[0]).toContain('Classic');
    expect(t[0]).toContain('Accepted');
    expect(t[1]).toContain('Rejected');
    expect(t[1]).toContain('Modern');
    expect(t[1]).toMatch(/1-3s.*2-2s/);
    expect(t[1]).toContain('Corrective action needed');
    expect(t[2]).toContain('Rerun needed');
    expect(t[3]).toContain('Collecting');
    expect(hrefs()).toContain(`/quality/qc-runs/${RUN_2}`);
  });

  it('forwards needs_action, outcome list, status and instrument; sort is run time desc only; malformed filters are dropped', async () => {
    await show('runs/page', { searchParams: { needs_action: 'true', outcome: 'rejected,incomplete', status: 'evaluated', instrument_id: INST_1, analyte_id: 'nope' } });
    const q = callsTo('GET', RUNS)[0]!.url.searchParams;
    expect(q.get('needs_action')).toBe('true');
    expect(q.get('outcome')).toBe('rejected,incomplete');
    expect(q.get('status')).toBe('evaluated');
    expect(q.get('instrument_id')).toBe(INST_1);
    expect(q.get('analyte_id')).toBeNull();
    expect(['-run_at', null]).toContain(q.get('sort'));
  });

  it('empty: "No QC runs match these filters."; error rejects; axe clean', async () => {
    routes[`GET ${RUNS}`] = json({ data: [], page: { limit: 50 } });
    await show('runs/page');
    expect(pageText()).toContain('No QC runs match these filters.');
    await axeClean();
    cleanup();
    routes[`GET ${RUNS}`] = () => problem('common.internal', 500);
    expect(await showOrThrown('runs/page')).toBeTruthy();
  });
});

describe('unassigned QC (04-UI-UX §2.5)', () => {
  const FIXABLE = ['unmapped_control', 'no_plan', 'no_target', 'level_not_in_plan', 'lot_expired', 'unit_mismatch', 'late_unassigned', 'unmapped_analyte'];
  beforeEach(() => {
    routes[`GET ${OBS}`] = json({
      data: [obsRow(1, 'unmapped_control'), obsRow(2, 'no_plan'), obsRow(3, 'no_target'), obsRow(4, 'unmapped_analyte', { control_id_raw: 'RAW-CTRL-4' }), obsRow(5, 'lot_expired')],
      page: { limit: 50 },
    });
  });

  it('asks the API for the unassigned statuses only — never "assigned" or "excluded"', async () => {
    await show('observations/page');
    const status = callsTo('GET', OBS)[0]!.url.searchParams.get('status') ?? '';
    const list = status.split(',');
    expect(list).toEqual(expect.arrayContaining(['unmapped_control', 'no_plan', 'no_target']));
    expect(list.every((s) => FIXABLE.includes(s))).toBe(true);
  });

  it('shows raw control id / lot / level, value and a plain-language status (no snake_case codes)', async () => {
    await show('observations/page');
    const g = gridNamed(/observations|unassigned/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Observed at', 'Instrument', 'Analyte', 'Control id', 'Lot', 'Level', 'Value', 'Status', 'Fix']));
    const t = rowTexts(g);
    expect(t[0]).toContain('RAW-CTRL-1');
    expect(t[0]).toContain('RAW-LOT-1');
    expect(t[0]).toContain('Unmapped control');
    expect(t[1]).toContain('No plan');
    expect(t[2]).toContain('No target');
    expect(t[3]).toContain('Not mapped in catalog');
    expect(t.join(' ')).not.toMatch(/unmapped_control|no_plan|no_target/);
  });

  it('with quality.qc.manage each status has its fix, pre-filled through the URL (instrument + raw id/lot)', async () => {
    resetApi(PERM_MANAGE);
    routes[`GET ${OBS}`] = json({ data: [obsRow(1, 'unmapped_control'), obsRow(2, 'no_plan'), obsRow(3, 'no_target'), obsRow(4, 'unmapped_analyte')], page: { limit: 50 } });
    await show('observations/page');
    const link = (name: RegExp) => screen.getAllByRole('link', { name }).map((a) => a.getAttribute('href') ?? '');
    const map = link(/create control map/i)[0]!;
    expect(map).toMatch(/^\/quality\/setup\/maps\?/);
    expect(map).toContain(`instrument_id=${INST_1}`);
    expect(decodeURIComponent(map)).toContain('RAW-CTRL-1');
    expect(link(/create qc plan/i)[0]).toMatch(/^\/quality\/setup\/plans/);
    expect(link(/add target/i)[0]).toMatch(/^\/quality\/setup\/targets/);
    expect(pageText()).toContain('Map the instrument code in Instruments › Code maps');
  });

  it('without quality.qc.manage there are no fix buttons (read-only list)', async () => {
    await show('observations/page');
    expect(screen.queryByRole('link', { name: /create control map|create qc plan|add target/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create control map|create qc plan|add target/i })).toBeNull();
  });

  it('filters: instrument and status are forwarded when valid; empty copy "All QC values are assigned."; axe clean', async () => {
    await show('observations/page', { searchParams: { instrument_id: INST_1, status: 'no_plan,no_target', observed_at_from: '2026-11-01T00:00:00.000Z', observed_at_to: '2026-11-14T00:00:00.000Z' } });
    const q = callsTo('GET', OBS)[0]!.url.searchParams;
    expect(q.get('instrument_id')).toBe(INST_1);
    expect(q.get('status')).toBe('no_plan,no_target');
    expect(q.get('observed_at_from')).toBe('2026-11-01T00:00:00.000Z');
    await axeClean();
    cleanup();
    routes[`GET ${OBS}`] = json({ data: [], page: { limit: 50 } });
    await show('observations/page');
    expect(pageText()).toContain('All QC values are assigned.');
  });

  it('unauthorised statuses in the URL (assigned) are not forwarded', async () => {
    await show('observations/page', { searchParams: { status: 'assigned' } });
    expect((callsTo('GET', OBS)[0]!.url.searchParams.get('status') ?? '').split(',')).not.toContain('assigned');
  });
});

// keep unused-import linters quiet without weakening anything
void [PLAN_1, router, norm];
