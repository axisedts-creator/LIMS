// @vitest-environment jsdom
// AN-T18 — app/(staff)/analytics/page.tsx (S1 Owner dashboard). Spec: C8 01-PRD US-01.1/.2/.4/.5 (UI side), 03-APP-FLOW §5 row S1 + X20,
// 04-UI-UX §2/§3/§10, 07-SECURITY (centre scope shown from the API echo only; no token/ids in the DOM). MSW plays the API.
// ASSUMED contract (spec fixes only the file + kit primitives):
//   * default export = async server component `Page({ searchParams: Promise<Record<string, string | string[] | undefined>> })`
//     (same shape as billing/daily-cash/page.tsx). It fetches GET /v1/analytics/dashboard itself (server-side, Bearer from the session),
//     and returns a tree that renders in a plain client render: NO nested async server components, tiles built from @lims/ui `StatTile`.
//   * searchParams → API query: only business_date_from/business_date_to/bs_month/fiscal_year_bs (strings matching the contract patterns)
//     and centre_id/branch_id (comma-joined, form/explode=false, uuids, ≤ 20) are forwarded; anything else is dropped. No period given → none sent
//     (the server defaults to Today).
//   * secondary reads (getAnalyticsFreshness, getPendingTestsSummary, getAnalyticsFilterOptions) may be used, but any failure of them must not
//     break the page (X20) — here every analytics GET other than dashboard/freshness/filter-options answers 503 common.dependency_unavailable.
//   * PermissionDenied for the missing route permission is the (staff) layout's job; the page only has to refuse to show data on an API 403.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh, back: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['analytics.dashboard.read'], displayName: 'Synthetic Owner', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/analytics',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const CENTRE_A = '01a1a98a-ac40-7000-8000-000000000002';
const CENTRE_B = '01a1a98a-ac40-7000-8000-000000000003';
const DEPT = '01a1a98a-ac40-7000-8000-000000000005';
const problem = (code: string, status: number) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code }, { status });
const tile = (value: number, unit = 'count', extra: Record<string, unknown> = {}) => ({ value, unit, ...extra });

const dashboard = (over: Record<string, any> = {}) => ({
  report_code: 'dashboard',
  period: { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' },
  scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: [
    { family: 'orders', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false },
    { family: 'income', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false },
  ],
  generated_at: '2026-01-15T04:30:00.000Z',
  tiles: {
    patient_visits: tile(12, 'count', { previous: 10, delta: 2, delta_bp: 2000 }),
    new_patients: tile(4),
    net_orders: tile(13),
    tests_ordered: tile(31),
    net_sales_paisa: tile(22500000, 'paisa', { previous: 20810000, delta: 1690000, delta_bp: 812 }),
    invoiced_paisa: tile(23000000, 'paisa'),
    credit_notes_paisa: tile(500000, 'paisa'),
    results_approved: tile(28, 'count', { previous: 26, delta: 2, delta_bp: 769 }),
    reports_pending: tile(5),
    reports_ready_unreleased: tile(2),
    pending_tests: tile(9),
    pending_overdue: tile(1),
    ...(over['tiles'] ?? {}),
  },
  series: { days: [{ business_date: '2026-01-15', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] },
  department_top: [{ department_id: DEPT, label: 'Synthetic Biochemistry', is_multiple: false, net_paisa: 900000, share_bp: 6294 }],
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'tiles')),
});
const zeros = Object.fromEntries(
  ['patient_visits', 'new_patients', 'net_orders', 'tests_ordered', 'net_sales_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'results_approved', 'reports_pending', 'reports_ready_unreleased', 'pending_tests', 'pending_overdue']
    .map((k) => [k, tile(0, k.endsWith('paisa') ? 'paisa' : 'count')]),
);

const calls: { url: URL; headers: Headers; method: string }[] = [];
let dash: () => Response | Promise<Response> = () => HttpResponse.json(dashboard());
let refresh: () => Response | Promise<Response> = () => HttpResponse.json({}, { status: 202 });
const api = setupServer(
  http.get(`${ORIGIN}/v1/analytics/dashboard`, ({ request }) => { calls.push({ url: new URL(request.url), headers: request.headers, method: 'GET' }); return dash(); }),
  http.get(`${ORIGIN}/v1/analytics/freshness`, () => HttpResponse.json({ data: dashboard().freshness })),
  http.get(`${ORIGIN}/v1/analytics/filter-options`, () => HttpResponse.json({ centres: [], branches: [], departments: [], payment_methods: [], specimen_types: [] })),
  http.post(`${ORIGIN}/v1/analytics/refresh`, ({ request }) => { calls.push({ url: new URL(request.url), headers: request.headers, method: 'POST' }); return refresh(); }),
  http.get(`${ORIGIN}/v1/analytics/*`, () => problem('common.dependency_unavailable', 503)),
);
function setVisibility(v: 'visible' | 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); }
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); vi.useRealTimers(); routerRefresh.mockClear(); setVisibility('visible'); api.resetHandlers(); calls.length = 0; dash = () => HttpResponse.json(dashboard()); refresh = () => HttpResponse.json({}, { status: 202 }); });
afterAll(() => api.close());

type SP = Record<string, string | string[] | undefined>;
const load = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/analytics/page')) as { default: (p: { searchParams: Promise<SP> }) => Promise<any> }).default;
const show = async (sp: SP = {}) => {
  const Page = await load();
  const el = await Page({ searchParams: Promise.resolve(sp) });
  return render(<ToastProvider>{el}</ToastProvider>);
};
const dashCalls = () => calls.filter((c) => c.method === 'GET');
const tileEl = (label: string) => {
  const hit = Array.from(document.querySelectorAll('.lims-stat')).find((e) => e.querySelector('.lims-stat-label')?.textContent === label);
  if (!hit) throw new Error(`tile "${label}" not rendered`);
  return hit as HTMLElement;
};
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ');
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

describe('S1 dashboard — request (US-01.1, 07-SECURITY)', () => {
  it('with no period it sends no period params (server default = Today) and calls the API with the session Bearer token, never exposing it in the DOM', async () => {
    const { container } = await show();
    expect(dashCalls()).toHaveLength(1);
    const { url, headers } = dashCalls()[0]!;
    expect(url.pathname).toBe('/v1/analytics/dashboard');
    for (const p of ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs']) expect(url.searchParams.has(p)).toBe(false);
    expect(headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(container.innerHTML).not.toContain('jwt-synthetic');
  });

  it('forwards only whitelisted, well-formed params (period, centre_id/branch_id comma-joined) and drops everything else', async () => {
    await show({ bs_month: '2083-07', centre_id: `${CENTRE_A},${CENTRE_B}`, branch_id: [CENTRE_A], evil: '1', tenant_id: 'other-tenant' });
    const q = dashCalls()[0]!.url.searchParams;
    expect(q.get('bs_month')).toBe('2083-07');
    expect(q.get('centre_id')).toBe(`${CENTRE_A},${CENTRE_B}`);
    expect(q.get('branch_id')).toBe(CENTRE_A);
    expect([...q.keys()].sort()).toEqual(['branch_id', 'bs_month', 'centre_id']);
  });

  it.each([
    ['bs_month', '2083-07&centre_id=x'],
    ['bs_month', '../../etc/passwd'],
    ['fiscal_year_bs', '2082/83;drop'],
    ['business_date_from', '2026-1-5'],
    ['centre_id', 'not-a-uuid'],
  ])('does not forward a malformed %s (%s)', async (key, bad) => {
    await show({ [key]: bad });
    for (const c of dashCalls()) {
      expect(c.url.searchParams.get(key)).not.toBe(bad);
      expect(c.url.search).not.toContain('drop');
      expect(c.url.search).not.toContain('passwd');
      expect(c.url.searchParams.has('x')).toBe(false);
    }
  });
});

describe('S1 dashboard — tiles (US-01.1, 04-UI-UX §3)', () => {
  it('shows the six tiles with spec labels and values; money in lakh grouping; sub-values; period header in A.D. and B.S.', async () => {
    const { container } = await show();
    expect(norm(tileEl('Patient visits').textContent)).toContain('12');
    expect(norm(tileEl('Income (net sales)').textContent)).toMatch(/2,25,000/);
    expect(norm(tileEl('Results approved').textContent)).toContain('28');
    expect(norm(tileEl('Reports pending').textContent)).toContain('5');
    expect(norm(tileEl('Pending tests').textContent)).toContain('9');
    const text = norm(container.textContent);
    for (const s of ['New patients 4', 'Tests ordered 31', 'Ready, not released 2', 'Overdue 1', '15 Jan 2026', '2082-10-01']) expect(text).toContain(s);
    expect(text).toMatch(/Invoiced.*2,30,000/);
    expect(text).toMatch(/Credit notes.*5,000/);
  });

  it('links each tile to its report (app-relative hrefs)', async () => {
    await show();
    const href = (l: string) => tileEl(l).closest('a')?.getAttribute('href');
    expect(href('Patient visits')).toBe('/analytics/reports/volume');
    expect(href('Income (net sales)')).toBe('/analytics/reports/income');
    expect(href('Results approved')).toBe('/analytics/reports/tests-done');
    expect(href('Reports pending')).toBe('/analytics/reports/pending-tests');
    expect(href('Pending tests')).toBe('/analytics/reports/pending-tests');
  });

  it('shows "Cash collected (net)" → /analytics/collections only when the API sent net_collected_paisa (omitted otherwise, never an empty tile)', async () => {
    await show();
    expect(Array.from(document.querySelectorAll('.lims-stat-label')).map((e) => e.textContent)).not.toContain('Cash collected (net)');
    cleanup();
    dash = () => HttpResponse.json(dashboard({ tiles: { net_collected_paisa: tile(1234500, 'paisa', { previous: 1000000, delta: 234500, delta_bp: 2345 }) } }));
    await show();
    expect(norm(tileEl('Cash collected (net)').textContent)).toMatch(/12,345/);
    expect(tileEl('Cash collected (net)').closest('a')?.getAttribute('href')).toBe('/analytics/collections');
  });

  it('explains T1 and T2 (help text from the copy catalogue)', async () => {
    const { container } = await show();
    const t = norm(container.textContent) + [...container.querySelectorAll('[title],[aria-label],[aria-description]')].map((e) => e.getAttribute('title') ?? e.getAttribute('aria-label')).join(' ');
    expect(t).toContain('Counts each patient once per centre per day. Over several days the same person can be counted more than once.');
    expect(t).toContain('Income = invoices issued (incl. VAT/other tax) minus credit notes. Cash collected is shown separately.');
  });

  it('lists the top departments (inactive-safe label text) and "Multiple departments" for is_multiple rows; hostile labels stay text', async () => {
    dash = () => HttpResponse.json(dashboard({ department_top: [
      { department_id: DEPT, label: '<img src=x onerror=alert(1)>', is_multiple: false, net_paisa: 900000, share_bp: 6000 },
      { label: 'ignored for multiple', is_multiple: true, net_paisa: 100000, share_bp: 4000 },
    ] }));
    const { container } = await show();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('Multiple departments');
  });
});

describe('S1 dashboard — deltas (US-01.2)', () => {
  it('shows absolute and percent (from delta_bp, one decimal) with the caption "vs yesterday" for a one-day period', async () => {
    dash = () => HttpResponse.json(dashboard({ tiles: { patient_visits: tile(120, 'count', { previous: 111, delta: 9, delta_bp: 811 }) } }));
    await show();
    const t = norm(tileEl('Patient visits').textContent);
    expect(t).toContain('+9 (8.1%)');
    expect(t).toContain('Up');
    expect(norm(document.body.textContent)).toContain('vs yesterday');
  });

  it('uses "vs previous {n} days" for a multi-day period', async () => {
    dash = () => HttpResponse.json(dashboard({ period: { business_date_from: '2026-01-09', business_date_to: '2026-01-16', days: 7, label_ad: '09 Jan – 15 Jan 2026', label_bs: '2082-09-25 – 2082-10-01', timezone: 'Asia/Kathmandu' } }));
    await show();
    expect(norm(document.body.textContent)).toContain('vs previous 7 days');
    expect(norm(document.body.textContent)).not.toContain('vs yesterday');
  });

  it('omits the percent when previous is 0 (no delta_bp) but keeps the absolute delta', async () => {
    dash = () => HttpResponse.json(dashboard({ tiles: { results_approved: tile(28, 'count', { previous: 0, delta: 28 }) } }));
    await show();
    const t = norm(tileEl('Results approved').textContent);
    expect(t).toContain('+28');
    expect(t).not.toContain('%');
    expect(t).not.toContain('Infinity');
    expect(t).not.toContain('NaN');
  });

  it('shows a decrease as "Down" with its magnitude and percent', async () => {
    dash = () => HttpResponse.json(dashboard({ tiles: { patient_visits: tile(100, 'count', { previous: 120, delta: -20, delta_bp: -1667 }) } }));
    await show();
    const t = norm(tileEl('Patient visits').textContent);
    expect(t).toContain('Down');
    expect(t).toContain('20');
    expect(t).toContain('16.7%');
  });

  it('shows no delta on the snapshot tiles (Reports pending, Pending tests)', async () => {
    await show();
    for (const l of ['Reports pending', 'Pending tests']) {
      const t = norm(tileEl(l).textContent);
      expect(t).not.toMatch(/Up|Down|No change|%/);
    }
  });
});

describe('S1 dashboard — freshness (US-01.4, 04-UI-UX §2)', () => {
  it('fresh: "Updated …" and no stale marker', async () => {
    await show();
    const t = norm(document.body.textContent);
    expect(t).toMatch(/Updated /);
    expect(t).not.toContain('Data may be out of date');
  });

  it('stale income (45 min): stale marker with text (not colour only), reason available, "Updated …" and the LAST VALUES still shown', async () => {
    dash = () => HttpResponse.json(dashboard({ freshness: [
      { family: 'orders', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false },
      { family: 'income', refreshed_at: '2026-01-15T03:45:00.000Z', is_stale: true, stale_reason: 'refresh_lagging', live: false },
    ] }));
    await show();
    expect(screen.getAllByText('Data may be out of date').length).toBeGreaterThan(0);
    expect(norm(document.body.textContent)).toMatch(/Updated /);
    expect(norm(tileEl('Income (net sales)').textContent)).toMatch(/2,25,000/);
  });

  // review #1: 03-APP-FLOW §5 S1 "stale badge per tile", US-01.4. A tile's cell = the widest ancestor of the tile that holds no other tile (tile + its sub-values + badge).
  const cellOf = (label: string) => {
    let el: HTMLElement = tileEl(label);
    while (el.parentElement && el.parentElement.querySelectorAll('.lims-stat').length === 1) el = el.parentElement;
    return el;
  };
  const STALE = 'Data may be out of date';
  const staleFresh = (family: string) => ['orders', 'income', 'results'].map((f) => (f === family
    ? { family: f, refreshed_at: '2026-01-15T03:45:00.000Z', is_stale: true, stale_reason: 'refresh_lagging', live: false }
    : { family: f, refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }));

  it('stale income: the stale marker sits in the "Income (net sales)" tile cell and NOT in "Patient visits"; last values still shown', async () => {
    dash = () => HttpResponse.json(dashboard({ freshness: staleFresh('income') }));
    await show();
    expect(norm(cellOf('Income (net sales)').textContent)).toContain(STALE);
    expect(norm(cellOf('Income (net sales)').textContent)).toMatch(/2,25,000/);
    expect(norm(cellOf('Patient visits').textContent)).not.toContain(STALE);
    expect(norm(cellOf('Results approved').textContent)).not.toContain(STALE);
  });

  it.each([
    ['orders', 'Patient visits', ['Income (net sales)', 'Results approved']],
    ['results', 'Results approved', ['Patient visits', 'Income (net sales)']],
  ])('stale %s family marks only the "%s" tile', async (family, label, others) => {
    dash = () => HttpResponse.json(dashboard({ freshness: staleFresh(family) }));
    await show();
    expect(norm(cellOf(label).textContent)).toContain(STALE);
    for (const o of others) expect(norm(cellOf(o).textContent)).not.toContain(STALE);
  });

  it('never_refreshed shows the marker without crashing when refreshed_at is absent', async () => {
    dash = () => HttpResponse.json(dashboard({ tiles: zeros, freshness: [{ family: 'income', is_stale: true, stale_reason: 'never_refreshed', live: false }] }));
    await show();
    expect(screen.getAllByText(/Data may be out of date|Not yet calculated/).length).toBeGreaterThan(0);
    expect(norm(document.body.textContent)).not.toContain('Invalid');
  });
});

describe('S1 dashboard — scope (US-01.5, 07-SECURITY)', () => {
  it('shows the tenant-wide notice when the API reports hidden sections, and never prints centre ids', async () => {
    dash = () => HttpResponse.json(dashboard({ scope: { all_centres: false, centre_ids: [CENTRE_A], tenant_wide_sections_hidden: ['collections'] } }));
    const { container } = await show();
    expect(norm(container.textContent)).toContain('Some figures are only available to users with access to all centres.');
    expect(container.innerHTML).not.toContain(CENTRE_A);
  });

  it('shows no notice for a centre-restricted user when nothing is tenant-wide-only (Phase 1)', async () => {
    dash = () => HttpResponse.json(dashboard({ scope: { all_centres: false, centre_ids: [CENTRE_A], tenant_wide_sections_hidden: [] } }));
    const { container } = await show();
    expect(norm(container.textContent)).not.toContain('Some figures are only available');
  });
});

describe('S1 dashboard — empty (03-APP-FLOW §5)', () => {
  it('all zeros: tiles still render with 0, plus "No activity in this period" and a "Show yesterday" action', async () => {
    dash = () => HttpResponse.json(dashboard({ tiles: zeros, series: { days: [] }, department_top: [] }));
    await show();
    expect(norm(tileEl('Patient visits').textContent)).toContain('0');
    expect(norm(tileEl('Income (net sales)').textContent)).toMatch(/0\.00|0\b/);
    expect(screen.getByText('No activity in this period')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show yesterday' })).toBeTruthy();
  });

  it('with activity there is no empty message', async () => {
    await show();
    expect(screen.queryByText('No activity in this period')).toBeNull();
  });
});

describe('S1 dashboard — error / permission states (03-APP-FLOW §5)', () => {
  const outcome = async (res: () => Response) => {
    dash = res;
    try { await show(); return { threw: undefined as unknown, text: document.body.textContent ?? '' }; }
    catch (e) { return { threw: e, text: '' }; }
  };

  it.each([
    ['500 common.internal', () => problem('common.internal', 500)],
    ['503 common.dependency_unavailable', () => problem('common.dependency_unavailable', 503)],
  ])('%s → the page rejects so error.tsx renders (no tiles, no partial data)', async (_n, res) => {
    const o = await outcome(res);
    expect(o.threw).toBeDefined();
    expect(String((o.threw as Error).message)).not.toMatch(/SELECT|stack|at \//);
  });

  it('403 auth.forbidden from the API → no figures are rendered (rejects, or shows the forbidden page)', async () => {
    const o = await outcome(() => problem('auth.forbidden', 403));
    if (!o.threw) {
      expect(o.text).not.toContain('Patient visits');
      expect(o.text).not.toContain('Income (net sales)');
    }
  });

  it('secondary reads failing (live pending 503, X20) does not take the other tiles down', async () => {
    await show();
    expect(norm(tileEl('Patient visits').textContent)).toContain('12');
    expect(norm(tileEl('Income (net sales)').textContent)).toMatch(/2,25,000/);
  });
});

describe('S1 dashboard — refresh action (04-UI-UX §2)', () => {
  const btn = () => screen.getByRole('button', { name: /refresh/i }) as HTMLButtonElement;

  it('a Refresh button posts once to /v1/analytics/refresh (Bearer) and then disables with "Refresh available at {time}"', async () => {
    await show();
    await userEvent.setup().click(btn());
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(norm(document.body.textContent)).toMatch(/Refresh available at/));
    expect((screen.queryByRole('button', { name: /refresh/i }) as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
  });

  it('429 → the same "Refresh available at {time}" text and no crash', async () => {
    refresh = () => problem('common.rate_limited', 429);
    await show();
    await userEvent.setup().click(btn());
    await waitFor(() => expect(norm(document.body.textContent)).toMatch(/Refresh available at/));
  });

  it('double click sends one request while the first is in flight', async () => {
    refresh = async () => { await delay(150); return HttpResponse.json({}, { status: 202 }); };
    await show();
    const user = userEvent.setup();
    await user.dblClick(btn());
    await waitFor(() => expect(norm(document.body.textContent)).toMatch(/Refresh available at/));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

// review round 2 #1: 04-UI-UX §2 L48 — Refresh is "disabled for 5 min after use", then enabled again (button and Alt+R).
// Clock is faked with shouldAdvanceTime so MSW/fetch/waitFor keep working; only setTimeout + Date are faked.
describe('S1 dashboard — refresh cooldown ends (04-UI-UX §2)', () => {
  const FIVE_MIN = 5 * 60_000;
  const postCount = () => calls.filter((c) => c.method === 'POST').length;
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
  const refreshBtn = () => screen.queryByRole('button', { name: /refresh/i }) as HTMLButtonElement | null;
  const disabled = () => refreshBtn()?.disabled ?? true;
  const pressAndCool = async () => {
    await userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }).click(refreshBtn()!);
    await waitFor(() => expect(norm(document.body.textContent)).toMatch(/Refresh available at/));
    expect(disabled()).toBe(true);
  };

  it('no next_allowed_at: disabled just before 5 min, enabled after, and the "available at" text is gone', async () => {
    fakeClock();
    await show();
    await pressAndCool();
    await vi.advanceTimersByTimeAsync(FIVE_MIN - 10_000);
    expect(disabled()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    await waitFor(() => expect(disabled()).toBe(false));
    expect(norm(document.body.textContent)).not.toMatch(/Refresh available at/);
  });

  it('next_allowed_at wins over the 5 min default (re-enabled after ~60 s)', async () => {
    fakeClock();
    refresh = () => HttpResponse.json({ next_allowed_at: new Date(Date.now() + 60_000).toISOString() }, { status: 202 });
    await show();
    await pressAndCool();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(disabled()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    await waitFor(() => expect(disabled()).toBe(false));
  });

  it('after the cooldown the button posts again and Alt+R works again', async () => {
    const { act } = await import('@testing-library/react');
    fakeClock();
    await show();
    await pressAndCool();
    expect(postCount()).toBe(1);
    const sc = (await (await import('@/core/shortcuts/registry')).shortcuts.list('staff.analytics.dashboard').find((s) => /^alt\+r$/i.test(s.key)))!;
    act(() => { sc.run(); }); // still cooling: no request
    await vi.advanceTimersByTimeAsync(100);
    expect(postCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(FIVE_MIN + 1_000);
    await waitFor(() => expect(disabled()).toBe(false));
    act(() => { sc.run(); });
    await waitFor(() => expect(postCount()).toBe(2));
  });

  it('unmount during cooldown leaves no pending timer that fires into a dead component', async () => {
    fakeClock();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = await show();
    await pressAndCool();
    unmount();
    await vi.advanceTimersByTimeAsync(FIVE_MIN + 1_000);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

// review #2: 03-APP-FLOW §2 step 5 — auto-refresh every 5 min via router.refresh() only while the tab is visible, never faster.
// Only the interval is faked so MSW/fetch keep real timers. ASSUMED: poller is a client child of the page tree (pattern: instruments AgentsList).
describe('S1 dashboard — auto-refresh (03-APP-FLOW §2.5)', () => {
  const FIVE_MIN = 5 * 60_000;
  const fakeInterval = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

  it('calls router.refresh() at 5 min and not before (nor at 30 s / 4m59s)', async () => {
    fakeInterval();
    await show();
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(FIVE_MIN - 31_000);
    expect(routerRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FIVE_MIN);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh while the tab is hidden; resumes when visible again', async () => {
    fakeInterval();
    await show();
    setVisibility('hidden');
    vi.advanceTimersByTime(3 * FIVE_MIN);
    expect(routerRefresh).not.toHaveBeenCalled();
    setVisibility('visible');
    vi.advanceTimersByTime(FIVE_MIN);
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('stops polling after unmount', async () => {
    fakeInterval();
    const { unmount } = await show();
    unmount();
    vi.advanceTimersByTime(3 * FIVE_MIN);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});

// review #3: 04-UI-UX §2 — Alt+R = Refresh on the dashboard, registered via core/shortcuts/registry for page id staff.analytics.dashboard.
describe('S1 dashboard — Alt+R shortcut (04-UI-UX §2)', () => {
  const PAGE = 'staff.analytics.dashboard';
  const altR = async () => (await import('@/core/shortcuts/registry')).shortcuts.list(PAGE).find((s) => /^alt\+r$/i.test(s.key));

  it('Alt+R is registered with a "Refresh" description and posts once to /v1/analytics/refresh', async () => {
    const { act } = await import('@testing-library/react');
    await show();
    const sc = await altR();
    expect(sc).toBeTruthy();
    expect(sc!.description).toMatch(/refresh/i);
    act(() => { sc!.run(); });
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(norm(document.body.textContent)).toMatch(/Refresh available at/));
  });

  it('pressing Alt+R twice quickly sends one request (same guard as the button)', async () => {
    const { act } = await import('@testing-library/react');
    refresh = async () => { await delay(100); return HttpResponse.json({}, { status: 202 }); };
    await show();
    const sc = (await altR())!;
    act(() => { sc.run(); sc.run(); });
    await waitFor(() => expect(norm(document.body.textContent)).toMatch(/Refresh available at/));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('is unregistered on unmount', async () => {
    await show();
    expect(await altR()).toBeTruthy();
    cleanup();
    expect(await altR()).toBeUndefined();
  });
});

describe('S1 dashboard — accessibility (04-UI-UX §10)', () => {
  it('populated, stale and empty variants are axe-clean; tiles are links with accessible names', async () => {
    await show();
    await axeClean();
    for (const a of document.querySelectorAll('a.lims-stat')) expect((a.textContent ?? '').trim().length).toBeGreaterThan(0);
    cleanup();
    dash = () => HttpResponse.json(dashboard({ freshness: [{ family: 'income', refreshed_at: '2026-01-15T03:45:00.000Z', is_stale: true, stale_reason: 'refresh_failed', live: false }] }));
    await show();
    await axeClean();
    cleanup();
    dash = () => HttpResponse.json(dashboard({ tiles: zeros, series: { days: [] }, department_top: [] }));
    await show();
    await axeClean();
  });
});
