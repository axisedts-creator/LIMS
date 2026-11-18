// @vitest-environment jsdom
// T0D-UIDASH-1 (4) daily cash and (5) dues — LD-353 template 5 REPORT (rules 3, 5, 10). Each screen is rendered with no rows and with data.
// Fails today because: neither screen has StatTiles or a ChartCard; daily cash prints the business date twice (picker label + "Business date:" line, outside the header);
// dues has no FilterBar and no aging chart; money cells are not in the kit scroll box with the header.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { cards, chartRows, filterBars, h1s, hasNotAvailable, headerCells, menuLabel, norm, num, oneTileRow, statLabels, statOf } from '@/features/analytics/__tests__/uidash1.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/billing/daily-cash',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/billing' }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }) }));
vi.mock('@/features/billing/server/actions', stub);

import { DailyCashView } from '@/features/billing/components/DailyCashView';
import { DuesList } from '@/features/billing/components/DuesList';

const wrap = (el: React.ReactElement) => render(<ToastProvider>{el}</ToastProvider>);
afterEach(cleanup);
const m = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const staff = (n: number) => ({ membership_id: `01a1a98a-ac40-7000-8000-00000000a${String(n).padStart(3, '0')}`, display_name: `Synthetic Cashier ${n}` });
const crow = (n: number, method: string, gross: number, reversed = 0) => ({ collected_by: staff(n), method_code: method, entries: 2, reversals: reversed ? 1 : 0, gross: m(gross), reversed: m(reversed), net: m(gross - reversed) });
const SESSION = { id: '01a1a98a-ac40-7000-8000-00000000e001', opened_by: staff(1), centre_id: 'c1', status: 'closed', opened_at: '2026-01-15T03:00:00.000Z', closed_at: '2026-01-15T10:00:00.000Z', version: 1,
  rows: [{ method_code: 'cash', expected: m(150000), counted: m(149500), variance: m(-500) }] };
const emptyCash = { business_date: '2026-01-15', business_date_bs: '2082-10-01', rows: [], totals: { gross: m(0), reversed: m(0), net: m(0) }, sessions: [] };
const fullCash = {
  business_date: '2026-01-15', business_date_bs: '2082-10-01',
  rows: [crow(1, 'cash', 120000, 20000), crow(2, 'cash', 50000), crow(1, 'qr', 30000)],
  totals: { gross: m(200000), reversed: m(20000), net: m(180000) }, sessions: [SESSION],
};

describe.each([['no rows', emptyCash], ['data', fullCash]])('billing daily cash — %s', (name, report) => {
  const mount = () => wrap(<DailyCashView report={report as never} session={null} permissions={['billing.cash_report.read']} />);
  const full = name === 'data';

  it('h1 is the menu label; the business date appears ONCE and inside the header slot; at most one FilterBar', () => {
    const { container } = mount();
    expect(h1s(container)).toEqual([menuLabel('/billing/daily-cash')]);
    const text = norm(container.textContent);
    expect(text.split('2082-10-01').length - 1, 'B.S. business date printed once').toBe(1);
    expect(norm(container.querySelector('.lims-page-header')!.textContent)).toContain('2082-10-01');
    expect(text.split('Business date').length - 1, 'the words "Business date" at most once').toBeLessThanOrEqual(1);
    expect(filterBars(container).length).toBeLessThanOrEqual(1);
  });

  it('StatTiles Gross, Reversed, Net, Variance in one row; money with two decimals', () => {
    const { container } = mount();
    expect(statLabels(container)).toEqual(['Gross', 'Reversed', 'Net', 'Variance']);
    expect(oneTileRow(container)).toBe(true);
    if (full) {
      expect(norm(statOf(container, 'Gross')!.textContent)).toMatch(/2,000\.00/);
      expect(norm(statOf(container, 'Reversed')!.textContent)).toMatch(/200\.00/);
      expect(norm(statOf(container, 'Net')!.textContent)).toMatch(/1,800\.00/);
      expect(norm(statOf(container, 'Variance')!.textContent)).toMatch(/5\.00/);
    } else {
      expect(norm(statOf(container, 'Variance')!.textContent)).toMatch(/No variance|0\.00/);
    }
  });

  it('ChartCard "net by payment method" (bar) always draws; one bar per method with the summed net; empty says "No data yet"', () => {
    const { container } = mount();
    const card = cards(container).find((c) => /method/i.test(c.querySelector('.lims-chart-card-title')?.textContent ?? ''));
    expect(card, 'ChartCard with "method" in its title').toBeTruthy();
    expect(card!.querySelector('svg')).toBeTruthy();
    expect(card!.querySelector('.lims-chart-empty') !== null).toBe(!full);
    if (full) {
      const rows = chartRows(card!);
      expect(num(rows.get('Cash'))).toBe(1500);
      expect(num(rows.get('Qr'))).toBe(300);
    }
  });

  it('both tables keep their header row in the kit scroll box (also empty); sessions table comes after the chart; money columns are right aligned', () => {
    const { container } = mount();
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Staff', 'Method', 'Gross', 'Reversed', 'Net', 'Opened', 'Closed', 'Expected cash', 'Counted cash', 'Variance']));
    expect(container.querySelectorAll('.lims-table-scroll').length).toBeGreaterThanOrEqual(2);
    const card = cards(container).find((c) => /method/i.test(c.querySelector('.lims-chart-card-title')?.textContent ?? ''))!;
    const sessions = [...container.querySelectorAll('[aria-label="Cash sessions"], table')].find((t) => /Expected cash/.test(t.textContent ?? '') && !card.contains(t))!;
    expect(card.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING, 'sessions table below the chart').toBeTruthy();
    for (const col of ['Gross', 'Reversed', 'Net', 'Expected cash', 'Counted cash']) {
      const th = [...container.querySelectorAll('[role="columnheader"], th')].find((h) => norm(h.textContent) === col)!;
      expect(th.className, `${col} header right aligned`).toMatch(/lims-align-end/);
    }
    if (!full) expect(container.textContent).toContain('No collections for this date.');
  });
});

// ---------------------------------------------------------------- dues
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const due = (n: number, paisa: number, daysAgo?: number, centre = 'c1') => ({
  order_id: `01a1a98a-ac40-7000-8000-00000000f${String(n).padStart(3, '0')}`, registration_no: `REG-${n}`, patient_display: `Synthetic Patient ${n}`, centre_id: centre,
  invoiced: m(paisa), paid: m(0), credited: m(0), balance_due: m(paisa), ...(daysAgo === undefined ? {} : { oldest_invoice_at: iso(daysAgo) }),
});
const centres = [{ id: 'c1', name: 'Synthetic Centre A1' }, { id: 'c2', name: 'Synthetic Centre B2' }];
const mountDues = (dues: unknown[]) => wrap(<DuesList dues={dues as never} centres={centres} />);

describe.each([['no rows', []], ['rows', [due(1, 150000, 10), due(2, 250000, 120)]]])('billing dues — %s', (name, rows) => {
  const full = name === 'rows';

  it('h1 is the menu label; exactly one FilterBar with centre and party; table header always present in the kit scroll box', () => {
    const { container } = mountDues(rows);
    expect(h1s(container)).toEqual([menuLabel('/billing/dues')]);
    expect(filterBars(container)).toHaveLength(1);
    expect(filterBars(container)[0]!.textContent).toMatch(/Centre/);
    expect(filterBars(container)[0]!.textContent).toMatch(/Party/);
    expect(headerCells(container)).toEqual(expect.arrayContaining(['Registration no', 'Patient', 'Centre', 'Due']));
    expect(container.querySelector('.lims-table-scroll table, .lims-table-scroll [role="grid"]')).toBeTruthy();
    if (!full) expect(container.textContent).toContain('No outstanding dues.');
  });

  it('StatTiles Total due and Oldest in one row', () => {
    const { container } = mountDues(rows);
    expect(statLabels(container)).toEqual(['Total due', 'Oldest']);
    expect(oneTileRow(container)).toBe(true);
    if (full) {
      expect(norm(statOf(container, 'Total due')!.textContent)).toMatch(/4,000\.00/);
      expect(norm(statOf(container, 'Oldest')!.textContent)).toMatch(/\b120\b/);
    }
  });

  it('ChartCard "aging" with the buckets 0-30, 31-60, 61-90, 90+ days always draws; empty says "No data yet"', () => {
    const { container } = mountDues(rows);
    const card = cards(container).find((c) => /aging|ageing/i.test(c.querySelector('.lims-chart-card-title')?.textContent ?? ''));
    expect(card, 'ChartCard with "aging" in its title').toBeTruthy();
    expect(card!.querySelector('svg')).toBeTruthy();
    expect(card!.querySelector('.lims-chart-empty') !== null).toBe(!full);
    const keys = [...chartRows(card!).keys()];
    expect(keys).toHaveLength(4);
    expect(keys[0]).toMatch(/^0\s*[-–]\s*30/);
    expect(keys[1]).toMatch(/^31\s*[-–]\s*60/);
    expect(keys[2]).toMatch(/^61\s*[-–]\s*90/);
    expect(keys[3]).toMatch(/^90\s*\+/);
  });
});

describe('billing dues — aging is computed from the rows', () => {
  it('a row of 10 days lands in 0-30 and a row of 120 days in 90+ (the 31-60 and 61-90 buckets stay zero)', () => {
    const { container } = mountDues([due(1, 150000, 10), due(2, 250000, 120)]);
    const card = cards(container).find((c) => /aging|ageing/i.test(c.querySelector('.lims-chart-card-title')?.textContent ?? ''))!;
    const v = [...chartRows(card).values()].map(num);
    expect(v[0]).toBeGreaterThan(0);
    expect(v[1]).toBe(0);
    expect(v[2]).toBe(0);
    expect(v[3]).toBeGreaterThan(0);
  });

  it('boundaries: 30 days is in 0-30, 31 in 31-60, 60 in 31-60, 61 in 61-90, 90 in 61-90, 91 in 90+', () => {
    const days = [30, 31, 60, 61, 90, 91];
    const { container } = mountDues(days.map((d, i) => due(i + 1, 100000, d)));
    const card = cards(container).find((c) => /aging|ageing/i.test(c.querySelector('.lims-chart-card-title')?.textContent ?? ''))!;
    const v = [...chartRows(card).values()].map(num);
    // each bucket holds two rows; the value is a count (2) or an amount (2,000.00), never zero and always equal across buckets
    expect(v[0]).toBeGreaterThan(0);
    expect(new Set(v).size, `buckets ${JSON.stringify(v)} must be equal`).toBe(1);
  });

  it('rows without a due date: the aging card shows NotAvailable and a note (no invented ages)', () => {
    const { container } = mountDues([due(1, 150000), due(2, 250000)]);
    const card = cards(container).find((c) => /aging|ageing/i.test(c.querySelector('.lims-chart-card-title')?.textContent ?? ''));
    expect(card, 'the aging ChartCard stays').toBeTruthy();
    expect(hasNotAvailable(card!)).toBe(true);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('a hostile patient label stays text', () => {
    const { container } = mountDues([{ ...due(1, 100000, 5), patient_display: '<img src=x onerror=alert(1)>' }]);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
