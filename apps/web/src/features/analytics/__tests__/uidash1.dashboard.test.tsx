// @vitest-environment jsdom
// T0D-UIDASH-1 (1) /analytics as template 5 REPORT (LD-353 rules 8 and 10; done_when (1)). Renders DashboardView with fake data twice: an empty period and one row of data.
// Contract: h1 = menu label (t('analytics.nav.dashboard')); ONE `.lims-stat-row` holding exactly four equal tiles, labelled in this order
//   "Patient visits", "Reports pending", "Net sales", "Cash collected" (money tiles only when the API sent them); the "Needs you" card and the pipeline stepper stay;
//   then ChartCards titled "Net sales per day" and "Top departments" side by side (same parent, nothing else in that row); each frame ALWAYS draws its chart
//   and says "No data yet" when the period is empty OR the role may not read money (then no department name or amount leaks); "Show yesterday" stays on an empty period.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { cardByTitle, cards, cardTitle, frameDraws, frameSaysNoData, hasAlert, norm, tileLabel, tileRows, tiles, titles } from '@/__tests__/uidash1.helpers';

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

  it('data: ONE row of exactly four equal tiles: Patient visits, Reports pending, Net sales, Cash collected', () => {
    const { container } = mount(withData());
    const rows = tileRows(container);
    expect(rows, 'one StatTileRow').toHaveLength(1);
    expect(tiles(container).map(tileLabel)).toEqual(['Patient visits', 'Reports pending', 'Net sales', 'Cash collected']);
    expect([...rows[0]!.children].every((c) => c.classList.contains('lims-stat')), 'the row holds only tiles').toBe(true);
  });

  it('a role without money: the two money tiles are not drawn, the count tiles are', () => {
    const { container } = mount(noMoney());
    expect(tiles(container).map(tileLabel)).toEqual(['Patient visits', 'Reports pending']);
  });

  it('data: "Needs you" card with its list and the pipeline stepper are kept', () => {
    const { container } = mount(withData());
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /reports pending 5/i })).toBeTruthy();
    expect(container.querySelector('ol.lims-stepper-list[aria-label="Sample pipeline"]')).not.toBeNull();
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
  it('data: "Net sales per day" then "Top departments", side by side in one row of two cards', () => {
    const { container } = mount(withData());
    const cs = cards(container);
    expect(cs.map(cardTitle)).toEqual(['Net sales per day', 'Top departments']);
    expect(cs[0]!.parentElement, 'same row').toBe(cs[1]!.parentElement);
    expect([...cs[0]!.parentElement!.children]).toEqual(cs);
    for (const c of cs) { expect(frameDraws(c)).toBe(true); expect(frameSaysNoData(c)).toBe(false); }
    expect(norm(container.textContent)).toContain(DEPT);
  });

  it('the line chart is first in the DOM (two thirds) and the bar chart second (one third); the row is the one the stylesheet sizes', () => {
    const { container } = mount(withData());
    const row = cards(container)[0]!.parentElement!;
    expect(row.className, 'a named row class the kit/feature css sizes 2:1').toMatch(/lims-[a-z-]*(charts|chart-row)/);
  });

  it('EMPTY period: both frames still draw and each says "No data yet" (today they are hidden)', () => {
    const { container } = mount(emptyPeriod());
    const cs = cards(container);
    expect(cs.map(cardTitle)).toEqual(['Net sales per day', 'Top departments']);
    for (const c of cs) { expect(frameDraws(c), `${cardTitle(c)} draws`).toBe(true); expect(frameSaysNoData(c), `${cardTitle(c)} says No data yet`).toBe(true); }
  });

  it('a role that may not read money: both frames draw with "No data yet", no department name and no amount leaks', () => {
    const { container } = mount(noMoney());
    const cs = cards(container);
    expect(cs.map(cardTitle)).toEqual(['Net sales per day', 'Top departments']);
    for (const c of cs) { expect(frameDraws(c)).toBe(true); expect(frameSaysNoData(c)).toBe(true); }
    expect(container.textContent).not.toContain(DEPT);
    expect(container.textContent).not.toMatch(/Rs\.|NPR|225,000|123,456/);
  });

  it('data with no departments yet: only the department frame says "No data yet"', () => {
    const d = withData();
    d.department_top = [];
    const { container } = mount(d);
    expect(frameSaysNoData(cardByTitle(container, 'Net sales per day')!)).toBe(false);
    expect(frameSaysNoData(cardByTitle(container, 'Top departments')!)).toBe(true);
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
