// @vitest-environment jsdom
// AN-T20 — S4 Referral business report, app/(staff)/analytics/referral-incentive/page.tsx (04-UI-UX §5; US-07.1–.5; 07-SECURITY B13/REQ-SEC-088).
// ASSUMED contract (same style as AN-T18/T19): default export async server component `Page({ searchParams: Promise<…> })`; checks the session permission
//   `analytics.referral_report.read` BEFORE any API call (notFound() otherwise); reads GET /v1/analytics/reports/referral-incentive with only whitelisted,
//   well-formed params (business_date_from/to, bs_month, fiscal_year_bs, centre_id/branch_id comma-joined uuids ≤ 20, group_by, rollup, referrer_id, cursor, limit=50);
//   returns a tree that renders in a plain client render. Table = kit DataTable (role=grid, name /referral/i), totals = LAST row with row header "Total".
//   API 403 auth.mfa_required / common.feature_disabled are RENDERED (banner / EmptyState); any other 403 and 5xx reject (analytics/error.tsx).
//   Filters: Group-by radios, Switch "Combine merged doctors" (default on = rollup canonical); a change = router.push/replace with the new query.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BRANCH, CENTRE_A, CENTRE_B, FRESH, PERIOD, REF_1, REF_2, TOKEN, api, axeClean, calls, callsTo, gridNamed, headersOf, json, lastNav, norm, pageText, problem, resetApi, routes, rowTexts, show, showOrThrown,
} from './an-t20.harness';

vi.mock('next/navigation', async () => (await import('./an-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t20.harness')).sessionMock);

const PAGE = 'referral-incentive/page';
const PATH = '/v1/analytics/reports/referral-incentive';
const READ = ['analytics.referral_report.read'];
const HOSTILE = '<img src=x onerror=alert(1)>';

const body = (over: Record<string, unknown> = {}) => ({
  report_code: 'referral_incentive', period: PERIOD, scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] }, freshness: FRESH, generated_at: '2026-01-15T04:30:00.000Z',
  rows: [
    { referrer_id: REF_1, label: 'Dr Synthetic Sharma', is_self: false, orders: 12, patient_visits: 10, tests_ordered: 30, net_billed_paisa: 123456780 },
    { referrer_id: REF_2, label: 'डा. सिन्थेटिक', is_self: false, orders: 4, patient_visits: 4, tests_ordered: 9, net_billed_paisa: 50000 },
    { label: 'SELF (no referrer)', is_self: true, orders: 7, patient_visits: 7, tests_ordered: 15 },
  ],
  totals: { orders: 23, patient_visits: 21, tests_ordered: 54, net_billed_paisa: 123461780 },
  billed_note_key: 'analytics.referrers.billed_note', page: { limit: 50 }, ...over,
});
const monthly = body({
  rows: [
    { referrer_id: REF_1, label: 'Dr Synthetic Sharma', is_self: false, period_key: '2026-01', period_label: 'Jan 2026', orders: 12, patient_visits: 10, tests_ordered: 30, net_billed_paisa: 123456780 },
    { referrer_id: REF_1, label: 'Dr Synthetic Sharma', is_self: false, period_key: '2025-12', period_label: 'Dec 2025', orders: 3, patient_visits: 3, tests_ordered: 5, net_billed_paisa: 100000 },
  ],
});

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(READ); routes[`GET ${PATH}`] = json(body()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const reads = () => callsTo('GET', PATH);

describe('access order (US-07.1; CV §10.1)', () => {
  it('without analytics.referral_report.read: notFound() and NO API call', async () => {
    resetApi(['analytics.dashboard.read', 'analytics.data.export']);
    expect(await showOrThrown(PAGE)).toMatch(/NEXT_NOT_FOUND/);
    expect(calls).toHaveLength(0);
  });

  it('API 403 common.feature_disabled (flag off): full-page EmptyState "This report is not enabled for your lab." and no figures, no error code', async () => {
    routes[`GET ${PATH}`] = () => problem('common.feature_disabled', 403);
    await show(PAGE);
    expect(screen.getByText('This report is not enabled for your lab.')).toBeTruthy();
    expect(screen.queryAllByRole('grid')).toHaveLength(0);
    expect(pageText()).not.toMatch(/feature_disabled|flag|referral_incentive_report/i);
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('API 403 auth.mfa_required: warning banner "Verify with your authenticator app to open this report." + "Verify now" button, no table', async () => {
    routes[`GET ${PATH}`] = () => problem('auth.mfa_required', 403);
    await show(PAGE);
    expect(screen.getByText('Verify with your authenticator app to open this report.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify now' })).toBeTruthy();
    expect(screen.queryAllByRole('grid')).toHaveLength(0);
  });

  it('any other 403 (auth.forbidden) and 5xx reject so error.tsx handles them; no figures leak', async () => {
    routes[`GET ${PATH}`] = () => problem('auth.forbidden', 403);
    expect(await showOrThrown(PAGE)).toBeTruthy();
    routes[`GET ${PATH}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE)).toBeTruthy();
  });
});

describe('content (US-07.2/.4/.5; §5)', () => {
  it('title "Referral business report", subtitle, and the "Viewing this report is recorded." footer', async () => {
    await show(PAGE);
    expect(screen.getByRole('heading', { level: 1, name: 'Referral business report' })).toBeTruthy();
    expect(pageText()).toContain('Orders and billing by referring doctor. For internal review only.');
    expect(pageText()).toContain('Viewing this report is recorded.');
  });

  it('columns Referrer · Orders · Patient visits · Tests ordered · Net billed (no Period column when grouped by referrer); rows, lakh money, Total row', async () => {
    await show(PAGE);
    const g = gridNamed(/referral/i);
    expect(headersOf(g)).toEqual(['Referrer', 'Orders', 'Patient visits', 'Tests ordered', 'Net billed']);
    const rows = rowTexts(g);
    expect(rows[0]).toContain('Dr Synthetic Sharma');
    expect(rows[0]).toMatch(/12,34,567/); // lakh grouping (MoneyText grouping='lakh')
    expect(rows[1]).toContain('डा. सिन्थेटिक'); // Devanagari renders as text
    const total = within(g).getAllByRole('row').at(-1)!;
    expect(within(total).getByRole('rowheader').textContent).toBe('Total');
    expect(norm(total.textContent)).toMatch(/23.*21.*54.*12,34,617/);
  });

  it('the SELF row shows its label and "—" for Net billed (not available), never 0', async () => {
    await show(PAGE);
    const self = rowTexts(gridNamed(/referral/i)).find((t) => t.includes('SELF (no referrer)'))!;
    expect(self).toBeTruthy();
    const cells = within(dataRowEl('SELF (no referrer)')).getAllByRole('gridcell');
    expect(norm(cells.at(-1)!.textContent)).toBe('—');
    expect(self).toMatch(/7.*7.*15/);
  });

  it('shows the "Net billed counts credit-party work on the day it was charged." note under the table', async () => {
    await show(PAGE);
    expect(pageText()).toContain('Net billed counts credit-party work on the day it was charged.');
  });

  it('grouped by month: a Period column with the API period labels appears', async () => {
    routes[`GET ${PATH}`] = json(monthly);
    await show(PAGE, { searchParams: { group_by: 'referrer_bs_month' } });
    const g = gridNamed(/referral/i);
    expect(headersOf(g)).toEqual(['Referrer', 'Period', 'Orders', 'Patient visits', 'Tests ordered', 'Net billed']);
    expect(rowTexts(g).join(' ')).toMatch(/Jan 2026.*Dec 2025/);
  });

  it('B13: no rate, percentage, payable amount, payout/pay action, and never the word "commission" (US-07.3/.4)', async () => {
    await show(PAGE);
    expect(pageText()).not.toMatch(/commission|payable|payout|\bpay\b|\brate\b|\bincentive\b|%/i);
    for (const b of screen.queryAllByRole('button')) expect(norm(b.textContent)).not.toMatch(/pay|commission|approve|settle/i);
  });

  it('empty rows: EmptyState "No data for this period and filter", no crash', async () => {
    routes[`GET ${PATH}`] = json(body({ rows: [], totals: { orders: 0, patient_visits: 0, tests_ordered: 0 } }));
    await show(PAGE);
    expect(pageText()).toContain('No data for this period and filter');
  });

  it('hostile referrer name is text, never markup (REQ-SEC-088)', async () => {
    const b = body(); b.rows[0]!.label = HOSTILE;
    routes[`GET ${PATH}`] = json(b);
    const { container } = await show(PAGE);
    expect(container.querySelector('img')).toBeNull();
    expect(pageText()).toContain(HOSTILE);
  });

  it('a11y: no axe violations on the table state and on the flag-off state', async () => {
    await show(PAGE);
    await axeClean();
    cleanup();
    routes[`GET ${PATH}`] = () => problem('common.feature_disabled', 403);
    await show(PAGE);
    await axeClean();
  });
});

function dataRowEl(text: string) {
  return within(gridNamed(/referral/i)).getAllByRole('row').find((r) => norm(r.textContent).includes(text))!;
}

describe('request (07-SECURITY: BFF whitelist, Bearer from the session, nothing in the DOM)', () => {
  it('sends the session Bearer token, limit=50, and never puts the token in the DOM', async () => {
    const { container } = await show(PAGE);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(reads()[0]!.url.searchParams.get('limit')).toBe('50');
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it('forwards well-formed params and drops everything else', async () => {
    await show(PAGE, { searchParams: { bs_month: '2083-07', centre_id: `${CENTRE_A},${CENTRE_B}`, branch_id: [BRANCH], group_by: 'referrer_ad_month', rollup: 'none', referrer_id: `${REF_1},${REF_2}`, cursor: 'abc123', evil: '1', tenant_id: 'other' } });
    const u = reads()[0]!.url.searchParams;
    expect(u.get('bs_month')).toBe('2083-07');
    expect(u.get('centre_id')).toBe(`${CENTRE_A},${CENTRE_B}`);
    expect(u.get('branch_id')).toBe(BRANCH);
    expect(u.get('group_by')).toBe('referrer_ad_month');
    expect(u.get('rollup')).toBe('none');
    expect(u.get('referrer_id')).toBe(`${REF_1},${REF_2}`);
    expect(u.get('cursor')).toBe('abc123');
    expect(u.has('evil')).toBe(false);
    expect(u.has('tenant_id')).toBe(false);
  });

  it.each([['group_by', 'evil;drop'], ['rollup', 'evil;drop'], ['bs_month', '2083-13;drop'], ['referrer_id', 'not-a-uuid;drop'], ['centre_id', 'not-a-uuid;drop']])('drops malformed %s', async (k, bad) => {
    await show(PAGE, { searchParams: { [k]: bad } });
    expect(reads()[0]!.url.searchParams.has(k)).toBe(false);
  });

  it('caps centre_id at 20 uuids (more than 20 are dropped or truncated, never forwarded)', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `01a1a98a-ac40-7000-8000-0000000002${String(i).padStart(2, '0')}`);
    await show(PAGE, { searchParams: { centre_id: ids.join(',') } });
    expect((reads()[0]!.url.searchParams.get('centre_id') ?? '').split(',').filter(Boolean).length).toBeLessThanOrEqual(20);
  });
});

describe('filters and pagination (§5)', () => {
  it('Group by radios: Referrer / Referrer × A.D. month / Referrer × B.S. month; the API value is the default selection and a change navigates', async () => {
    await show(PAGE);
    expect((screen.getByRole('radio', { name: /^referrer$/i }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /A\.D\. month/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: /B\.S\. month/ }));
    expect(lastNav()).toContain('group_by=referrer_bs_month');
  });

  it('"Combine merged doctors" switch is on by default (rollup=canonical); turning it off navigates with rollup=none', async () => {
    await show(PAGE);
    const sw = screen.getByLabelText(/combine merged doctors/i) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    await userEvent.click(sw);
    expect(lastNav()).toContain('rollup=none');
  });

  it('rollup=none in the URL renders the switch off', async () => {
    await show(PAGE, { searchParams: { rollup: 'none' } });
    expect((screen.getByLabelText(/combine merged doctors/i) as HTMLInputElement).checked).toBe(false);
  });

  it('a next_cursor shows Next, which navigates with that cursor; no Next on the last page', async () => {
    routes[`GET ${PATH}`] = json(body({ page: { limit: 50, next_cursor: 'cur-2' } }));
    await show(PAGE);
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(lastNav()).toContain('cursor=cur-2');
    cleanup();
    routes[`GET ${PATH}`] = json(body());
    await show(PAGE);
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
  });
});

describe('export gating (US-17 UI; §2)', () => {
  it('no Export menu without analytics.data.export; with it the Export menu opens the dialog for report_code referral_incentive', async () => {
    await show(PAGE);
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
    cleanup();
    resetApi([...READ, 'analytics.data.export']);
    routes[`GET ${PATH}`] = json(body());
    await show(PAGE);
    await userEvent.click(screen.getByRole('button', { name: /export/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /excel/i }));
    const d = await screen.findByRole('dialog', { name: 'Export report' });
    expect(d.textContent).toContain('Referral business report');
  });
});
