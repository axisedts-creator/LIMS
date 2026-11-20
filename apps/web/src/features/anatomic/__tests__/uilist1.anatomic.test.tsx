// @vitest-environment jsdom
// T0D-UILIST-1 (LD-353 template 1 LIST, UI rules 5, 6, 8): anatomic pathology list screens. Each page renders twice (no rows, one row) through the REAL page + BFF + MSW.
// Pinned (done_when): (1) PageHeader title = menu label; batches: New batch ONCE on the page (header, not again in the EmptyState); (2) batches: ONE FilterBar (Status + Assay);
// (6) anatomic landing: a failed read renders ErrorState inside the page (h1 kept, Retry, Reference), 501 operation_pending renders NotAvailable (h1 kept): today both THROW to error.tsx;
// (7) table header row always (also empty), table inside `.lims-table-scroll`. Helpers: src/__tests__/uilist1.helpers.tsx. Reuses the C11 T-22 harness, synthetic data only.
// Skipped (other tasks / not template 1): case workspace, tracking, config (T0D-UISETTINGS-1), batch detail.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectErrorState, expectFilterBars, expectHeader, expectNotAvailable, expectTable } from '@/__tests__/uilist1.helpers';
import { ORIGIN, PERM_WORK, api, batch, page, problem, resetHits, state, summary, t22Defaults } from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); state.permissions = PERM_WORK; api.use(...t22Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

/** Mount a server page. A throw IS the founder's error page: report it as the design failure it is. */
async function mount(path: string, load: () => Promise<unknown>) {
  let el: unknown;
  try { el = await load(); } catch (e) { expect.fail(`${path}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}
const sp = (o: Record<string, string> = {}) => ({ searchParams: Promise.resolve(o) }) as never;

// ------------------------------------------------------------------------------------------------ anatomic batches
describe('/anatomic/batches', () => {
  const PATH = '/anatomic/batches';
  const open = () => mount(PATH, async () => (await import('../../../app/(staff)/anatomic/batches/page')).default(sp()));
  const batchHeads = ['Batch no', 'Assay', 'Status'];

  it('no rows: menu title, New batch exactly once (header), ONE FilterBar (Status + Assay), table header row, EmptyState without a second New batch', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => page([])));
    const { container } = await open();
    expectHeader(container, PATH, { action: 'New batch' });
    expectFilterBars(container, PATH, 1);
    const bar = container.querySelector('.lims-filter-bar')!;
    for (const label of ['Status', 'Assay']) expect(bar.textContent, `FilterBar holds "${label}"`).toContain(label);
    expectTable(container, PATH, { headers: batchHeads });
    expectEmptyState(container, PATH);
    expect(container.querySelector('.lims-state')!.querySelectorAll('button, a').length, 'the EmptyState repeats no New batch button').toBe(0);
  });

  it('one row: the batch is drawn under the same header row, no EmptyState, New batch still once', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => page([batch(1)])));
    const { container } = await open();
    expectHeader(container, PATH, { action: 'New batch' });
    expectFilterBars(container, PATH, 1);
    expectTable(container, PATH, { headers: batchHeads });
    expect(await screen.findByText('MB260001')).toBeTruthy();
    expect(container.querySelectorAll('.lims-state:not(.lims-tone-danger)').length).toBe(0);
  });

  it('501 operation_pending: NotAvailable keeps the title and the table header row', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => problem('operation_pending', 501)));
    const { container } = await open();
    expectNotAvailable(container, PATH, { table: true });
  });
});

// ------------------------------------------------------------------------------------------------ anatomic landing (worklist)
describe('/anatomic', () => {
  const PATH = '/anatomic';
  const open = () => mount(PATH, async () => (await import('../../../app/(staff)/anatomic/page')).default(sp()));

  it('no rows: menu title, table header row, EmptyState', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => page([])));
    const { container } = await open();
    expectHeader(container, PATH, { noAction: true });
    expectTable(container, PATH, { min: 3 });
    expectEmptyState(container, PATH);
  });

  it('one row: the case is drawn under the same header row, at most ONE FilterBar', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => page([summary(1)])));
    const { container } = await open();
    expectHeader(container, PATH, { noAction: true });
    expectFilterBars(container, PATH, 1);
    expectTable(container, PATH, { min: 3 });
    expect(await screen.findByText('SP26-000001')).toBeTruthy();
  });

  it('500 on the case list: ErrorState inside the page, title kept, Reference and Retry (today: thrown to error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => problem('common.internal', 500, { request_id: '01950c12-0000-7000-8000-000000000001' })));
    const { container } = await open();
    expectErrorState(container, PATH);
  });

  it('501 operation_pending on the case list: NotAvailable, title kept, table header row (today: thrown to error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => problem('operation_pending', 501)));
    const { container } = await open();
    expectNotAvailable(container, PATH, { table: true });
  });
});
