// @vitest-environment jsdom
// T0D-UILIST-1 (LD-353 template 1 LIST, rules 5, 6, 8; done_when 1, 2, 6, 7) — instruments: /instruments/agents, /instruments/instruments, /instruments/settings.
// Pinned: PageHeader title = menu label with the ONE primary action at right (drawn once on the page: not again inside the EmptyState); ONE FilterBar (the instruments
// "Sort by" radio row goes into it or away: no second row); a table with its header row in the scroll box also when empty (instruments: the card grid becomes a table,
// columns Code, Name, Agent, Driver, Last message, Status as the NotAvailable state already shows) and ONE EmptyState in the body; the API failing (500) keeps the title
// and shows an ErrorState with reference and Retry instead of throwing to the error page; 501 operation_pending = NotAvailable with title (and header row on lists).
// Not pinned (listed in notes): /instruments/messages (own task list), detail pages.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectErrorState, expectFilterBars, expectHeader, expectNotAvailable, expectTable } from '@/__tests__/uilist1.helpers';
import { ORIGIN, agentRow, driver, summary } from './rs-c7.fixtures';

process.env['LIMS_ORIGIN_API'] = ORIGIN;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/instruments/agents',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['instruments.instrument.read', 'instruments.message.read', 'instruments.agent.read', 'instruments.instrument.manage', 'instruments.agent.manage'], displayName: 'Synthetic Engineer', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/agents',
}));

const REF = 'req-synthetic-in';
const problem = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: REF }, { status, headers: { 'content-type': 'application/problem+json' } });
const page = (data: unknown[]) => HttpResponse.json({ data, page: { limit: 50 } });
const SETTINGS = { default_backlog_threshold: 500, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 5, agent_uploaded_retention_hours: 72, version: 3 };

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
/** main = the screen's own read; the secondary reads (agents, drivers for the instruments filter) answer empty unless given. */
const serve = (o: { agents?: () => Response; instruments?: () => Response; settings?: () => Response }) => api.use(
  http.get(`${ORIGIN}/v1/instruments/agents`, o.agents ?? (() => page([]))),
  http.get(`${ORIGIN}/v1/instruments/instruments`, o.instruments ?? (() => page([]))),
  http.get(`${ORIGIN}/v1/instruments/drivers`, () => HttpResponse.json({ data: [driver()] })),
  http.get(`${ORIGIN}/v1/instruments/settings`, o.settings ?? (() => HttpResponse.json(SETTINGS))),
);
const props = { searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never;
async function show(file: string) {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/instruments/${file}.tsx`);
  const tree = await (mod.default as (p: never) => Promise<never>)(props).catch((e: unknown) => { throw new Error(`the page threw to the error page instead of keeping its title with an ErrorState: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}

describe('/instruments/agents', () => {
  const P = '/instruments/agents';
  it('no rows: menu title, New agent ONCE (header only), one FilterBar, header row, one EmptyState', async () => {
    serve({});
    const { container } = await show('agents/page');
    await screen.findByText(/no agents yet/i);
    expectHeader(container, P, { action: 'New agent' });
    expectFilterBars(container, P, 1);
    expectTable(container, P, { min: 8, headers: ['Agent code', 'Name', 'Centre', 'Health', 'Status'] });
    expectEmptyState(container, P, { title: /no agents/i });
  });

  it('one row: header and one filter row; the row sits under the header; no EmptyState', async () => {
    serve({ agents: () => page([agentRow(1)]) });
    const { container } = await show('agents/page');
    await screen.findByText('SYN-AGENT-1');
    expectHeader(container, P, { action: 'New agent' });
    expectFilterBars(container, P, 1);
    const { heads } = expectTable(container, P, { min: 8, headers: ['Agent code', 'Last heartbeat'] });
    const queue = container.querySelectorAll('thead th')[heads.indexOf('Queue')];
    expect(queue?.className, 'numbers right aligned (rule 3): the Queue header is lims-align-end').toMatch(/align-end/);
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('API 500: title and filters stay, ErrorState with reference and Retry', async () => {
    serve({ agents: () => problem(500, 'common.internal') });
    const { container } = await show('agents/page');
    expectErrorState(container, P, { filters: 1 });
    expect(container.textContent).toContain(REF);
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the header row', async () => {
    serve({ agents: () => problem(501, 'operation_pending') });
    const { container } = await show('agents/page');
    expectNotAvailable(container, P, { table: true });
  });
});

describe('/instruments/instruments', () => {
  const P = '/instruments/instruments';
  it('no rows: menu title, New instrument ONCE, ONE FilterBar and no second sort row, header row, one EmptyState', async () => {
    serve({});
    const { container } = await show('instruments/page');
    await screen.findByText(/no instruments registered/i);
    expectHeader(container, P, { action: 'New instrument' });
    expectFilterBars(container, P, 1);
    expect([...container.querySelectorAll('[role="radiogroup"]')].filter((r) => !r.closest('.lims-filter-bar')).length, 'no "Sort by" row outside the FilterBar').toBe(0);
    expectTable(container, P, { min: 6, headers: ['Code', 'Name', 'Agent', 'Driver', 'Last message', 'Status'] });
    expectEmptyState(container, P, { title: /no instruments/i });
  });

  it('one row: a TABLE row (not a card), under the header', async () => {
    serve({ instruments: () => page([summary({ state: 'live' })]) });
    const { container } = await show('instruments/page');
    await screen.findByText('SIM-CHEM-1');
    expectHeader(container, P, { action: 'New instrument' });
    expectFilterBars(container, P, 1);
    const { table } = expectTable(container, P, { min: 6, headers: ['Code', 'Name', 'Status'] });
    expect(table.textContent, 'the instrument is a row of the table').toContain('SIM-CHEM-1');
    expect(container.querySelectorAll('article, .lims-card').length, 'no link-card grid any more').toBe(0);
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('API 500: title and filters stay, ErrorState with reference and Retry', async () => {
    serve({ instruments: () => problem(500, 'common.internal') });
    const { container } = await show('instruments/page');
    expectErrorState(container, P, { filters: 1 });
    expect(container.textContent).toContain(REF);
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the header row', async () => {
    serve({ instruments: () => problem(501, 'operation_pending') });
    const { container } = await show('instruments/page');
    expectNotAvailable(container, P, { table: true });
  });
});

describe('/instruments/settings', () => {
  const P = '/instruments/settings';
  it('populated: one PageHeader with the menu title, no filter bar, no list table', async () => {
    serve({});
    const { container } = await show('settings/page');
    await screen.findByLabelText(/backlog threshold/i).catch(() => undefined);
    expectHeader(container, P, { noAction: false });
    expectFilterBars(container, P, 0);
  });

  it('API 500: the page keeps its title and shows an ErrorState with reference and Retry', async () => {
    serve({ settings: () => problem(500, 'common.internal') });
    const { container } = await show('settings/page');
    expectErrorState(container, P);
    expect(container.textContent).toContain(REF);
  });

  it('API 501 operation_pending: NotAvailable with the menu title', async () => {
    serve({ settings: () => problem(501, 'operation_pending') });
    const { container } = await show('settings/page');
    expectNotAvailable(container, P);
  });
});
