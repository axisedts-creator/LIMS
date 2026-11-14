// @vitest-environment jsdom
// RS-C8 — visual regression snapshots + axe of the key MIS screens (10-DESIGN-SYSTEM s7.4 "RS tasks record snapshots of their key screens"; s8 axe; LD-170).
// Screens: dashboard (populated, role without money), report hub, Income report, Pending tests report. Schedules/exports are in rs-c8.screens.admin.test.tsx.
// These snapshots are a REGRESSION BASELINE, not proof the look is right (design review does that). The WRITER records them once, LAST, after the other rs-c8 tests pass:
//   pnpm --dir apps/web exec vitest run --config src/features/analytics/__tests__/vitest.rs-c8.config.ts --pool=threads -u rs-c8.screens
// into __snapshots__/rs-c8.screens.test.tsx.snap and rs-c8.screens.admin.test.tsx.snap (LD-170 lets the writer/debugger keep those files). With CI=true a missing snapshot
// FAILS, which is the state today. Do not edit a test or the implementation just to make a snapshot match. DOM is serialised (not pixels): react-aria generated ids are normalised.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { api, axeClean, bodies, bySlug, resetApi, session, show } from './an-t19.harness';

vi.mock('next/navigation', async () => (await import('./an-t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t19.harness')).sessionMock);

const norm = (html: string) =>
  html
    .replace(/react-aria\d*-:?[\w-]+:?/g, 'aria-id')
    .replace(/:r[0-9a-z]+:/g, ':rN:')
    .replace(/(id|for|aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-activedescendant)="[^"]*(?:aria-id|:rN:)[^"]*"/g, '$1="ID"')
    .replace(/></g, '>\n<');
const snap = (el: Element) => expect(norm(el.innerHTML)).toMatchSnapshot();

const t = (value: number, unit = 'count', extra: Record<string, unknown> = {}) => ({ value, unit, ...extra });
const PERIOD = { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' };
const FRESH = [{ family: 'orders', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }, { family: 'income', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }];
const TILES = {
  patient_visits: t(12, 'count', { previous: 10, delta: 2, delta_bp: 2000 }), new_patients: t(4), net_orders: t(13), tests_ordered: t(31),
  net_sales_paisa: t(22500000, 'paisa', { previous: 20810000, delta: 1690000, delta_bp: 812 }), invoiced_paisa: t(23000000, 'paisa'), credit_notes_paisa: t(500000, 'paisa'), net_collected_paisa: t(19000000, 'paisa'),
  results_approved: t(28, 'count', { previous: 26, delta: 2, delta_bp: 769 }), reports_pending: t(5), reports_ready_unreleased: t(2), pending_tests: t(9), pending_overdue: t(1),
};
const dash = (tiles: Record<string, unknown>) => ({
  report_code: 'dashboard', period: PERIOD, scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] }, freshness: FRESH, generated_at: '2026-01-15T04:30:00.000Z', tiles,
  series: { days: [{ business_date: '2026-01-15', net_sales_paisa: 22500000, patient_visits: 12, net_orders: 13 }] },
  department_top: [{ department_id: '01a1a98a-ac40-7000-8000-000000000005', label: 'Synthetic Biochemistry', is_multiple: false, net_paisa: 900000, share_bp: 6294 }],
});
async function dashboard(tiles: Record<string, unknown>) {
  bodies['/v1/analytics/dashboard'] = dash(tiles);
  const mod = (await import('../../../app/(staff)/analytics/page')) as { default: (p: any) => Promise<any> };
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve({}) })}</ToastProvider>);
}

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(); session.permissions = ['analytics.dashboard.read', 'analytics.collections.read', 'billing.cash_report.read']; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('RS-C8 key-screen snapshots + axe', () => {
  it('Dashboard: populated (pipeline, needs you, money strip, charts)', async () => {
    const v = await dashboard(TILES);
    await axeClean();
    snap(v.container);
  });

  it('Dashboard: role without money tiles', async () => {
    const noMoney = Object.fromEntries(Object.entries(TILES).filter(([k]) => !k.endsWith('_paisa')));
    const v = await dashboard(noMoney);
    await axeClean();
    snap(v.container);
  });

  it('Report hub (tabs)', async () => {
    const v = await show('hub');
    await axeClean();
    snap(v.container);
  });

  it('Income report', async () => {
    const v = await show('income');
    await axeClean();
    snap(v.container);
  });

  it('Pending tests report', async () => {
    const v = await show('pending-tests');
    await axeClean();
    snap(v.container);
    expect(bySlug('pending-tests').slug).toBe('pending-tests');
  });
});
