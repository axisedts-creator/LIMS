// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /engagement/settings through the REAL page + BFF + MSW (as adminpage-eng-1).
// Fails today because: five Cards and a loose Save (no kit SettingsForm, no tabs Features / Patient app / Bookings / Reminders / Queue, no sticky bar, no dirty note);
// a 501 or 500 on GET throws to error.tsx (no NotAvailable / ErrorState). Field names stay (adminpage-eng-1 still applies).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectDirtyState, expectErrorState, expectNotAvailable, expectSettingsForm, menuLabel, norm } from '@/__tests__/uiset1.helpers';

const ORIGIN = 'http://api.test';
const S = `${ORIGIN}/v1/engagement/settings`;
const PATH = '/engagement/settings';
const CENTRE_ID = '01950c16-0000-7000-8000-000000000283';
const session = { perms: ['engagement.settings.manage'] as string[] };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/engagement/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [], membershipId: '01a1a98a-ac40-7000-8000-000000000090' } }),
  getRequestPathname: async () => '/engagement/settings',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const settings = () => ({
  app_enabled: true, bookings_enabled: true, home_collection_enabled: true, queue_enabled: true, reminders_enabled: true, memberships_enabled: true, enquiries_enabled: true,
  smart_report_in_app: false, show_partner_orders: false, auto_no_show: false, auto_follow_up_reminders: false, home_collection_centre_id: CENTRE_ID,
  allowed_phone_prefixes: ['+999'], otp_daily_cap: 2000, min_app_version_android: '1.0.0', min_app_version_ios: '1.0.0', app_gateways: ['esewa'], support_phone: '+15550100100',
  app_consent_text: 'Synthetic consent text.', app_consent_text_version: '2026-01', max_profiles_per_account: 8, max_accounts_per_patient: 3, link_code_ttl_hours: 72,
  dormant_after_days: 180, minor_age_years: 18, booking_horizon_days: 14, booking_min_lead_minutes: 120, booking_cancel_cutoff_minutes: 60, no_show_grace_minutes: 120,
  max_active_bookings_per_profile: 2, max_bookings_created_per_account_day: 3, max_orderables_per_booking: 20, booking_reminder_hours_before: 24, follow_up_reminder_lead_days: 3,
  queue_display_history_count: 5, smart_report_disclaimer_text: 'Synthetic disclaimer.', version: 3,
});
// every writable field of EngagementSettingsInput except the two with no single input (app_gateways is a checkbox group, home_collection_centre_id a Select)
const NAMES = Object.keys(settings()).filter((k) => !['version', 'app_gateways', 'home_collection_centre_id'].includes(k));
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: 'about:blank', title: code, status, code, request_id: 'req-synthetic', ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });

const api = setupServer(
  http.get(S, () => HttpResponse.json(settings())),
  http.get(`${ORIGIN}/v1/identity/centres`, () => HttpResponse.json({ data: [{ id: CENTRE_ID, name: 'Synthetic Centre One', is_active: true }], page: { limit: 50 } })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function mount() {
  const mod = await import('../../../app/(staff)/engagement/settings/page');
  let el: unknown;
  try { el = await mod.default({ searchParams: Promise.resolve({}) }); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}

describe('/engagement/settings', () => {
  it('kit SettingsForm: menu title, five section tabs, one Save in the sticky bar, every field name kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, { path: PATH, tabs: ['Features', 'Patient app', 'Bookings', 'Reminders', 'Queue'], names: NAMES });
  });

  it('dirty state: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await userEvent.click(await screen.findByRole('tab', { name: 'Patient app' }));
    await expectDirtyState(container, PATH);
  });

  it('step-up (403 auth.mfa_required): the title stays, a warning, no form', async () => {
    api.use(http.get(S, () => problem(403, 'auth.mfa_required')));
    const { container } = await mount();
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(PATH)]);
    expect(container.querySelectorAll('.lims-settings-bar').length).toBe(0);
  });

  it('501 operation_pending: NotAvailable keeps the title (today: thrown to error.tsx)', async () => {
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
