// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /frontdesk/settings through the REAL page + BFF + MSW (as adminpage-fd-1).
// Fails today because: two Cards and a loose Save (no kit SettingsForm, no tabs Discounts / Registration, no sticky bar, no dirty note); the saved message is an in-page Banner, not a toast;
// a 500 on GET throws to error.tsx (no ErrorState). The nine field names and the PUT contract stay (adminpage-fd-1 still applies).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectDirtyState, expectErrorState, expectNotAvailable, expectOneSavedToast, expectSettingsForm, menuLabel, norm } from '@/__tests__/uiset1.helpers';

const ORIGIN = 'http://api.test';
const S = `${ORIGIN}/v1/frontdesk/settings`;
const PATH = '/frontdesk/settings';
const session = { perms: ['frontdesk.settings.manage'] as string[] };
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/frontdesk/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [], membershipId: '01a1a98a-ac40-7000-8000-000000000090' } }),
  getRequestPathname: async () => '/frontdesk/settings',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const settings = (o: Record<string, unknown> = {}) => ({
  discount_self_limit_bp: 500, discount_self_limit_paisa: 250000, discount_absolute_max_bp: 9000, require_referrer: false,
  consent_text_version: 'v3', registration_sms_enabled: true, label_autoprint: false, buyer_pan_pattern: '^[0-9]{9}$', patient_search_min_chars: 3, version: 7, ...o,
});
const NAMES = ['discount_self_limit_bp', 'discount_self_limit_paisa', 'discount_absolute_max_bp', 'require_referrer', 'consent_text_version', 'registration_sms_enabled', 'label_autoprint', 'buyer_pan_pattern', 'patient_search_min_chars'];
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: 'about:blank', title: code, status, code, request_id: 'req-synthetic', ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });

const puts: unknown[] = [];
const api = setupServer(
  http.get(S, () => HttpResponse.json(settings())),
  http.put(S, async ({ request }) => { puts.push(await request.clone().json()); return HttpResponse.json(settings({ version: 8 })); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); puts.length = 0; refresh.mockReset(); session.perms = ['frontdesk.settings.manage']; });
afterAll(() => api.close());

async function mount() {
  const mod = await import('../../../app/(staff)/frontdesk/settings/page');
  let el: unknown;
  try { el = await mod.default({ searchParams: Promise.resolve({}) }); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}

describe('/frontdesk/settings', () => {
  it('kit SettingsForm: menu title, tabs Discounts and Registration, one Save in the sticky bar, nine field names kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, { path: PATH, tabs: ['Discounts', 'Registration'], names: NAMES });
  });

  it('dirty state: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
  });

  it('Save sends one PUT and shows ONE success toast, no in-page saved banner', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() => expect(document.querySelectorAll('.lims-toast').length).toBe(1));
    expectOneSavedToast(container, PATH);
  });

  it('step-up (403 auth.mfa_required) keeps the title and shows the warning, no form', async () => {
    api.use(http.get(S, () => problem(403, 'auth.mfa_required')));
    const { container } = await mount();
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(PATH)]);
    expect(container.querySelectorAll('.lims-settings-bar').length).toBe(0);
  });

  it('501 operation_pending: NotAvailable keeps the title', async () => {
    api.use(http.get(S, () => problem(501, 'operation_pending')));
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });

  it('500: ErrorState in the page, title kept, Reference and Retry (today: thrown to error.tsx)', async () => {
    api.use(http.get(S, () => problem(500, 'common.internal')));
    const { container } = await mount();
    expectErrorState(container, PATH);
  });
});
