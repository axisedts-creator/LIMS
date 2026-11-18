// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /partners/settings. Page with mocked read.server (t16 fixture). One section, so NO tabs.
// Fails today because: a bare kit Form with a Save settings button in the body (no .lims-settings, no sticky bar, no dirty note) and a radio group laid out by the page;
// 501 operation_pending throws (only the 500 stub is handled). NOTE: T0D-PARTYSET-1 (not done) may own partners screens: if the lead rules this file is theirs, drop this file.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ApiError } from '@/core/api/server-fetch';
import { expectDirtyState, expectNotAvailable, expectSettingsForm, menuLabel, norm } from '@/__tests__/uiset1.helpers';
import { settings } from './t16.fixtures';

const PATH = '/partners/settings';
const state = vi.hoisted(() => ({ fail: undefined as unknown, perms: ['partners.partner.read', 'partners.partner.manage'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/partners/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: state.perms } }), getRequestPathname: async () => PATH }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }) }));
vi.mock('@/features/partners/server/actions', stub);
vi.mock('@/features/partners/server/read.server', async () => {
  const f = await import('./t16.fixtures');
  return { getSettings: async () => { if (state.fail) throw state.fail; return { settings: f.settings(), etag: '"3"' }; } };
});
afterEach(() => { cleanup(); state.fail = undefined; state.perms = ['partners.partner.read', 'partners.partner.manage']; });
void settings;

const NAMES = ['default_conversion_mode', 'max_lines_per_manifest', 'draft_ttl_days', 'pickup_max_days_ahead', 'report_download_daily_cap_per_user', 'consent_text_version', 'consent_statement'];

async function mount() {
  const mod = await import('../../../app/(staff)/partners/settings/page');
  let el: unknown;
  try { el = await mod.default(); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}

describe('/partners/settings', () => {
  it('kit SettingsForm: menu title, no tabs (one section), one Save in the sticky bar, every field name and the three switches kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, { path: PATH, names: NAMES, labels: [/show standard-rate tests to partners/i, /require confirmed doctors/i, /patient access slips/i] });
  });

  it('dirty state: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
  });

  it('without partners.partner.manage: the title stays and there is no Save', async () => {
    state.perms = ['partners.partner.read'];
    const { container } = await mount();
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(PATH)]);
    expect(container.querySelectorAll('button[type="submit"]').length).toBe(0);
  });

  it('501 operation_pending: NotAvailable keeps the title (today: thrown)', async () => {
    state.fail = new ApiError(501, { type: 'x', title: 'operation_pending', status: 501, code: 'operation_pending' } as never);
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });

  it('500 common.internal (LD-301 stub): the title stays and the page says it is not available yet', async () => {
    state.fail = new ApiError(500, { type: 'x', title: 'common.internal', status: 500, code: 'common.internal' } as never);
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });
});
