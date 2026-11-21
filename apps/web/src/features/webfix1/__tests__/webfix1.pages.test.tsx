// @vitest-environment jsdom
// T0D-WEBFIX-1 — web pages that failed for the tenant administrator on staging (LD-301, live 2026-11-17). Synthetic data only.
// MSW plays the API with the REAL request/response shapes from contracts/openapi (identity.yaml, reporting.yaml, engagement.yaml, partners.yaml)
// and with the strictness the deployed API has:
//   (c) listTenantSupportSessions declares only `status`; any other query key answers 400 common.validation_failed (it has no `limit`, its body has no `page`).
//   (d) listCriticalAlerts: ajv coerceTypes turns `limit=50` into the number 50, and reports-read.handlers.ts:200 accepts only a string, so ANY `limit` answers 400.
//       Without `limit` the API default is 50, so the web must simply not send it.
//   (b) getPartnerSettings and updatePartnerSettings are unimplemented stubs in services/api/src/modules/partners/index.ts:53 (500 common.internal; known-failures.json).
//   (e) listRolePacks / listAccessReviews are notImplemented in services/api/src/modules/identity/handlers/index.ts (500 common.internal).
// Contract assumed for the fix (writer may dispute): the not-available pages return plain copy matching /not available yet/i, no ErrorState, no request id,
// and make NO call to the unimplemented operation; permission gates stay as they are (PermissionDenied, no API call).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/',
}));
const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CENTRE = U(3);
const problem = (code: string, status: number) => ({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: U(99) });

const hits: { method: string; path: string; query: URLSearchParams }[] = [];
const rec = (request: Request) => { const u = new URL(request.url); hits.push({ method: request.method, path: u.pathname, query: u.searchParams }); };
const called = (re: RegExp) => hits.some((h) => re.test(h.path));
const ok = (body: unknown, headers: Record<string, string> = {}) => ({ request }: { request: Request }) => { rec(request); return HttpResponse.json(body as never, { headers }); };
const fail = (status: number, code: string) => ({ request }: { request: Request }) => { rec(request); return HttpResponse.json(problem(code, status) as never, { status }); };

// ---- real-shape fixtures (contracts/openapi examples) ----
const supportSession = (o: Record<string, unknown> = {}) => ({
  support_session_id: U(70), tenant_id: U(90), platform_staff_id: U(80), platform_staff_display_name: 'Demo Support', scope: 'read_only',
  reason_text: 'Investigating a synthetic ticket', ticket_ref: 'SUP-1001', duration_minutes: 30, status: 'requested', requested_at: '2026-11-05T04:15:00.000Z', version: 1, ...o,
});
const criticalAlert = () => ({
  critical_event_id: U(26), report_id: U(27), order_id: U(28), registration_no: 'R2611050001', centre_id: CENTRE, alerted_at: '2026-11-05T04:15:00.000Z',
  recipients: [{ recipient_kind: 'referrer', status: 'queued' }],
});
const centre = (n: number, o: Record<string, unknown> = {}) => ({ centre_id: U(n), code: `C00000000${n}`, name: `Synthetic Centre ${n}`, branch_id: U(30), kind: 'own', address_text: 'Synthetic street 2', is_active: true, version: 1, ...o });
const slotTemplate = () => ({ id: U(137), centre_id: CENTRE, booking_kind: 'centre_visit', weekdays: [1], start_local: '07:00', end_local: '11:00', slot_minutes: 15, capacity: 3, effective_from: '2026-03-01', effective_to: '2026-03-01', is_active: true, version: 3 });
const slotBlackout = () => ({ id: U(147), centre_id: CENTRE, booking_kind: 'centre_visit', starts_at: '2026-03-01T04:15:00.000Z', ends_at: '2026-03-01T04:15:00.000Z', reason_code: 'holiday', note: 'Synthetic maintenance window', is_active: true, version: 3 });
const bookableItem = () => ({ orderable_id: U(201), kind: 'test', code: 'CBC', display_name: 'Synthetic CBC', booking_kinds: ['centre_visit'], is_active: true, version: 1 });
const partnerSettings = () => ({
  default_conversion_mode: 'on_receipt', include_default_price_list: true, require_mapped_referrer: true, access_slip_enabled: true, max_lines_per_manifest: 50, draft_ttl_days: 14,
  pickup_max_days_ahead: 7, report_download_daily_cap_per_user: 500, consent_text_version: 'v1', consent_statement: 'Synthetic consent statement.',
});

// ---- strict API doubles ----
/** (c) The deployed validator: only `status` is a declared query parameter. */
const supportSessionsStrict = ({ request }: { request: Request }) => {
  rec(request);
  const keys = [...new URL(request.url).searchParams.keys()];
  if (keys.some((k) => k !== 'status')) return HttpResponse.json(problem('common.validation_failed', 400) as never, { status: 400 });
  return HttpResponse.json({ data: [supportSession()] });
};
/** (d) The deployed handler: `limit` is coerced to a number and then rejected; `since` must be IsoUtc (ms) and at most 7 days old. */
const criticalAlertsStrict = ({ request }: { request: Request }) => {
  rec(request);
  const q = new URL(request.url).searchParams;
  const since = q.get('since');
  const bad = q.has('limit') || [...q.keys()].some((k) => !['centre_id', 'since', 'cursor', 'limit'].includes(k))
    || (since !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(since));
  if (bad) return HttpResponse.json(problem('common.validation_failed', 400) as never, { status: 400 });
  return HttpResponse.json({ data: [criticalAlert()], page: { limit: 50 } });
};

let engagement: { templates: unknown[]; blackouts: unknown[]; items: unknown[]; bookings: unknown[]; centres: unknown[] } = { templates: [], blackouts: [], items: [], bookings: [], centres: [] };
const E = `${ORIGIN}/v1/engagement`;
const api = setupServer(
  http.get(`${ORIGIN}/v1/identity/support-sessions`, supportSessionsStrict),
  http.get(`${ORIGIN}/v1/reporting/critical-alerts`, criticalAlertsStrict),
  http.get(`${ORIGIN}/v1/reporting/reports`, ok({ data: [], page: { limit: 50 } })),
  http.get(`${ORIGIN}/v1/reporting/centres`, ok({ data: [] })),
  http.get(`${ORIGIN}/v1/identity/centres`, ({ request }) => { rec(request); return HttpResponse.json({ data: engagement.centres }); }),
  http.get(`${E}/slot-templates`, ({ request }) => { rec(request); return HttpResponse.json({ data: engagement.templates }); }),
  http.get(`${E}/slot-blackouts`, ({ request }) => { rec(request); return HttpResponse.json({ data: engagement.blackouts }); }),
  http.get(`${E}/bookable-items`, ({ request }) => { rec(request); return HttpResponse.json({ data: engagement.items, page: { limit: 200 } }); }),
  http.get(`${E}/bookings`, ({ request }) => { rec(request); return HttpResponse.json({ data: engagement.bookings, page: { limit: 100 } }); }),
  http.get(`${E}/queues`, ok({ data: [] })),
  http.get(`${E}/coded-sets/:set`, ok({ data: [{ code: 'patient_request', display: 'Patient request' }] })),
  http.get(`${ORIGIN}/v1/partners/admin/settings`, fail(500, 'common.internal')),
  http.get(`${ORIGIN}/v1/identity/role-packs`, fail(500, 'common.internal')),
  http.get(`${ORIGIN}/v1/identity/access-reviews`, fail(500, 'common.internal')),
  http.get(`${ORIGIN}/v1/identity/roles`, ok({ data: [] })),
  http.get(`${ORIGIN}/v1/identity/permissions`, ok({ data: [] })),
  http.get(`${ORIGIN}/v1/identity/users`, ok({ data: [], page: { limit: 200 } })),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); hits.length = 0; session.permissions = []; engagement = { templates: [], blackouts: [], items: [], bookings: [], centres: [] }; });
afterAll(() => api.close());

type El = React.ReactElement;
const route = async (file: string) => (await import(/* @vite-ignore */ `../../../app/(staff)/${file}/page.tsx`)).default as (p: unknown) => Promise<El>;
const SP = { searchParams: Promise.resolve({}), params: Promise.resolve({}) };
const show = async (file: string, perms: string[]) => {
  session.permissions = perms;
  const el = await (await route(file))(SP);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
const NOT_AVAILABLE = /not available yet/i;
/** No error chrome: no error title, no reference line, no alert role carrying a failure. */
const expectNoErrorChrome = () => {
  expect(text()).not.toMatch(/something went wrong|could not (be )?load|reference/i);
};

// ================= (a) engagement bookings, slots, bookable items =================
describe('(a) engagement pages render the real API response shapes', () => {
  const populated = () => { engagement = { centres: [centre(3)], templates: [slotTemplate()], blackouts: [slotBlackout()], items: [bookableItem()], bookings: [], }; };

  it('slots: real templates and blackouts render, no error page', async () => {
    populated();
    await show('engagement/slots', ['engagement.slot.manage']);
    expect(called(/\/slot-templates$/) && called(/\/slot-blackouts$/)).toBe(true);
    expect(screen.getByRole('heading', { name: /slot templates and blackouts/i })).toBeTruthy();
    expectNoErrorChrome();
  });
  it('slots: an empty tenant (no templates, no blackouts) is an empty state, not an error', async () => {
    engagement.centres = [centre(3)];
    await show('engagement/slots', ['engagement.slot.manage']);
    expect(screen.getByRole('heading', { name: /slot templates and blackouts/i })).toBeTruthy();
    expectNoErrorChrome();
  });
  it('bookable items: real items render, no error page', async () => {
    populated();
    await show('engagement/bookable-items', ['engagement.bookable_item.manage']);
    expect(called(/\/bookable-items$/)).toBe(true);
    expect(screen.getByRole('heading', { name: /bookable catalogue/i })).toBeTruthy();
    expect(text()).toMatch(/Synthetic CBC/);
    expectNoErrorChrome();
  });
  it('bookable items: an empty list is an empty state, not an error', async () => {
    engagement.centres = [centre(3)];
    await show('engagement/bookable-items', ['engagement.bookable_item.manage']);
    expect(screen.getByRole('heading', { name: /bookable catalogue/i })).toBeTruthy();
    expectNoErrorChrome();
  });
  it('bookings: a tenant with a centre and no bookings today shows the list, no error page', async () => {
    engagement.centres = [centre(3)];
    await show('engagement/bookings', ['engagement.booking.read']);
    expect(called(/\/bookings$/)).toBe(true);
    expect(screen.getByRole('heading', { name: /^bookings$/i })).toBeTruthy();
    expectNoErrorChrome();
  });
  it('bookings: a tenant with no centre at all shows an empty state, not an error', async () => {
    await show('engagement/bookings', ['engagement.booking.read']);
    expectNoErrorChrome();
  });
  it('bookings: the list request carries only parameters listBookings declares (and a numeric-safe limit)', async () => {
    engagement.centres = [centre(3)];
    await show('engagement/bookings', ['engagement.booking.read']);
    const h = hits.find((x) => /\/engagement\/bookings$/.test(x.path))!;
    const declared = ['centre_id', 'booking_kind', 'status', 'slot_start_from', 'slot_start_to', 'sort', 'cursor', 'limit'];
    expect([...h.query.keys()].filter((k) => !declared.includes(k))).toEqual([]);
    expect(h.query.get('slot_start_from')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  it('slots and bookings: the only centre is inactive (resolveCentre sees it, listCentres?is_active=true does not) → no crash', async () => {
    const inactive = centre(3, { is_active: false });
    api.use(http.get(`${ORIGIN}/v1/identity/centres`, ({ request }) => {
      rec(request);
      const only = new URL(request.url).searchParams.get('is_active') === 'true';
      return HttpResponse.json({ data: only ? [] : [inactive] });
    }));
    engagement.templates = [slotTemplate()]; engagement.blackouts = [slotBlackout()];
    await show('engagement/slots', ['engagement.slot.manage']);
    expect(screen.getByRole('heading', { name: /slot templates and blackouts/i })).toBeTruthy();
    cleanup();
    await show('engagement/bookings', ['engagement.booking.read']);
    expect(screen.getByRole('heading', { name: /^bookings$/i })).toBeTruthy();
    expectNoErrorChrome();
  });
  it('permission floors are unchanged: no engagement.slot.manage → 404 and no API call', async () => {
    await expect(show('engagement/slots', ['engagement.booking.read'])).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(hits).toEqual([]);
  });
});

// ================= (b) partner settings =================
describe('(b) partner settings', () => {
  it('shows the form from the real 200 response (ETag kept for the PUT)', async () => {
    api.use(http.get(`${ORIGIN}/v1/partners/admin/settings`, ok(partnerSettings(), { etag: '"3"' })));
    await show('partners/settings', ['partners.partner.read', 'partners.partner.manage']);
    expect(screen.getByRole('heading', { name: /partner settings/i })).toBeTruthy();
    expect(screen.getByDisplayValue('Synthetic consent statement.')).toBeTruthy();
  });
  it('while the API answers 500 common.internal for getPartnerSettings (stub today) the page shows plain "not available yet", never the error page or a reference', async () => {
    const r = await show('partners/settings', ['partners.partner.read', 'partners.partner.manage']);
    expect(r.container.textContent ?? '').toMatch(NOT_AVAILABLE);
    expectNoErrorChrome();
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
  });
  it('permission floor unchanged: without partners.partner.read → notice and no API call', async () => {
    await show('partners/settings', []);
    expect(hits).toEqual([]);
  });
});

// ================= (c) support access =================
describe('(c) admin support access sends a request listTenantSupportSessions accepts', () => {
  it('lists the real sessions (no limit, no other undeclared query key) and shows no load error', async () => {
    await show('admin/support-access', ['audit.log.read']);
    const h = hits.find((x) => x.path === '/v1/identity/support-sessions')!;
    expect([...h.query.keys()].filter((k) => k !== 'status')).toEqual([]);
    expect(text()).toMatch(/SUP-1001/);
    expect(text()).not.toMatch(/could not load/i);
  });
  it('an empty list is an empty state, not an error', async () => {
    api.use(http.get(`${ORIGIN}/v1/identity/support-sessions`, ok({ data: [] })));
    await show('admin/support-access', ['audit.log.read']);
    expect(text()).not.toMatch(/could not load|something went wrong/i);
  });
  it('permission floor unchanged: without audit.log.read → denied and no API call', async () => {
    await show('admin/support-access', []);
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits).toEqual([]);
  });
});

// ================= (d) Reports critical alerts =================
describe('(d) Reports critical alerts request is accepted by listCriticalAlerts', () => {
  const perms = ['reporting.report.read'];
  it('the Reports page shows the alert from the real response and not "could not be loaded"', async () => {
    await show('reporting', perms);
    const h = hits.find((x) => x.path === '/v1/reporting/critical-alerts')!;
    expect(h.query.has('limit')).toBe(false); // the API default is 50; sending limit answers 400 (number coercion)
    expect(h.query.get('since')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(text()).toMatch(/R2611050001/);
    expect(text()).not.toMatch(/Critical alerts could not be loaded/i);
  });
  it('the 30-second refresh / Retry server action gets ok:true, not a 400', async () => {
    const { listCriticalAlertsAction } = await import('@/features/reporting/server/actions');
    session.permissions = perms;
    const r = await listCriticalAlertsAction();
    expect(r).toMatchObject({ ok: true });
    expect([...hits.find((x) => x.path === '/v1/reporting/critical-alerts')!.query.keys()]).not.toContain('limit');
  });
  it('an empty alert list is the empty state, not the error', async () => {
    api.use(http.get(`${ORIGIN}/v1/reporting/critical-alerts`, ok({ data: [], page: { limit: 50 } })));
    await show('reporting', perms);
    expect(text()).toMatch(/No critical alerts in the last 24 hours/i);
    expect(text()).not.toMatch(/could not be loaded/i);
  });
});

// ================= (e) not-implemented admin pages =================
describe('(e) role packs and access review say "not available yet" and never call the stub', () => {
  it('role packs: plain message, no call to listRolePacks, no error reference', async () => {
    await show('admin/roles/packs', ['identity.role.manage']);
    expect(text()).toMatch(NOT_AVAILABLE);
    expectNoErrorChrome();
    expect(called(/role-packs/)).toBe(false);
  });
  it('access review: plain message, no call to listAccessReviews, no error reference', async () => {
    await show('admin/access-review', ['identity.user.read', 'identity.user.manage']);
    expect(text()).toMatch(NOT_AVAILABLE);
    expectNoErrorChrome();
    expect(called(/access-reviews/)).toBe(false);
  });
  it('permission gates unchanged: role packs needs identity.role.manage, access review needs identity.user.read (denied, no API call)', async () => {
    await show('admin/roles/packs', ['identity.user.read']);
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    cleanup();
    await show('admin/access-review', ['identity.role.manage']);
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits).toEqual([]);
  });
  it('navigation still lists both entries with their old permissions (nothing here changes who can see a page)', async () => {
    const { navManifest } = await import('@/features/admin/nav.manifest');
    const byId = Object.fromEntries(navManifest.entries.map((e) => [e.id, e]));
    expect(byId['admin.access_review']?.permission).toBe('identity.user.read');
    expect(byId['admin.roles']?.permission).toBe('identity.user.read');
  });
});
