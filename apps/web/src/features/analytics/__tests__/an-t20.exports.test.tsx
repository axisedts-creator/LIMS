// @vitest-environment jsdom
// AN-T20 — S5 My exports (04-UI-UX §7) + download BFF route; US-17.1/.4/.5/.6/.7/.8 (UI side), 07-SECURITY export rows (E1/E3, REQ-SEC-045/100).
// ASSUMED contract:
//   * exports/page.tsx = default async server component `Page({ searchParams })`; checks `analytics.data.export` (notFound() otherwise, no API call); reads
//     GET /v1/analytics/exports with only whitelisted params (`status` = comma-joined values of queued|building|ready|failed|expired, `cursor`, `limit`).
//   * table = kit DataTable (role=grid, name /export/i), columns Requested · Report · Period · Format · Status · Rows · Size · Downloads · Expires (+ an action column);
//     Status = StatusChip text Queued/Building/Ready/Failed/Expired; Downloads "1 of 3"; Rows grouped "1,234"; Size "2 KB" (2048 B).
//   * Download = a plain <a> (role=link, name /download/i) to the BFF route `/analytics/exports/<id>/file` (file `exports/[export_id]/file/route.ts`,
//     export `GET(req, { params: Promise<{ export_id }> })`), shown only when status=ready, not expired and downloads_used < downloads_allowed. No blob: URLs.
//   * polling: while any row is queued/building a client component calls `router.refresh()` (or re-reads the list) every 3 s, for at most 2 minutes, then shows a
//     manual "Refresh" button; no polling when every row is terminal; polling stops on unmount.
//   * the BFF route streams the API file with the session Bearer token, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, the upstream Content-Disposition
//     (attachment) and Content-Type; non-uuid id → 400 (no upstream call); no token → 401; upstream 404/403/409/410 → same status; anything else → 502.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import {
  CENTRE_A, TOKEN, api, axeClean, bodyOf, calls, callsTo, exportDto, exportId, gridNamed, headersOf, importPage, json, norm, pageText, problem, resetApi, router, routes, rowTexts, show, showOrThrown, state,
} from './an-t20.harness';

vi.mock('next/navigation', async () => (await import('./an-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t20.harness')).sessionMock);

const PAGE = 'exports/page';
const ROUTE = 'exports/[export_id]/file/route';
const LIST = '/v1/analytics/exports';
const PERMS = ['analytics.data.export'];
const FUTURE = '2099-01-01T00:00:00.000Z';
const list = (data: unknown[], page: Record<string, unknown> = { limit: 20 }) => json({ data, page });

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(PERMS); routes[`GET ${LIST}`] = list([exportDto(1, { expires_at: FUTURE })]); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const rowWith = (text: string) => within(gridNamed(/export/i)).getAllByRole('row').find((r) => norm(r.textContent).includes(text))!;
const download = (r: HTMLElement) => within(r).queryByRole('link', { name: /download/i });

describe('access (E1; US-17.1)', () => {
  it('without analytics.data.export: notFound() and NO API call', async () => {
    resetApi(['analytics.dashboard.read']);
    expect(await showOrThrown(PAGE)).toMatch(/NEXT_NOT_FOUND/);
    expect(calls).toHaveLength(0);
  });

  it('sends the session Bearer token to the list API and never puts it in the DOM; API 403 / 5xx reject (error.tsx)', async () => {
    const { container } = await show(PAGE);
    expect(callsTo('GET', LIST)[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(container.innerHTML).not.toContain(TOKEN);
    cleanup();
    routes[`GET ${LIST}`] = () => problem('auth.mfa_required', 403);
    expect(await showOrThrown(PAGE)).toBeTruthy();
    routes[`GET ${LIST}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE)).toBeTruthy();
  });

  it('forwards only whitelisted status values and cursor; drops everything else', async () => {
    await show(PAGE, { searchParams: { status: 'queued,ready', cursor: 'cur-1', evil: '1' } });
    const u = callsTo('GET', LIST)[0]!.url.searchParams;
    expect(u.get('status')).toBe('queued,ready');
    expect(u.get('cursor')).toBe('cur-1');
    expect(u.has('evil')).toBe(false);
    cleanup();
    calls.length = 0;
    await show(PAGE, { searchParams: { status: 'evil;drop,ready' } });
    const s = callsTo('GET', LIST)[0]!.url.searchParams.get('status');
    expect(s === null || s === 'ready').toBe(true);
  });
});

describe('table (§7)', () => {
  it('columns, status chip, rows/size/downloads/period formatting for a ready export', async () => {
    await show(PAGE);
    const g = gridNamed(/export/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Requested', 'Report', 'Period', 'Format', 'Status', 'Rows', 'Size', 'Downloads', 'Expires']));
    const t = rowTexts(g)[0]!;
    expect(t).toContain('Income');
    expect(t).toContain('2083-07');
    expect(t).toMatch(/xlsx|excel/i);
    expect(t).toContain('Ready');
    expect(t).toContain('1,234');
    expect(t).toMatch(/2(\.0)?\s?(KB|KiB)/i);
    expect(t).toContain('1 of 3');
  });

  it('Period for a date-range export shows the INCLUSIVE last day (stored business_date_to is exclusive, 01-PRD:246)', async () => {
    routes[`GET ${LIST}`] = list([exportDto(1, { expires_at: FUTURE, params: { business_date_from: '2026-01-01', business_date_to: '2026-02-01' } })]);
    await show(PAGE);
    const t = rowTexts(gridNamed(/export/i))[0]!;
    expect(t).toContain('2026-01-01');
    expect(t).toContain('2026-01-31');
    expect(t).not.toContain('2026-02-01');
  });

  it('status chips for queued/building/failed/expired show their text label (never colour alone)', async () => {
    routes[`GET ${LIST}`] = list([
      exportDto(1, { status: 'queued', ready_at: undefined, expires_at: undefined, row_count: undefined, size_bytes: undefined, downloads_used: 0 }),
      exportDto(2, { status: 'building', ready_at: undefined, expires_at: undefined, row_count: undefined, size_bytes: undefined, downloads_used: 0 }),
      exportDto(3, { status: 'failed', failure_code: 'analytics.export_too_large', downloads_used: 0 }),
      exportDto(4, { status: 'expired', expires_at: '2020-01-01T00:00:00.000Z' }),
    ]);
    await show(PAGE);
    const t = rowTexts(gridNamed(/export/i)).join(' | ');
    for (const s of ['Queued', 'Building', 'Failed', 'Expired']) expect(t).toContain(s);
  });

  it('Download is a plain <a> to the BFF route only for ready, unexpired exports with downloads left (no blob: URLs)', async () => {
    routes[`GET ${LIST}`] = list([
      exportDto(1, { expires_at: FUTURE }),
      exportDto(2, { status: 'queued', downloads_used: 0, expires_at: FUTURE }),
      exportDto(3, { status: 'failed', failure_code: 'common.internal', downloads_used: 0 }),
      exportDto(4, { status: 'expired', expires_at: '2020-01-01T00:00:00.000Z' }),
      exportDto(5, { downloads_used: 3, downloads_allowed: 3, expires_at: FUTURE }), // US-17.7: 3 downloads used
      exportDto(6, { status: 'ready', expires_at: '2020-01-01T00:00:00.000Z' }), // past its 24 h window
    ]);
    const { container } = await show(PAGE);
    const links = [...container.querySelectorAll('a')].filter((a) => /download/i.test(a.textContent ?? ''));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/analytics/exports/${exportId(1)}/file`]);
    expect(container.innerHTML).not.toMatch(/blob:|createObjectURL/);
    expect(download(rowWith('3 of 3'))).toBeNull();
  });

  it.each([
    ['analytics.export_too_large', 'Too much data — choose a shorter period or fewer centres.'],
    ['auth.forbidden', 'You no longer have access to this data.'],
    ['common.feature_disabled', 'This report is disabled for your lab.'],
  ])('failed export with %s shows "%s"', async (code, text) => {
    routes[`GET ${LIST}`] = list([exportDto(1, { status: 'failed', failure_code: code, downloads_used: 0 })]);
    await show(PAGE);
    expect(pageText()).toContain(text);
    expect(pageText()).not.toContain(code); // no raw error code in the UI
  });

  it('any other failure shows "Export failed. Reference: …"', async () => {
    routes[`GET ${LIST}`] = list([exportDto(1, { status: 'failed', failure_code: 'common.internal', downloads_used: 0 })]);
    await show(PAGE);
    expect(pageText()).toMatch(/Export failed\. Reference: \S+/);
  });

  it('empty list: an EmptyState, no crash; Status filter control present', async () => {
    routes[`GET ${LIST}`] = list([]);
    await show(PAGE);
    expect(screen.getByLabelText(/status/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
  });

  it('a next_cursor shows Next which navigates with that cursor', async () => {
    routes[`GET ${LIST}`] = list([exportDto(1, { expires_at: FUTURE })], { limit: 20, next_cursor: 'cur-2' });
    await show(PAGE);
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    const t = [...router.push.mock.calls, ...router.replace.mock.calls].at(-1)?.[0];
    expect(String(t)).toContain('cursor=cur-2');
  });

  it('a11y: no axe violations', async () => {
    await show(PAGE);
    await axeClean();
  });
});

describe('polling (§7: every 3 s while queued/building, max 2 min, then a manual Refresh button)', () => {
  const useClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const refreshes = () => router.refresh.mock.calls.length + Math.max(0, callsTo('GET', LIST).length - 1);
  const pending = () => { routes[`GET ${LIST}`] = list([exportDto(1, { status: 'queued', ready_at: undefined, expires_at: undefined, row_count: undefined, size_bytes: undefined, downloads_used: 0 })]); };

  it('re-reads about every 3 s while an export is queued', async () => {
    useClock(); pending();
    await show(PAGE);
    expect(refreshes()).toBe(0);
    await advance(3100);
    expect(refreshes()).toBeGreaterThanOrEqual(1);
    await advance(6000);
    expect(refreshes()).toBeGreaterThanOrEqual(3);
  });

  it('does not poll when every export is terminal', async () => {
    useClock();
    await show(PAGE);
    await advance(10_000);
    expect(refreshes()).toBe(0);
  });

  it('stops after 2 minutes and then offers a manual Refresh button that re-reads once', async () => {
    useClock(); pending();
    await show(PAGE);
    await advance(125_000);
    const at = refreshes();
    expect(at).toBeGreaterThan(5);
    await advance(30_000);
    expect(refreshes()).toBe(at);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: /refresh/i }));
    expect(refreshes()).toBe(at + 1);
  });

  it('stops polling on unmount', async () => {
    useClock(); pending();
    await show(PAGE);
    await advance(3100);
    cleanup();
    const at = refreshes();
    await advance(10_000);
    expect(refreshes()).toBe(at);
  });
});

describe('download BFF route (US-17.7/.8; 07-SECURITY E3, REQ-SEC-100)', () => {
  const FILE = new Uint8Array([0x50, 0x4b, 3, 4, 9, 8, 7]); // "PK.." xlsx magic + junk
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const get = async (id: string) => (await importPage(ROUTE)).GET!(new Request(`http://web.test/analytics/exports/${id}/file`), { params: Promise.resolve({ export_id: id }) });
  const up = (id: string) => `GET /v1/analytics/exports/${id}/file`;

  it('streams the file with the Bearer token, attachment disposition, no-store and nosniff', async () => {
    routes[up(exportId(1))] = () => new HttpResponse(FILE, { status: 200, headers: { 'content-type': XLSX, 'content-disposition': 'attachment; filename="income_2026-01-01_2026-01-15.xlsx"', 'cache-control': 'no-store' } });
    const res = await get(exportId(1));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FILE);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="income_2026-01-01_2026-01-15.xlsx"');
    expect(res.headers.get('content-type')).toBe(XLSX);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(callsTo('GET', `/v1/analytics/exports/${exportId(1)}/file`)[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('forces an attachment disposition when the upstream sends none', async () => {
    routes[up(exportId(1))] = () => new HttpResponse(FILE, { status: 200, headers: { 'content-type': XLSX } });
    expect((await get(exportId(1))).headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it.each(['../etc/passwd', 'not-a-uuid', '01a1a98a-ac40-7000-8000-00000000010g', ''])('rejects the malformed id %j with 400 and makes no upstream call', async (id) => {
    expect((await get(id)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('without a session token: 401 and no upstream call', async () => {
    state.token = undefined;
    expect((await get(exportId(1))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it.each([[404, 404], [403, 403], [409, 409], [410, 410], [500, 502], [503, 502]])('upstream %i -> %i, without leaking the upstream body or any file bytes', async (from, to) => {
    routes[up(exportId(1))] = () => problem(from === 410 ? 'analytics.export_unavailable' : 'common.internal', from, { detail: 'SECRET-DETAIL' });
    const res = await get(exportId(1));
    expect(res.status).toBe(to);
    expect(await res.text()).not.toContain('SECRET-DETAIL');
  });

  it('exports only GET (no state change over a plain link)', async () => {
    const m = await importPage(ROUTE);
    expect(Object.keys(m).filter((k) => /^(POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
  });
});

describe('E2E (component level): owner exports XLSX and downloads it (US-17.1/.7)', () => {
  it('Export dialog posts the xlsx request -> the export shows up Ready on My exports -> the Download link streams the file', async () => {
    const { ExportDialog } = (await import(/* @vite-ignore */ '../components/ExportDialog')) as { ExportDialog: any };
    const params = { bs_month: '2083-07', centre_id: [CENTRE_A], group_by: 'day' };
    routes['POST /v1/analytics/exports'] = () => HttpResponse.json(exportDto(7, { status: 'queued', downloads_used: 0, ready_at: undefined, expires_at: undefined, row_count: undefined, size_bytes: undefined }), { status: 202 });
    const onClose = vi.fn();
    render(
      <ToastProvider>
        <ExportDialog isOpen onClose={onClose} reportCode="income" params={params} summary={{ report: 'Income', periodAd: '18/10/2026 – 16/11/2026', periodBs: '2083-07-01 – 2083-07-30 B.S.', centres: ['Synthetic Centre A'], groupBy: 'Day' }} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /I will keep this file inside the lab/ }));
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await vi.waitFor(() => expect(callsTo('POST', '/v1/analytics/exports')).toHaveLength(1));
    const post = callsTo('POST', '/v1/analytics/exports')[0]!;
    expect(bodyOf(post)).toEqual({ report_code: 'income', format: 'xlsx', params });
    expect(post.headers.get('idempotency-key')).toBeTruthy();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    cleanup();

    // the worker finished: the list now reports it ready
    routes[`GET ${LIST}`] = list([exportDto(7, { expires_at: FUTURE, downloads_used: 0 })]);
    await show(PAGE);
    const link = download(rowWith('Ready'))!;
    expect(link.getAttribute('href')).toBe(`/analytics/exports/${exportId(7)}/file`);

    routes[`GET /v1/analytics/exports/${exportId(7)}/file`] = () => new HttpResponse(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="income_2083-07.xlsx"' } });
    const res = await (await importPage(ROUTE)).GET!(new Request(`http://web.test${link.getAttribute('href')}`), { params: Promise.resolve({ export_id: exportId(7) }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="income_2083-07\.xlsx"/);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x50, 0x4b, 3, 4]);
  });
});
