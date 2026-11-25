// @vitest-environment jsdom
// T0D-BUILD-1 (LD-447, LD-358; founder order 2026-11-22 13:36 NPT) /billing/accounts/summary: the not-available state is replaced by a FilterBar (party kind select, name search,
// "Blocked only" and "Outstanding only" switches) and a DataTable (name, kind, credit limit, outstanding, blocked tag; money right aligned) with a totals line for the page, paging,
// empty and loading states, and a link from the party name to the existing party account screen (billing/accounts/ledger). Synthetic rows through msw; no provider is called.
// Fails now: the page has no kind select, no switches, no kind column, no totals line and no paging control. PINS the writer may dispute:
//  - the URL carries the filters: party_kind, q, blocked_only=true, outstanding_only=true, cursor (the names of the operation); a bad value of any of them is DROPPED before the call
//    (never forwarded to the API), q is trimmed and cut to 80, a cursor outside ^[A-Za-z0-9_-]{1,512}$ is dropped;
//  - paging = a "Next" control (link or button) shown only when page.next_cursor is present, carrying cursor=<next_cursor> and keeping the other filters;
//  - totals line: the word "Total" with the SUM of credit limit and of outstanding of the rows on the page (fixtures use one side only, so the sum is unambiguous), through the existing
//    formatter (components/format.formatAmount); the line is not drawn for an empty page;
//  - the party name links to /billing/accounts/ledger?party_kind=..&party_id=.. (the existing party account screen); blocked is a text tag, not colour only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { formatAmount } from '@/features/billing/components/format';
import { U, bodyRows, expectEmptyState, expectFilterBars, expectFilterLabels, expectHeader, expectMoneyColumn, expectTable, headerTexts, page, problem } from '@/__tests__/uilist2.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const P = '/billing/accounts/summary';
const LIST = '/v1/billing/account-summaries';
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.push, refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/billing/accounts/summary',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['billing.account.read'], displayName: 'Synthetic Accountant', membershipId: '01a1a98a-ac40-7000-8000-000000000090', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => P,
}));

const row = (o: Record<string, unknown>) => ({ party_kind: 'credit_party', party_id: U(1), party_name: 'Synthetic Party', credit_limit_paisa: 0, outstanding_paisa: 0, outstanding_side: 'debit', is_blocked: false, ...o });
const ROWS = [
  row({ party_id: U(11), party_name: 'Synthetic Himal Diagnostics', credit_limit_paisa: 10_000_000, outstanding_paisa: 123_456_789 }),
  row({ party_id: U(12), party_kind: 'franchise', party_name: 'Synthetic Franchise Beta', credit_limit_paisa: 0, outstanding_paisa: 50_000 }),
  row({ party_id: U(13), party_name: 'Synthetic Blocked Gamma', credit_limit_paisa: 2_500_000, outstanding_paisa: 750_000, is_blocked: true }),
];
const SUM_LIMIT = ROWS.reduce((s, r) => s + (r.credit_limit_paisa as number), 0);
const SUM_OUT = ROWS.reduce((s, r) => s + (r.outstanding_paisa as number), 0);

const calls: URL[] = [];
const api = setupServer();
beforeAll(() => { api.listen({ onUnhandledFrame: 'error' }); api.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname === LIST) calls.push(u); }); });
beforeEach(() => { calls.length = 0; nav.push.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
const serve = (h: () => Response) => api.use(http.get(`${ORIGIN}${LIST}`, h), http.all(`${ORIGIN}/v1/*`, () => page([])));
const body = (data: unknown[], next?: string) => () => HttpResponse.json({ data, page: { limit: 50, ...(next ? { next_cursor: next } : {}) } });
async function show(sp: Record<string, string | string[]> = {}) {
  const mod = await import(/* @vite-ignore */ '../../../app/(staff)/billing/accounts/summary/page.tsx');
  const tree = await (mod.default as unknown as (p: never) => Promise<never>)({ searchParams: Promise.resolve(sp), params: Promise.resolve({}) } as never)
    .catch((e: unknown) => { throw new Error(`the page threw instead of keeping its title: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}
const txt = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const cellsOf = (tr: Element) => [...tr.children].map(txt);
const nextControl = (root: ParentNode) => [...root.querySelectorAll('a, button')].find((e) => /^(next|next page)\b/i.test(txt(e)));

describe('filter bar (done_when 3)', () => {
  it('ONE FilterBar: party kind select, name search with a Search button, Blocked only and Outstanding only switches', async () => {
    serve(body(ROWS));
    const { container } = await show();
    await screen.findByText('Synthetic Himal Diagnostics');
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectFilterLabels(container, P, [/kind|type/i, /name|search/i, /blocked only/i, /outstanding only/i]);
    const bar = container.querySelector('.lims-filter-bar') as HTMLElement;
    expect(within(bar).getAllByRole('switch').map((s) => txt(s.closest('label') ?? s)).join('|')).toMatch(/blocked only.*outstanding only|outstanding only.*blocked only/i);
    expect(bar.querySelectorAll('input[type="search"], input[type="text"], .lims-filter-search input').length, 'one search box').toBe(1);
    expect([...bar.querySelectorAll('button')].map(txt).some((b) => /^search$/i.test(b)), 'a Search button').toBe(true);
    expect(container.textContent).not.toMatch(/not available yet/i);
  });

  it('the switches and the search box show the state of the URL', async () => {
    serve(body(ROWS));
    const { container } = await show({ blocked_only: 'true', outstanding_only: 'true', q: 'Himal' });
    await screen.findByText('Synthetic Himal Diagnostics');
    const bar = container.querySelector('.lims-filter-bar') as HTMLElement;
    expect((within(bar).getByRole('switch', { name: /blocked only/i }) as HTMLInputElement).checked).toBe(true);
    expect((within(bar).getByRole('switch', { name: /outstanding only/i }) as HTMLInputElement).checked).toBe(true);
    expect((bar.querySelector('.lims-filter-search input') as HTMLInputElement).value).toBe('Himal');
  });

  it('a switch is off when the URL does not say true', async () => {
    serve(body(ROWS));
    const { container } = await show({ blocked_only: 'false' });
    await screen.findByText('Synthetic Himal Diagnostics');
    const bar = container.querySelector('.lims-filter-bar') as HTMLElement;
    expect((within(bar).getByRole('switch', { name: /blocked only/i }) as HTMLInputElement).checked).toBe(false);
    expect((within(bar).getByRole('switch', { name: /outstanding only/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('turning Blocked only on and searching navigates to the same screen with blocked_only=true (the filters live in the URL, no cursor carried over)', async () => {
    serve(body(ROWS, 'NEXTCUR'));
    const user = userEvent.setup();
    const { container } = await show({ cursor: 'OLDCUR' });
    await screen.findByText('Synthetic Himal Diagnostics');
    const bar = container.querySelector('.lims-filter-bar') as HTMLElement;
    await user.click(within(bar).getByRole('switch', { name: /blocked only/i }));
    const search = [...bar.querySelectorAll('button')].find((b) => /^search$/i.test(txt(b)));
    if (search) await user.click(search);
    expect(nav.push, 'the screen navigated').toHaveBeenCalled();
    const url = String(nav.push.mock.calls.at(-1)![0]);
    expect(url).toContain('blocked_only=true');
    expect(url, 'a new filter starts at page one').not.toContain('OLDCUR');
  });
});

describe('request to listAccountSummaries (done_when 3)', () => {
  it('the URL filters reach the list operation under the contract names, q trimmed, a limit within 1..200', async () => {
    serve(body(ROWS));
    await show({ party_kind: 'franchise', q: '  Himal  ', blocked_only: 'true', outstanding_only: 'true', cursor: 'Q1_-x' });
    expect(calls, 'one list read, not one per party').toHaveLength(1);
    const sp = calls[0]!.searchParams;
    expect(Object.fromEntries(['party_kind', 'q', 'blocked_only', 'outstanding_only', 'cursor'].map((k) => [k, sp.get(k)]))).toEqual({ party_kind: 'franchise', q: 'Himal', blocked_only: 'true', outstanding_only: 'true', cursor: 'Q1_-x' });
    const limit = Number(sp.get('limit'));
    expect(Number.isInteger(limit) && limit >= 1 && limit <= 200, `limit ${sp.get('limit')}`).toBe(true);
  });

  it('no filter in the URL = none sent: no party_kind, no q, no switch, no cursor', async () => {
    serve(body(ROWS));
    await show();
    const sp = calls[0]!.searchParams;
    for (const k of ['party_kind', 'q', 'blocked_only', 'outstanding_only', 'cursor']) expect(sp.has(k), k).toBe(false);
  });

  it('bad URL values are dropped before the call (never forwarded), the page still renders its title and table', async () => {
    serve(body(ROWS));
    const { container } = await show({ party_kind: 'supplier', blocked_only: 'maybe', outstanding_only: '1; DROP', cursor: '<script>alert(1)</script>', q: 'x'.repeat(300) });
    await screen.findByText('Synthetic Himal Diagnostics');
    const sp = calls[0]!.searchParams;
    expect(sp.get('party_kind')).toBeNull();
    expect(sp.get('blocked_only')).toBeNull();
    expect(sp.get('outstanding_only')).toBeNull();
    expect(sp.get('cursor')).toBeNull();
    expect((sp.get('q') ?? '').length).toBeLessThanOrEqual(80);
    expectHeader(container, P);
  });

  it('a repeated URL parameter (array) is not forwarded as an array and never throws', async () => {
    serve(body(ROWS));
    const { container } = await show({ party_kind: ['credit_party', 'franchise'], q: ['a', 'b'], cursor: ['c1', 'c2'] });
    expectHeader(container, P);
    const sp = calls[0]!.searchParams;
    expect(sp.getAll('party_kind').length).toBeLessThanOrEqual(1);
    expect(sp.getAll('q').length).toBeLessThanOrEqual(1);
    expect(sp.getAll('cursor').length).toBeLessThanOrEqual(1);
  });

  it('the party kind of the URL is one of the four contract kinds, and each is accepted', async () => {
    for (const k of ['credit_party', 'franchise', 'user_pocket', 'laboratory']) {
      calls.length = 0; serve(body([]));
      const { unmount } = await show({ party_kind: k });
      expect(calls[0]!.searchParams.get('party_kind')).toBe(k);
      unmount();
    }
  });
});

describe('table, money, link, totals (done_when 3)', () => {
  it('DataTable columns: name, kind, credit limit (NPR), outstanding (NPR), blocked; one row per party, in the order the API sent', async () => {
    serve(body(ROWS));
    const { container } = await show();
    await screen.findByText('Synthetic Himal Diagnostics');
    expectTable(container, P, { min: 5, headers: [/name/i, /kind|type/i, /^Credit limit\b/i, /^Outstanding\b/i, /blocked/i] });
    expect(container.querySelectorAll('table').length, 'one table').toBe(1);
    const rows = bodyRows(container);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => txt(r)).map((t) => ROWS.findIndex((x) => t.includes(x.party_name as string)))).toEqual([0, 1, 2]);
    expect(headerTexts(container).every((h) => !/\n/.test(h))).toBe(true);
  });

  it('the kind column says the kind in words, never the raw code', async () => {
    serve(body(ROWS));
    const { container } = await show();
    await screen.findByText('Synthetic Himal Diagnostics');
    const kinds = bodyRows(container).map((r) => cellsOf(r).join(' | '));
    expect(kinds[0]).toMatch(/credit party|client/i);
    expect(kinds[1]).toMatch(/franchise/i);
    for (const k of kinds) expect(k).not.toMatch(/credit_party|user_pocket/);
  });

  it('money: Credit limit and Outstanding right aligned, "(NPR)" in the header, two decimals and separators from the existing formatter, no currency word in the cell', async () => {
    serve(body(ROWS));
    const { container } = await show();
    await screen.findByText('Synthetic Himal Diagnostics');
    expectMoneyColumn(container, P, /^Credit limit\b/i);
    expectMoneyColumn(container, P, /^Outstanding\b/i);
    const first = cellsOf(bodyRows(container)[0]!);
    expect(first, 'credit limit 10,000,000 paisa').toContain(formatAmount(10_000_000));
    expect(first, 'outstanding 123,456,789 paisa').toContain(formatAmount(123_456_789));
    expect(formatAmount(123_456_789)).toMatch(/^[\d,]+\.89$/);
  });

  it('the party name links to the existing party account screen with the party kind and id', async () => {
    serve(body(ROWS));
    const { container } = await show();
    const link = (await screen.findByRole('link', { name: 'Synthetic Franchise Beta' })) as HTMLAnchorElement;
    expect(container.contains(link)).toBe(true);
    const u = new URL(link.getAttribute('href')!, 'http://web.test');
    expect(u.pathname).toBe('/billing/accounts/ledger');
    expect(u.searchParams.get('party_kind')).toBe('franchise');
    expect(u.searchParams.get('party_id')).toBe(U(12));
    for (const r of ROWS) expect(screen.getByRole('link', { name: r.party_name as string }).getAttribute('href')).toContain(r.party_id as string);
  });

  it('a blocked party carries a text tag (not colour only) and an unblocked one does not', async () => {
    serve(body(ROWS));
    const { container } = await show();
    await screen.findByText('Synthetic Himal Diagnostics');
    const [ok, , blocked] = bodyRows(container);
    const blockedCell = (tr: Element) => cellsOf(tr).slice(-1)[0]!;
    expect(blockedCell(blocked!)).toMatch(/blocked|yes/i);
    expect(blockedCell(ok!)).not.toMatch(/blocked|yes/i);
  });

  it('totals line for the page: the word Total with the sum of credit limit and of outstanding, same formatter', async () => {
    serve(body(ROWS));
    const { container } = await show();
    await screen.findByText('Synthetic Himal Diagnostics');
    const text = txt(container);
    expect(text).toMatch(/\btotal\b/i);
    expect(text, `credit limit total ${SUM_LIMIT}`).toContain(formatAmount(SUM_LIMIT));
    expect(text, `outstanding total ${SUM_OUT}`).toContain(formatAmount(SUM_OUT));
    const line = [...container.querySelectorAll('tfoot, p, div, section, li, span, tr')].filter((e) => /\btotal\b/i.test(txt(e)) && txt(e).includes(formatAmount(SUM_OUT)));
    expect(line.length, 'one element holds the Total label and the outstanding sum').toBeGreaterThan(0);
  });
});

describe('paging, empty, loading, failures (done_when 3)', () => {
  it('next_cursor present: a Next control that carries cursor=<next_cursor> and keeps the filters', async () => {
    serve(body(ROWS, 'NEXT_cur-1'));
    const user = userEvent.setup();
    const { container } = await show({ party_kind: 'credit_party', q: 'Syn', outstanding_only: 'true' });
    await screen.findByText('Synthetic Himal Diagnostics');
    const next = nextControl(container);
    expect(next, 'a Next control').toBeDefined();
    let url: string;
    if (next!.tagName === 'A') url = next!.getAttribute('href')!;
    else { await user.click(next!); url = String(nav.push.mock.calls.at(-1)?.[0]); }
    const u = new URL(url, 'http://web.test');
    expect(u.pathname).toBe('/billing/accounts/summary');
    expect(u.searchParams.get('cursor')).toBe('NEXT_cur-1');
    expect(u.searchParams.get('party_kind')).toBe('credit_party');
    expect(u.searchParams.get('q')).toBe('Syn');
    expect(u.searchParams.get('outstanding_only')).toBe('true');
  });

  it('no next_cursor: no Next control; a page opened with a cursor can go back to the first page', async () => {
    serve(body(ROWS));
    const { container } = await show();
    await screen.findByText('Synthetic Himal Diagnostics');
    expect(nextControl(container), 'last page has no Next').toBeUndefined();
    cleanup(); serve(body(ROWS));
    const second = await show({ cursor: 'SECOND_page' });
    await screen.findByText('Synthetic Himal Diagnostics');
    const first = [...second.container.querySelectorAll('a, button')].find((e) => /first page|first|back to start|previous/i.test(txt(e)));
    expect(first, 'a way back to the first page when a cursor is set').toBeDefined();
  });

  it('empty page: header row, one EmptyState inside the table, no totals line, no Next, filters stay', async () => {
    serve(body([]));
    const { container } = await show({ q: 'nothing' });
    await screen.findByText(/no (clients|parties|accounts|summaries|franchises)|nothing/i).catch(() => undefined);
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectTable(container, P, { min: 5 });
    expectEmptyState(container, P);
    expect(bodyRows(container)).toHaveLength(0);
    expect(txt(container)).not.toMatch(/\btotal\b/i);
    expect(nextControl(container)).toBeUndefined();
  });

  it('API 500: title and filters stay, one ErrorState with a reference and Retry, no half table of rows', async () => {
    serve(() => problem(500, 'common.internal'));
    const { container } = await show();
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expect(container.querySelectorAll('.lims-state.lims-tone-danger').length).toBe(1);
    expect(bodyRows(container)).toHaveLength(0);
  });

  // 403 is left to the platform error boundary (existing convention, not pinned here); a stale cursor or a refused filter must not blank the screen.
  it.each([[400, 'common.validation_failed'], [400, 'common.invalid_cursor']] as const)('API %s %s: the page keeps its title, shows no rows, never throws to the error page', async (status, code) => {
    serve(() => problem(status, code));
    const { container } = await show({ cursor: 'STALE_cur' });
    expectHeader(container, P);
    expect(bodyRows(container)).toHaveLength(0);
    expect(txt(container)).not.toMatch(/Synthetic (Himal|Franchise|Blocked)/);
  });

  it('a loading state exists for this route (route loading.tsx of the screen or of billing) and renders without data', async () => {
    const dir = join(__dirname, '../../../app/(staff)/billing');
    const file = [join(dir, 'accounts/summary/loading.tsx'), join(dir, 'accounts/loading.tsx'), join(dir, 'loading.tsx')].find((f) => existsSync(f));
    expect(file, 'a loading.tsx on the route or above it').toBeDefined();
    const mod = await import(/* @vite-ignore */ file!);
    const { container } = render(mod.default());
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});

describe('UI rules and scope (UIX-1 table look, UIX-6 button roles, kit only, no new library)', () => {
  const comp = join(__dirname, '../components/accounts');
  const summaryFiles = readdirSync(comp).filter((f) => /summar/i.test(f)).map((f) => join(comp, f)).concat(join(__dirname, '../../../app/(staff)/billing/accounts/summary/page.tsx'));
  it('the summary screen sources use kit components: no raw table, button, select, input or textarea element, no ad hoc number formatting', () => {
    expect(summaryFiles.length).toBeGreaterThanOrEqual(2);
    for (const f of summaryFiles) {
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/<(table|button|select|input|textarea)[\s>]/);
      expect(src, f).not.toMatch(/toLocaleString|Intl\.NumberFormat|\.toFixed\(|parseFloat/);
    }
  });
  it('no new library: the web package keeps its dependency list', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../../package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@lims/ui', 'next', 'react', 'react-dom', 'server-only']);
  });
  it('the screen reads only the list operation and does not fall back to one getAccountSummary call per party', async () => {
    serve(body(ROWS));
    const seenPaths: string[] = [];
    api.events.on('request:start', ({ request }) => { seenPaths.push(new URL(request.url).pathname); });
    await show();
    await screen.findByText('Synthetic Himal Diagnostics');
    expect(seenPaths).toContain(LIST);
    expect(seenPaths).not.toContain('/v1/billing/account-summary');
  });
});
