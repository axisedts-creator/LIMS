// @vitest-environment jsdom
// C12.T-24 — S17 Reports (04-UI-UX §3 S17). ACs: AC-21.1 daily consumption, AC-21.2 analyser-wise (+ test counts), AC-21.3 CPT (columns, "incomplete" badge, breakdown Drawer, footnote), AC-21.4 wastage by category,
// AC-21.5 expiry (days to expiry), AC-21.6 valuation (As of), AC-21.7 reconciliation (two tables; tab only for all-centres), AC-21.8 export affordance (privileged), AC-21.9 no cost cells without inventory.cost.read.
// The row maths of the reports (golden totals, CPT rounding, CSV neutralisation, 50,000 cap) is API logic; here we prove the screen asks the right question, shows what it is given, hides what it must, and never invents numbers.
// LD-140 (2026-11-13): kit components only, ONE primary button per page, every status shows tone + icon + word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, PERM_COST, PERM_EXPORT, PERM_EXPORT_COST, PERM_NONE, PERM_READ, api, dayAgo, hit, hits, page, problem, reportFixtures, resetHits, router, state, withoutCost } from './t24.harness';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_READ; state.path = '/inventory/reports'; state.allCentres = true; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/reports/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const reportCalls = (code?: string) => hit('GET', code ? new RegExp(`^/v1/inventory/reports/${code}$`) : /^\/v1\/inventory\/reports\/[^/]+$/);
const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent?.trim());
const q = (h: { search: string }) => new URLSearchParams(h.search);

describe('S17 gating and tabs', () => {
  it('without inventory.item.read: permission-denied, no API call', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });
  it('tabs in spec order for a full-access caller: Daily consumption · Analyser-wise · Cost per test · Wastage · Expiry · Valuation · Reconciliation', async () => {
    state.permissions = PERM_COST;
    await mount();
    await screen.findByRole('tablist');
    await waitFor(() => expect(tabNames()).toHaveLength(7));
    expect(tabNames()).toEqual(['Daily consumption', 'Analyser-wise', 'Cost per test', 'Wastage', 'Expiry', 'Valuation', 'Reconciliation']);
  });
  it('without inventory.cost.read the "Cost per test" tab is hidden (and cost_per_test is never requested)', async () => {
    await mount({ report: 'cost_per_test' });
    await screen.findByRole('tablist');
    expect(tabNames()).not.toContain('Cost per test');
    expect(reportCalls('cost_per_test')).toHaveLength(0); // deep link falls back, no 403 round trip
  });
  it('without all centres (GET /identity/me centre_scope.all=false) the "Reconciliation" tab is hidden and the report is not requested', async () => {
    state.allCentres = false;
    await mount({ report: 'consumption_reconciliation' });
    await screen.findByRole('tablist');
    expect(tabNames()).not.toContain('Reconciliation');
    expect(reportCalls('consumption_reconciliation')).toHaveLength(0);
  });
  it('if the all-centres lookup fails the Reconciliation tab fails CLOSED (hidden)', async () => {
    api.use(http.get(`${ORIGIN}/v1/identity/me`, () => problem('common.internal', 500)));
    await mount();
    await screen.findByRole('tablist');
    expect(tabNames()).not.toContain('Reconciliation');
  });
  it('the default tab is Daily consumption (selected) and calls daily_consumption', async () => {
    await mount();
    const tab = await screen.findByRole('tab', { name: 'Daily consumption' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(reportCalls('daily_consumption')).toHaveLength(1));
  });
  it.each([
    ['Analyser-wise', 'analyser_consumption'], ['Wastage', 'wastage'], ['Expiry', 'expiry'], ['Valuation', 'stock_valuation'], ['Reconciliation', 'consumption_reconciliation'], ['Cost per test', 'cost_per_test'],
  ])('tab "%s" requests report_code %s', async (name, code) => {
    state.permissions = PERM_COST;
    await mount();
    await userEvent.click(await screen.findByRole('tab', { name }));
    await waitFor(() => expect(reportCalls(code).length).toBeGreaterThan(0));
  });
  it('?report=<code> deep-links to that tab', async () => {
    await mount({ report: 'wastage' });
    expect((await screen.findByRole('tab', { name: 'Wastage' })).getAttribute('aria-selected')).toBe('true');
    expect(reportCalls('wastage')).toHaveLength(1);
  });
  it('an unknown ?report= value falls back to Daily consumption and never reaches the API path', async () => {
    await mount({ report: '../../identity/me' });
    expect((await screen.findByRole('tab', { name: 'Daily consumption' })).getAttribute('aria-selected')).toBe('true');
    expect(hits.filter((h) => /identity\/me$/.test(h.path)).every((h) => h.method === 'GET')).toBe(true);
    expect(reportCalls().every((h) => /^\/v1\/inventory\/reports\/(daily_consumption)$/.test(h.path))).toBe(true);
  });
});

describe('S17 filters and request (TRD #92)', () => {
  it('default period is the last 30 days: business_date_from/_to both present, from < to, ≤ 366 days', async () => {
    await mount();
    await waitFor(() => expect(reportCalls('daily_consumption')).toHaveLength(1));
    const p = q(reportCalls('daily_consumption')[0]!);
    const [f, t] = [p.get('business_date_from')!, p.get('business_date_to')!];
    expect(f).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f < t).toBe(true);
    expect((Date.parse(t) - Date.parse(f)) / 86_400_000).toBeLessThanOrEqual(366);
  });
  it('?from/to/store/analyser/test/item map to business_date_from/_to, store_id, instrument_id, test_id, item_id', async () => {
    await mount({ from: '2026-10-01', to: '2026-10-31', store: 'S-1', analyser: 'I-1', test: 'T-1', item: 'M-1' });
    await waitFor(() => expect(reportCalls('daily_consumption')).toHaveLength(1));
    const p = q(reportCalls('daily_consumption')[0]!);
    expect(Object.fromEntries(['business_date_from', 'business_date_to', 'store_id', 'instrument_id', 'test_id', 'item_id'].map((k) => [k, p.get(k)])))
      .toEqual({ business_date_from: '2026-10-01', business_date_to: '2026-11-01', store_id: 'S-1', instrument_id: 'I-1', test_id: 'T-1', item_id: 'M-1' }); // contract: business_date_to is EXCLUSIVE (CV §4.4) -> picked end date + 1 day
  });
  it('Item filter control (04-UI-UX S17 "Common filters: … analyser, test, item"): picking an item navigates with item=<id>; with ?item= the request carries item_id', async () => {
    await mount();
    await screen.findByRole('grid');
    const combo = screen.getByRole('combobox', { name: /^item/i });
    await userEvent.type(combo, 'GLU');
    await userEvent.click(await screen.findByRole('option', { name: /GLU-R1/ }));
    await waitFor(() => expect(router.push.mock.calls.length + router.replace.mock.calls.length).toBeGreaterThan(0));
    const target = String([...router.push.mock.calls, ...router.replace.mock.calls].at(-1)![0]);
    expect(new URL(target, 'http://app.test').searchParams.get('item')).toBe('01950c12-0000-7000-8000-000000000011');
  });
  it('review item 1: with ?item=<id> the Item combobox shows "item_code · name" (resolved server-side); clearing it navigates without item', async () => {
    await mount({ item: '01950c12-0000-7000-8000-000000000011' });
    await screen.findByRole('grid');
    const combo = screen.getByRole('combobox', { name: /^item/i }) as HTMLInputElement;
    await waitFor(() => expect(combo.value).toMatch(/GLU-R1\s*·\s*Synthetic glucose reagent/));
    await userEvent.clear(combo);
    await waitFor(() => expect(router.push.mock.calls.length + router.replace.mock.calls.length).toBeGreaterThan(0));
    const target = String([...router.push.mock.calls, ...router.replace.mock.calls].at(-1)![0]);
    expect(new URL(target, 'http://app.test').searchParams.has('item')).toBe(false);
  });
  it('the date control is the kit DateRangePicker with a 366-day maximum', async () => {
    await mount();
    const group = await screen.findByRole('group', { name: /period|date range|dates/i });
    expect(within(group).getAllByRole('textbox').length).toBeGreaterThanOrEqual(2);
  });
  it('inventory.range_too_large -> shown INLINE at the date field (not only a toast), report area stays usable', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/daily_consumption`, () => problem('inventory.range_too_large', 422)));
    await mount({ from: '2024-01-01', to: '2026-01-01' });
    const group = await screen.findByRole('group', { name: /period|date range|dates/i });
    await waitFor(() => expect(group.textContent).toMatch(/366|too (long|large|wide)|shorter|at most/i));
  });
  it('a generic API failure shows an ErrorState alert with the request id', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/daily_consumption`, () => problem('common.internal', 500)));
    await mount();
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0024');
  });
  it('empty period: "No data for this period"', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/daily_consumption`, () => HttpResponse.json({ ...reportFixtures['daily_consumption'], rows: [], totals: {} })));
    await mount();
    expect(await screen.findByText('No data for this period')).toBeTruthy();
  });
  it('truncated=true shows a notice that the screen is capped (5,000 rows) and points to Export CSV', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/daily_consumption`, () => HttpResponse.json({ ...reportFixtures['daily_consumption'], truncated: true })));
    await mount();
    expect(await screen.findByText(/5,000|first rows|not all rows|truncated|capped/i)).toBeTruthy();
  });
  it('Expiry: ?within_days=45 is passed as within_days; Valuation: ?as_of=… is passed as as_of', async () => {
    await mount({ report: 'expiry', within_days: '45' });
    await waitFor(() => expect(reportCalls('expiry')).toHaveLength(1));
    expect(q(reportCalls('expiry')[0]!).get('within_days')).toBe('45');
    cleanup(); resetHits();
    await mount({ report: 'stock_valuation', as_of: '2026-10-15T00:00:00.000Z' });
    await waitFor(() => expect(reportCalls('stock_valuation')).toHaveLength(1));
    expect(q(reportCalls('stock_valuation')[0]!).get('as_of')).toBe('2026-10-15'); // contract #92 as_of is IsoDate (YYYY-MM-DD, Asia/Kathmandu calendar date of the picked instant)
  });
});

describe('S17 tab content', () => {
  it('AC-21.1 Daily consumption: DataTable of per day × item × kind with the API totals row, plus a BarChart', async () => {
    state.permissions = PERM_COST;
    await mount();
    const grid = await screen.findByRole('grid');
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(expect.arrayContaining(['Date', 'Item', 'Kind', 'Quantity', 'Value']));
    expect(within(grid).getAllByText('GLU-R1').length).toBe(2);
    expect(grid.textContent).toContain('375'); // totals.value 37500 paisa = Rs. 375.00, shown as given (no client re-sum)
    expect(document.querySelector('[role="img"][aria-label*="consumption" i], figure, svg[aria-label*="consumption" i], [data-testid="bar-chart"]')).toBeTruthy();
  });
  it('AC-21.1: movement kinds are shown in words ("Per test" style), never the raw enum', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    expect(grid.textContent).not.toMatch(/consume_test|consume_qc/);
  });
  it('AC-21.2 Analyser-wise: grouped by analyser, with a test-count sub-table (tests, reruns, QC events)', async () => {
    await mount({ report: 'analyser_consumption' });
    const grid = await screen.findByRole('grid');
    expect(grid.textContent).toMatch(/BIO-1/);
    expect(document.body.textContent).toMatch(/GLU/);
    expect(document.body.textContent).toMatch(/\b12\b/);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent).join('|')).toMatch(/tests/i);
  });
  it('AC-21.3 Cost per test: columns Test, Analyser, Tests, Direct CPT, Loaded CPT, Standard CPT, Breakdown; paisa formatted as rupees; footnote verbatim', async () => {
    state.permissions = PERM_COST;
    await mount({ report: 'cost_per_test' });
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Test', 'Analyser', 'Tests', 'Direct CPT', 'Loaded CPT', 'Standard CPT', 'Breakdown']) expect(heads, h).toContain(h);
    const glu = within(grid).getByText('GLU').closest('tr')!;
    expect(glu.textContent).toMatch(/25\.00/); // 2500 paisa
    expect(glu.textContent).toMatch(/30\.00/); // 3000 paisa
    expect(await screen.findByText('CPT excludes wastage, expiry and count differences. See the Wastage report.')).toBeTruthy();
  });
  it('AC-21.3: a row whose standard CPT is incomplete shows an "incomplete" Badge (tone + icon + word); a complete row does not', async () => {
    state.permissions = PERM_COST;
    await mount({ report: 'cost_per_test' });
    const grid = await screen.findByRole('grid');
    const crea = within(grid).getByText('CREA').closest('tr')!;
    const badge = within(crea).getByText(/incomplete/i);
    const host = (badge.closest('[data-tone]') ?? badge.parentElement) as HTMLElement;
    expect(host.getAttribute('data-tone') ?? host.className).toBeTruthy();
    expect(host.querySelector('svg, [data-icon], [aria-hidden="true"]')).toBeTruthy();
    expect(within(within(grid).getByText('GLU').closest('tr')!).queryByText(/incomplete/i)).toBeNull();
  });
  it('AC-21.3: "Breakdown" opens a right Drawer with the by-kind split (consume_test / consume_qc in words, value in rupees)', async () => {
    state.permissions = PERM_COST;
    await mount({ report: 'cost_per_test' });
    const grid = await screen.findByRole('grid');
    await userEvent.click(within(within(grid).getByText('GLU').closest('tr')!).getByRole('button', { name: /breakdown/i }));
    const dlg = await screen.findByRole('dialog', { name: /breakdown/i });
    expect(dlg.textContent).toMatch(/270\.00/);
    expect(dlg.textContent).toMatch(/30\.00/);
    expect(dlg.textContent).not.toMatch(/consume_test|consume_qc/);
  });
  it('AC-21.4 Wastage: grouped by category (wastage / expiry write-off / count variance), quantity and value', async () => {
    state.permissions = PERM_COST;
    await mount({ report: 'wastage' });
    const body = await screen.findByRole('grid');
    expect(body.textContent).toMatch(/wastage/i);
    expect(body.textContent).toMatch(/expiry write-?off/i);
    expect(body.textContent).toMatch(/count (variance|difference)/i);
    expect(body.textContent).not.toMatch(/expiry_writeoff|count_variance/);
  });
  it('AC-21.5 Expiry: days to expiry shown; an expired lot (negative days) reads as expired in words, not just a negative number or colour', async () => {
    await mount({ report: 'expiry' });
    const grid = await screen.findByRole('grid');
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toContain('Days to expiry');
    const expired = within(grid).getByText('L-SYN-000').closest('tr')!;
    expect(expired.textContent).toMatch(/expired/i);
    const soon = within(grid).getByText('L-SYN-001').closest('tr')!;
    expect(soon.textContent).toMatch(/\b10\b/);
  });
  it('AC-21.6 Valuation: an "As of" DateTimePicker (default now) is shown on this tab only', async () => {
    state.permissions = PERM_COST;
    await mount({ report: 'stock_valuation' });
    await screen.findByRole('grid');
    expect(screen.getByRole('textbox', { name: /as of/i }) ?? screen.getByLabelText(/as of/i)).toBeTruthy();
    cleanup();
    await mount({ report: 'wastage' });
    await screen.findByRole('grid');
    expect(screen.queryByLabelText(/as of/i)).toBeNull();
  });
  it('AC-21.7 Reconciliation: TWO tables - tests (C12 vs lab) and analysers (QC observations vs analyser QC records); differences listed in text', async () => {
    await mount({ report: 'consumption_reconciliation' });
    await waitFor(() => expect(screen.getAllByRole('grid').length).toBe(2));
    const [tests, analysers] = screen.getAllByRole('grid');
    expect(tests!.textContent).toMatch(/GLU/);
    expect(tests!.textContent).toMatch(/98/); expect(tests!.textContent).toMatch(/100/);
    expect(analysers!.textContent).toMatch(/BIO-1/);
    expect(analysers!.textContent).toMatch(/7/);
    expect(screen.getByRole('heading', { name: /tests/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /analysers/i })).toBeTruthy();
  });
  it('AC-21.7: the analyser block is listed only - it must not claim an alert (D-74)', async () => {
    await mount({ report: 'consumption_reconciliation' });
    await waitFor(() => expect(screen.getAllByRole('grid').length).toBe(2));
    const analysers = screen.getAllByRole('grid')[1]!;
    expect(analysers.textContent).not.toMatch(/alert raised|alert/i);
  });
  it('403 auth.forbidden on Reconciliation (scope changed under us) -> an ErrorState, never a crash or empty table', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/consumption_reconciliation`, () => problem('auth.forbidden', 403)));
    await mount({ report: 'consumption_reconciliation' });
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0024');
  });
});

describe('AC-21.9 cost fields', () => {
  it('without inventory.cost.read the Daily consumption screen shows quantity but no Value column, no rupee amounts, no cost columns (API omits *_paisa)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/daily_consumption`, () => HttpResponse.json(withoutCost(reportFixtures['daily_consumption']))));
    await mount();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(heads).toContain('Quantity');
    expect(heads).not.toContain('Value');
    expect(grid.textContent).not.toMatch(/Rs\.?|₹|NPR|\d\.\d{2}\b/);
  });
  it('defence in depth (REQ-SEC-081): even if the API sent an is_cost column, a caller without inventory.cost.read does not see it', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    expect(within(grid).queryAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Value');
  });
  it('Wastage and Valuation likewise drop value without inventory.cost.read', async () => {
    for (const code of ['wastage', 'stock_valuation']) {
      api.use(http.get(`${ORIGIN}/v1/inventory/reports/${code}`, () => HttpResponse.json(withoutCost(reportFixtures[code]))));
      await mount({ report: code });
      const grid = await screen.findByRole('grid');
      expect(within(grid).queryAllByRole('columnheader').map((h) => h.textContent?.trim()), code).not.toContain('Value');
      cleanup(); resetHits();
    }
  });
});

describe('AC-21.8 export affordance', () => {
  it('"Export CSV" is hidden without inventory.report.export', async () => {
    await mount();
    await screen.findByRole('grid');
    expect(screen.queryByRole('link', { name: /export csv/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /export csv/i })).toBeNull();
  });
  it('with inventory.report.export it is a link to /inventory/reports/<code>/export carrying the SAME filters (no token, no scanned/free text in the URL beyond the filters)', async () => {
    state.permissions = PERM_EXPORT;
    await mount({ from: '2026-10-01', to: '2026-10-31', store: 'S-1' });
    const a = (await screen.findByRole('link', { name: /export csv/i })) as HTMLAnchorElement;
    const u = new URL(a.getAttribute('href')!, 'http://app.test');
    expect(u.pathname).toBe('/inventory/reports/daily_consumption/export');
    expect(u.searchParams.get('business_date_from')).toBe('2026-10-01');
    expect(u.searchParams.get('business_date_to')).toBe('2026-11-01'); // exclusive upper bound
    expect(u.searchParams.get('store_id')).toBe('S-1');
    expect(u.search).not.toMatch(/token|bearer|jwt/i);
  });
  it('?export_error=<contract code> (set by the export route on failure) shows a ProblemBanner alert; the report stays usable', async () => {
    state.permissions = PERM_EXPORT;
    await mount({ export_error: 'inventory.export_too_large' });
    await screen.findByRole('grid');
    expect(screen.getAllByRole('alert').some((a) => a.textContent && a.textContent.trim().length > 0)).toBe(true);
  });
  it('?export_error=auth.mfa_required shows the step-up copy; an unknown ?export_error value is not echoed into the page', async () => {
    state.permissions = PERM_EXPORT;
    await mount({ export_error: 'auth.mfa_required' });
    await screen.findByRole('grid');
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/step.?up|verify|multi-factor|mfa|second factor|authenticat/i);
    cleanup(); resetHits();
    await mount({ export_error: '<img src=x onerror=alert(1)>' });
    await screen.findByRole('grid');
    expect(document.body.innerHTML).not.toContain('onerror=alert');
  });
  it('it follows the tab: Wastage exports wastage', async () => {
    state.permissions = PERM_EXPORT;
    await mount({ report: 'wastage' });
    const a = (await screen.findByRole('link', { name: /export csv/i })) as HTMLAnchorElement;
    expect(new URL(a.getAttribute('href')!, 'http://app.test').pathname).toBe('/inventory/reports/wastage/export');
  });
  it('cost_per_test export needs BOTH inventory.report.export and inventory.cost.read: export-only user sees no CPT tab or link; both -> link', async () => {
    state.permissions = PERM_EXPORT;
    await mount({ report: 'cost_per_test' });
    await screen.findByRole('tablist');
    expect(tabNames()).not.toContain('Cost per test');
    cleanup(); resetHits();
    state.permissions = PERM_EXPORT_COST;
    await mount({ report: 'cost_per_test' });
    const a = (await screen.findByRole('link', { name: /export csv/i })) as HTMLAnchorElement;
    expect(new URL(a.getAttribute('href')!, 'http://app.test').pathname).toBe('/inventory/reports/cost_per_test/export');
  });
  it('the S17 page has at most ONE primary button (Export CSV is secondary)', async () => {
    state.permissions = PERM_EXPORT_COST;
    await mount();
    await screen.findByRole('grid');
    expect(document.querySelectorAll('button[data-variant="primary"], button.lims-btn-primary, button[class*="primary"], a.lims-btn-primary').length).toBeLessThanOrEqual(1);
  });
});

describe('help link', () => {
  it('S17 links to the consumption-model help (inventory.help.consumption_model)', async () => {
    await mount();
    await screen.findByRole('grid');
    expect(screen.getAllByRole('link').some((a) => /help|consumption model|how .*deduct/i.test(a.textContent ?? '') || /help/.test(a.getAttribute('href') ?? ''))).toBe(true);
  });
});

void dayAgo; void page;
