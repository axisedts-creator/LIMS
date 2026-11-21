// @vitest-environment jsdom
// T0D-UILIST-3 (3) inventory landing, alerts, settings — LD-353 template 1 LIST (rules 5, 6, 8). Each renders with no rows and with one row.
// Alerts is an error page today: a 501 operation_pending shows NotAvailable and any other API failure shows an ErrorState, both INSIDE the page with the title and the FilterBar.
// Judgement call: the landing carries the same one FilterBar (brief done_when 3 names it with the list screens); settings is a form: header only, no table, no FilterBar.
// Harness: t20.harness.tsx (MSW plays the inventory API; the page.tsx server components run for real).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, PERM_MANAGE, PERM_READ, alert, api, db, problem, resetDb, resetHits, router, state } from './t20.harness';
import { expectListScreen, expectStateInPage, h1s, menuLabel, norm } from '@/features/catalog/__tests__/uilist3.helpers';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); resetDb(); Object.values(router).forEach((f) => f.mockReset()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

type Page = { default: (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement> };
const mount = async (load: () => Promise<Page>, path: string, perms: string[]) => {
  state.permissions = perms; state.path = path;
  const mod = await load();
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve({}) })}</ToastProvider>);
};
const home = () => import('../../../app/(staff)/inventory/page') as unknown as Promise<Page>;
const alerts = () => import('../../../app/(staff)/inventory/alerts/page') as unknown as Promise<Page>;
const settings = () => import('../../../app/(staff)/inventory/settings/page') as unknown as Promise<Page>;

describe.each([
  { name: 'landing', path: '/inventory', load: home, headers: [] as string[] },
  { name: 'alerts', path: '/inventory/alerts', load: alerts, headers: ['Kind', 'Store', 'Item', 'Lot', 'First raised', 'Last raised', 'Occurrences', 'Status'] },
])('inventory $name', (s) => {
  it('no rows: h1 = menu label, exactly one FilterBar, header row in the kit scroll box, no exclamation or dev copy', async () => {
    db.alerts = [];
    const { container } = await mount(s.load, s.path, PERM_MANAGE);
    expectListScreen(container, { path: s.path, headers: s.headers });
  });

  it('one row: same header and FilterBar, header row kept, the alert is shown', async () => {
    db.alerts = [alert(1)];
    const { container } = await mount(s.load, s.path, PERM_MANAGE);
    expectListScreen(container, { path: s.path, headers: s.headers });
    expect(norm(container.textContent)).toMatch(/below reorder level/i);
  });

  it('a reader without manage rights gets the same header and FilterBar', async () => {
    db.alerts = [alert(1)];
    const { container } = await mount(s.load, s.path, PERM_READ);
    expect(h1s(container)).toEqual([menuLabel(s.path)]);
    expect(container.querySelectorAll('.lims-filter-bar')).toHaveLength(1);
  });
});

describe('inventory alerts — states stay inside the page (rule 6)', () => {
  it('501 operation_pending: NotAvailable with the title and the filters, not an error page', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/alerts`, () => problem('operation_pending', 501)));
    const { container } = await mount(alerts, '/inventory/alerts', PERM_MANAGE);
    expectStateInPage(container, { path: '/inventory/alerts', kind: 'notavailable' });
    expect(container.querySelectorAll('thead th, [role="columnheader"]').length, 'header row stays').toBeGreaterThan(0);
  });

  it('500 from the API: an ErrorState with the title, the filters, a reference and Retry (the page does not throw to error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/alerts`, () => problem('common.internal_error', 500)));
    const { container } = await mount(alerts, '/inventory/alerts', PERM_MANAGE);
    expectStateInPage(container, { path: '/inventory/alerts', kind: 'error' });
    expect(norm(container.textContent)).toMatch(/req-syn-0024|reference|request/i);
    expect([...container.querySelectorAll('button')].some((b) => /retry/i.test(b.textContent ?? '')), 'Retry button').toBe(true);
  });
});

describe('inventory settings', () => {
  it('h1 = menu label and the form shows (no table, no FilterBar, no exclamation or dev copy)', async () => {
    const { container } = await mount(settings, '/inventory/settings', PERM_MANAGE);
    expectListScreen(container, { path: '/inventory/settings', filterBar: 'optional', table: false });
    expect(container.querySelectorAll('input, [role="switch"], [role="checkbox"]').length).toBeGreaterThan(0);
  });

  it('501 operation_pending: NotAvailable keeps the title', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/settings`, () => problem('operation_pending', 501)));
    const { container } = await mount(settings, '/inventory/settings', PERM_MANAGE);
    expect(h1s(container)).toEqual([menuLabel('/inventory/settings')]);
    expect(norm(container.textContent)).toMatch(/not available yet/i);
  });
});
