// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /quality/settings through the REAL page + BFF + MSW (harness of C9 T-24).
// Fails today because: the Settings tab is three Cards with a Save each (kit SettingsForm wanted: tabs Settings / Coded sets in its tabs slot, ONE Save in the sticky bar, no Card boxes,
// dirty note); a 501 or 500 on GET throws to error.tsx (no NotAvailable / ErrorState). quality-t24.settings pins "each card has its own Save": the writer updates those assertions to the one Save.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { expectDirtyState, expectErrorState, expectNotAvailable, expectSettingsForm, menuLabel, norm } from '@/__tests__/uiset1.helpers';
import { PERM_CFG_READ, PERM_CFG_WRITE, SETTINGS, api, problem, resetApi, routes, show } from './quality-t24.harness';

vi.mock('next/navigation', async () => (await import('./quality-t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t24.harness')).sessionMock);

const PATH = '/quality/settings';
const PAGE = 'settings/page';
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi(PERM_CFG_WRITE));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function mount() {
  try { return await show(PAGE); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
}

const LABELS = [/warning at %/i, /escalate at %/i, /close orphan clocks after/i, /minimum points to establish a target/i, /re-process window days/i, /minimum simulation days/i, /minimum shadow decisions/i];

describe('/quality/settings', () => {
  it('kit SettingsForm: menu title, tabs Settings and Coded sets, ONE Save in the sticky bar, no Cards, every field kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, { path: PATH, tabs: ['Settings', 'Coded sets'], labels: LABELS, unionTabs: false });
  });

  it('dirty state: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
  });

  it('without quality.config.manage: the title stays and there is no Save button', async () => {
    resetApi(PERM_CFG_READ);
    const { container } = await mount();
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(PATH)]);
    expect(container.querySelectorAll('button[type="submit"]').length).toBe(0);
  });

  it('501 operation_pending: NotAvailable keeps the title', async () => {
    routes[`GET ${SETTINGS}`] = () => problem('operation_pending', 501);
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });

  it('500: ErrorState in the page, title kept, Reference and Retry (today: thrown to error.tsx)', async () => {
    routes[`GET ${SETTINGS}`] = () => problem('common.internal', 500, { request_id: '01950c12-0000-7000-8000-000000000001' });
    const { container } = await mount();
    expectErrorState(container, PATH);
  });
});
