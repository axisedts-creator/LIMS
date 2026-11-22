// @vitest-environment jsdom
// T0D-UIDASH-1 (1) /analytics as template 5 REPORT (LD-353 rules 8 and 10; done_when (1)). Renders DashboardView with fake data twice: an empty period and one row of data.
// Contract: h1 = menu label (t('analytics.nav.dashboard')); the "Needs you" card and the pipeline stepper stay.
// RE-PINNED by T0D-UIDASH-2 (LD-436 mock, LD-437 exact match; review item 1): the old four-tile header row (Patient visits, Reports pending, Net sales, Cash collected) is gone; the
//   StatTile cells now live only in the Money card (Billed, Collected, Outstanding, Cash in drawer; none when the API sent no money tile). Charts are ChartCards titled
//   "Billed per day" and "Tests by department" side by side (same parent, nothing else in that row); "Billed per day" ALWAYS draws its frame and says "No data yet" when the
//   period is empty OR the role may not read money; "Tests by department" says "Not available yet" (the contract has no test count per department) and never leaks a
//   department name or amount; "Show yesterday" stays on an empty period.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { cardByTitle, cardNotAvailable, cards, cardTitle, frameDraws, frameSaysNoData, hasAlert, norm, tileLabel, tileRows, tiles, titles } from '@/__tests__/uidash1.helpers';

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
const DEPT = 'Synthetic Biochemistry';
const base = {
  report_code: 'dashboard',
  period: { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' },
  scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: ['orders', 'income', 'results', 'collections'].map((family) => ({ family, refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false })),
  generated_at: '2026-01-15T04:30:00.000Z',
};
const withData = () => ({
  ...base,
  tiles: {
    patient_visits: tile(12, 'count', { previous: 10, delta: 2, delta_bp: 2000 }), new_patients: tile(4), tests_ordered: tile(31),
    net_sales_paisa: tile(22500000, 'paisa'), invoiced_paisa: tile(23000000, 'paisa'), credit_notes_paisa: tile(500000, 'paisa'),
    net_collected_paisa: tile(21000000, 'paisa'), results_approved: tile(28), reports_pending: tile(5), pending_tests: tile(9),
  },
  series: { days: [{ business_date: '2026-01-14', net_sales_paisa: 20000000, patient_visits: 10, net_orders: 11 }, { business_date: '2026-01-15', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] },
  department_top: [{ department_id: 'd1', label: DEPT, net_paisa: 12345600, is_multiple: false }],
});
const emptyPeriod = () => ({
  ...base,
  tiles: { patient_visits: tile(0), net_sales_paisa: tile(0, 'paisa'), net_collected_paisa: tile(0, 'paisa'), reports_pending: tile(0), results_approved: tile(0), pending_tests: tile(0) },
  series: { days: [] }, department_top: [],
});
// a role that may not read money: the API sends no money tile (DashboardView comment: "the API sent no money tile = this role may not read money")
const noMoney = () => {
  const d = withData();
  for (const k of ['net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'net_collected_paisa']) delete (d.tiles as Record<string, unknown>)[k];
  return d;
};
const mount = (dto: unknown, readOnly = false) => render(<ToastProvider><DashboardView dto={dto as never} query="" readOnly={readOnly} /></ToastProvider>);
afterEach(cleanup);

describe('/analytics header and tiles (template 5)', () => {
  it.each([['empty period', emptyPeriod], ['one row of data', withData]])('%s: the h1 is the menu label, once', (_n, make) => {
    const { container } = mount(make());
    expect(titles(container)).toEqual([t('analytics.nav.dashboard')]);
  });

  it('data: no header tile row; the only StatTile cells are the four of the Money card: Billed, Collected, Outstanding, Cash in drawer', () => {
    const { container } = mount(withData());
    expect(tileRows(container), 'no StatTileRow').toHaveLength(0);
    expect(tiles(container).map(tileLabel).map((l) => l.replace(/^(Cash in drawer).*/, '$1'))).toEqual(['Billed', 'Collected', 'Outstanding', 'Cash in drawer']);
    for (const s of tiles(container)) expect(s.closest('.lims-card'), 'cell inside a kit Card').not.toBeNull();
  });

  it('a role without money: no Money card and no tile at all', () => {
    const { container } = mount(noMoney());
    expect(tiles(container).map(tileLabel)).toEqual([]);
  });

  it('data: "Needs you" card with its list and the pipeline stepper are kept', () => {
    const { container } = mount(withData());
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy();
    const row = [...container.querySelectorAll<HTMLAnchorElement>('ul.lims-action-list a.lims-action-row')].find((r) => /^reports pending$/i.test(norm(r.querySelector('.lims-action-title')?.textContent)));
    expect(row, 'ActionList row "Reports pending"').toBeDefined();
    expect(norm(row!.querySelector('.lims-chip')?.textContent)).toBe('5');
    expect([...container.querySelectorAll('.lims-stepper li.lims-step .lims-step-label')].map((e) => norm(e.textContent))).toEqual(['Registered', 'Collected', 'Received', 'In testing', 'Verified', 'Released']);
  });

  it('empty period: "Needs you" says nothing needs you, and "Show yesterday" is still offered', () => {
    mount(emptyPeriod());
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy();
    expect(screen.getByText(/nothing needs you/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /show yesterday/i })).toBeTruthy();
  });

  it('one freshness note for the page, not one per tile (stale data)', () => {
    const d = withData();
    d.freshness = d.freshness.map((f) => ({ ...f, is_stale: true, stale_reason: 'refresh_lagging' } as never));
    const { container } = mount(d);
    const notes = [...container.querySelectorAll('*')].filter((e) => e.children.length === 0 && /data may be out of date/i.test(e.textContent ?? ''));
    expect(notes).toHaveLength(1);
    for (const s of tiles(container)) expect(s.textContent).not.toMatch(/out of date/i);
  });
});

describe('/analytics chart row (LD-353 rule 10: the frame ALWAYS draws)', () => {
  it('data: "Billed per day" then "Tests by department", side by side in one row of two cards', () => {
    const { container } = mount(withData());
    const cs = cards(container);
    expect(cs.map(cardTitle)).toEqual(['Billed per day', 'Tests by department']);
    expect(cs[0]!.parentElement, 'same row').toBe(cs[1]!.parentElement);
    expect([...cs[0]!.parentElement!.children]).toEqual(cs);
    // T0D-DASHCARDS-1 (LD-447, founder order 2026-11-22): the charts draw the dashboard series and department_top (bars), they no longer say "Not available yet"
    expect(frameDraws(cs[0]!)).toBe(true); expect(cardNotAvailable(cs[0]!), 'Billed per day draws the series').toBe(false);
    expect(cardNotAvailable(cs[1]!), 'Tests by department draws department_top').toBe(false);
    expect(cs[0]!.querySelectorAll('.lims-chart-bar')).toHaveLength(2);
    expect(norm(cs[1]!.textContent), 'the department label is drawn').toContain(DEPT);
  });

  it('the line chart is first in the DOM (two thirds) and the bar chart second (one third); the row is the one the stylesheet sizes', () => {
    const { container } = mount(withData());
    const row = cards(container)[0]!.parentElement!;
    expect(row.className, 'a named row class the kit/feature css sizes 2:1').toMatch(/lims-[a-z-]*(charts|chart-row)/);
  });

  it('EMPTY period: both frames still draw and say "No data yet" (T0D-DASHCARDS-1)', () => {
    const { container } = mount(emptyPeriod());
    const cs = cards(container);
    expect(cs.map(cardTitle)).toEqual(['Billed per day', 'Tests by department']);
    // T0D-DASHCARDS-1: fresh data with an empty series says "No data yet" (a stale read model says "Data is being prepared": dashcards1.dashboard.test.tsx)
    expect(frameDraws(cs[0]!), 'Billed per day draws').toBe(true); expect(norm(cs[0]!.textContent), 'Billed per day says No data yet').toMatch(/no data yet/i);
    expect(norm(cs[1]!.textContent)).toMatch(/no data yet/i);
  });

  it('a role that may not read money: both frames draw ("No data yet" / "Not available yet"), no department name and no amount leaks', () => {
    const { container } = mount(noMoney());
    const cs = cards(container);
    expect(cs.map(cardTitle)).toEqual(['Billed per day', 'Tests by department']);
    expect(frameDraws(cs[0]!)).toBe(true); expect(cardNotAvailable(cs[0]!)).toBe(true);
    expect(cardNotAvailable(cs[1]!)).toBe(true);
    expect(container.textContent).not.toContain(DEPT);
    expect(container.textContent).not.toMatch(/Rs\.|NPR|225,000|123,456/);
  });

  it('data with no departments yet: "Billed per day" still draws, "Tests by department" says "No data yet"', () => {
    const d = withData();
    d.department_top = [];
    const { container } = mount(d);
    expect(frameSaysNoData(cardByTitle(container, 'Billed per day')!)).toBe(false);
    expect(norm(cardByTitle(container, 'Tests by department')!.textContent), 'T0D-DASHCARDS-1: no departments = No data yet').toMatch(/no data yet/i);
  });

  it('charts use accent plus grey: no inline colour literal in the chart cards', () => {
    const { container } = mount(withData());
    for (const c of cards(container)) expect(c.outerHTML, `${cardTitle(c)}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(|gradient/i);
  });
});

describe('/analytics embedded in a report run (readOnly)', () => {
  it('has no page header, no h1 and no alert', () => {
    const { container } = mount(withData(), true);
    expect(titles(container)).toEqual([]);
    expect(hasAlert(container)).toBe(false);
    expect(screen.queryByRole('button', { name: /show yesterday/i })).toBeNull();
  });
});
