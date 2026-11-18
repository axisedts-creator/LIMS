// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /instruments/settings. Page with mocked read + session (web-t06 fixture).
// Fails today because: two Cards (Backlog and clock, Agent PC) and a loose Save: no kit SettingsForm, no tabs, no sticky bar, no dirty note. The six field names stay (web-t06 still applies).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ApiError } from '@/core/api/server-fetch';
import { expectDirtyState, expectErrorState, expectNotAvailable, expectSettingsForm } from '@/__tests__/uiset1.helpers';

const PATH = '/instruments/settings';
const state = vi.hoisted(() => ({ fail: undefined as unknown, perms: ['instruments.instrument.read', 'instruments.instrument.manage'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/instruments/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: state.perms } }), getRequestPathname: async () => PATH }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }) }));
vi.mock('@/features/instruments/server/actions', stub);
vi.mock('@/features/instruments/server/getInstrumentSettings.server', () => ({
  getInstrumentSettings: async () => {
    if (state.fail) throw state.fail;
    return { default_backlog_threshold: 500, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 120, agent_uploaded_retention_hours: 24, update_window_from: '01:00', update_window_to: '04:00', version: 1 };
  },
}));
afterEach(() => { cleanup(); state.fail = undefined; });

const NAMES = ['default_backlog_threshold', 'backlog_max_oldest_pending_seconds', 'clock_offset_warn_seconds', 'agent_uploaded_retention_hours', 'update_window_from', 'update_window_to'];

async function mount() {
  const mod = await import('../../../app/(staff)/instruments/settings/page');
  let el: unknown;
  try { el = await mod.default(); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}

describe('/instruments/settings', () => {
  it('kit SettingsForm: menu title, tabs Backlog and clock / Agent PC, one Save in the sticky bar, six field names kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, { path: PATH, tabs: ['Backlog and clock', 'Agent PC'], names: NAMES });
  });

  it('dirty state: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
  });

  it('without instruments.instrument.manage: values shown read only, no Save', async () => {
    state.perms = ['instruments.instrument.read'];
    const { container } = await mount();
    state.perms = ['instruments.instrument.read', 'instruments.instrument.manage'];
    expect(container.querySelectorAll('button[type="submit"]').length).toBe(0);
    expect(container.querySelectorAll('h1').length).toBe(1);
  });

  it('501 operation_pending: NotAvailable keeps the title', async () => {
    state.fail = new ApiError(501, { type: 'x', title: 'operation_pending', status: 501, code: 'operation_pending' } as never);
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });

  it('500: ErrorState in the page, title kept, Reference and Retry', async () => {
    state.fail = new ApiError(500, { type: 'x', title: 'common.internal', status: 500, code: 'common.internal', request_id: 'req-syn-0001' } as never);
    const { container } = await mount();
    expectErrorState(container, PATH);
  });
});
