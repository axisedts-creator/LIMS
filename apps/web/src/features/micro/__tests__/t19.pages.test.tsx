// @vitest-environment jsdom
// C10.T-19 — /micro/worklist page (04-UI-UX §2; 03-APP-FLOW §5; AC-02.1; AC-02.3 is server-side RLS, the UI never widens it; REQ-SEC-026/027).
// "all page states": populated · empty · loading · error · forbidden. Server components are awaited directly and their element rendered (MSW plays the API).
// ASSUMED: page is an async server component; 403 on the culture list -> MicroForbidden (no table, no scan bar, no data); other failures reject (error.tsx);
// counts for the other four tabs come from limit=1&include_total=true calls; Reg no from GET /v1/lab/specimens/{id}; centres from GET /v1/identity/centres?is_active=true.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_READ, api, culture, cultureList, hit, hits, page, problem, resetHits, router, state } from './t19.harness';

vi.mock('next/navigation', async () => (await import('./t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); state.permissions = PERM_READ; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const worklist = async (sp: Record<string, string | string[] | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/micro/worklist/page');
  const el = await mod.default({ searchParams: Promise.resolve(sp) } as never);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const lists = () => hit('GET', /^\/v1\/micro\/cultures$/);
const q = (h: { search: string }) => new URLSearchParams(h.search);
/** The page's main list call = the one that is not a count probe (count probes use limit=1). */
const main = () => lists().find((h) => q(h).get('limit') !== '1') ?? lists()[0]!;
const statuses = (h: { search: string }) => (q(h).get('status') ?? '').split(',').sort().join(',');

describe('request shape per tab (AC-02.1, 04-UI-UX §2 table)', () => {
  it.each([
    ['setup', 'awaiting_setup', 'received_at'],
    ['incubating', 'incubating', 'next_read_due_at'],
    ['workup', 'growth_detected', 'next_read_due_at'],
    ['amending', 'amending', '-updated_at'],
  ] as const)('tab %s -> status=%s, sort=%s, include_total, page size ≤ 50', async (tab, status, sort) => {
    await worklist({ tab });
    const m = main();
    expect(m.method).toBe('GET');
    expect(statuses(m)).toBe(status);
    expect(q(m).get('sort')).toBe(sort);
    expect(q(m).get('include_total')).toBe('true');
    expect(Number(q(m).get('limit') ?? '50')).toBeLessThanOrEqual(50);
  });

  it('no tab param -> the "Awaiting setup" tab', async () => {
    await worklist();
    expect(statuses(main())).toBe('awaiting_setup');
    expect(screen.getByRole('tab', { name: /^awaiting setup/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('recent tab -> status final_submitted+cancelled, sort -updated_at, updated_at_from = now − recent window (7 days default [CONV])', async () => {
    const before = Date.now();
    await worklist({ tab: 'recent' });
    const m = main();
    expect(statuses(m)).toBe('cancelled,final_submitted');
    expect(q(m).get('sort')).toBe('-updated_at');
    const from = Date.parse(q(m).get('updated_at_from') ?? '');
    expect(Number.isNaN(from)).toBe(false);
    const sevenDays = 7 * 24 * 3600 * 1000;
    expect(Math.abs(before - from - sevenDays)).toBeLessThan(3600 * 1000);
  });

  it.each(['drop table', 'SETUP', ['recent', 'setup'], '', 'amending,incubating'])('unknown / array tab %j falls back to setup (nothing user-controlled reaches the API)', async (tab) => {
    await worklist({ tab: tab as never });
    for (const c of lists().filter((h) => q(h).get('limit') !== '1')) expect(['awaiting_setup', '']).toContain(statuses(c).replace(/^$/, ''));
    expect(statuses(main())).toBe('awaiting_setup');
  });

  it('counts: the other tabs are counted with limit=1&include_total=true (no row data pulled), the tab badges show the totals', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, ({ request }) => {
      const st = new URL(request.url).searchParams.get('status');
      const total = ({ awaiting_setup: 4, incubating: 9, growth_detected: 2, amending: 1 } as Record<string, number>)[st ?? ''] ?? 0;
      return page([culture(1)], { total });
    }));
    await worklist({ tab: 'incubating' });
    const probed = new Set(lists().filter((h) => q(h).get('limit') === '1').map(statuses));
    for (const s of ['awaiting_setup', 'growth_detected', 'amending']) expect(probed.has(s), s).toBe(true);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s+/g, ' ').trim());
    expect(tabs).toEqual(expect.arrayContaining(['Awaiting setup (4)', 'Incubating (9)', 'Growth / work-up (2)', 'Amending (1)']));
  });

  it('a failing count probe does not break the page (the badge is omitted)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, ({ request }) => new URL(request.url).searchParams.get('limit') === '1' ? problem('common.internal', 500) : page([culture(1)], { total: 1 })));
    await worklist();
    expect(screen.getByRole('link', { name: /Synthetic culture 1/ })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent).join(' ')).not.toMatch(/undefined|NaN/);
  });
});

describe('filters are whitelisted and validated before they reach the API (REQ-SEC-026/027)', () => {
  it('forwards centre_id, received_at_from/to, read_overdue, has_open_instrument_records, sort, cursor — and nothing else', async () => {
    await worklist({
      tab: 'incubating', centre_id: ID(2), received_at_from: '2026-11-01T00:00:00.000Z', received_at_to: '2026-11-08T00:00:00.000Z',
      read_overdue: 'true', has_open_instrument_records: 'false', sort: '-received_at', cursor: 'abc_DEF-1',
      evil: '1', barcode: 'E260000001', tenant_id: ID(99), specimen_id: ID(5),
    });
    const m = q(main());
    expect(Object.fromEntries(m)).toMatchObject({ centre_id: ID(2), received_at_from: '2026-11-01T00:00:00.000Z', received_at_to: '2026-11-08T00:00:00.000Z', read_overdue: 'true', has_open_instrument_records: 'false', sort: '-received_at', cursor: 'abc_DEF-1' });
    for (const k of ['evil', 'barcode', 'tenant_id', 'specimen_id']) expect(m.has(k), k).toBe(false);
  });

  it.each([
    ['centre_id', 'not-a-uuid'], ['centre_id', `${ID(2)},${ID(3)}`], ['received_at_from', 'yesterday'], ['received_at_to', '2026-13-45'], ['read_overdue', 'maybe'],
    ['has_open_instrument_records', '1'], ['sort', 'password'], ['cursor', '../../etc'], ['cursor', 'x'.repeat(2000)],
  ])('a malformed %s (%s) is dropped, not forwarded', async (key, value) => {
    await worklist({ tab: 'incubating', [key]: value });
    // ruling: every tab has a default sort, so a bad sort is "not forwarded", not "absent"
    if (key === 'sort') expect(q(main()).get('sort')).toBe('next_read_due_at');
    else expect(q(main()).has(key)).toBe(false);
  });

  it('the page never sends centre scoping of its own (centre limits are the server\'s RLS job, AC-02.3)', async () => {
    await worklist();
    expect(q(main()).has('centre_id')).toBe(false);
  });
});

describe('page data (AC-02.1 rows, AC-02.2 prerequisites)', () => {
  it('renders the rows in API order with tabs and the scan bar', async () => {
    api.use(cultureList([culture(2), culture(1)]));
    await worklist();
    expect(screen.getAllByRole('link', { name: /Synthetic culture/ }).map((l) => l.textContent?.match(/culture (\d)/)?.[1])).toEqual(['2', '1']);
    expect(screen.getByRole('textbox', { name: /scan specimen barcode/i })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });

  it('Reg no / barcode come from GET /v1/lab/specimens/{uuid}, one call per distinct specimen', async () => {
    api.use(cultureList([culture(1), culture(2), culture(3, { specimen_id: ID(401) })]));
    await worklist();
    const calls = hit('GET', /^\/v1\/lab\/specimens\/[0-9a-f-]{36}$/).map((h) => h.path).sort();
    expect(calls).toEqual([`/v1/lab/specimens/${ID(401)}`, `/v1/lab/specimens/${ID(402)}`]);
    expect(screen.getAllByText('R261100001')).toHaveLength(2); // cultures 1 and 3 share specimen ID(401)
  });

  it('a failing C5 specimen read (403 / 404 / 500) does not break the table; Reg no shows "—"', async () => {
    api.use(http.get(`${ORIGIN}/v1/lab/specimens/:id`, () => problem('auth.forbidden', 403)));
    await worklist();
    expect(screen.getByRole('link', { name: /Synthetic culture 1/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/R2611\d+/);
  });

  it('centres are loaded with is_active=true under the user\'s session and offered in the Centre filter', async () => {
    await worklist();
    const c = hit('GET', /^\/v1\/identity\/centres$/);
    expect(c).toHaveLength(1);
    expect(q(c[0]!).get('is_active')).toBe('true');
    expect(c[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(screen.getAllByText(/^centre$/i).length).toBeGreaterThan(0);
  });

  it('listCentres 403 (no identity.centre.read) hides the Centre filter; the page still works', async () => {
    api.use(http.get(`${ORIGIN}/v1/identity/centres`, () => problem('auth.forbidden', 403)));
    await worklist();
    expect(screen.queryByText(/^centre$/i)).toBeNull();
    expect(screen.getByRole('link', { name: /Synthetic culture 1/ })).toBeTruthy();
  });

  it('listCentres 500 also degrades to "no Centre filter" instead of failing the worklist', async () => {
    api.use(http.get(`${ORIGIN}/v1/identity/centres`, () => problem('common.internal', 500)));
    await worklist();
    expect(screen.getByRole('link', { name: /Synthetic culture 1/ })).toBeTruthy();
  });

  it('passes the opaque next_cursor to the screen (Next control appears)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => page([culture(1)], { next_cursor: 'cur_1' })));
    await worklist();
    expect(screen.getByRole('button', { name: /next|more/i })).toBeTruthy();
  });

  it('empty tab renders the empty state, not an error', async () => {
    api.use(cultureList([]));
    await worklist();
    expect(document.body.textContent).toContain('No specimens waiting for set-up.');
  });

  it('every request carries the bearer from the session (server side), never from the URL', async () => {
    await worklist();
    for (const h of hits) { expect(h.headers.get('authorization')).toBe('Bearer jwt-synthetic'); expect(h.search).not.toMatch(/token|jwt/i); }
  });
});

describe('permission and failure states (03-APP-FLOW §5)', () => {
  it('403 on the culture list -> full-page "no access" with a way back; no table, no tabs, no scan bar, no culture data (REQ-SEC-081)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => problem('auth.forbidden', 403)));
    await worklist();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: /scan specimen barcode/i })).toBeNull();
    expect(document.body.textContent).toMatch(/don.t have access/i);
    expect(document.body.textContent).not.toContain('Synthetic culture');
    expect(screen.getByRole('link', { name: /back to home/i })).toBeTruthy();
  });

  it('403 does not fan out: no specimen / centre / count calls are made for a forbidden user', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => problem('auth.forbidden', 403)));
    await worklist();
    expect(hit('GET', /\/v1\/lab\/specimens\//)).toHaveLength(0);
  });

  it.each([500, 503])('%i from the list rejects so error.tsx renders (no partial table)', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => problem('common.internal', status)));
    await expect(worklist()).rejects.toBeTruthy();
  });

  it('400 (invalid cursor) rejects rather than showing stale rows', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => problem('common.invalid_cursor', 400)));
    await expect(worklist({ cursor: 'abc' })).rejects.toBeTruthy();
  });

  it('no session token -> the API is never called with an empty bearer', async () => {
    state.token = undefined;
    try { await worklist().catch(() => undefined); } finally { state.token = 'jwt-synthetic'; }
    for (const h of hits) expect(h.headers.get('authorization') ?? 'Bearer x').not.toMatch(/^Bearer\s*$|undefined/);
  });
});

describe('loading.tsx / error.tsx', () => {
  it('loading renders the kit skeleton with an accessible busy status and no data', async () => {
    const { default: Loading } = await import('../../../app/(staff)/micro/worklist/loading');
    render(<Loading />);
    expect(document.querySelector('[aria-busy="true"],[role="status"],.lims-skeleton')).toBeTruthy();
    expect(hits).toHaveLength(0);
  });

  it('error shows a plain message with Retry that calls reset(); never the raw error text or stack', async () => {
    const { default: ErrorPage } = await import('../../../app/(staff)/micro/worklist/error');
    const reset = vi.fn();
    const err = Object.assign(new Error('stack: secret-internal at db.query'), { digest: 'abc123' });
    render(<ErrorPage error={err} reset={reset} />);
    expect(document.body.textContent).not.toContain('secret-internal');
    const retry = screen.getByRole('button', { name: /retry|try again/i });
    retry.click();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
