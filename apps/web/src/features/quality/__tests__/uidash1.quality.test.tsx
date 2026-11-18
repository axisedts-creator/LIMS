// @vitest-environment jsdom
// T0D-UIDASH-1 (6) quality indicators, runs, TAT alerts on the Report layout; Levey-Jennings restyle (LD-353 rules 4, 5, 6, 8, 10; template 5). Each screen renders with fake data twice: no rows and rows.
// Contract (display only; counts come from the rows the screen already has):
//   QC status (StatusBoardView): h1 'QC status'; ONE `.lims-filter-bar`; ONE `.lims-stat-row` of tiles In control, Warning, Out of control, QC overdue; ChartCard "Pairs by status"; table header kept.
//   QC runs (RunsView): h1 'QC runs'; ONE filter bar; tiles Runs, Needs action; ChartCard "Runs by outcome"; table header kept.
//   TAT alerts (TatView): h1 'TAT alerts'; ONE filter bar; tiles Warning, Breached, Escalated; ChartCard "Alerts by level"; table header kept.
//   Every ChartCard frame draws and says "No data yet" with no rows. The Levey-Jennings screen loses its development note ("Chart component pending...") and keeps the menu label as the
//   start of its h1; its chart markup carries no colour literal (accent plus grey from tokens; point status stays in chips).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { cardByTitle, cards, dataTables, filterBars, frameDraws, frameSaysNoData, hasAlert, headerCells, norm, tileLabel, tileRows, tileValue, tiles, titles } from '@/__tests__/uidash1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/quality',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/quality' }));
vi.mock('../server/actions', async (orig) => ({ ...(await orig<object>()), pollStatusAction: vi.fn(), pollLjAction: vi.fn() }));
vi.mock('../tat/actions', async (orig) => ({ ...(await orig<object>()), pollTatAction: vi.fn() }));

import { LjView } from '../components/LjView';
import { RunsView } from '../components/RunsView';
import { StatusBoardView } from '../components/StatusBoardView';
import { TatView } from '../tat/TatView';

const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
const statusRow = (n: number, o: Record<string, unknown> = {}) => ({ plan_id: id(10 + n), instrument_id: id(1), instrument_label: 'SYN-CHEM-01', analyte_id: id(2), analyte_code: `AN${n}`, status: 'in_control',
  last_in_control_run_at: '2026-11-14T03:10:00.000Z', violated_rules: [], open_rejected_run_ids: [], qc_overdue: false, patient_results_since_last_qc: 0, ...o });
const STATUS_ROWS = [statusRow(1), statusRow(2, { status: 'warning' }), statusRow(3, { status: 'out_of_control', qc_overdue: true, open_rejected_run_ids: [id(50)] }), statusRow(4, { status: 'out_of_control' })];
const run = (n: number, o: Record<string, unknown> = {}) => ({ id: id(100 + n), version: 1, plan_id: id(11), instrument_id: id(1), analyte_id: id(2), run_at: '2026-11-14T03:00:00.000Z', status: 'evaluated', outcome: 'accepted',
  is_complete: true, observation_count: 2, controls_per_run: 2, rule_mode: 'classic', warning_rules: [], rules_violated: [], needs_action: false, ...o });
const RUNS = [run(1), run(2), run(3, { outcome: 'rejected', rules_violated: ['1-3s'], needs_action: true, needs_action_reason: 'corrective_action' })];
const tat = (n: number, level: string) => ({ tat_item_id: id(200 + n), version: 1, order_id: id(300), order_item_id: id(301), test_id: id(302), test_code: 'GLU', department_id: id(303), specimen_id: id(304), centre_id: id(305),
  priority: 'routine', segment: 'within_lab', segment_label: 'Within lab: received to first verified result', alert_level: level, started_at: '2026-11-14T01:00:00.000Z', elapsed_seconds: 5400, target_seconds: 3600, pct_of_target: 150 });
const TATS = [tat(1, 'warning'), tat(2, 'breached'), tat(3, 'breached'), tat(4, 'escalated')];

const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const status = (rows: unknown[]) => wrap(<StatusBoardView rows={rows as never} generatedAt="2026-11-14T04:00:00.000Z" sp={{}} canManage={false} />);
const runs = (rows: unknown[]) => wrap(<RunsView rows={rows as never} hasPrevious={false} sp={{}} labels={{ [id(11)]: { instrument: 'SYN-CHEM-01', analyte: 'GLU' } }} />);
const tats = (rows: unknown[]) => wrap(<TatView page={{ rows, next: undefined } as never} generatedAt="2026-11-14T04:00:00.000Z" sp={{}} canAck={false} />);
const values = (c: ParentNode) => tiles(c).map(tileValue).map((v) => v.replace(/\D/g, ''));
afterEach(cleanup);

type Screen = { name: string; title: string; head: string[]; labels: string[]; chart: string; mount: (rows: unknown[]) => ReturnType<typeof wrap>; rows: unknown[]; counts: string[] };
const SCREENS: Screen[] = [
  { name: 'QC status', title: t('quality.nav.status'), head: ['Instrument', 'Analyte', 'Status', 'Open failures', 'QC overdue', 'Actions'], labels: ['In control', 'Warning', 'Out of control', 'QC overdue'],
    chart: 'Pairs by status', mount: status, rows: STATUS_ROWS, counts: ['1', '1', '2', '1'] },
  { name: 'QC runs', title: t('quality.nav.runs'), head: ['Run time', 'Instrument', 'Analyte', 'Observations', 'Outcome', 'Rules', 'Needs action'], labels: ['Runs', 'Needs action'],
    chart: 'Runs by outcome', mount: runs, rows: RUNS, counts: ['3', '1'] },
  { name: 'TAT alerts', title: t('quality.nav.tat_alerts'), head: ['Level', 'Test', 'Priority', 'Segment', 'Elapsed / target', '% of target', 'Acknowledged', 'Actions'], labels: ['Warning', 'Breached', 'Escalated'],
    chart: 'Alerts by level', mount: tats, rows: TATS, counts: ['1', '2', '1'] },
];

describe.each(SCREENS)('$name (template 5 REPORT)', (s) => {
  it.each([['no rows', true], ['rows', false]])('%s: h1 = menu label, ONE FilterBar, the table header row, no alert', (_n, none) => {
    const { container } = s.mount(none ? [] : s.rows);
    expect(titles(container)).toEqual([s.title]);
    expect(filterBars(container)).toHaveLength(1);
    const heads = headerCells(container);
    for (const h of s.head) expect(heads, h).toContain(h);
    expect(dataTables(container)).toHaveLength(1);
    expect(hasAlert(container)).toBe(false);
  });

  it('rows: ONE row of equal tiles with the counts of the rows', () => {
    const { container } = s.mount(s.rows);
    expect(tileRows(container)).toHaveLength(1);
    expect(tiles(container).map(tileLabel)).toEqual(s.labels);
    expect(values(container)).toEqual(s.counts);
  });

  it('no rows: the tiles still draw and read 0', () => {
    const { container } = s.mount([]);
    expect(tiles(container).map(tileLabel)).toEqual(s.labels);
    expect(values(container).every((v) => v === '0')).toBe(true);
    expect(tileRows(container)).toHaveLength(1);
  });

  it('ChartCard: drawn with rows, drawn with "No data yet" without rows; only accent and grey (no colour literal)', () => {
    const a = s.mount(s.rows);
    const full = cardByTitle(a.container, s.chart)!;
    expect(full, s.chart).toBeTruthy();
    expect(frameDraws(full)).toBe(true);
    expect(frameSaysNoData(full)).toBe(false);
    expect(cards(a.container)).toHaveLength(1);
    expect(full.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(|gradient/i);
    a.unmount();
    const b = s.mount([]);
    const empty = cardByTitle(b.container, s.chart)!;
    expect(frameDraws(empty)).toBe(true);
    expect(frameSaysNoData(empty)).toBe(true);
  });

  it('copy: no development note and no exclamation mark', () => {
    const { container } = s.mount(s.rows);
    expect(norm(container.textContent)).not.toMatch(/!|\bTODO\b|pending;|CR-C\d/i);
  });
});

describe('QC status: the out-of-control banner and the live region survive', () => {
  it('rows with two out-of-control pairs keep the danger banner', () => {
    const { container } = status(STATUS_ROWS);
    expect(norm(container.textContent)).toMatch(/2 instrument\/analyte pairs are out of control/);
  });
});

const lj = (chart?: unknown) => wrap(<LjView sp={chart ? { plan_id: id(11) } : {}} plans={STATUS_ROWS as never} chart={chart as never} generatedAt="2026-11-14T04:00:00.000Z" canManage={false} exclusionOptions={[]} />);
const pt = (n: number, status: string) => ({ observation_id: id(400 + n), observed_at: `2026-11-${String(10 + n).padStart(2, '0')}T03:00:00.000Z`, value: '100.0', z: '0.000', status, qc_run_id: id(100), rule_hits: [] });
const LJ = {
  plan: { id: id(11), instrument_id: id(1), analyte_id: id(2), analyte_code: 'GLU', unit_code: 'mg_dl', decimals: 1 }, view: 'level', truncated: false,
  series: [{ level_id: id(20), level_code: 'L1', lot_id: id(21), lot_no: 'SYN-LOT-001', points: [pt(0, 'accepted'), pt(1, 'rejected')],
    targets: [{ target_id: id(30), effective_from: '2026-11-01T00:00:00.000Z', mean: '100.0', sd: '2.0', source: 'established' }] }],
};

describe('Levey-Jennings (restyle only)', () => {
  it('no plan chosen: the h1 is exactly the menu label and the empty state keeps its words', () => {
    const { container } = lj();
    expect(titles(container)).toEqual([t('quality.nav.lj_chart')]);
    expect(norm(container.textContent)).toContain('Choose a plan');
  });

  it.each([['no points', { ...LJ, series: [] }], ['one series', LJ]])('%s: the h1 starts with the menu label, no development note, no alert', (_n, chart) => {
    const { container } = lj(chart);
    expect(titles(container)).toHaveLength(1);
    expect(titles(container)[0]!.startsWith(t('quality.nav.lj_chart'))).toBe(true);
    expect(norm(container.textContent)).not.toMatch(/chart component pending|showing values as a table|CR-C9/i);
    expect(hasAlert(container)).toBe(false);
  });

  it('no points: the points table keeps its header row with the message in the body', () => {
    const { container } = lj({ ...LJ, series: [] });
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Value', 'z', 'Status', 'Rule hits']));
    expect(norm(container.textContent)).toContain('No QC values in this period.');
  });

  it('one series: the chart area carries no colour literal (accent plus grey from tokens), no gradient', () => {
    const { container } = lj(LJ);
    const html = container.outerHTML;
    expect(html).not.toMatch(/style="[^"]*(#[0-9a-f]{3,8}\b|rgba?\(|hsl\(|gradient)/i);
    for (const svg of container.querySelectorAll('svg')) expect(svg.outerHTML, 'svg paint').not.toMatch(/(stroke|fill)="(#[0-9a-f]{3,8}|rgba?\(|hsl\()/i);
  });
});
