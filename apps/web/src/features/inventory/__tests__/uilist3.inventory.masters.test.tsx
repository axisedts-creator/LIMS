// @vitest-environment jsdom
// T0D-UILIST-3 (3) inventory items, suppliers, stores — LD-353 template 1 LIST (rules 5, 8). Each screen renders with no rows and with one row.
// Fails today because: suppliers and stores have no FilterBar; the name cells have no title attribute.
// Harness: t21.harness.tsx (MSW plays the inventory API; the page.tsx server components run for real).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, PERM_MANAGE, PERM_READ, api, itemSummary, page, resetHits, router, state, store, supplier } from './t21.harness';
import { expectListScreen, h1s, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';
import { expectCellTitled } from './uilist3.inventory.util';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

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
    name: 'items', path: '/inventory/items', load: () => import('../../../app/(staff)/inventory/items/page') as unknown as Promise<Page>,
    url: '/v1/inventory/items', row: itemSummary(1), rowText: 'GLU-R1', titled: 'Synthetic glucose reagent 1',
  },
  {
    name: 'suppliers', path: '/inventory/suppliers', load: () => import('../../../app/(staff)/inventory/suppliers/page') as unknown as Promise<Page>,
    url: '/v1/inventory/suppliers', row: supplier(1), rowText: 'SUP-01', titled: 'Synthetic supplier 1',
  },
  {
    name: 'stores', path: '/inventory/stores', load: () => import('../../../app/(staff)/inventory/stores/page') as unknown as Promise<Page>,
    url: '/v1/inventory/stores', row: store(1), rowText: 'BR1-ST1', titled: 'Synthetic store 1',
  },
] as const;

describe.each(screens)('inventory $name', (s) => {
  it('no rows: h1 = menu label, exactly one FilterBar, header row in the kit scroll box, no exclamation or dev copy', async () => {
    api.use(http.get(`${ORIGIN}${s.url}`, () => page([])));
    const { container } = await mount(s.load, s.path, PERM_MANAGE);
    expectListScreen(container, { path: s.path });
  });

  it('one row: same header and FilterBar, header row kept, the row is shown, the name cell has a title', async () => {
    api.use(http.get(`${ORIGIN}${s.url}`, () => page([s.row])));
    const { container } = await mount(s.load, s.path, PERM_MANAGE);
    expectListScreen(container, { path: s.path });
    expect(norm(container.textContent)).toContain(s.rowText);
    expectCellTitled(container, s.titled);
  });

  it('a reader without manage rights gets the same header and FilterBar', async () => {
    api.use(http.get(`${ORIGIN}${s.url}`, () => page([s.row])));
    const { container } = await mount(s.load, s.path, PERM_READ);
    expect(h1s(container)).toEqual([menuLabel(s.path)]);
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(1);
  });
});
