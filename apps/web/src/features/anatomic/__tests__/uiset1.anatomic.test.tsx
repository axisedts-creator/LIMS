// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /anatomic/config "Pathology setup" through the REAL page + BFF + MSW (harness of C11 T-23).
// Pinned: the seven tabs (Settings, Stains, Test profiles, Assays, Coded lists, Synoptic templates, Text templates) sit in the SettingsForm tabs slot on EVERY tab;
// the Settings tab is the form (one Save in the sticky bar; "Max images per case" no longer spans the page: kit form width). Master-list tabs keep their lists and drawers.
// Fails today because: the Tabs are drawn by ConfigScreen itself (no .lims-settings), the Settings form is a bare Form with a loose Save, no dirty note; 500 / 501 on GET throw to error.tsx.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectDirtyState, expectErrorState, expectNotAvailable, expectSettingsForm, menuLabel, norm, tabNames } from '@/__tests__/uiset1.helpers';
import { ORIGIN, PERM_CONFIG, api, problem, resetHits, router, state, t23Defaults } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

const PATH = '/anatomic/config';
const TABS = ['Settings', 'Stains', 'Test profiles', 'Assays', 'Coded lists', 'Synoptic templates', 'Text templates'];
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); state.permissions = PERM_CONFIG; api.use(...t23Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function mount(sp: Record<string, string> = {}) {
  const mod = await import('../../../app/(staff)/anatomic/config/page');
  let el: unknown;
  try { el = await mod.default({ searchParams: Promise.resolve(sp) } as never); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}

describe('/anatomic/config', () => {
  it('Settings tab: kit SettingsForm, seven tabs in its slot, one Save in the sticky bar, the five setting fields kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, { path: PATH, tabs: TABS, unionTabs: false, names: ['auto_accession_on_receipt', 'require_gross_complete_for_processing', 'default_routine_stain_code', 'max_images_per_case', 'max_report_images'] });
  });

  it('dirty state on Settings: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
  });

  it.each([['stains', 'Stains'], ['text-templates', 'Text templates']])('?tab=%s keeps the title and the same seven tabs in the slot, the selected one is "%s"', async (id, label) => {
    const { container } = await mount({ tab: id });
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(PATH)]);
    expect(tabNames(container)).toEqual(TABS);
    expect(screen.getByRole('tab', { name: label }).getAttribute('aria-selected')).toBe('true');
  });

  it('without anatomic.config.manage: no-access state, no tabs, no Save', async () => {
    state.permissions = ['anatomic.case.read'];
    const { container } = await mount();
    expect(container.querySelectorAll('[role="tab"], button[type="submit"]').length).toBe(0);
  });

  it('501 operation_pending: NotAvailable keeps the title (today: thrown to error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/settings`, () => problem('operation_pending', 501)));
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });

  it('500: ErrorState in the page, title kept, Reference and Retry (today: thrown to error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/settings`, () => problem('common.internal', 500, { request_id: '01950c12-0000-7000-8000-000000000001' })));
    const { container } = await mount();
    expectErrorState(container, PATH);
  });
});
