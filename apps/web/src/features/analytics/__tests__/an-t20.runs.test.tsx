// @vitest-environment jsdom
// AN-T20 — S7 Report run, app/(staff)/analytics/report-runs/[report_run_id]/page.tsx (04-UI-UX §9; US-18.4/.6 UI side; 07-SECURITY S4, REQ-SEC-098).
// ASSUMED contract:
//   * default async server component `Page({ params: Promise<{ report_run_id }> })`; checks `analytics.dashboard.read` (notFound() otherwise, no API call);
//     a malformed id makes NO API call; reads GET /v1/analytics/report-runs/{id}. API 404 (not a recipient/owner, other tenant, expired) -> notFound() whose copy
//     "This report link is not for your account or has expired." lives in a not-found.tsx beside the page (report-runs/[report_run_id]/ or report-runs/), or the
//     page renders that copy itself — both accepted.
//   * header "{schedule_name} — {period A.D.} · {period B.S.}" (heading level 1) + info banner "Figures as of now for this period. Your access limits apply."
//   * for each code in report_codes that is NOT in viewer_omitted_report_codes: one Card with the report's content, read from GET /v1/analytics/reports/<code with _ -> ->
//     using the run's period (business_date_from/business_date_to verbatim) and the run's `effective_scope` (centre_id comma-joined when not all_centres). Omitted codes are never
//     requested; codes that are not a known report code are ignored (no request, no crash).
//   * filters are read-only (no enabled period/centre control).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import {
  CENTRE_A, CENTRE_B, PERIOD, RUN_ID, SCHED_ID, TOKEN, MEMBER_2, OWNER_M, api, axeClean, calls, callsTo, has, json, pageText, problem, read, resetApi, routes, show, showOrThrown,
} from './an-t20.harness';
import { bySlug } from './an-t19.harness';

vi.mock('next/navigation', async () => (await import('./an-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t20.harness')).sessionMock);

const PAGE = 'report-runs/[report_run_id]/page';
const RUN = `/v1/analytics/report-runs/${RUN_ID}`;
const COPY = 'This report link is not for your account or has expired.';
const PERMS = ['analytics.dashboard.read'];
const props = (id = RUN_ID) => ({ params: { report_run_id: id } });
const run = (over: Record<string, unknown> = {}) => ({
  id: RUN_ID, schedule_id: SCHED_ID, schedule_name: 'Daily MIS', report_codes: ['income', 'department_income', 'volume', 'referral_incentive'], period: PERIOD,
  scope_all_centres: true, scope_centre_ids: [], created_at: '2026-01-15T01:15:00.000Z',
  effective_scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] }, viewer_omitted_report_codes: ['referral_incentive'],
  recipients: [{ membership_id: OWNER_M, display_name: 'Synthetic Owner', outcome: 'queued' }, { membership_id: MEMBER_2, display_name: 'Synthetic Manager Two', outcome: 'skipped_ineligible' }], ...over,
});
const tile = (value: number, unit = 'count') => ({ value, unit });
const DASHBOARD = {
  report_code: 'dashboard', period: PERIOD, scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: [{ family: 'orders', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }], generated_at: '2026-01-15T04:30:00.000Z',
  tiles: Object.fromEntries(['patient_visits', 'new_patients', 'net_orders', 'tests_ordered', 'net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'results_approved', 'reports_pending', 'reports_ready_unreleased', 'pending_tests', 'pending_overdue']
    .map((k) => [k, tile(12, k.endsWith('paisa') ? 'paisa' : 'count')])),
  series: { days: [{ business_date: '2026-01-01', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] }, department_top: [],
};
const REPORT = { income: bySlug('income'), 'department-income': bySlug('department-income'), volume: bySlug('volume') };

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  resetApi(PERMS);
  routes[`GET ${RUN}`] = json(run());
  for (const r of Object.values(REPORT)) routes[`GET ${r.paths[0]}`] = json(r.body);
});
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const reportCalls = () => calls.filter((c) => c.method === 'GET' && c.url.pathname.startsWith('/v1/analytics/reports/'));

async function expectNotFound(p: ReturnType<typeof props>) {
  const err = await showOrThrown(PAGE, p);
  if (err) {
    expect(err).toMatch(/NEXT_NOT_FOUND/);
    const f = [['report-runs', '[report_run_id]', 'not-found.tsx'], ['report-runs', 'not-found.tsx']].find((s) => has(...s));
    expect(f, 'a not-found.tsx carrying the copy').toBeTruthy();
    expect(read(...f!)).toContain(COPY);
  } else expect(pageText()).toContain(COPY);
}

describe('access (US-18.4; 07-SECURITY S4)', () => {
  it('without analytics.dashboard.read: not found and NO API call', async () => {
    resetApi(['analytics.data.export']);
    expect(await showOrThrown(PAGE, props())).toMatch(/NEXT_NOT_FOUND|not for your account/);
    expect(calls).toHaveLength(0);
  });

  it('API 404 (not a recipient / owner, other tenant, expired) -> the "not for your account or has expired" copy; no report is read', async () => {
    routes[`GET ${RUN}`] = () => problem('common.not_found', 404);
    await expectNotFound(props());
    expect(reportCalls()).toHaveLength(0);
  });

  it.each(['../exports', 'not-a-uuid', ''])('malformed run id %j: same not-found behaviour and NO API call', async (id) => {
    await expectNotFound(props(id));
    expect(calls).toHaveLength(0);
  });

  it('API 5xx rejects (error.tsx); the Bearer token is sent but never rendered', async () => {
    const { container } = await show(PAGE, props());
    expect(callsTo('GET', RUN)[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(container.innerHTML).not.toContain(TOKEN);
    cleanup();
    routes[`GET ${RUN}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE, props())).toBeTruthy();
  });
});

describe('content (§9)', () => {
  it('heading "{schedule name} — {A.D.} · {B.S.}" and the "Figures as of now…" info banner', async () => {
    await show(PAGE, props());
    const h = screen.getByRole('heading', { level: 1 });
    for (const s of ['Daily MIS', PERIOD.label_ad, PERIOD.label_bs]) expect(h.textContent).toContain(s);
    expect(pageText()).toContain('Figures as of now for this period. Your access limits apply.');
  });

  it('one card per non-omitted report code, each read with the run period; codes map _ -> - in the path; the omitted referral report is never requested or shown', async () => {
    await show(PAGE, props());
    const paths = reportCalls().map((c) => c.url.pathname).sort();
    expect(paths).toEqual(['/v1/analytics/reports/department-income', '/v1/analytics/reports/income', '/v1/analytics/reports/volume']);
    for (const c of reportCalls()) {
      expect(c.url.searchParams.get('business_date_from')).toBe(PERIOD.business_date_from);
      expect(c.url.searchParams.get('business_date_to')).toBe(PERIOD.business_date_to);
      expect(c.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    }
    expect(calls.some((c) => /referral/.test(c.url.pathname))).toBe(false);
    expect(pageText()).not.toMatch(/referral/i);
  });

  it('a run of the default schedule [dashboard, income] renders TWO cards: the Dashboard card is not dropped (§9)', async () => {
    routes[`GET ${RUN}`] = json(run({ report_codes: ['dashboard', 'income'], viewer_omitted_report_codes: [] }));
    routes[`GET /v1/analytics/dashboard`] = json(DASHBOARD);
    await show(PAGE, props());
    expect(callsTo('GET', '/v1/analytics/dashboard').length).toBeGreaterThan(0);
    for (const c of callsTo('GET', '/v1/analytics/dashboard')) {
      expect(c.url.searchParams.get('business_date_from')).toBe(PERIOD.business_date_from);
      expect(c.url.searchParams.get('business_date_to')).toBe(PERIOD.business_date_to);
    }
    expect(reportCalls().map((c) => c.url.pathname)).toEqual(['/v1/analytics/reports/income']);
    expect(screen.queryAllByRole('region').length + screen.queryAllByRole('article').length + screen.queryAllByRole('group').length).toBeGreaterThanOrEqual(2);
    expect(pageText()).toMatch(/dashboard/i);
    expect(pageText()).toMatch(/income/i);
    expect(screen.queryByRole('button', { name: /refresh|export/i })).toBeNull(); // dashboard refresh/export actions are hidden inside a run
  });

  it('renders the same content as the report pages (rows from the API, formatted)', async () => {
    await show(PAGE, props());
    const t = pageText();
    for (const r of Object.values(REPORT)) for (const s of r.tables[0]!.rowText.slice(0, 2)) expect(t, `${r.slug}: ${s}`).toContain(s);
  });

  it('uses the run\'s effective_scope (viewer ∩ schedule), not the schedule\'s own list: centre_id only when not all centres', async () => {
    routes[`GET ${RUN}`] = json(run({ scope_all_centres: false, scope_centre_ids: [CENTRE_A, CENTRE_B], effective_scope: { all_centres: false, centre_ids: [CENTRE_A], tenant_wide_sections_hidden: [] } }));
    await show(PAGE, props());
    expect(reportCalls().length).toBeGreaterThan(0);
    for (const c of reportCalls()) expect(c.url.searchParams.get('centre_id')).toBe(CENTRE_A);
    cleanup();
    calls.length = 0;
    routes[`GET ${RUN}`] = json(run());
    await show(PAGE, props());
    for (const c of reportCalls()) expect(c.url.searchParams.has('centre_id')).toBe(false);
  });

  it('ignores report codes that are not known report codes (no request built from them)', async () => {
    routes[`GET ${RUN}`] = json(run({ report_codes: ['income', '../exports', 'bogus_report', 'a/b'], viewer_omitted_report_codes: [] }));
    await show(PAGE, props());
    expect(reportCalls().map((c) => c.url.pathname)).toEqual(['/v1/analytics/reports/income']);
    expect(calls.some((c) => /\/exports|bogus|\/a\/b/.test(c.url.pathname))).toBe(false);
  });

  it('filters are read-only: no enabled period/centre control', async () => {
    await show(PAGE, props());
    const live = [...screen.queryAllByRole('combobox'), ...screen.queryAllByRole('listbox'), ...screen.queryAllByRole('textbox'), ...screen.queryAllByRole('radio')].filter(
      (e) => !(e as HTMLInputElement).disabled && e.getAttribute('aria-disabled') !== 'true' && !(e as HTMLInputElement).readOnly && e.getAttribute('aria-readonly') !== 'true',
    );
    expect(live.map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('a hostile schedule name is text, never markup', async () => {
    const H = '<img src=x onerror=alert(1)>';
    routes[`GET ${RUN}`] = json(run({ schedule_name: H }));
    const { container } = await show(PAGE, props());
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(H);
  });

  it('a11y: no axe violations', async () => {
    await show(PAGE, props());
    await axeClean();
  });
});
