// @vitest-environment jsdom
// T0D-UIDASH-1 (6) quality: indicators (QC status), runs and TAT alerts on the same REPORT layout (LD-353 template 5), plus the Levey-Jennings screen (restyle only).
// Each screen is rendered with no rows and with one row of each kind. Fails today because none of the three has a StatTile row.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { filterBars, h1s, headerCells, menuLabel, norm, oneTileRow, statLabels, statOf } from '@/features/analytics/__tests__/uidash1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/quality',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/quality' }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : async () => undefined) }) }));
vi.mock('@/features/quality/server/actions', stub);
vi.mock('@/features/quality/tat/actions', stub);

import { StatusBoardView } from '@/features/quality/components/StatusBoardView';
import { RunsView } from '@/features/quality/components/RunsView';
import { LjView } from '@/features/quality/components/LjView';
import { TatView } from '@/features/quality/tat/TatView';

const wrap = (el: React.ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
afterEach(cleanup);
const U = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
const NOW = '2026-11-14T03:00:00.000Z';

const statusRow = (n: number, status: string, over: Record<string, unknown> = {}) => ({
  plan_id: U(1000 + n), instrument_id: U(1), instrument_label: 'SYN-CHEM-01 Synthetic Chemistry Analyser', analyte_id: U(2), analyte_code: `AN${n}`, status,
  last_in_control_run_at: NOW, violated_rules: [], open_rejected_run_ids: [], qc_overdue: false, patient_results_since_last_qc: 0, ...over,
});
const STATUS_ROWS = [statusRow(1, 'in_control'), statusRow(2, 'warning'), statusRow(3, 'out_of_control', { violated_rules: ['1-3s'] }), statusRow(4, 'no_qc_data', { last_in_control_run_at: undefined })];
const runRow = (n: number, outcome: string, over: Record<string, unknown> = {}) => ({
  id: U(2000 + n), version: 1, plan_id: U(1000 + n), instrument_id: U(1), analyte_id: U(2), run_at: NOW, status: 'evaluated', outcome, is_complete: true, observation_count: 2, controls_per_run: 2,
  rule_mode: 'classic', warning_rules: [], rules_violated: [], needs_action: false, ...over,
});
const RUN_ROWS = [runRow(1, 'accepted'), runRow(2, 'rejected', { rules_violated: ['1-3s'], needs_action: true, needs_action_reason: 'corrective_action' }), runRow(3, 'incomplete')];
const tatRow = (n: number, level: string) => ({
  tat_item_id: U(3000 + n), version: 1, test_code: `T${n}`, department_id: U(4), centre_id: U(5), priority: 'routine', segment: 'within_lab', segment_label: 'Received to approved',
  started_at: NOW, elapsed_seconds: 5400, target_seconds: 3600, pct_of_target: 150, alert_level: level,
});
const TAT_ROWS = [tatRow(1, 'warning'), tatRow(2, 'breached'), tatRow(3, 'escalated'), tatRow(4, 'escalated')];

const SCREENS = [
  {
    name: 'QC status (indicators)', path: '/quality',
    el: (full: boolean) => <StatusBoardView rows={(full ? STATUS_ROWS : []) as never} generatedAt={NOW} sp={{}} canManage />,
    headers: ['Instrument', 'Analyte', 'Status'], tiles: ['In control', 'Warning', 'Out of control', 'No QC data'], counts: [1, 1, 1, 1], emptyCounts: [0, 0, 0, 0],
  },
  {
    name: 'QC runs', path: '/quality/runs',
    el: (full: boolean) => <RunsView rows={(full ? RUN_ROWS : []) as never} hasPrevious={false} sp={{}} labels={{}} />,
    headers: ['Run time', 'Instrument', 'Analyte', 'Outcome'], tiles: ['Accepted', 'Rejected', 'Needs action'], counts: [1, 1, 1], emptyCounts: [0, 0, 0],
  },
  {
    name: 'TAT alerts', path: '/quality/tat-alerts',
    el: (full: boolean) => <TatView page={{ rows: (full ? TAT_ROWS : []) as never }} generatedAt={NOW} sp={{}} canAck />,
    headers: ['Level', 'Test', 'Priority', 'Segment'], tiles: ['Warning', 'Breached', 'Escalated'], counts: [1, 1, 2], emptyCounts: [0, 0, 0],
  },
] as const;

describe.each(SCREENS)('quality — $name', (s) => {
  it.each([['no rows', false], ['rows', true]])('%s: h1 is the menu label, exactly one FilterBar, the table header is present', (_n, full) => {
    const { container } = wrap(s.el(full));
    expect(h1s(container)).toEqual([menuLabel(s.path)]);
    expect(filterBars(container)).toHaveLength(1);
    expect(headerCells(container)).toEqual(expect.arrayContaining([...s.headers]));
    expect(container.querySelector('.lims-table-scroll'), 'table in the kit scroll box').toBeTruthy();
  });

  it.each([['no rows', false], ['rows', true]])('%s: StatTiles in one equal row with the counts', (_n, full) => {
    const { container } = wrap(s.el(full));
    expect(statLabels(container)).toEqual([...s.tiles]);
    expect(oneTileRow(container)).toBe(true);
    const want = full ? s.counts : s.emptyCounts;
    s.tiles.forEach((l, i) => expect(norm(statOf(container, l)!.textContent), `${l} count`).toMatch(new RegExp(`(^|\\D)${want[i]}(\\D|$)`)));
  });

  it('a hostile cell value stays text (no markup injection)', () => {
    const rows = s.name === 'TAT alerts' ? [{ ...tatRow(1, 'warning'), test_code: '<img src=x onerror=alert(1)>' }] : s.name === 'QC runs' ? [] : [statusRow(1, 'in_control', { instrument_label: '<img src=x onerror=alert(1)>' })];
    const el = s.name === 'TAT alerts' ? <TatView page={{ rows: rows as never }} generatedAt={NOW} sp={{}} canAck /> : s.name === 'QC runs' ? s.el(false) : <StatusBoardView rows={rows as never} generatedAt={NOW} sp={{}} canManage />;
    const { container } = wrap(el);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('quality — Levey-Jennings (restyle only)', () => {
  const lj = { plan: { id: U(1008), instrument_id: U(1), analyte_id: U(2), analyte_code: 'GLU', unit_code: 'mg_dl', decimals: 1 }, view: 'level', truncated: false, series: [] };

  it('no plan chosen: h1 is the menu label and the filter row is one FilterBar', () => {
    const { container } = wrap(<LjView sp={{}} plans={STATUS_ROWS as never} generatedAt={NOW} canManage exclusionOptions={[]} />);
    expect(h1s(container)).toEqual([menuLabel('/quality/lj')]);
    expect(filterBars(container)).toHaveLength(1);
  });

  it('plan chosen, no points: the title starts with the menu label, one FilterBar, the points table keeps its header', () => {
    const { container } = wrap(<LjView sp={{ plan_id: U(1008) }} plans={STATUS_ROWS as never} chart={lj as never} generatedAt={NOW} canManage exclusionOptions={[]} />);
    expect(h1s(container)[0]).toContain(menuLabel('/quality/lj'));
    expect(filterBars(container)).toHaveLength(1);
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Time', 'Value', 'Status']));
  });

  it('LJ colours: accent plus grey only — no colour tone class outside status chips and banners, no inline colour style', () => {
    const series = [{
      level_id: U(1004), level_code: 'L1', lot_id: U(1006), lot_no: 'SYN-LOT-001',
      points: [{ observation_id: U(2301), observed_at: NOW, value: '100.0', z: '0.000', status: 'accepted', rule_hits: [] }, { observation_id: U(2302), observed_at: NOW, value: '106.4', z: '3.200', status: 'rejected', qc_run_id: U(2000), rule_hits: ['1-3s'] }],
      targets: [{ target_id: U(1031), effective_from: '2026-11-01T00:00:00.000Z', mean: '100.0', sd: '2.0', source: 'established' }],
    }];
    const { container } = wrap(<LjView sp={{ plan_id: U(1008) }} plans={STATUS_ROWS as never} chart={{ ...lj, series } as never} generatedAt={NOW} canManage exclusionOptions={[]} />);
    const loose = [...container.querySelectorAll('[class*="lims-tone-"]')].filter((e) => !e.closest('.lims-chip, .lims-status-chip, .lims-badge, .lims-banner, [class*="lims-status"]'));
    expect(loose.map((e) => e.className), 'tone colour outside a status chip').toEqual([]);
    expect(container.querySelectorAll('[style*="color"], [style*="background"]'), 'inline colour').toHaveLength(0);
  });
});
