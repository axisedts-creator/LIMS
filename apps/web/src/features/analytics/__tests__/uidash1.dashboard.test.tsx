// @vitest-environment jsdom
// T0D-UIDASH-1 (1) — /analytics as a REPORT screen (LD-353 template 5, rules 8 and 10). Fails today because: the h1 is "Dashboard" (not the menu label),
// the tiles are labelled "Income (net sales)" / "Cash collected (net)", there is no "Top departments" chart, the charts are plain Cards (no ChartCard frame),
// and for an empty period or a role without money the charts are not drawn at all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { cardTitled, cards, h1s, menuLabel, norm, oneTileRow, statLabels, stats } from './uidash1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/analytics' }));

import { DashboardView } from '@/features/analytics/components/DashboardView';

const tile = (value: number, unit = 'count', extra: Record<string, unknown> = {}) => ({ value, unit, ...extra });
const fam = (family: string, stale: boolean) => ({ family, refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: stale, ...(stale ? { stale_reason: 'refresh_lagging' } : {}), live: false });
const PERIOD = { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' };
const TILES = {
  patient_visits: tile(12, 'count', { previous: 10, delta: 2, delta_bp: 2000 }), new_patients: tile(4), tests_ordered: tile(31),
  net_sales_paisa: tile(22500000, 'paisa', { previous: 20810000, delta: 1690000, delta_bp: 812 }), invoiced_paisa: tile(23000000, 'paisa'), credit_notes_paisa: tile(500000, 'paisa'),
  net_collected_paisa: tile(21000000, 'paisa'), results_approved: tile(28), reports_pending: tile(5), pending_tests: tile(9), pending_overdue: tile(1), reports_ready_unreleased: tile(2),
};
const ZERO = Object.fromEntries(Object.entries(TILES).map(([k, v]) => [k, { ...v, value: 0, previous: undefined, delta: undefined, delta_bp: undefined }]));
const DEPTS = [
  { department_id: '01a1a98a-ac40-7000-8000-0000000d0001', label: 'Biochemistry', is_multiple: false, net_paisa: 900000, share_bp: 6000 },
  { department_id: '01a1a98a-ac40-7000-8000-0000000d0002', label: 'Haematology', is_multiple: false, net_paisa: 600000, share_bp: 4000 },
];
const dto = (over: Record<string, unknown> = {}) => ({
  report_code: 'dashboard', period: PERIOD, scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: ['orders', 'income', 'results', 'collections'].map((f) => fam(f, false)), generated_at: '2026-01-15T04:30:00.000Z',
  tiles: TILES,
  series: { days: [{ business_date: '2026-01-14', net_sales_paisa: 20810000, patient_visits: 10, net_orders: 11 }, { business_date: '2026-01-15', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] },
  department_top: DEPTS, ...over,
});
const withoutMoney = () => { const { net_sales_paisa: _a, invoiced_paisa: _b, credit_notes_paisa: _c, net_collected_paisa: _d, ...rest } = TILES; return rest; };
const mount = (d: Record<string, unknown>) => render(<ToastProvider><DashboardView dto={d as never} query="" /></ToastProvider>);
afterEach(cleanup);

describe('/analytics — REPORT template (done_when 1)', () => {
  it('the one h1 is the menu label', () => {
    const { container } = mount(dto());
    expect(h1s(container)).toEqual([menuLabel('/analytics')]);
  });

  it('StatTileRow: the first four equal tiles are Patient visits, Reports pending, Net sales, Cash collected, all in one row', () => {
    const { container } = mount(dto());
    expect(statLabels(container).slice(0, 4)).toEqual(['Patient visits', 'Reports pending', 'Net sales', 'Cash collected']);
    expect(oneTileRow(container), 'every tile shares one row that holds only tiles').toBe(true);
  });

  it('one freshness note for the page when stale (none per tile); a fresh page has no stale wording', () => {
    const stale = mount(dto({ freshness: ['orders', 'income', 'results', 'collections'].map((f) => fam(f, true)) }));
    const notes = [...stale.container.querySelectorAll('*')].filter((e) => e.children.length === 0 && /data may be out of date/i.test(e.textContent ?? ''));
    expect(notes).toHaveLength(1);
    for (const s of stats(stale.container)) expect(s.textContent).not.toMatch(/out of date/i);
    cleanup();
    expect(mount(dto()).container.textContent).not.toMatch(/out of date|stale/i);
  });

  it('keeps the "Needs you" card with its list, and the pipeline stepper', () => {
    const { container } = mount(dto());
    const h2 = [...container.querySelectorAll('h2')].find((h) => norm(h.textContent) === 'Needs you');
    expect(h2, 'Needs you heading').toBeTruthy();
    const card = h2!.closest('.lims-card, section');
    expect(card?.querySelectorAll('a').length, 'its list has links').toBeGreaterThan(0);
    expect(container.querySelector('ol.lims-stepper-list[aria-label="Sample pipeline"]')).toBeTruthy();
  });

  it('ChartCard row: "Net sales per day" (line) then "Top departments" (bar), side by side, after the tiles, the needs-you card and the pipeline', () => {
    const { container } = mount(dto());
    const line = cardTitled(container, 'Net sales per day');
    const bar = cardTitled(container, 'Top departments');
    expect(line, 'ChartCard "Net sales per day"').toBeTruthy();
    expect(bar, 'ChartCard "Top departments"').toBeTruthy();
    expect(line!.parentElement, 'one row').toBe(bar!.parentElement);
    expect(line!.compareDocumentPosition(bar!) & Node.DOCUMENT_POSITION_FOLLOWING, 'line first (two thirds), bar second (one third)').toBeTruthy();
    expect(line!.querySelector('svg'), 'line chart drawn').toBeTruthy();
    expect(bar!.querySelector('svg'), 'bar chart drawn').toBeTruthy();
    expect(bar!.textContent).toContain('Biochemistry');
    const after = (el: Element | null) => !!el && !!(el.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(container.querySelector('.lims-stat-row')), 'after the tile row').toBe(true);
    expect(after(container.querySelector('ol.lims-stepper-list')), 'after the pipeline').toBe(true);
    expect(after([...container.querySelectorAll('h2')].find((h) => norm(h.textContent) === 'Needs you') ?? null), 'after Needs you').toBe(true);
    expect(cards(container).filter((c) => c.querySelector('.lims-chart-empty')), 'no "No data yet" with data').toHaveLength(0);
  });

  it('an empty period still draws both chart frames, each with the "No data yet" line; Show yesterday stays', () => {
    const { container } = mount(dto({ tiles: ZERO, series: { days: [] }, department_top: [] }));
    for (const title of ['Net sales per day', 'Top departments']) {
      const c = cardTitled(container, title);
      expect(c, `ChartCard "${title}" must draw when empty`).toBeTruthy();
      expect(c!.querySelector('svg'), `${title}: the frame still draws its chart`).toBeTruthy();
      expect(norm(c!.querySelector('.lims-chart-empty')?.textContent)).toBe('No data yet');
    }
    expect(screen.getByRole('button', { name: 'Show yesterday' })).toBeTruthy();
  });

  it('a role that may not read money (no paisa tile) still sees both chart frames with "No data yet" and no money figure', () => {
    const { container } = mount(dto({ tiles: withoutMoney() }));
    for (const title of ['Net sales per day', 'Top departments']) {
      const c = cardTitled(container, title);
      expect(c, `ChartCard "${title}" must draw for a no-money role`).toBeTruthy();
      expect(norm(c!.querySelector('.lims-chart-empty')?.textContent)).toBe('No data yet');
    }
    expect(norm(container.textContent)).not.toMatch(/Rs\. [\d,]+\.\d\d/);
    expect(statLabels(container)).not.toContain('Net sales');
  });

  it('error/empty states keep the page title: the title never depends on the data', () => {
    for (const d of [dto(), dto({ tiles: ZERO, series: { days: [] }, department_top: [] }), dto({ tiles: withoutMoney() })]) {
      const { container } = mount(d);
      expect(h1s(container)).toEqual([menuLabel('/analytics')]);
      cleanup();
    }
  });

  it('the Refresh and "Show yesterday" (empty period) actions are kept', () => {
    mount(dto());
    expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy();
  });
});
