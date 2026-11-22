// @vitest-environment jsdom
// ADMINPAGE-LAB-1 — /lab/critical-values list (C5 04-UI-UX 1 + 3.9, 03-APP-FLOW 3.9, route permission lab.critical_value.read, LD-255, LD-250).
// Tested through the real page (async server component) against a mocked API (msw):
//   page: apps/web/src/app/(staff)/lab/critical-values/page.tsx, default export async ({searchParams?}) => element; session perms from getShellSession().
//   Operation: GET /v1/lab/critical-values (lab.yaml listCriticalValues: status, detected_at_from/to, centre_id, cursor, limit <= 200) -> CriticalValueDto rows.
//   Spec columns (3.9): detected at, age since detected (live), reg no, patient, analyte, direction text, status (Open / Notified / Closed), notifications count. Open rows first.
//   CriticalValueDto carries NO reg no, patient or notification count: those three columns are a SPEC GAP (notes), the tests require only the columns the DTO can fill.
//   The result value is NOT a list column; it is shown on the detail (03 2.7: value shown, access_log), so the list must not print it.
//   Each row links to /lab/critical-values/{critical_event_id} (that detail page is not built yet: see notes).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';

const ORIGIN = 'http://api.test';
const READ = 'lab.critical_value.read';
const URL_CV = `${ORIGIN}/v1/lab/critical-values`;
const U = (n: number) => `0c1c1c1c-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-11-16T06:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const session = { perms: [] as string[] };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/critical-values',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Lab', tenantCode: 'syn', roles: [], membershipId: '01a1a98a-ac40-7000-8000-000000000090' } }),
  getRequestPathname: async () => '/lab/critical-values',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const ev = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(n), result_id: U(0x100 + n), order_id: U(0x200 + n), analyte_code: 'K', value: `9.${n}1`, unit_code: 'MMOL_L', flag: 'HH', direction: 'high', status: 'open',
  detected_at: ago(90), value_changed_after_detection: false, centre_id: U(0x300), ...o,
});
const ROWS = [
  ev(1, { analyte_code: 'GLUCOSEX', direction: 'low', flag: 'LL', status: 'closed', detected_at: ago(180), closed_at: ago(120), first_confirmed_notification_at: ago(150) }),
  ev(2, { analyte_code: 'KPLASMA', direction: 'high', status: 'open', detected_at: ago(90) }),
  ev(3, { analyte_code: 'SODIUMX', direction: 'low', flag: 'LL', status: 'notified', detected_at: ago(30), first_confirmed_notification_at: ago(20) }),
  ev(4, { analyte_code: 'CALCIUMX', direction: 'low', flag: 'LL', status: 'open', detected_at: ago(10) }),
];
const problem = (status: number, code: string) =>
  HttpResponse.json({ type: 'about:blank', title: code, status, code, request_id: 'req-synthetic' }, { status, headers: { 'content-type': 'application/problem+json' } });

type Call = { method: string; url: URL; headers: Headers };
const calls: Call[] = [];
const rec = (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers }); };
let rows: unknown[] = ROWS;
let nextCursor: string | undefined;
const handler = ({ request }: { request: Request }) => { rec(request); return HttpResponse.json({ data: rows, page: { limit: 50, ...(nextCursor ? { next_cursor: nextCursor } : {}) } }); };
const api = setupServer(http.get(URL_CV, handler));
beforeAll(() => api.listen({ onUnhandledFrame: 'error' })); // any other operation fails the test (no invented operation, no per-row detail calls)
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; session.perms = []; rows = ROWS; nextCursor = undefined; });
afterAll(() => api.close());

const SEG = 'critical-values'; // the page may not exist yet: resolved at run time so each test fails (page missing), not the collection
const pageModule = async () => (await import(/* @vite-ignore */ `../../../app/(staff)/lab/${SEG}/page`)) as { default: (p: any) => Promise<ReactNode> };
async function open(sp: Record<string, string> = {}, perms: string[] = [READ]) {
  session.perms = perms;
  const { default: Page } = await pageModule();
  render(await Page({ searchParams: Promise.resolve(sp) }));
  return userEvent.setup();
}
const listCalls = () => calls.filter((c) => c.url.pathname === '/v1/lab/critical-values');
const dataRows = () => screen.getAllByRole('row').filter((r) => within(r).queryAllByRole('columnheader').length === 0);
const rowOf = (analyte: string) => dataRows().find((r) => (r.textContent ?? '').includes(analyte))!;
const links = () => screen.queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('/lab/critical-values/'));

describe('permission gate (lab.critical_value.read)', () => {
  it.each([[[]], [['lab.worklist.read', 'lab.result.read', 'lab.critical_value.log_notification']]])('perms %j: the API is never called and no critical value is shown (notFound or the permission-denied page)', async (perms) => {
    session.perms = perms as string[];
    const { default: Page } = await pageModule();
    let out: ReactNode | undefined;
    try { out = await Page({ searchParams: Promise.resolve({}) }); } catch (e) { expect(String((e as Error).message)).toBe('NEXT_NOT_FOUND'); }
    if (out !== undefined) { render(out); expect(screen.queryByText('KPLASMA')).toBeNull(); expect(screen.queryAllByRole('grid')).toEqual([]); }
    expect(calls).toHaveLength(0);
  });

  it('the session holds the permission but the API answers 403: permission-denied state, no table, no crash', async () => {
    api.use(http.get(URL_CV, ({ request }) => { rec(request); return problem(403, 'auth.forbidden'); }));
    session.perms = [READ];
    const { default: Page } = await pageModule();
    let out: ReactNode | undefined;
    try { out = await Page({ searchParams: Promise.resolve({}) }); } catch (e) { expect(String((e as Error).message)).toBe('NEXT_NOT_FOUND'); }
    if (out !== undefined) { render(out); expect(screen.queryAllByRole('grid')).toEqual([]); }
  });
});

describe('list (listCriticalValues)', () => {
  it('reads the list once with the bearer token and limit <= 200, shows the title "Critical values" and the columns the DTO can fill', async () => {
    await open();
    expect(listCalls()).toHaveLength(1);
    const c = listCalls()[0]!;
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(Number(c.url.searchParams.get('limit') ?? '50')).toBeLessThanOrEqual(200);
    expect(screen.getByRole('heading', { level: 1, name: 'Critical values' })).toBeTruthy();
    const heads = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim());
    for (const re of [/detected at/i, /age since detected/i, /analyte/i, /direction/i, /status/i]) expect(heads.some((h) => re.test(h)), `column ${re}`).toBe(true);
  });

  it('each row shows analyte, direction as text ("Critical high" / "Critical low") and status as text (Open / Notified / Closed), not only a flag code or colour', async () => {
    await open();
    expect(dataRows()).toHaveLength(4);
    const k = within(rowOf('KPLASMA'));
    expect(k.getByText(/critical high/i)).toBeTruthy();
    expect(k.getByText(/^open$/i)).toBeTruthy();
    expect(within(rowOf('SODIUMX')).getByText(/critical low/i)).toBeTruthy();
    expect(within(rowOf('SODIUMX')).getByText(/^notified$/i)).toBeTruthy();
    expect(within(rowOf('GLUCOSEX')).getByText(/^closed$/i)).toBeTruthy();
  });

  it('open rows come first; the other rows keep the API order', async () => {
    await open();
    const order = dataRows().map((r) => ['KPLASMA', 'CALCIUMX', 'GLUCOSEX', 'SODIUMX'].find((a) => (r.textContent ?? '').includes(a)));
    expect(order).toEqual(['KPLASMA', 'CALCIUMX', 'GLUCOSEX', 'SODIUMX']);
  });

  it('every row links to /lab/critical-values/{critical_event_id} with the event id only (no value, no patient in the URL)', async () => {
    await open();
    const hrefs = links().map((a) => a.getAttribute('href'));
    for (const r of ROWS) expect(hrefs).toContain(`/lab/critical-values/${r.id}`);
    for (const h of hrefs) expect(h).toMatch(/^\/lab\/critical-values\/[0-9a-f-]{36}$/i);
    for (const row of dataRows()) expect(within(row).getAllByRole('link').length).toBeGreaterThan(0);
  });

  it('the result value is not printed in the list (it is shown on the detail, which logs the access)', async () => {
    await open();
    for (const r of ROWS) expect(document.body.textContent ?? '').not.toContain(String(r.value));
  });

  it('no per-row call: only listCriticalValues is requested (no getCriticalValue, no patient or order lookup)', async () => {
    await open();
    expect(calls.every((c) => c.method === 'GET' && c.url.pathname === '/v1/lab/critical-values')).toBe(true);
  });
});

describe('age since detected (live)', () => {
  it('shows hours and minutes since detection and moves forward by itself', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
    await open();
    const age = () => [...rowOf('KPLASMA').querySelectorAll<HTMLElement>('[role="gridcell"], [role="rowheader"]')].map((c) => c.textContent ?? '').join(' | ');
    expect(age()).toMatch(/\b0?1:30\b|1 ?h 30 ?m/); // 90 min, hh:mm as the TAT ages of 3.4 / 3.5
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(age()).toMatch(/\b0?1:31\b|1 ?h 31 ?m/);
  });
});

describe('filters and paging come from the URL and only valid values reach the API', () => {
  it('status=open and a cursor are passed on to the API (the spec names no filter control: gap in notes)', async () => {
    await open({ status: 'open', cursor: 'abc_DEF-123' });
    const q = listCalls()[0]!.url.searchParams;
    expect(q.get('status')).toBe('open');
    expect(q.get('cursor')).toBe('abc_DEF-123');
  });

  it('an unknown status or a malformed cursor in the URL is dropped, never sent to the API', async () => {
    await open({ status: 'x; drop', cursor: '../../etc/passwd' });
    const q = listCalls()[0]!.url.searchParams;
    expect(q.get('status')).toBeNull();
    expect(q.get('cursor')).toBeNull();
  });

  it('a next_cursor from the API becomes a "next page" link that carries only the opaque cursor', async () => {
    nextCursor = 'NEXT_cur-1';
    await open();
    const next = screen.getAllByRole('link').find((a) => /cursor=NEXT_cur-1/.test(a.getAttribute('href') ?? ''));
    expect(next, 'link with ?cursor=').toBeTruthy();
    expect(next!.getAttribute('href')).toMatch(/^\/lab\/critical-values\?/);
  });
});

describe('empty and failing states', () => {
  it('no critical value: the spec text "No critical values." and no table row', async () => {
    rows = [];
    await open();
    expect(screen.getByText('No critical values.')).toBeTruthy();
    expect(links()).toEqual([]);
  });

  it('API 500: the page throws so error.tsx renders (no raw error text on screen)', async () => {
    api.use(http.get(URL_CV, ({ request }) => { rec(request); return problem(500, 'common.internal'); }));
    session.perms = [READ];
    const { default: Page } = await pageModule();
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeTruthy();
  });

  it('API 400 (bad filter the page let through) is not shown as a table of nothing: the page throws to error.tsx', async () => {
    api.use(http.get(URL_CV, ({ request }) => { rec(request); return problem(400, 'common.validation_failed'); }));
    session.perms = [READ];
    const { default: Page } = await pageModule();
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeTruthy();
  });
});

describe('accessibility and keyboard', () => {
  it('axe finds no violations on the list and on the empty state (colour contrast comes from tokens and is checked elsewhere)', async () => {
    await open();
    const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes[0]?.html}`);
    expect(await run()).toEqual([]);
    cleanup();
    rows = [];
    await open();
    expect(await run()).toEqual([]);
  });

  it('the table has a caption or accessible name; Tab reaches the row links in list order', async () => {
    const user = await open();
    expect(screen.getByRole('grid', { name: /critical/i })).toBeTruthy();
    const ls = links();
    const seen: Element[] = [];
    // Ruling T0D-UIX-3 (04-UI-UX:35 DataTable keyboard row navigation): Tab enters the grid once, the arrow keys reach the link in each row (ArrowRight into the cell's link, ArrowDown to the next row).
    const grid = screen.getByRole('grid', { name: /critical/i });
    for (let i = 0; i < 10 && !grid.contains(document.activeElement); i++) await user.tab(); // the page header buttons come first
    expect(grid.contains(document.activeElement), 'Tab reaches the grid').toBe(true);
    for (let i = 0; i < 60 && seen.length < ls.length; i++) {
      if (ls.includes(document.activeElement as HTMLAnchorElement)) { if (!seen.includes(document.activeElement!)) seen.push(document.activeElement!); await user.keyboard('{ArrowDown}'); }
      else await user.keyboard('{ArrowRight}');
    }
    expect(seen).toEqual(ls);
  });
});
