// @vitest-environment jsdom
// T0D-FIX-11 (LD-455; founder order 2026-11-22 22:06 NPT), /billing/dues and /billing/daily-cash:
//   (1) dues: one money format. No "Rs." anywhere on the screen (the aging chart's data table included); every money value is "NPR 1,234.00" (thousands separators, two decimals).
//   (2) every <table> on the screen is the kit table (class lims-table): no raw table with centred headers (the chart data tables were the raw ones).
//   (4) a failed api call (mocked 400 and 500) shows the kit inline error with the reference inside the page (title kept), never an empty section.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ApiError } from '@/core/api/server-fetch';
import { t } from '@/core/i18n/messages';
import { barValue, cardByTitle, norm, titles } from '@/__tests__/uidash1.helpers';

const h = vi.hoisted(() => ({ perms: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/billing/dues',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: h.perms, displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/dues',
}));
vi.mock('@/features/billing/server/read.server', () => ({ listDues: vi.fn(), getDailyCash: vi.fn(), getMyCashSession: vi.fn() }));
vi.mock('@/features/billing/server/accounts.server', () => ({ listCentres: vi.fn(), listAccountParties: vi.fn(), listAccountParticulars: vi.fn() }));
vi.mock('@/features/billing/server/expenses.server', () => ({ getDailyCollectionSummary: vi.fn() }));

const REF = '01933b6f-0a11-7e2b-8c55-1d2e3f405166';
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CENTRE = U(3), ME = U(90);
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const fail = (status: number, code: string) => new ApiError(status, { type: `urn:lims:error:${code}`, title: 'Synthetic failure', status, code, request_id: REF } as never);
const due = (n: number, o: Record<string, unknown> = {}) => ({ order_id: U(500 + n), registration_no: `REG-9${String(n).padStart(5, '0')}`, patient_display: `S*** B${n}`, centre_id: CENTRE,
  invoiced: npr(3891000), paid: npr(0), credited: npr(0), balance_due: npr(3891000), oldest_invoice_at: '2026-10-01T04:00:00.000Z', ...o });
const cash = () => ({
  business_date: '2026-11-07', business_date_bs: '2083-07-21',
  rows: [{ collected_by: { membership_id: ME, display_name: 'Synthetic Cashier' }, method_code: 'cash', entries: 4, reversals: 0, gross: npr(123456700), reversed: npr(0), net: npr(123456700) }],
  totals: { gross: npr(123456700), reversed: npr(0), net: npr(123456700) },
  sessions: [{ id: U(20), opened_by: { membership_id: ME, display_name: 'Synthetic Cashier' }, centre_id: CENTRE, status: 'closed', opened_at: '2026-11-07T03:00:00.000Z', closed_at: '2026-11-07T11:00:00.000Z', rows: [{ method_code: 'cash', expected: npr(400000), counted: npr(395000), variance: npr(-5000) }], version: 2 }],
});
const rawTables = (root: ParentNode) => [...root.querySelectorAll('table')].filter((x) => !x.classList.contains('lims-table')).map((x) => x.querySelector('caption')?.textContent ?? '(no caption)');

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-18T04:00:00.000Z'), toFake: ['Date'] }); h.perms = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

async function duesScreen(rows: unknown[]) {
  const { DuesList } = await import('../components/DuesList');
  return render(<ToastProvider><DuesList dues={rows as never} centres={[{ id: CENTRE, name: 'Synthetic Centre A1' }]} /></ToastProvider>);
}
async function duesPage() {
  const read = await import('@/features/billing/server/read.server');
  const acc = await import('@/features/billing/server/accounts.server');
  vi.mocked(acc.listCentres).mockResolvedValue([{ centre_id: CENTRE, name: 'Synthetic Centre A1' }] as never);
  const { default: DuesPage } = await import('../../../app/(staff)/billing/dues/page');
  return { listDues: vi.mocked(read.listDues), render: async () => render(await DuesPage()) };
}
async function cashPage(sp: Record<string, string> = {}) {
  const read = await import('@/features/billing/server/read.server');
  const acc = await import('@/features/billing/server/accounts.server');
  const exp = await import('@/features/billing/server/expenses.server');
  vi.mocked(read.getMyCashSession).mockResolvedValue(null as never);
  vi.mocked(acc.listAccountParties).mockResolvedValue({ centres: [{ id: CENTRE, name: 'Synthetic Centre A1' }] } as never);
  vi.mocked(acc.listAccountParticulars).mockResolvedValue([] as never);
  const { default: DailyCashPage } = await import('../../../app/(staff)/billing/daily-cash/page');
  return { getDailyCash: vi.mocked(read.getDailyCash), summary: vi.mocked(exp.getDailyCollectionSummary), render: async () => render(<ToastProvider>{await DailyCashPage({ searchParams: Promise.resolve(sp) })}</ToastProvider>) };
}
const oneInlineError = (container: HTMLElement) => {
  const err = [...container.querySelectorAll('.lims-state.lims-tone-danger')];
  expect(err, 'one kit inline error state').toHaveLength(1);
  expect(norm(err[0]!.querySelector('.lims-state-ref')?.textContent), 'the reference of the failed call').toContain(REF);
};

describe('/billing/dues: one money format (done_when 1)', () => {
  it('no "Rs." anywhere on the screen, hidden chart data table and axis ticks included', async () => {
    const { container } = await duesScreen([due(1), due(2, { balance_due: npr(2000000), oldest_invoice_at: '2026-11-10T04:00:00.000Z' })]);
    expect(norm(container.textContent)).not.toMatch(/\bRs\b\.?/);
  });

  it('the aging chart values read NPR with thousands separators and two decimals (Rs. 38,910.00 was the sweep finding)', async () => {
    const { container } = await duesScreen([due(1)]);
    const card = cardByTitle(container, 'Dues by age')!;
    expect(barValue(card, /^31-60/)).toBe('NPR 38,910.00'); // 48 days
    for (const cat of [/^0-30/, /^61-90/, /^90\+/]) expect(barValue(card, cat), String(cat)).toMatch(/^NPR 0\.00$/);
  });

  it('every money value on the screen is NPR 1,234.00; a lakh amount keeps its separators', async () => {
    const { container } = await duesScreen([due(1, { balance_due: npr(123456700) })]);
    const money = norm(container.textContent).match(/(?:NPR|Rs\.?) ?-?[\d,]+\.\d{2}/g) ?? [];
    expect(money.length, 'money values on the screen').toBeGreaterThan(0);
    for (const m of money) expect(m, 'money format').toMatch(/^NPR [\d,]+\.\d{2}$/);
    expect(money).toContain('NPR 12,34,567.00');
  });
});

describe('done_when 2: no raw table on dues or daily cash', () => {
  it('dues: every table is the kit table', async () => {
    const { container } = await duesScreen([due(1)]);
    expect(container.querySelectorAll('table').length).toBeGreaterThan(0);
    expect(rawTables(container), 'tables that are not the kit DataTable').toEqual([]);
  });

  it('daily cash: every table is the kit table', async () => {
    const { DailyCashView } = await import('../components/DailyCashView');
    const { container } = render(<ToastProvider><DailyCashView report={cash() as never} session={null} permissions={['billing.cash_report.read']} /></ToastProvider>);
    expect(container.querySelectorAll('table').length).toBeGreaterThan(0);
    expect(rawTables(container), 'tables that are not the kit DataTable').toEqual([]);
  });
});

describe('done_when 4: a failed call shows the kit inline error with the reference', () => {
  it.each([[400, 'common.validation_failed'], [500, 'common.internal']])('dues: listDues fails with %i: title kept, ONE inline error, no empty table', async (status, code) => {
    const p = await duesPage();
    p.listDues.mockRejectedValue(fail(status, code));
    const { container } = await p.render();
    expect(titles(container)).toEqual([t('nav.billing.dues')]);
    oneInlineError(container);
    expect(norm(container.textContent), 'a failed read never reads as "no dues"').not.toContain('No outstanding dues.');
  });

  it.each([[400, 'common.validation_failed'], [500, 'common.internal']])('daily cash: getDailyCash fails with %i: title kept, ONE inline error, no empty table', async (status, code) => {
    const p = await cashPage();
    p.getDailyCash.mockRejectedValue(fail(status, code));
    const { container } = await p.render();
    expect(titles(container)).toEqual([t('nav.billing.daily_cash')]);
    oneInlineError(container);
    expect(norm(container.textContent), 'a failed read never reads as "no collections"').not.toContain('No collections for this date.');
  });

  it.each([[400, 'common.validation_failed'], [500, 'common.internal']])('daily cash: the collection summary fails with %i: the report stays, the summary section shows ONE inline error', async (status, code) => {
    h.perms = ['billing.cash_report.read', 'billing.account.read'];
    const p = await cashPage();
    p.getDailyCash.mockResolvedValue(cash() as never);
    p.summary.mockRejectedValue(fail(status, code));
    const { container } = await p.render();
    expect(titles(container)).toContain(t('nav.billing.daily_cash'));
    expect(norm(container.textContent), 'the cash report itself is still on screen').toContain('Collections by staff and method');
    oneInlineError(container);
  });

  it('x-permission first: without billing.account.read the collection summary is never read', async () => {
    h.perms = ['billing.cash_report.read'];
    const p = await cashPage();
    p.getDailyCash.mockResolvedValue(cash() as never);
    await p.render();
    expect(p.summary).not.toHaveBeenCalled();
  });
});
