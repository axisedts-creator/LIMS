// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /inventory/settings through the REAL page + BFF + MSW (harness of C12 T-20).
// Fails today because: four Cards and a loose Save instead of the kit SettingsForm with tabs (Consumption, Purchasing, Alerts and counts, Document numbers) and a sticky Save bar;
// no "Unsaved changes" dirty note; 500 on GET /settings throws to error.tsx instead of ErrorState in the page. Field names and values stay (the t20.settings tests still apply).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectDirtyState, expectErrorState, expectNotAvailable, expectOneSavedToast, expectSettingsForm, menuLabel, norm } from '@/__tests__/uiset1.helpers';
import { ORIGIN, PERM_MANAGE, PERM_READ, api, hits, problem, resetDb, resetHits, router, state } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

const PATH = '/inventory/settings';
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); resetDb(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = PATH; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function mount() {
  const mod = await import('../../../app/(staff)/inventory/settings/page');
  let el: unknown;
  try { el = await mod.default({ searchParams: Promise.resolve({}) } as never); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}

const NAMES = ['vat_in_cost', 'po_self_approval_allowed', 'grn_without_po_allowed', 'over_receipt_tolerance_bp', 'expiry_alert_days', 'count_locks_store', 'per_day_requires_activity',
  'reconciliation_gap_alert_bp', 'backdate_max_days', 'po_no_pattern', 'grn_no_pattern', 'transfer_no_pattern', 'count_no_pattern', 'doc_no_pattern'];

describe('/inventory/settings — manager', () => {
  it('kit SettingsForm: menu title, four section tabs, one Save in the sticky bar, every field name kept', async () => {
    const { container } = await mount();
    await screen.findByRole('tab', { name: 'Consumption' });
    await expectSettingsForm(container, { path: PATH, tabs: ['Consumption', 'Purchasing', 'Alerts and counts', 'Document numbers'], names: NAMES, labels: [/^default consumption store/i, /^automatic consumption/i] });
  });

  it('dirty state: the Save bar shows "Unsaved changes" after an edit, not before', async () => {
    const { container } = await mount();
    await screen.findByRole('tab', { name: 'Purchasing' });
    await userEvent.click(screen.getByRole('tab', { name: 'Alerts and counts' }));
    await expectDirtyState(container, PATH);
  });

  it('Save sends ONE PUT and shows ONE success toast; the dirty note clears', async () => {
    const { container } = await mount();
    await userEvent.click(await screen.findByRole('tab', { name: 'Alerts and counts' }));
    await expectDirtyState(container, PATH);
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hits.filter((h) => h.method === 'PUT')).toHaveLength(1));
    await waitFor(() => expect(document.querySelectorAll('.lims-toast').length).toBe(1));
    expectOneSavedToast(container, PATH);
  });
});

describe('/inventory/settings — read only and states', () => {
  it('without inventory.master.manage: the title stays, the values are listed, there is no Save', async () => {
    state.permissions = PERM_READ;
    const { container } = await mount();
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(PATH)]);
    expect(container.querySelectorAll('button[type="submit"]').length).toBe(0);
  });

  it('501 operation_pending: NotAvailable keeps the title', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/settings`, () => problem('operation_pending', 501)));
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });

  it('500: ErrorState in the page, title kept, Reference and Retry (today: thrown to error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/settings`, () => problem('common.internal', 500, { request_id: '01950c12-0000-7000-8000-000000000001' })));
    const { container } = await mount();
    expectErrorState(container, PATH);
  });
});
