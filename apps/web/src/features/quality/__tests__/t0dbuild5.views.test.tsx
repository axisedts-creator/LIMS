// @vitest-environment jsdom
// T0D-BUILD-5 (founder order 2026-11-22 22:06 NPT; LD-455), views driven directly with synthetic rows (done_when 2, 3, 4, 6):
//  (2) TAT tiles + chart: contract listTatAlerts (contracts/openapi/quality.yaml) answers { data, page: { limit, next_cursor? }, generated_at } = NO total and NO count field.
//      So: a page with `next` shows 'at least N' (N = what the page holds) on every tile and says so in the chart card; without `next` the plain count. Never an invented total.
//  (3) Department and Centre columns show the NAMES the page already has (departments / centres options); the (short) id, full id in its title, only when the name is unknown.
//  (4) The chart data of /quality, /quality/runs and /quality/tat-alerts is a kit DataTable INSIDE the ChartCard (so the one-table page checks of uidash1 still hold):
//      no raw <table> in the card, header cells left aligned (kit class lims-align-start), the number column right aligned (lims-align-end), never centred.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { cardByTitle, norm, tileLabel, tileValue, tiles } from '@/__tests__/uidash1.helpers';

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

import { RunsView } from '../components/RunsView';
import { StatusBoardView } from '../components/StatusBoardView';
import { TatView } from '../tat/TatView';

const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
const DEPT_KNOWN = id(7001);
const DEPT_UNKNOWN = id(7002);
const CENTRE_KNOWN = id(7003);
const CENTRE_UNKNOWN = id(7004);
const DEPTS = [{ value: DEPT_KNOWN, label: 'Synthetic Biochemistry' }];
const CENTRES = [{ value: CENTRE_KNOWN, label: 'Synthetic Centre One' }];

const tat = (n: number, level: string, o: Record<string, unknown> = {}) => ({ tat_item_id: id(200 + n), version: 1, order_id: id(300), order_item_id: id(301), test_id: id(302), test_code: `T${n}`,
  department_id: DEPT_KNOWN, specimen_id: id(304), centre_id: CENTRE_KNOWN, priority: 'routine', segment: 'within_lab', segment_label: 'Within lab: received to first verified result', alert_level: level,
  started_at: '2026-11-14T01:00:00.000Z', elapsed_seconds: 5400, target_seconds: 3600, pct_of_target: 150, ...o });
const mountTat = (rows: unknown[], next?: string, extra: Record<string, unknown> = {}) =>
  render(<ToastProvider><TatView page={{ rows, ...(next ? { next } : {}) } as never} generatedAt="2026-11-14T04:00:00.000Z" sp={{}} canAck={false} departments={DEPTS} centres={CENTRES} {...extra} /></ToastProvider>);

const statusRow = (n: number, o: Record<string, unknown> = {}) => ({ plan_id: id(10 + n), instrument_id: id(1), instrument_label: 'SYN-CHEM-01', analyte_id: id(2), analyte_code: `AN${n}`, status: 'in_control',
  last_in_control_run_at: '2026-11-14T03:10:00.000Z', violated_rules: [], open_rejected_run_ids: [], qc_overdue: false, patient_results_since_last_qc: 0, ...o });
const STATUS_ROWS = [statusRow(1), statusRow(2, { status: 'warning' }), statusRow(3, { status: 'out_of_control', qc_overdue: true, open_rejected_run_ids: [id(50)] }), statusRow(4, { status: 'out_of_control' })];
const run = (n: number, o: Record<string, unknown> = {}) => ({ id: id(100 + n), version: 1, plan_id: id(11), instrument_id: id(1), analyte_id: id(2), run_at: '2026-11-14T03:00:00.000Z', status: 'evaluated', outcome: 'accepted',
  is_complete: true, observation_count: 2, controls_per_run: 2, rule_mode: 'classic', warning_rules: [], rules_violated: [], needs_action: false, ...o });
const RUNS = [run(1), run(2), run(3, { outcome: 'rejected', rules_violated: ['1-3s'], needs_action: true, needs_action_reason: 'corrective_action' })];
const TATS = [tat(1, 'warning'), tat(2, 'breached'), tat(3, 'breached'), tat(4, 'escalated')];

afterEach(cleanup);

// ---------------------------------------------------------------- (2) real totals
describe('TAT tiles and chart: never an invented total (contract has no total/count field)', () => {
  const tileTexts = (c: ParentNode) => Object.fromEntries(tiles(c).map((t) => [tileLabel(t), tileValue(t)]));

  it("a next page exists: every tile reads 'at least N' with N = the alerts this page holds", () => {
    const { container } = mountTat(TATS, 'cursor-next');
    const v = tileTexts(container);
    expect(v['Warning']).toMatch(/at least\s*1\b/i);
    expect(v['Breached']).toMatch(/at least\s*2\b/i);
    expect(v['Escalated']).toMatch(/at least\s*1\b/i);
  });
  it("the sweep case: a full page of 50 escalated alerts with the Next button enabled reads 'at least 50', not a bare 50", () => {
    const rows = Array.from({ length: 50 }, (_, i) => tat(i, 'escalated'));
    const { container } = mountTat(rows, 'cursor-next');
    expect(tileTexts(container)['Escalated']).toMatch(/at least\s*50\b/i);
  });
  it('the chart card says the counts are a lower bound while a next page exists', () => {
    const { container } = mountTat(TATS, 'cursor-next');
    expect(norm(cardByTitle(container, 'Alerts by level')!.textContent)).toMatch(/at least/i);
  });
  it('the last page (no next): plain counts, no "at least" anywhere in tiles or chart card', () => {
    const { container } = mountTat(TATS);
    const v = tileTexts(container);
    expect(v['Warning']).toBe('1');
    expect(v['Breached']).toBe('2');
    expect(v['Escalated']).toBe('1');
    expect(norm(container.textContent)).not.toMatch(/at least/i);
  });
  it('no rows and no next page: tiles read 0, no "at least"', () => {
    const { container } = mountTat([]);
    expect(Object.values(tileTexts(container)).every((x) => x === '0')).toBe(true);
    expect(norm(container.textContent)).not.toMatch(/at least/i);
  });
});

// ---------------------------------------------------------------- (3) names instead of ids
describe('TAT table: Department and Centre show names, the id only when the name is unknown', () => {
  const cell = (container: ParentNode, header: string, rowText: string) => {
    const grid = [...container.querySelectorAll('[role="grid"]')].find((g) => g.getAttribute('aria-label') === 'TAT alerts')!;
    const heads = [...grid.querySelectorAll('[role="columnheader"]')].map((x) => norm(x.textContent));
    const at = heads.indexOf(header);
    expect(at, `column ${header} in ${JSON.stringify(heads)}`).toBeGreaterThanOrEqual(0);
    const row = [...grid.querySelectorAll('[role="row"]')].find((r) => norm(r.textContent).includes(rowText))!;
    expect(row, `row ${rowText}`).toBeTruthy();
    return row.children[at] as HTMLElement;
  };

  it('known department and centre: the cell reads the name and the id is not on screen', () => {
    const { container } = mountTat([tat(1, 'breached')]);
    expect(norm(cell(container, 'Department', 'T1').textContent)).toBe('Synthetic Biochemistry');
    expect(norm(cell(container, 'Centre', 'T1').textContent)).toBe('Synthetic Centre One');
    expect(container.querySelector(`[title="${DEPT_KNOWN}"]`), 'department id still drawn').toBeNull(); // the kit IdText always carries the full id in its title
    expect(container.querySelector(`[title="${CENTRE_KNOWN}"]`), 'centre id still drawn').toBeNull();
  });
  it('unknown department and centre: the id is the fallback (short text, full id in the title), never an empty cell', () => {
    const { container } = mountTat([tat(1, 'breached', { department_id: DEPT_UNKNOWN, centre_id: CENTRE_UNKNOWN })]);
    const d = cell(container, 'Department', 'T1');
    const c = cell(container, 'Centre', 'T1');
    expect(d.textContent).toContain(DEPT_UNKNOWN.slice(0, 8));
    expect(d.querySelector(`[title="${DEPT_UNKNOWN}"]`)).not.toBeNull();
    expect(c.textContent).toContain(CENTRE_UNKNOWN.slice(0, 8));
    expect(c.querySelector(`[title="${CENTRE_UNKNOWN}"]`)).not.toBeNull();
  });
  it('mixed rows are resolved row by row', () => {
    const { container } = mountTat([tat(1, 'breached'), tat(2, 'breached', { department_id: DEPT_UNKNOWN, centre_id: CENTRE_UNKNOWN })]);
    expect(norm(cell(container, 'Department', 'T1').textContent)).toBe('Synthetic Biochemistry');
    expect(cell(container, 'Department', 'T2').textContent).toContain(DEPT_UNKNOWN.slice(0, 8));
  });
  it('the lookups failed (no options): every row falls back to the id, the table still renders', () => {
    const { container } = mountTat([tat(1, 'breached')], undefined, { departments: [], centres: [] });
    expect(cell(container, 'Department', 'T1').textContent).toContain(DEPT_KNOWN.slice(0, 8));
    expect(cell(container, 'Centre', 'T1').textContent).toContain(CENTRE_KNOWN.slice(0, 8));
  });
  it('a name is rendered as text, never as markup (a hostile centre name stays inert)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { container } = mountTat([tat(1, 'breached')], undefined, { centres: [{ value: CENTRE_KNOWN, label: evil }] });
    expect(container.querySelector('img')).toBeNull();
    expect(norm(cell(container, 'Centre', 'T1').textContent)).toBe(evil);
  });
});

// ---------------------------------------------------------------- (4) chart data = kit DataTable, left aligned headers
type Screen = { name: string; chart: string; mount: () => ReturnType<typeof render>; numbers: Record<string, string> };
const SCREENS: Screen[] = [
  { name: '/quality (QC status)', chart: 'Pairs by status',
    mount: () => render(<ToastProvider><StatusBoardView rows={STATUS_ROWS as never} generatedAt="2026-11-14T04:00:00.000Z" sp={{}} canManage={false} /></ToastProvider>),
    numbers: { 'In control': '1', Warning: '1', 'Out of control': '2' } },
  { name: '/quality/runs (QC runs)', chart: 'Runs by outcome',
    mount: () => render(<ToastProvider><RunsView rows={RUNS as never} hasPrevious={false} sp={{}} labels={{ [id(11)]: { instrument: 'SYN-CHEM-01', analyte: 'GLU' } }} /></ToastProvider>),
    numbers: {} },
  { name: '/quality/tat-alerts (TAT alerts)', chart: 'Alerts by level', mount: () => mountTat(TATS), numbers: { Warning: '1', Breached: '2', Escalated: '1' } },
];

describe.each(SCREENS)('$name: the chart data is a kit DataTable with left aligned headers', (s) => {
  const card = (c: ParentNode) => cardByTitle(c, s.chart)!;

  it('the chart card has no raw <table>; its data is a kit DataTable (role grid) named after the chart', () => {
    const { container } = s.mount();
    expect(card(container), s.chart).toBeTruthy();
    expect(card(container).querySelectorAll('table:not([role="grid"])'), 'raw table inside the chart card').toHaveLength(0);
    const grids = card(container).querySelectorAll('[role="grid"]');
    expect(grids).toHaveLength(1);
    expect(grids[0]!.getAttribute('aria-label')).toBe(s.chart);
    expect(card(container).querySelector('.lims-data-table')).not.toBeNull();
  });
  it('first column header is left aligned (lims-align-start); number columns are right aligned (lims-align-end); nothing is centred', () => {
    const { container } = s.mount();
    const heads = [...card(container).querySelectorAll('[role="columnheader"]')];
    expect(heads.length).toBeGreaterThanOrEqual(2);
    expect(heads[0]!.className).toContain('lims-align-start');
    for (const hd of heads.slice(1)) expect(hd.className).toContain('lims-align-end');
    expect(card(container).innerHTML).not.toContain('lims-align-center');
    const cells = [...card(container).querySelectorAll('[role="row"]')].slice(1).flatMap((r) => [...r.children]);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => !c.className.includes('lims-align-center'))).toBe(true);
  });
  it('the table carries the same numbers as the screen counts', () => {
    const { container } = s.mount();
    const rows = [...card(container).querySelectorAll('[role="row"]')].slice(1).map((r) => [...r.children].map((c) => norm(c.textContent)));
    expect(rows.length).toBeGreaterThan(0);
    for (const [label, n] of Object.entries(s.numbers)) {
      const r = rows.find((x) => x[0] === label);
      expect(r, `row ${label} in ${JSON.stringify(rows)}`).toBeTruthy();
      expect(r!.slice(1).join(' ')).toMatch(new RegExp(`(^|\\s)${n}(\\s|$)`));
    }
  });
  it('the page still has ONE data table outside the chart (the rows table keeps its place)', () => {
    const { container } = s.mount();
    const outside = [...container.querySelectorAll('[role="grid"]')].filter((g) => !g.closest('.lims-chart-card'));
    expect(outside).toHaveLength(1);
  });
});
