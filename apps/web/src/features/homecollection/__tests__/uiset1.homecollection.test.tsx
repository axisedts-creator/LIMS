// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /homecollection/settings. Form rendered with the HC-T20 fixture; the page with a mocked read.server.
// Fails today because: five Cards and loose Save (no kit SettingsForm, tabs Sync & privacy / Visit checks / Payments / Handover / Routes & messages, sticky bar, dirty note);
// the page throws on 501 and 500 instead of NotAvailable / ErrorState. Field labels stay (hc-t20.settings still applies).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ApiError } from '@/core/api/server-fetch';
import { expectDirtyState, expectErrorState, expectNotAvailable, expectSettingsForm } from '@/__tests__/uiset1.helpers';
import { SETTINGS } from './hc-t20.helpers';

const PATH = '/homecollection/settings';
const read = vi.hoisted(() => ({ fail: undefined as unknown }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/homecollection/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: ['homecollection.settings.manage'] } }), getRequestPathname: async () => PATH }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }) }));
vi.mock('@/features/homecollection/server/actions', stub);
vi.mock('@/features/homecollection/server/read.server', () => ({ getSettings: async () => { if (read.fail) throw read.fail; return SETTINGS; } }));

afterEach(() => { cleanup(); read.fail = undefined; });

const LABELS = [/^sync interval/i, /^clear phone data after offline/i, /^gps kept for/i, /^minimum app version/i, /^consent text version/i, /^consent text$/i, /^confirmation at centre required/i,
  /^overdue after/i, /^max visits per route/i, /^clock tolerance/i, /^allow maps hand-off/i, /^allow typed barcodes/i];

async function mount() {
  const mod = await import('../../../app/(staff)/homecollection/settings/page');
  let el: unknown;
  try { el = await mod.default(); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}

describe('/homecollection/settings', () => {
  it('kit SettingsForm: menu title, five section tabs, one Save in the sticky bar, every field kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, { path: PATH, tabs: ['Sync & privacy', 'Visit checks', 'Payments', 'Handover', 'Routes & messages'], labels: LABELS });
  });

  it('dirty state: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
  });

  it('501 operation_pending: NotAvailable keeps the title (today: thrown)', async () => {
    read.fail = new ApiError(501, { type: 'x', title: 'operation_pending', status: 501, code: 'operation_pending' } as never);
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });

  it('500: ErrorState in the page, title kept, Reference and Retry (today: thrown)', async () => {
    read.fail = new ApiError(500, { type: 'x', title: 'common.internal', status: 500, code: 'common.internal', request_id: 'req-syn-0001' } as never);
    const { container } = await mount();
    expectErrorState(container, PATH);
  });
});
