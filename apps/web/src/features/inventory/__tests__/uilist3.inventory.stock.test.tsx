// @vitest-environment jsdom
// T0D-UILIST-3 (3) inventory stock, transfers, counts, bench — LD-353 template 1 LIST (rules 5, 6, 8). Each screen renders with no rows and with one row.
// Fails today because: transfers and counts have no FilterBar; stock cells carry no title attribute; bench shows the generic access-denied page (title "Access denied", not "Bench").
// Harness: t23.harness.tsx (MSW plays the inventory API; the page.tsx server components run for real).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, PERM_BENCH, PERM_MANAGE, PERM_READ, api, balance, countSummary, page, resetHits, router, state, transfer } from './t23.harness';
import { expectListScreen, h1s, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';
import { expectCellTitled } from './uilist3.inventory.util';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

type Page = { default: (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement> };
const mount = async (load: () => Promise<Page>, path: string, perms: string[]) => {
  state.permissions = perms; state.path = path;
  const mod = await load();
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve({}) })}</ToastProvider>);
};

const screens = [
  {
    name: 'stock', path: '/inventory/stock', load: () => import('../../../app/(staff)/inventory/stock/page') as unknown as Promise<Page>,
    headers: ['Item code', 'Item', 'Lot', 'Expiry', 'Lot status', 'Qty', 'Available'], rowText: 'SYNLOT-001', titled: 'Synthetic pipette tips 1',
    empty: () => api.use(http.get(`${ORIGIN}/v1/inventory/stock`, () => page([]))),
    one: () => api.use(http.get(`${ORIGIN}/v1/inventory/stock`, () => page([balance(1)]))),
  },
  {
    name: 'transfers', path: '/inventory/transfers', load: () => import('../../../app/(staff)/inventory/transfers/page') as unknown as Promise<Page>,
    headers: [], rowText: 'TRF-000001',
    empty: () => api.use(http.get(`${ORIGIN}/v1/inventory/transfers`, () => page([]))),
    one: () => api.use(http.get(`${ORIGIN}/v1/inventory/transfers`, () => page([transfer(1, { status: 'draft' })]))),
  },
  {
    name: 'counts', path: '/inventory/counts', load: () => import('../../../app/(staff)/inventory/counts/page') as unknown as Promise<Page>,
    headers: [], rowText: 'CNT-000001',
    empty: () => api.use(http.get(`${ORIGIN}/v1/inventory/stock-counts`, () => page([]))),
    one: () => api.use(http.get(`${ORIGIN}/v1/inventory/stock-counts`, () => page([countSummary(1)]))),
  },
] as const;

describe.each(screens)('inventory $name', (s) => {
  it('no rows: h1 = menu label, exactly one FilterBar, header row in the kit scroll box, no exclamation or dev copy', async () => {
    s.empty();
    const { container } = await mount(s.load, s.path, PERM_MANAGE);
    expectListScreen(container, { path: s.path, headers: [...s.headers] });
  });

  it('one row: same header and FilterBar, header row kept, the row is shown', async () => {
    s.one();
    const { container } = await mount(s.load, s.path, PERM_MANAGE);
    expectListScreen(container, { path: s.path, headers: [...s.headers] });
    expect(norm(container.textContent)).toContain(s.rowText);
  });

  it('a reader without manage rights gets the same header and FilterBar', async () => {
    s.one();
    const { container } = await mount(s.load, s.path, PERM_READ);
    expect(h1s(container)).toEqual([menuLabel(s.path)]);
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(1);
  });
});

describe('inventory stock — cut off cells', () => {
  it('the item name cell carries a title attribute with the full text', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/stock`, () => page([balance(1)])));
    const { container } = await mount(screens[0].load, '/inventory/stock', PERM_MANAGE);
    expectCellTitled(container, 'Synthetic pipette tips 1');
  });
});

describe('inventory bench — no access', () => {
  it('without inventory.bench.record the page keeps the menu title, says plainly there is no access, makes no API call and shows no form', async () => {
    const { container } = await mount(() => import('../../../app/(staff)/inventory/bench/page') as unknown as Promise<Page>, '/inventory/bench', PERM_READ);
    expect(h1s(container), 'title stays "Bench"').toEqual([menuLabel('/inventory/bench')]);
    expect(norm(container.textContent)).toMatch(/no access|not allowed|do not have (access|permission)|permission/i);
    expect(container.querySelector('form, button[type="submit"]')).toBeNull();
    expect(norm(container.textContent)).not.toMatch(/!/);
  });

  it('with the bench permission the page keeps one h1 = Bench and the open containers header row (also with no containers)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/containers`, () => page([])));
    const { container } = await mount(() => import('../../../app/(staff)/inventory/bench/page') as unknown as Promise<Page>, '/inventory/bench', PERM_BENCH);
    expect(h1s(container)).toEqual([menuLabel('/inventory/bench')]);
    expect(container.querySelectorAll('thead th, [role="columnheader"]').length).toBeGreaterThan(0);
  });
});
