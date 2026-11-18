// @vitest-environment jsdom
// T0D-UILIST-1 (LD-353 template 1 LIST, rules 5 and 6; done_when 1, 2, 3, 7) — reporting worklist (/reporting) and outsourced queue (/reporting/outsourced).
// Pinned: PageHeader title = menu label; ONE FilterBar holds EVERYTHING that filters (reporting: registration search, centre, family, dates, review flag AND the
// status tabs: no second search row, no tab bar outside it); the table header row is always drawn inside .lims-table-scroll, also when empty, with ONE EmptyState in
// the body; the critical alerts read failing = a slim ErrorState banner UNDER the title with Retry (never the page-pushing red card above the title) and the worklist
// table still renders below it; the selection checkbox column is the only leading column (no empty first column next to it).
// Not pinned here (other tasks own them, listed in notes): reporting settings (T0D-PRINTCFG-1), messages (T0D-MSGDESK-1), report catalogue (T0D-MISREPORTS-1), detail pages.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectFilterBars, expectHeader, expectTable } from '@/__tests__/uilist1.helpers';
import { ADMIN, ORIGIN, alert, outsourced, page as pageOf, problem, summary } from './c6-t31.fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/reporting',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ADMIN, displayName: 'Synthetic Reporter', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/reporting',
}));
process.env['LIMS_ORIGIN_API'] = ORIGIN;

const R = `${ORIGIN}/v1/reporting`;
const CENTRES = { data: [{ id: '01a1a98a-ac40-7000-8000-000000000003', name: 'Synthetic Centre A1' }] };
const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const use = (o: { reports?: unknown[]; alerts?: unknown[] | 500; outsourced?: unknown[] }) => api.use(
  http.get(`${R}/reports`, () => HttpResponse.json(pageOf(o.reports ?? []))),
  http.get(`${R}/critical-alerts`, () => (o.alerts === 500 ? HttpResponse.json(problem(500, 'common.internal', { request_id: 'req-synthetic-1' }), { status: 500 }) : HttpResponse.json(pageOf(o.alerts ?? [])))),
  http.get(`${R}/outsourced-items`, () => HttpResponse.json(pageOf(o.outsourced ?? []))),
  http.get(`${ORIGIN}/v1/identity/centres`, () => HttpResponse.json(CENTRES)),
);
const props = { searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never;
const show = async (file: string) => {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/reporting/${file}.tsx`);
  return render(<ToastProvider>{await (mod.default as (p: never) => Promise<never>)(props)}</ToastProvider>);
};
const txt = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** ONE FilterBar holds the registration search, centre, family, dates, review flag and the status tabs; nothing of that sits outside it. */
function expectOneFilterRow(root: HTMLElement) {
  expectFilterBars(root, '/reporting', 1);
  const bar = root.querySelector('.lims-filter-bar') as HTMLElement;
  const search = screen.getByLabelText(/registration no/i);
  expect(bar.contains(search), 'the registration no. / barcode search is a field of the FilterBar, not a separate form row').toBe(true);
  for (const label of [/centre/i, /family/i, /registered/i, /review flag/i]) expect(txt(bar), `FilterBar holds ${String(label)}`).toMatch(label);
  expect(txt(bar), 'the status tabs live in the FilterBar').toMatch(/ready to release/i);
  expect(txt(bar)).toMatch(/awaiting content/i);
  const outside = [...root.querySelectorAll('[role="tablist"]')].filter((el) => !bar.contains(el));
  expect(outside.length, 'no tab bar outside the FilterBar (a third row)').toBe(0);
  expect(root.querySelectorAll('form').length, 'no separate search form row').toBe(0);
}

describe('/reporting worklist: one header, one filter row, table with header and EmptyState', () => {
  it('no rows: menu title, ONE FilterBar, table header row in the scroll box, one EmptyState in the body', async () => {
    use({ reports: [], alerts: [alert()] });
    const { container } = await show('page');
    await screen.findByText(/no reports are ready to release/i);
    expectHeader(container, '/reporting', { noAction: true });
    expectOneFilterRow(container);
    expectTable(container, '/reporting', { min: 6, headers: ['Reg no', 'Patient', 'Centre', 'Status'] });
    expectEmptyState(container, '/reporting', { title: /no reports/i });
  });

  it('one row: same header and one filter row; the row sits under the header; ONE leading selection column (checkbox merged with the empty first column)', async () => {
    use({ reports: [summary()], alerts: [] });
    const { container } = await show('page');
    await screen.findByText('R2611050001');
    expectHeader(container, '/reporting', { noAction: true });
    expectOneFilterRow(container);
    const { table } = expectTable(container, '/reporting', { min: 6, headers: ['Reg no', 'Patient', 'Status'] });
    const headCells = [...table.querySelectorAll('thead th')];
    const emptyHeads = headCells.filter((th) => txt(th) === '' && !th.querySelector('input[type="checkbox"]'));
    expect(emptyHeads.length, 'no empty-text first column header besides the select-all checkbox').toBe(0);
    const boxes = headCells.filter((th) => th.querySelector('input[type="checkbox"]'));
    expect(boxes.length, 'at most ONE select-all checkbox column').toBeLessThanOrEqual(1);
    if (boxes[0]) expect(headCells.indexOf(boxes[0]), 'the checkbox column is the first column').toBe(0);
    const row = table.querySelector('tbody tr.lims-row, tbody tr:not(.lims-row-empty)') as HTMLElement;
    expect([...row.children].length, 'header and body have the same number of columns').toBe(headCells.length);
    expect(container.querySelectorAll('.lims-state:not(.lims-tone-danger)').length, 'no EmptyState while rows exist').toBe(0);
  });

  it('critical alerts read fails: slim ErrorState banner under the title with Retry, worklist table still drawn below it', async () => {
    use({ reports: [summary()], alerts: 500 });
    const { container } = await show('page');
    await screen.findByText('R2611050001');
    expectHeader(container, '/reporting', { noAction: true });
    const banners = [...container.querySelectorAll('.lims-state.lims-tone-danger')];
    expect(banners.length, 'one ErrorState banner').toBe(1);
    const banner = banners[0]!;
    expect([...banner.querySelectorAll('button')].map(txt), 'Retry on the banner').toContain('Retry');
    expect(banner.closest('.lims-card'), 'a slim banner, not the red card box that pushes the worklist off screen').toBeNull();
    expect(banner.closest('[role="alert"]')?.querySelector('table, .lims-filter-bar'), 'the alert never wraps the worklist').toBeFalsy();
    const h1 = container.querySelector('h1')!;
    const { table } = expectTable(container, '/reporting', { min: 6, headers: ['Reg no', 'Patient'] });
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(h1.compareDocumentPosition(banner) & FOLLOWING, 'the banner comes UNDER the page title (today the card sits above it)').toBeTruthy();
    expect(banner.compareDocumentPosition(table) & FOLLOWING, 'the worklist table comes after the banner').toBeTruthy();
    expectOneFilterRow(container);
  });
});

describe('/reporting/outsourced: one header, one filter row, table with header and EmptyState', () => {
  it('no rows: menu title, ONE FilterBar, header row, one EmptyState', async () => {
    use({ outsourced: [] });
    const { container } = await show('outsourced/page');
    await screen.findByText(/no outsourced reports to show|no outsourced/i);
    expectHeader(container, '/reporting/outsourced', { noAction: true });
    expectFilterBars(container, '/reporting/outsourced', 1);
    expectTable(container, '/reporting/outsourced', { min: 5, headers: ['Reg no', 'Test', 'External lab', 'File state'] });
    expectEmptyState(container, '/reporting/outsourced', { title: /no outsourced/i });
  });

  it('one row: same markup; the row is under the header; no EmptyState', async () => {
    use({ outsourced: [outsourced()] });
    const { container } = await show('outsourced/page');
    await screen.findByText('Synthetic send-out test');
    expectHeader(container, '/reporting/outsourced', { noAction: true });
    expectFilterBars(container, '/reporting/outsourced', 1);
    expectTable(container, '/reporting/outsourced', { min: 5, headers: ['Reg no', 'External lab'] });
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });
});
