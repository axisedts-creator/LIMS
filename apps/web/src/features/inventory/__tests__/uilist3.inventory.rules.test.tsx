// @vitest-environment jsdom
// T0D-UILIST-3 (3) inventory consumption rules — LD-353 template 1 LIST (rules 5, 8). Renders with no rows and with one row.
// Harness: t24.harness.tsx (MSW plays the inventory API; the page.tsx server component runs for real).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, PERM_MANAGE, PERM_READ, api, page, resetHits, router, rule, state } from './t24.harness';
import { expectListScreen, h1s, menuLabel } from '@/features/catalog/__tests__/uilist3.helpers';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.path = '/inventory/rules'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const PATH = '/inventory/rules';
const mount = async (perms: string[]) => {
  state.permissions = perms;
  const mod = await import('../../../app/(staff)/inventory/rules/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve({}) } as never)}</ToastProvider>);
};

describe('inventory consumption rules', () => {
  it('no rows: h1 = menu label, exactly one FilterBar, header row in the kit scroll box, no exclamation or dev copy', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-rules`, () => page([])));
    const { container } = await mount(PERM_MANAGE);
    expectListScreen(container, { path: PATH });
  });

  it('one row: same header and FilterBar, header row kept', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-rules`, () => page([rule(1)])));
    const { container } = await mount(PERM_MANAGE);
    expectListScreen(container, { path: PATH });
  });

  it('a reader without manage rights gets the same header and FilterBar', async () => {
    const { container } = await mount(PERM_READ);
    expect(h1s(container)).toEqual([menuLabel(PATH)]);
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(1);
  });
});
