// @vitest-environment jsdom
// T0D-UIDASH-1 (4) billing daily cash and (5) billing dues as template 5 REPORT (LD-353 rules 3, 5, 6, 8, 10). Each screen renders with fake data twice: no rows and rows.
// DAILY CASH contract: h1 = t('nav.billing.daily_cash'); exactly one `.lims-filter-bar` that holds the "Business date" picker; the business date (B.S.) is written ONCE, inside
//   the page header slot (the "Business date: ..." paragraph is gone); ONE `.lims-stat-row` of four tiles Gross, Reversed, Net, Variance (money with two decimals, from report.totals
//   and the sessions); ChartCard "Net by payment method" (BarChart; frame always draws, "No data yet" when no rows); the sessions table keeps its header when empty;
//   money columns are right aligned (`lims-align-end`) with two decimals.
// DUES contract: h1 = t('nav.billing.dues'); exactly one `.lims-filter-bar` with a Centre and a Party control; StatTiles "Total due" and "Oldest" (days of the oldest invoice);
//   ChartCard "Dues by age" with the four buckets 0-30, 31-60, 61-90, 90+ days computed from balance_due and oldest_invoice_at of the rows already on the screen
//   (a row without oldest_invoice_at: the card holds NotAvailable); table header always shown; money right aligned with two decimals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { barValue, cardByTitle, cardNotAvailable, dataTables, filterBars, frameDraws, frameSaysNoData, hasAlert, headerCells, norm, tileLabel, tileRows, tileValue, tiles, titles } from '@/__tests__/uidash1.helpers';

const push = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/billing/daily-cash',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/daily-cash',
}));

const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CENTRE = U(3), CENTRE_B = U(4), ORDER = U(5), ME = U(90), OTHER = U(91);
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const BS = '2083-07-21';
const cash = (o: Record<string, unknown> = {}) => ({
  business_date: '2026-11-07', business_date_bs: BS,
  rows: [
    { collected_by: { membership_id: ME, display_name: 'Synthetic Cashier' }, method_code: 'cash', entries: 4, reversals: 1, gross: npr(500000), reversed: npr(100000), net: npr(400000) },
    { collected_by: { membership_id: ME, display_name: 'Synthetic Cashier' }, method_code: 'esewa', entries: 2, reversals: 0, gross: npr(250000), reversed: npr(0), net: npr(250000) },
  ],
  totals: { gross: npr(750000), reversed: npr(100000), net: npr(650000) },
  sessions: [
    { id: U(20), opened_by: { membership_id: ME, display_name: 'Synthetic Cashier' }, centre_id: CENTRE, status: 'closed', opened_at: '2026-11-07T03:00:00.000Z', closed_at: '2026-11-07T11:00:00.000Z', rows: [{ method_code: 'cash', expected: npr(400000), counted: npr(395000), variance: npr(-5000) }], version: 2 },
    { id: U(21), opened_by: { membership_id: OTHER, display_name: 'Other Cashier' }, centre_id: CENTRE, status: 'closed', opened_at: '2026-11-07T03:00:00.000Z', closed_at: '2026-11-07T11:00:00.000Z', rows: [{ method_code: 'cash', expected: npr(100000), counted: npr(102500), variance: npr(2500) }], version: 2 },
  ],
  ...o,
});
const emptyCash = () => cash({ rows: [], totals: { gross: npr(0), reversed: npr(0), net: npr(0) }, sessions: [] });
const PERMS = ['billing.cash_report.read', 'billing.data.export'];
const daily = async (report: unknown, permissions: readonly string[] = PERMS) => {
  const { DailyCashView } = await import('../components/DailyCashView');
  return render(<ToastProvider><DailyCashView report={report as never} session={null} permissions={permissions} /></ToastProvider>);
};
const due = (n: number, o: Record<string, unknown> = {}) => ({ order_id: U(500 + n), registration_no: `REG-9${String(n).padStart(5, '0')}`, patient_display: `S*** B${n}`, centre_id: CENTRE,
  invoiced: npr(113000), paid: npr(50000), credited: npr(0), balance_due: npr(63000), oldest_invoice_at: '2026-10-01T04:00:00.000Z', ...o });
const dues = async (rows: unknown[], centres: readonly { id: string; name: string }[] = [{ id: CENTRE, name: 'Synthetic Centre A1' }, { id: CENTRE_B, name: 'Synthetic Centre B2' }]) => {
  const { DuesList } = await import('../components/DuesList');
  return render(<ToastProvider><DuesList dues={rows as never} centres={centres} /></ToastProvider>);
};
const tileOf = (c: ParentNode, label: string) => tiles(c).find((x) => tileLabel(x) === label)!;

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-18T04:00:00.000Z'), toFake: ['Date'] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); push.mockReset(); replace.mockReset(); });

describe('/billing/daily-cash (template 5 REPORT)', () => {
  it.each([['no rows', emptyCash], ['rows', cash]])('%s: h1 = menu label, ONE FilterBar with the Business date picker, no alert', async (_n, make) => {
    const { container } = await daily(make());
    expect(titles(container)).toEqual([t('nav.billing.daily_cash')]);
    expect(filterBars(container)).toHaveLength(1);
    expect(within(filterBars(container)[0] as HTMLElement).getByText('Business date')).toBeTruthy();
    expect(hasAlert(container)).toBe(false);
  });

  it.each([['no rows', emptyCash], ['rows', cash]])('%s: the B.S. business date is written once, in the page header, not in a paragraph', async (_n, make) => {
    const { container } = await daily(make());
    expect(norm(container.textContent).split(BS).length - 1, 'exactly once').toBe(1);
    expect(container.querySelector('.lims-page-header')!.textContent).toContain(BS);
    expect([...container.querySelectorAll('p')].some((p) => /^Business date:/.test(norm(p.textContent)))).toBe(false);
  });

  it('rows: ONE row of four tiles Gross, Reversed, Net, Variance with two decimals', async () => {
    const { container } = await daily(cash());
    expect(tileRows(container)).toHaveLength(1);
    expect(tiles(container).map(tileLabel)).toEqual(['Gross', 'Reversed', 'Net', 'Variance']);
    expect(tileValue(tileOf(container, 'Gross'))).toContain('7,500.00');
    expect(tileValue(tileOf(container, 'Reversed'))).toContain('1,000.00');
    expect(tileValue(tileOf(container, 'Net'))).toContain('6,500.00');
    expect(tileValue(tileOf(container, 'Variance'))).toMatch(/25\.00/); // -50.00 + 25.00 over the two sessions
  });

  it('no rows: the four tiles still draw and read 0.00', async () => {
    const { container } = await daily(emptyCash());
    expect(tiles(container).map(tileLabel)).toEqual(['Gross', 'Reversed', 'Net', 'Variance']);
    for (const label of ['Gross', 'Reversed', 'Net']) expect(tileValue(tileOf(container, label))).toMatch(/\b0\.00\b/);
  });

  it('ChartCard "Net by payment method": rows give a bar per method (cash 4,000.00, esewa 2,500.00); no rows give "No data yet" and still draw', async () => {
    const a = await daily(cash());
    const card = cardByTitle(a.container, 'Net by payment method')!;
    expect(card).toBeTruthy();
    expect(frameDraws(card)).toBe(true);
    expect(frameSaysNoData(card)).toBe(false);
    expect(barValue(card, /cash/i)).toMatch(/4,?000\.00/);
    expect(barValue(card, /esewa/i)).toMatch(/2,?500\.00/);
    a.unmount();
    const b = await daily(emptyCash());
    const empty = cardByTitle(b.container, 'Net by payment method')!;
    expect(frameDraws(empty)).toBe(true);
    expect(frameSaysNoData(empty)).toBe(true);
  });

  it.each([['no rows', emptyCash], ['rows', cash]])('%s: both tables keep their header row; money columns are right aligned', async (_n, make) => {
    const { container } = await daily(make());
    const heads = headerCells(container);
    for (const h of ['Staff', 'Method', 'Entries', 'Reversals', 'Gross', 'Reversed', 'Net', 'Opened', 'Closed', 'Expected cash', 'Counted cash', 'Variance']) expect(heads, h).toContain(h);
    expect(dataTables(container)).toHaveLength(2);
    for (const name of ['Gross', 'Reversed', 'Net', 'Expected cash', 'Counted cash']) {
      const th = [...container.querySelectorAll('[role="columnheader"], th')].find((h) => norm(h.textContent) === name && !h.closest('.lims-chart-card'))!;
      expect(th.className, `${name} header`).toMatch(/lims-align-end/);
    }
  });

  it('rows: money cells show two decimals', async () => {
    const { container } = await daily(cash());
    const money = [...container.querySelectorAll('.lims-cell.lims-align-end')].map((c) => norm(c.textContent)).filter((x) => /NPR/.test(x));
    expect(money.length).toBeGreaterThan(0);
    for (const m of money) expect(m, m).toMatch(/\.\d{2}$/);
  });

  it('Export stays tied to billing.data.export; the date picker still navigates by ?date=', async () => {
    const a = await daily(cash(), ['billing.cash_report.read']);
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
    a.unmount();
    await daily(cash(), PERMS);
    expect(screen.getByRole('button', { name: /export/i })).toBeTruthy();
    expect(within(document.querySelector('.lims-page-header') as HTMLElement).getByRole('button', { name: /export/i })).toBeTruthy();
  });
});

describe('/billing/dues (template 5 REPORT)', () => {
  it.each([['no rows', () => []], ['rows', () => [due(1), due(2, { balance_due: npr(20000), oldest_invoice_at: '2026-11-10T04:00:00.000Z' })]]])(
    '%s: h1 = menu label, ONE FilterBar with Centre and Party, the table header row, no alert', async (_n, rows) => {
      const { container } = await dues(rows());
      expect(titles(container)).toEqual([t('nav.billing.dues')]);
      expect(filterBars(container)).toHaveLength(1);
      const bar = within(filterBars(container)[0] as HTMLElement);
      expect(bar.getByText('Centre')).toBeTruthy();
      expect(bar.getByText('Party')).toBeTruthy();
      expect(headerCells(container)).toEqual(['Registration no', 'Patient', 'Centre', 'Invoiced', 'Paid', 'Credited', 'Due', 'Oldest invoice age']);
      expect(hasAlert(container)).toBe(false);
    });

  it('no rows: the empty state sits in the table body and both tiles draw (0.00 and a dash)', async () => {
    const { container } = await dues([]);
    expect(dataTables(container)[0]!.contains(screen.getByText(/no outstanding dues/i))).toBe(true);
    expect(tiles(container).map(tileLabel)).toEqual(['Total due', 'Oldest']);
    expect(tileValue(tileOf(container, 'Total due'))).toMatch(/\b0\.00\b/);
  });

  it('rows: Total due is the sum of balance_due; Oldest is the age in days of the oldest invoice', async () => {
    const { container } = await dues([due(1), due(2, { balance_due: npr(20000), oldest_invoice_at: '2026-11-10T04:00:00.000Z' })]);
    expect(tileRows(container)).toHaveLength(1);
    expect(tileValue(tileOf(container, 'Total due'))).toContain('830.00');
    expect(tileValue(tileOf(container, 'Oldest'))).toMatch(/48\s*days/); // 2026-10-01T04:00Z to 2026-11-18T04:00Z
  });

  it('rows: the aging bar "Dues by age" has the buckets 0-30, 31-60, 61-90, 90+ days with the money of the rows in them', async () => {
    const rows = [due(1), due(2, { balance_due: npr(20000), oldest_invoice_at: '2026-11-10T04:00:00.000Z' }), due(3, { balance_due: npr(10000), oldest_invoice_at: '2026-06-01T04:00:00.000Z' })];
    const { container } = await dues(rows);
    const card = cardByTitle(container, 'Dues by age')!;
    expect(card).toBeTruthy();
    expect(frameDraws(card)).toBe(true);
    expect(frameSaysNoData(card)).toBe(false);
    expect(barValue(card, /^0-30/)).toMatch(/200\.00/); // 8 days
    expect(barValue(card, /^31-60/)).toMatch(/630\.00/); // 48 days
    expect(barValue(card, /^61-90/)).toMatch(/(^|[^\d])0(\.00)?$|—/); // none
    expect(barValue(card, /^90\+/)).toMatch(/100\.00/); // 170 days
  });

  it('no rows: "Dues by age" still draws and says "No data yet"', async () => {
    const { container } = await dues([]);
    const card = cardByTitle(container, 'Dues by age')!;
    expect(frameDraws(card)).toBe(true);
    expect(frameSaysNoData(card)).toBe(true);
  });

  it('rows without oldest_invoice_at: the aging card shows NotAvailable (no invented ages), the table still lists the row', async () => {
    const { container } = await dues([due(1, { oldest_invoice_at: undefined })]);
    expect(cardNotAvailable(cardByTitle(container, 'Dues by age')!)).toBe(true);
    expect(screen.getByText('REG-900001')).toBeTruthy();
    expect(tileValue(tileOf(container, 'Total due'))).toContain('630.00');
  });

  it('rows: money columns are right aligned with two decimals; the registration no still opens the order billing tab', async () => {
    const { container } = await dues([due(1)]);
    for (const name of ['Invoiced', 'Paid', 'Credited', 'Due', 'Oldest invoice age']) {
      const th = [...container.querySelectorAll('[role="columnheader"], th')].find((h) => norm(h.textContent) === name && !h.closest('.lims-chart-card'))!;
      expect(th.className, name).toMatch(/lims-align-end/);
    }
    expect(screen.getByText('NPR 630.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'REG-900001' }).getAttribute('href')).toBe(`/frontdesk/orders/${U(501)}?tab=billing`);
  });

  it('centres are shown by name, never by id (07-SECURITY: ids are not rendered)', async () => {
    const { container } = await dues([due(1), due(2, { centre_id: CENTRE_B })]);
    const table = norm(dataTables(container)[0]!.textContent);
    expect(table).toContain('Synthetic Centre A1');
    expect(table).toContain('Synthetic Centre B2');
    expect(container.textContent).not.toContain(CENTRE);
    expect(container.textContent).not.toContain(CENTRE_B);
  });
});
