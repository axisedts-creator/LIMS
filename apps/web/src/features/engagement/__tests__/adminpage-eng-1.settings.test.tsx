// @vitest-environment jsdom
// ADMINPAGE-ENG-1 — /engagement/settings (C16 04-UI-UX 1.3 nav row + W12 screen, T1 getEngagementSettings / T2 updateEngagementSettings, LD-255).
// Tested through the real page (async server component) + the real BFF/server-action chain against a mocked API (msw), as adminpage-fd-1 does:
//   page: apps/web/src/app/(staff)/engagement/settings/page.tsx, default export async ({searchParams?}) => element; session perms from getShellSession().
//   GET  /v1/engagement/settings -> EngagementSettings (36 writable fields + version)   [x-permission engagement.booking.read]
//   PUT  /v1/engagement/settings -> If-Match `"<version>"`, body = EngagementSettingsInput (additionalProperties:false => NO `version` key), returns the new EngagementSettings.
// The page is gated on engagement.settings.manage (routes.yaml). Saving needs aal2 (403 auth.mfa_required is a page/alert state). 422 engagement.setting_out_of_range is shown inline.
// Labels (case-insensitive, W12 wording; the tests are the spec of the wording, see notes): switches App, Bookings, Home collection, Queue, Reminders, Memberships, Enquiries,
// Smart summary in app, Show partner orders, Auto no-show, Auto follow-up reminders; text/number fields as in L below. One form, one "Save" button.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectErrorState, revealTab } from '@/__tests__/uiset1.helpers';

const ORIGIN = 'http://api.test';
const MANAGE = 'engagement.settings.manage';
const S = `${ORIGIN}/v1/engagement/settings`;
const CENTRES = `${ORIGIN}/v1/identity/centres`; // C2 listCentres: the only other operation the page may call (home-collection centre Select)
const CONFLICT_COPY = 'This record was changed by someone else. Reload to see the latest version.';
const CENTRE_ID = '01950c16-0000-7000-8000-000000000283';

const session = { perms: [] as string[] };
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
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

const settings = (o: Record<string, unknown> = {}) => ({
  app_enabled: true, bookings_enabled: true, home_collection_enabled: true, queue_enabled: true, reminders_enabled: true, memberships_enabled: true, enquiries_enabled: true,
  smart_report_in_app: false, show_partner_orders: false, auto_no_show: false, auto_follow_up_reminders: false, home_collection_centre_id: CENTRE_ID,
  allowed_phone_prefixes: ['+999'], otp_daily_cap: 2000, min_app_version_android: '1.0.0', min_app_version_ios: '1.0.0', app_gateways: ['esewa'], support_phone: '+15550100100',
  app_consent_text: 'Synthetic consent text.', app_consent_text_version: '2026-01', max_profiles_per_account: 8, max_accounts_per_patient: 3, link_code_ttl_hours: 72,
  dormant_after_days: 180, minor_age_years: 18, booking_horizon_days: 14, booking_min_lead_minutes: 120, booking_cancel_cutoff_minutes: 60, no_show_grace_minutes: 120,
  max_active_bookings_per_profile: 2, max_bookings_created_per_account_day: 3, max_orderables_per_booking: 20, booking_reminder_hours_before: 24, follow_up_reminder_lead_days: 3,
  queue_display_history_count: 5, smart_report_disclaimer_text: 'Synthetic disclaimer.', version: 3, ...o,
});
const REQUIRED = [
  'app_enabled', 'bookings_enabled', 'home_collection_enabled', 'queue_enabled', 'reminders_enabled', 'memberships_enabled', 'enquiries_enabled', 'smart_report_in_app', 'show_partner_orders',
  'auto_no_show', 'auto_follow_up_reminders', 'allowed_phone_prefixes', 'otp_daily_cap', 'min_app_version_android', 'min_app_version_ios', 'app_gateways', 'max_profiles_per_account',
  'max_accounts_per_patient', 'link_code_ttl_hours', 'dormant_after_days', 'minor_age_years', 'booking_horizon_days', 'booking_min_lead_minutes', 'booking_cancel_cutoff_minutes',
  'no_show_grace_minutes', 'max_active_bookings_per_profile', 'max_bookings_created_per_account_day', 'max_orderables_per_booking', 'booking_reminder_hours_before',
  'follow_up_reminder_lead_days', 'queue_display_history_count',
];
const OPTIONAL = ['home_collection_centre_id', 'support_phone', 'app_consent_text', 'app_consent_text_version', 'smart_report_disclaimer_text'];
// integer ranges of EngagementSettingsInput (contracts/openapi/engagement.yaml)
const RANGES: Record<string, [number, number]> = {
  otp_daily_cap: [100, 20000], max_profiles_per_account: [1, 10], max_accounts_per_patient: [1, 5], link_code_ttl_hours: [1, 168], dormant_after_days: [30, 730], minor_age_years: [14, 21],
  booking_horizon_days: [1, 60], booking_min_lead_minutes: [0, 2880], booking_cancel_cutoff_minutes: [0, 2880], no_show_grace_minutes: [15, 1440], max_active_bookings_per_profile: [1, 5],
  max_bookings_created_per_account_day: [1, 10], max_orderables_per_booking: [1, 50], booking_reminder_hours_before: [1, 72], follow_up_reminder_lead_days: [0, 30], queue_display_history_count: [1, 10],
};
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: 'about:blank', title: code, status, code, request_id: 'req-synthetic', ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });

type Call = { method: string; headers: Headers; body?: any };
const calls: Call[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const puts = () => calls.filter((c) => c.method === 'PUT');
const gets = () => calls.filter((c) => c.method === 'GET');
let current = settings();
const getHandler = async ({ request }: { request: Request }) => { await rec(request); return HttpResponse.json(current); };
const putOk = async ({ request }: { request: Request }) => {
  await rec(request);
  const b = await request.clone().json();
  current = { ...settings(), ...b, version: Number(/"?(\d+)"?/.exec(request.headers.get('if-match') ?? '')?.[1] ?? 0) + 1 };
  return HttpResponse.json(current);
};
const centresHandler = () => HttpResponse.json({ items: [{ id: CENTRE_ID, code: 'HC1', name: 'Synthetic Home Centre', kind: 'home_collection', is_active: true, version: 1 }], next_cursor: null });
const api = setupServer(http.get(S, getHandler), http.put(S, putOk), http.get(CENTRES, centresHandler));
beforeAll(() => api.listen({ onUnhandledFrame: 'error' })); // any other operation than T1/T2/listCentres fails the test
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); session.perms = []; current = settings(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const SEG = 'settings'; // the page may not exist yet: resolved at run time so the suite fails per test (page missing), not at collection
const pageModule = async () => (await import(/* @vite-ignore */ `../../../app/(staff)/engagement/${SEG}/page`)) as { default: (p: any) => Promise<ReactNode> };
async function open(perms: string[] = [MANAGE]) {
  session.perms = perms;
  const { default: Page } = await pageModule();
  wrap(await Page({ searchParams: Promise.resolve({}) }));
  return userEvent.setup();
}
const L = {
  app: /^app$/i, bookings: /^bookings$/i, homeCollection: /^home collection$/i, queue: /^queue$/i, reminders: /^reminders$/i, memberships: /^memberships$/i, enquiries: /^enquiries$/i,
  smartReport: /^smart summary in app$/i, partnerOrders: /^show partner orders$/i, autoNoShow: /^auto no-show$/i, autoFollowUp: /^auto follow-up reminders$/i,
  prefixes: /allowed phone prefixes/i, otp: /otp daily cap/i, android: /android/i, ios: /\bios\b/i, esewa: /esewa/i, khalti: /khalti/i, supportPhone: /support phone/i,
  consent: /^consent text$/i, consentVersion: /consent text version/i, profiles: /max(imum)? profiles per account/i, accounts: /max(imum)? accounts per patient/i, linkTtl: /link.?code ttl/i,
  dormant: /dormant/i, minorAge: /minor age/i, horizon: /booking horizon/i, lead: /booking (minimum )?lead/i, cancelCutoff: /cancel cutoff/i, grace: /no-show grace/i,
  activeBookings: /max(imum)? active bookings per profile/i, createdDay: /bookings created per account/i, orderables: /max(imum)? (tests|orderables) per booking/i,
  reminderHours: /booking reminder/i, followUpLead: /follow-up reminder lead|follow-up lead/i, history: /queue display history/i, disclaimer: /smart (report|summary) disclaimer/i,
};
const INT_LABEL: Record<string, RegExp> = {
  otp_daily_cap: L.otp, max_profiles_per_account: L.profiles, max_accounts_per_patient: L.accounts, link_code_ttl_hours: L.linkTtl, dormant_after_days: L.dormant, minor_age_years: L.minorAge,
  booking_horizon_days: L.horizon, booking_min_lead_minutes: L.lead, booking_cancel_cutoff_minutes: L.cancelCutoff, no_show_grace_minutes: L.grace, max_active_bookings_per_profile: L.activeBookings,
  max_bookings_created_per_account_day: L.createdDay, max_orderables_per_booking: L.orderables, booking_reminder_hours_before: L.reminderHours, follow_up_reminder_lead_days: L.followUpLead,
  queue_display_history_count: L.history,
};
const field = (re: RegExp) => screen.getByLabelText(re) as HTMLInputElement;
const isOn = (el: HTMLElement) => ((el as HTMLInputElement).checked ?? el.getAttribute('aria-checked') === 'true') === true;
const saveBtn = () => screen.getByRole('button', { name: /^save/i });
// LD-353 template 4: sections are tabs; the tab holding a field is opened before it is typed into or clicked.
const rev = async (re: RegExp) => { const el = field(re); await revealTab(el); return el; };
const setText = async (user: ReturnType<typeof userEvent.setup>, re: RegExp, v: string) => { const el = await rev(re); await user.clear(el); if (v) { await user.click(el); await user.paste(v); } };
const alertText = () => [...document.querySelectorAll('[role="alert"],[role="alertdialog"]')].map((e) => e.textContent ?? '').join(' | ');
const statusText = () => [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? '').join(' | ');
const describedText = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
const { version: _v0, ...BODY0 } = settings(); // the GET body without version = what an untouched save must send back

/** Problems of one PUT body against EngagementSettingsInput; [] = acceptable to the API. */
function bodyProblems(b: Record<string, any>): string[] {
  const bad: string[] = [];
  for (const k of REQUIRED) if (!(k in b)) bad.push(`missing ${k}`);
  for (const k of Object.keys(b)) if (![...REQUIRED, ...OPTIONAL].includes(k)) bad.push(`unknown key ${k} (additionalProperties:false)`);
  for (const [k, [lo, hi]] of Object.entries(RANGES)) if (!(Number.isInteger(b[k]) && b[k] >= lo && b[k] <= hi)) bad.push(`${k}=${b[k]} outside ${lo}..${hi}`);
  const p = b.allowed_phone_prefixes;
  if (!(Array.isArray(p) && p.length >= 1 && p.length <= 5 && p.every((x: unknown) => typeof x === 'string' && /^\+[1-9][0-9]{0,3}$/.test(x)))) bad.push(`allowed_phone_prefixes ${JSON.stringify(p)}`);
  for (const k of ['min_app_version_android', 'min_app_version_ios']) if (!(typeof b[k] === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$/.test(b[k]))) bad.push(`${k}=${b[k]}`);
  const g = b.app_gateways;
  if (!(Array.isArray(g) && g.length <= 2 && new Set(g).size === g.length && g.every((x: unknown) => x === 'esewa' || x === 'khalti'))) bad.push(`app_gateways ${JSON.stringify(g)}`);
  if (b.support_phone !== undefined && !(typeof b.support_phone === 'string' && b.support_phone.length <= 40)) bad.push('support_phone length');
  if (b.app_consent_text !== undefined && !(typeof b.app_consent_text === 'string' && b.app_consent_text.length <= 4000)) bad.push('app_consent_text length');
  if (b.app_consent_text_version !== undefined && !(typeof b.app_consent_text_version === 'string' && b.app_consent_text_version.length <= 32)) bad.push('app_consent_text_version length');
  if (b.smart_report_disclaimer_text !== undefined && !(typeof b.smart_report_disclaimer_text === 'string' && b.smart_report_disclaimer_text.length <= 1000)) bad.push('disclaimer length');
  for (const k of REQUIRED.filter((x) => /_enabled$|^smart_report_in_app$|^show_partner_orders$|^auto_/.test(x))) if (typeof b[k] !== 'boolean') bad.push(`${k} not boolean`);
  return bad;
}
const expectNoBadPut = () => { for (const p of puts()) expect(bodyProblems(p.body), JSON.stringify(p.body)).toEqual([]); };
const settle = () => new Promise((r) => setTimeout(r, 100));

describe('load (getEngagementSettings)', () => {
  it('reads T1 once with the bearer token and shows every spec field with its current value; no write happens', async () => {
    await open();
    expect(gets()).toHaveLength(1);
    expect(gets()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    for (const re of [L.app, L.bookings, L.homeCollection, L.queue, L.reminders, L.memberships, L.enquiries]) expect(isOn(field(re)), String(re)).toBe(true);
    for (const re of [L.smartReport, L.partnerOrders, L.autoNoShow, L.autoFollowUp]) expect(isOn(field(re)), String(re)).toBe(false);
    expect(field(L.prefixes).value).toContain('+999');
    expect(field(L.otp).value).toMatch(/^2,?000$/);
    expect(field(L.android).value).toBe('1.0.0');
    expect(field(L.ios).value).toBe('1.0.0');
    expect(isOn(field(L.esewa))).toBe(true);
    expect(isOn(field(L.khalti))).toBe(false);
    expect(field(L.supportPhone).value).toBe('+15550100100');
    expect(field(L.consent).value).toBe('Synthetic consent text.');
    expect(field(L.consentVersion).value).toBe('2026-01');
    expect(field(L.profiles).value).toBe('8');
    expect(field(L.minorAge).value).toBe('18');
    expect(field(L.history).value).toBe('5');
    expect(field(L.disclaimer).value).toBe('Synthetic disclaimer.');
    expect(saveBtn()).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });

  it('an untouched Save sends back exactly what was loaded (every field incl. the home-collection centre id and the optional texts), without `version`, with If-Match "3"', async () => {
    const user = await open();
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const p = puts()[0]!;
    expect(p.headers.get('if-match')).toBe('"3"');
    expect(p.body).toEqual(BODY0);
    expect(p.body).not.toHaveProperty('version');
    expect(bodyProblems(p.body)).toEqual([]);
  });

  it('settings the API returns without the optional fields (no centre, no texts) load and save without inventing values', async () => {
    const { home_collection_centre_id: _a, support_phone: _b, app_consent_text: _c, app_consent_text_version: _d, smart_report_disclaimer_text: _e, ...bare } = settings();
    current = bare as ReturnType<typeof settings>;
    const user = await open();
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const b = puts()[0]!.body;
    expect(bodyProblems(b)).toEqual([]);
    for (const k of ['home_collection_centre_id', 'app_consent_text']) expect(b[k] === undefined || b[k] === null || b[k] === '', `${k} invented: ${JSON.stringify(b[k])}`).toBe(true);
  });

  it('a 5xx on load is not hidden: the page renders ErrorState with the title, a reference and Retry (LD-353 rule 6; never a blank or default form)', async () => {
    session.perms = [MANAGE];
    api.use(http.get(S, () => problem(500, 'common.internal')));
    const { default: Page } = await pageModule();
    const { container } = wrap(await Page({ searchParams: Promise.resolve({}) }));
    expectErrorState(container, '/engagement/settings');
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    expect(screen.queryByLabelText(L.otp)).toBeNull();
  });
});

describe('W12 sections (C16 04-UI-UX line 261; reviewer item 2)', () => {
  it('shows the five tabs Features, Patient app, Bookings, Reminders, Queue in that order, each field inside its W12 section (tab panel)', async () => {
    await open();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Features', 'Patient app', 'Bookings', 'Reminders', 'Queue']); // exact: no invented titles such as "Booking limits"
    const panels = [...document.querySelectorAll<HTMLElement>('.lims-settings-section')];
    expect(panels).toHaveLength(5); // the i-th section is the i-th tab
    const [features, , bookings, reminders, queue] = panels.map((e) => within(e));
    expect(bookings!.getByLabelText(L.autoNoShow)).toBeTruthy();
    expect(bookings!.getByLabelText(/^home collection centre$/i)).toBeTruthy();
    expect(reminders!.getByLabelText(L.autoFollowUp)).toBeTruthy();
    expect(queue!.getByLabelText(L.history)).toBeTruthy();
    // and they are NOT left in the wrong section
    expect(features!.queryByLabelText(L.autoNoShow)).toBeNull();
    expect(features!.queryByLabelText(L.autoFollowUp)).toBeNull();
    expect(reminders!.queryByLabelText(L.history)).toBeNull();
    // opening a tab shows only its section
    await userEvent.click(screen.getByRole('tab', { name: 'Bookings' }));
    expect(panels.map((e) => e.hidden)).toEqual([true, true, false, true, true]);
  });
});

describe('save (updateEngagementSettings)', () => {
  it('edits switches, texts and numbers; PUTs ONCE with If-Match "3"; the body is the full input with the edits; role=status success and no alert', async () => {
    const user = await open();
    await user.click(await rev(L.queue)); // on -> off
    await user.click(await rev(L.autoNoShow)); // off -> on
    await user.click(await rev(L.khalti));
    await setText(user, L.prefixes, '+999, +977');
    await setText(user, L.otp, '3000');
    await setText(user, L.android, '2.1.7');
    await setText(user, L.supportPhone, '+15550100222');
    await setText(user, L.horizon, '30');
    await setText(user, L.history, '7');
    await setText(user, L.disclaimer, 'Synthetic disclaimer v2.');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const p = puts()[0]!;
    expect(p.headers.get('if-match')).toBe('"3"');
    expect(p.body).toEqual({
      ...BODY0, queue_enabled: false, auto_no_show: true, app_gateways: expect.arrayContaining(['esewa', 'khalti']), allowed_phone_prefixes: ['+999', '+977'], otp_daily_cap: 3000,
      min_app_version_android: '2.1.7', support_phone: '+15550100222', booking_horizon_days: 30, queue_display_history_count: 7, smart_report_disclaimer_text: 'Synthetic disclaimer v2.',
    });
    expect(p.body.app_gateways).toHaveLength(2);
    expect(bodyProblems(p.body)).toEqual([]);
    const key = p.headers.get('idempotency-key');
    if (key) expect(key).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    await waitFor(() => expect(statusText()).toMatch(/saved/i));
    expect(alertText()).toBe('');
  });

  it('a consent text change with a new version label is saved together (text and version both in the body)', async () => {
    const user = await open();
    await setText(user, L.consent, 'Synthetic consent text, second edition.');
    await setText(user, L.consentVersion, '2026-02');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toMatchObject({ app_consent_text: 'Synthetic consent text, second edition.', app_consent_text_version: '2026-02' });
  });

  it('the next save sends If-Match from the response of the previous one (3 -> 4), not the stale page version', async () => {
    const user = await open();
    await setText(user, L.otp, '2100');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    await waitFor(() => expect(statusText()).toMatch(/saved/i));
    await setText(user, L.otp, '2200');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts().map((c) => c.headers.get('if-match'))).toEqual(['"3"', '"4"']);
  });

  it('a double click while the request is in flight sends ONE PUT (no duplicate write)', async () => {
    let n = 0;
    api.use(http.put(S, async ({ request }) => { n++; await rec(request); await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(settings({ version: 4 })); }));
    const user = await open();
    await user.dblClick(saveBtn());
    await waitFor(() => expect(statusText()).toMatch(/saved/i));
    expect(n).toBe(1);
  });
});

describe('validation (matches the operation schema; nothing invalid is ever sent)', () => {
  const cases = Object.entries(RANGES).flatMap(([k, [lo, hi]]) => [[k, String(hi + 1)], [k, String(lo - 1)]] as const).filter(([, v]) => Number(v) >= 0);
  it.each(cases)('%s = %s is outside the operation range: never sent (an alert is shown, or the value is held inside the range)', async (key, bad) => {
    const user = await open();
    await setText(user, INT_LABEL[key]!, bad);
    await user.click(saveBtn());
    await settle();
    expectNoBadPut();
    if (puts().length === 0) expect(alertText(), `no PUT and no alert for ${key}=${bad}`).not.toBe('');
  });

  it('negative or non-numeric numbers never reach the API', async () => {
    const user = await open();
    await setText(user, L.otp, '-5');
    await setText(user, L.horizon, 'abc');
    await user.click(saveBtn());
    await settle();
    expectNoBadPut();
    if (puts().length === 0) expect(alertText()).not.toBe('');
  });

  it.each([['no plus sign', '977'], ['plus zero', '+0'], ['too long', '+12345'], ['letters', '+9a'], ['six prefixes', '+1, +2, +3, +4, +5, +6'], ['empty list', '']])('allowed phone prefixes: %s is refused (no PUT, alert names the field, aria-invalid)', async (_n, v) => {
    const user = await open();
    await setText(user, L.prefixes, v);
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).toMatch(/prefix/i));
    expect(puts()).toHaveLength(0);
    expect(field(L.prefixes).getAttribute('aria-invalid')).toBe('true');
    expect(describedText(field(L.prefixes))).not.toBe('');
  });

  it.each([['1.2'], ['1.2.3.4'], ['a.b.c'], ['1234.1.1']])('minimum app version %s does not match ^[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,4}$: refused for Android and for iOS', async (v) => {
    const user = await open();
    await setText(user, L.android, v);
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).toMatch(/version/i));
    expect(puts()).toHaveLength(0);
    await setText(user, L.android, '1.0.0');
    await setText(user, L.ios, v);
    await user.click(saveBtn());
    await settle();
    expectNoBadPut();
    expect(puts()).toHaveLength(0);
  });

  it('both gateways may be chosen and none may be chosen (app_gateways minItems 0, unique, esewa/khalti only)', async () => {
    const user = await open();
    await user.click(await rev(L.esewa)); // off
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.app_gateways).toEqual([]);
  });

  it('changing the consent text WITHOUT a new version label is refused as the spec says (W12: changing the text requires a new version): no PUT, alert names the version', async () => {
    const user = await open();
    await setText(user, L.consent, 'Another synthetic text.');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).toMatch(/version/i));
    expect(puts()).toHaveLength(0);
    expect(describedText(field(L.consentVersion))).not.toBe('');
  });

  it('a consent text longer than 4000 characters, a version longer than 32 and a disclaimer longer than 1000 are never sent', async () => {
    const user = await open();
    await setText(user, L.consent, 'x'.repeat(4001));
    await setText(user, L.consentVersion, 'v'.repeat(33));
    await setText(user, L.disclaimer, 'd'.repeat(1001));
    await user.click(saveBtn());
    await settle();
    expectNoBadPut();
  });

  it('the minor-age field carries the spec note "Confirm the legal age with your counsel"', async () => {
    await open();
    const el = field(L.minorAge);
    expect(`${describedText(el)} ${document.body.textContent}`).toMatch(/confirm the legal age with your counsel/i);
  });

  it('server 400 common.validation_failed with errors[].path -> inline role=alert text on THAT field (aria-invalid + aria-describedby), focus moves to it, no raw code shown', async () => {
    api.use(http.put(S, async ({ request }) => { await rec(request); return problem(400, 'common.validation_failed', { errors: [{ path: '/otp_daily_cap', code: 'common.field_invalid', message: 'out of range' }] }); }));
    const user = await open();
    await setText(user, L.otp, '2500');
    await user.click(saveBtn());
    await waitFor(() => expect(field(L.otp).getAttribute('aria-invalid')).toBe('true'));
    expect(describedText(field(L.otp))).not.toBe('');
    expect(alertText()).not.toBe('');
    expect(alertText()).not.toContain('common.validation_failed');
    expect(document.activeElement).toBe(field(L.otp));
    expect(statusText()).not.toMatch(/saved/i);
  });

  it('server 422 engagement.setting_out_of_range -> role=alert plain text (no raw code), the typed edit is kept, never a success status', async () => {
    api.use(http.put(S, async ({ request }) => { await rec(request); return problem(422, 'engagement.setting_out_of_range', { errors: [{ path: '/booking_horizon_days', code: 'engagement.setting_out_of_range', message: 'out of range' }] }); }));
    const user = await open();
    await setText(user, L.horizon, '45');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).not.toBe(''));
    expect(alertText()).not.toContain('engagement.setting_out_of_range');
    expect(puts()).toHaveLength(1);
    expect(field(L.horizon).value).toBe('45');
    expect(statusText()).not.toMatch(/saved/i);
  });
});

describe('failures after Save', () => {
  it('409 common.version_conflict -> the shared reload message in a role=alert/alertdialog, the typed edit is kept, exactly one PUT, Reload refetches', async () => {
    api.use(http.put(S, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    const user = await open();
    await setText(user, L.supportPhone, '+15550100333');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).toContain(CONFLICT_COPY));
    expect(puts()).toHaveLength(1);
    expect(field(L.supportPhone).value).toBe('+15550100333');
    expect(statusText()).not.toMatch(/saved/i);
    await user.click(screen.getByRole('button', { name: /reload/i }));
    await waitFor(() => expect(refresh.mock.calls.length + gets().length).toBeGreaterThan(1));
  });

  it('428 common.precondition_required is a plain alert (the page always sends If-Match, but the message must not be a crash)', async () => {
    api.use(http.put(S, async ({ request }) => { await rec(request); return problem(428, 'common.precondition_required'); }));
    const user = await open();
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).not.toBe(''));
    expect(alertText()).not.toContain('common.precondition_required');
    expect(statusText()).not.toMatch(/saved/i);
  });

  it('403 auth.mfa_required on Save -> role=alert with the two-step verification text (privileged / aal2), not a crash', async () => {
    api.use(http.put(S, async ({ request }) => { await rec(request); return problem(403, 'auth.mfa_required'); }));
    const user = await open();
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).toMatch(/two-step verification|authenticator/i));
    expect(alertText()).not.toContain('auth.mfa_required');
  });

  it('403 auth.forbidden, 429 and 500 on Save -> role=alert plain text (no raw error code, no stack), never a success status', async () => {
    for (const [status, code] of [[403, 'auth.forbidden'], [429, 'common.rate_limited'], [500, 'common.internal']] as const) {
      api.use(http.put(S, async ({ request }) => { await rec(request); return problem(status, code); }));
      const user = await open();
      await user.click(saveBtn());
      await waitFor(() => expect(alertText()).not.toBe(''));
      expect(alertText()).not.toContain(code);
      expect(statusText()).not.toMatch(/saved/i);
      cleanup(); calls.length = 0;
    }
  });

  it('a network failure on Save is shown as a role=alert (the form stays editable)', async () => {
    api.use(http.put(S, () => HttpResponse.error()));
    const user = await open();
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).not.toBe(''));
    expect(field(L.otp).disabled).toBe(false);
  });
});

describe('forbidden (engagement.settings.manage is required)', () => {
  it.each([[[]], [['engagement.booking.read', 'engagement.slot.manage', 'engagement.queue.manage', 'engagement.reminder.read']]])('perms %j: the API is never called and no settings control is shown (notFound or the permission-denied page)', async (perms) => {
    session.perms = perms as string[];
    const { default: Page } = await pageModule();
    let out: ReactNode | undefined;
    try { out = await Page({ searchParams: Promise.resolve({}) }); } catch (e) { expect(String((e as Error).message)).toBe('NEXT_NOT_FOUND'); }
    if (out !== undefined) {
      wrap(out);
      expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
      expect(screen.queryByLabelText(L.otp)).toBeNull();
      expect(screen.queryByLabelText(L.consent)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('session holds the permission but the API answers 403 auth.forbidden (T1 needs engagement.booking.read): no form, no crash (permission-denied state, not error.tsx)', async () => {
    session.perms = [MANAGE];
    api.use(http.get(S, async ({ request }) => { await rec(request); return problem(403, 'auth.forbidden'); }));
    const { default: Page } = await pageModule();
    let out: ReactNode | undefined;
    try { out = await Page({ searchParams: Promise.resolve({}) }); } catch (e) { expect(String((e as Error).message)).toBe('NEXT_NOT_FOUND'); }
    if (out !== undefined) { wrap(out); expect(screen.queryByRole('button', { name: /^save/i })).toBeNull(); }
  });

  it('403 auth.mfa_required on load -> a visible step-up banner with the two-step verification text and no form (aal2 is a page state)', async () => {
    session.perms = [MANAGE];
    api.use(http.get(S, async ({ request }) => { await rec(request); return problem(403, 'auth.mfa_required'); }));
    const { default: Page } = await pageModule();
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    expect(document.body.textContent).toMatch(/two-step verification|authenticator/i);
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
  });
});

describe('accessibility and keyboard', () => {
  it('every control has a programmatic label (no unlabeled input) and the 11 switches, the gateways and the 16 numbers are all present', async () => {
    await open();
    for (const re of Object.values(L)) expect(screen.getByLabelText(re), String(re)).toBeTruthy();
    const unlabeled = [...document.querySelectorAll('input,select,textarea')].filter((e) => !(e as HTMLInputElement).labels?.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && (e as HTMLInputElement).type !== 'hidden');
    expect(unlabeled.map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('axe finds no violations on the loaded form and on the form with errors (colour contrast comes from tokens and is checked elsewhere)', async () => {
    const user = await open();
    const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`);
    expect(await run()).toEqual([]);
    await setText(user, L.prefixes, '');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).not.toBe(''));
    expect(await run()).toEqual([]);
  });

  it('keyboard only: Tab reaches every field (per tab) and then Save; Space toggles a switch; Enter on Save writes once', async () => {
    const user = await open();
    const targets = [L.app, L.queue, L.prefixes, L.otp, L.consent, L.minorAge, L.horizon, L.history].map((re) => field(re));
    const seen = new Set<HTMLElement>();
    for (const tab of screen.getAllByRole('tab')) {
      await user.click(tab);
      (document.activeElement as HTMLElement | null)?.blur();
      let reached = false;
      for (let i = 0; i < 120 && !reached; i++) { await user.tab(); seen.add(document.activeElement as HTMLElement); reached = document.activeElement === saveBtn(); }
      expect(document.activeElement, `Save is reached by Tab on tab ${tab.textContent}`).toBe(saveBtn());
    }
    const missing = targets.filter((t) => !seen.has(t));
    expect(missing.map((t) => t.getAttribute('name') ?? t.id), 'fields not reachable by Tab').toEqual([]);
    const q = await rev(L.autoNoShow);
    q.focus();
    await user.keyboard(' ');
    expect(isOn(q)).toBe(true);
    saveBtn().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.auto_no_show).toBe(true);
  });

  it('error text is announced: role=alert exists for errors and role=status for success, and they are different live regions', async () => {
    const user = await open();
    await setText(user, L.prefixes, '');
    await user.click(saveBtn());
    await waitFor(() => expect(document.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0));
    await setText(user, L.prefixes, '+999');
    await user.click(saveBtn());
    await waitFor(() => expect(statusText()).toMatch(/saved/i));
  });
});
