// @vitest-environment jsdom
// T0D-UILIST-3 (3) inventory purchase orders and receipts (goods receipts) — LD-353 template 1 LIST (rules 5, 8). Each screen renders with no rows and with one row.
// Harness: t22.harness.tsx (MSW plays the inventory API; the page.tsx server components run for real).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, PERM_PO_MANAGE, PERM_READ, api, grnSummary, page, poSummary, resetHits, router, state } from './t22.harness';
import { expectListScreen, h1s, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

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
    name: 'purchase orders', path: '/inventory/purchase-orders', load: () => import('../../../app/(staff)/inventory/purchase-orders/page') as unknown as Promise<Page>,
    url: '/v1/inventory/purchase-orders', row: poSummary(1), rowText: 'PO-000001',
  },
  {
    name: 'receipts', path: '/inventory/receipts', load: () => import('../../../app/(staff)/inventory/receipts/page') as unknown as Promise<Page>,
    url: '/v1/inventory/goods-receipts', row: grnSummary(1), rowText: 'GRN-000001',
  },
] as const;

describe.each(screens)('inventory $name', (s) => {
  it('no rows: h1 = menu label, exactly one FilterBar, header row in the kit scroll box, no exclamation or dev copy', async () => {
    api.use(http.get(`${ORIGIN}${s.url}`, () => page([])));
    const { container } = await mount(s.load, s.path, PERM_PO_MANAGE);
    expectListScreen(container, { path: s.path });
  });

  it('one row: same header and FilterBar, header row kept, the row is shown', async () => {
    api.use(http.get(`${ORIGIN}${s.url}`, () => page([s.row])));
    const { container } = await mount(s.load, s.path, PERM_PO_MANAGE);
    expectListScreen(container, { path: s.path });
    expect(norm(container.textContent)).toContain(s.rowText);
  });

  it('a reader without manage rights gets the same header and FilterBar', async () => {
    api.use(http.get(`${ORIGIN}${s.url}`, () => page([s.row])));
    const { container } = await mount(s.load, s.path, PERM_READ);
    expect(h1s(container)).toEqual([menuLabel(s.path)]);
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(1);
  });
});
