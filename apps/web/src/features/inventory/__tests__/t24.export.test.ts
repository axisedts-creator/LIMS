// C12.T-24 — S17 CSV export BFF route (AC-21.8; TRD #93; 07-SECURITY PE-3, REQ-SEC-081/-096). The route proxies GET /v1/inventory/reports/{code}/export.csv with the session Bearer.
// Row cap (50,000), formula neutralisation (neutraliseFormula) and the access_log entry are API-side (C12 API tests); here: the BFF never leaks the token, never echoes upstream text, never lets the path be steered.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ORIGIN, api, hit, hits, resetHits, state } from './t24.harness';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); state.token = 'jwt-synthetic'; state.permissions = ['inventory.item.read', 'inventory.report.export']; });
afterEach(() => api.resetHandlers());
afterAll(() => api.close());

const CODES = ['daily_consumption', 'analyser_consumption', 'cost_per_test', 'wastage', 'expiry', 'stock_valuation', 'consumption_reconciliation'];
const GET = async (code: string, query = '?business_date_from=2026-10-01&business_date_to=2026-10-31') => {
  const mod = await import('../../../app/(staff)/inventory/reports/[report_code]/export/route');
  return mod.GET(new Request(`http://app.test/inventory/reports/${code}/export${query}`), { params: Promise.resolve({ report_code: code }) });
};
const csv = (body = 'business_date,item_code,qty\r\n2026-10-01,GLU-R1,12\r\n') => http.get(`${ORIGIN}/v1/inventory/reports/:code/export.csv`, () =>
  new HttpResponse(body, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="daily_consumption.csv"' } }));
const upstream = () => hit('GET', /\/export\.csv$/);

describe('export route: happy path', () => {
  it.each(CODES)('%s -> proxies GET /v1/inventory/reports/%s/export.csv with the same query and the session Bearer', async (code) => {
    api.use(csv());
    const res = await GET(code, '?business_date_from=2026-10-01&business_date_to=2026-10-31&store_id=S-1&instrument_id=I-1');
    expect(res.status).toBe(200);
    expect(upstream()).toHaveLength(1);
    const h = upstream()[0]!;
    expect(h.path).toBe(`/v1/inventory/reports/${code}/export.csv`);
    expect(new URLSearchParams(h.search).get('business_date_from')).toBe('2026-10-01');
    expect(new URLSearchParams(h.search).get('store_id')).toBe('S-1');
    expect(new URLSearchParams(h.search).get('instrument_id')).toBe('I-1');
    expect(h.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });
  it('response is text/csv, an attachment, no-store and nosniff; the body is the upstream CSV verbatim (the API already neutralised formulas)', async () => {
    api.use(csv("business_date,note\r\n2026-10-01,'=1+1\r\n"));
    const res = await GET('daily_consumption');
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment\b/i);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe("business_date,note\r\n2026-10-01,'=1+1\r\n");
  });
  it('the upstream disposition is only forwarded when it is an attachment; otherwise a safe default filename is used', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/:code/export.csv`, () => new HttpResponse('a\r\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'inline; filename="x.html"' } })));
    const res = await GET('wastage');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment\b/i);
  });
  it('the Bearer token never appears in a response header or body', async () => {
    api.use(csv());
    const res = await GET('wastage');
    expect([...res.headers.entries()].join('\n')).not.toContain('jwt-synthetic');
    expect(await res.text()).not.toContain('jwt-synthetic');
  });
});

describe('export route: abuse and failure', () => {
  it.each(['../../identity/me', 'daily_consumption/../../x', 'DAILY_CONSUMPTION', 'unknown_report', '', '%2e%2e', 'wastage%2Fexport.csv?x='])('report_code %j is refused with 400 and the API is NOT called', async (code) => {
    api.use(csv());
    const res = await GET(code);
    expect(res.status).toBe(400);
    expect(hits).toHaveLength(0);
  });
  it('no session token -> 401 and the API is not called', async () => {
    state.token = undefined;
    const res = await GET('wastage');
    expect(res.status).toBe(401);
    expect(hits).toHaveLength(0);
  });
  // Review item 4: a plain <a href> download must never land the user on a blank page. Any non-200 -> 303 to /inventory/reports?<same page query>&export_error=<code>,
  // <code> = the upstream problem `code` if it is a contract x-error-code for #93, else common.internal. Upstream text is never echoed.
  const where = (res: Response) => new URL(res.headers.get('location') ?? '', 'http://app.test');
  const fail = (status: number, body: unknown) => api.use(http.get(`${ORIGIN}/v1/inventory/reports/:code/export.csv`, () => HttpResponse.json(body as never, { status })));
  it.each([
    [403, 'auth.forbidden'], [403, 'auth.mfa_required'], [404, 'common.not_found'], [422, 'inventory.export_too_large'], [422, 'inventory.range_too_large'],
  ])('upstream %i %s -> 303 to /inventory/reports with export_error=<that code>; empty body; upstream text is not echoed', async (status, code) => {
    fail(status, { type: `urn:lims:error:${code}`, code, title: 'secret upstream title', detail: 'secret upstream detail', request_id: 'r' });
    const res = await GET('daily_consumption');
    expect(res.status).toBe(303);
    const u = where(res);
    expect(u.pathname).toBe('/inventory/reports');
    expect(u.searchParams.get('export_error')).toBe(code);
    expect(res.headers.get('location')).not.toMatch(/secret|jwt-synthetic/);
    expect(await res.text()).toBe('');
  });
  it('the redirect keeps the page query (tab + filters) so the banner appears on the same report', async () => {
    fail(422, { code: 'inventory.export_too_large', request_id: 'r' });
    const res = await GET('wastage', '?business_date_from=2026-10-01&business_date_to=2026-10-31&store_id=S-1');
    const u = where(res);
    expect(u.searchParams.get('report')).toBe('wastage');
    expect(u.searchParams.get('store')).toBe('S-1');
    expect(u.searchParams.get('export_error')).toBe('inventory.export_too_large');
  });
  it('an upstream code that is not a contract code for #93 (or is garbage/script) becomes common.internal', async () => {
    for (const code of ['inventory.made_up', '<script>alert(1)</script>', 'x'.repeat(500)]) {
      resetHits(); api.resetHandlers();
      fail(422, { code, detail: 'secret upstream detail', request_id: 'r' });
      const res = await GET('daily_consumption');
      expect(res.status, code).toBe(303);
      expect(where(res).searchParams.get('export_error'), code).toBe('common.internal');
    }
  });
  it.each([500, 502, 503, 429])('upstream %i -> 303 with export_error=common.internal (no stack trace echoed)', async (status) => {
    fail(status, { detail: 'stack trace' });
    const res = await GET('daily_consumption');
    expect(res.status).toBe(303);
    expect(where(res).searchParams.get('export_error')).toBe('common.internal');
    expect(res.headers.get('location')).not.toMatch(/stack/);
    expect(await res.text()).toBe('');
  });
  it('upstream 401 (session expired) -> 303 with export_error=<its code> or common.internal; never a blank 401 page', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/:code/export.csv`, () => new HttpResponse(null, { status: 401 })));
    const res = await GET('wastage');
    expect(res.status).toBe(303);
    expect(where(res).searchParams.get('export_error')).toBeTruthy();
  });
  it('network failure -> 303 with export_error=common.internal (no throw)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/:code/export.csv`, () => HttpResponse.error()));
    const res = await GET('wastage');
    expect(res.status).toBe(303);
    expect(where(res).searchParams.get('export_error')).toBe('common.internal');
  });
  it('an upstream redirect is never followed (no token forwarded to another host); the user gets the common.internal banner redirect', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/reports/:code/export.csv`, () => new HttpResponse(null, { status: 302, headers: { location: 'http://evil.test/steal' } })));
    const res = await GET('wastage');
    expect(res.status).toBe(303);
    expect(where(res).pathname).toBe('/inventory/reports');
    expect(where(res).host).toBe('app.test'); // our own origin, not evil.test
    expect(hits.some((h) => /evil\.test/.test(h.path))).toBe(false);
  });
  it('query parameters that are not report filters are not forwarded (no header/param smuggling)', async () => {
    api.use(csv());
    await GET('wastage', '?business_date_from=2026-10-01&business_date_to=2026-10-31&authorization=x&__proto__=1&token=abc');
    const p = new URLSearchParams(upstream()[0]!.search);
    expect(p.has('authorization')).toBe(false);
    expect(p.has('token')).toBe(false);
    expect(p.has('__proto__')).toBe(false);
  });
});
