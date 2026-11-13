// @vitest-environment jsdom
// C2.T26 — (platform) layout, PL-1 Home, PL-2 Tenants + Provision, PL-3 Tenant detail (04-UI-UX §7; AC-E1.1..E1.3, AC-E2 UI side; 03-APP-FLOW §2.3 T1..T5).
// ASSUMED contract (dispute if wrong):
//   * Pages are default async server components `Page({ searchParams?, params? })` at app/(platform)/platform/<rel>/page.tsx. Each checks the session permission
//     (`getShellSession().actor.permissions`) BEFORE any API call and refuses (throws notFound/redirect OR renders a "no access" text) when it is missing: zero API calls.
//     Reads go through core/api/server-fetch `serverFetch` to /v1/identity/platform/*; mutations are server actions called by client components, then router.refresh()/push.
//   * app/(platform)/layout.tsx: default async `PlatformLayout({ children })`; session kind 'platform' → persistent label "PLATFORM CONSOLE — the LIMS provider staff only" + children;
//     any other session kind → text "Platform access only" and children NOT rendered (03-APP-FLOW §11, CR-C2-009).
//   * Tables are the kit DataTable (role=grid, accessible name /tenants/i). Kit StatTile (label then value) is used for the PL-1 tiles. Dialogs are role=dialog (kit ConfirmDialog/Dialog).
//   * Errors: ErrorState shows the problem's `request_id`; `409 common.version_conflict` → dialog "This record was changed by someone else. Reload to see the latest version." + [Reload] (04-UI-UX §3).
//   * Row `version` is sent as If-Match: "<version>" (quoted) on every lifecycle POST; provision sends an Idempotency-Key header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  P, SUPER, SUPPORT, T_ALPHA, T_BETA, T_GAMMA, annex, api, apiCalls, axeClean, bodyOf, callsTo, deadLetter, dialog, gridNamed, headersOf, lastNav, norm, page, pageText, problem, resetApi,
  router, routes, rowTexts, show, showLayout, showOrThrown, supportSession, tenantDetail, tenantDto,
} from './t26.harness';

const router_refreshed = () => router.refresh.mock.calls.length + router.push.mock.calls.length + router.replace.mock.calls.length > 0;

vi.mock('next/navigation', async () => (await import('./t26.harness')).navigationMock);
vi.mock('next/cache', async () => (await import('./t26.harness')).cacheMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t26.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi(SUPER));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const TENANTS = [tenantDto(T_ALPHA, 'alpha', 'active'), tenantDto(T_BETA, 'beta', 'suspended', { suspended_at: '2026-11-01T04:00:00.000Z' }), tenantDto(T_GAMMA, 'gamma', 'provisioning')];
const refused = (msg: string | undefined) => msg === undefined ? /no access|don.t have access|platform access only|not allowed|permission/i.test(pageText()) : true;

describe('(platform) layout', () => {
  it('platform session: shows the persistent PLATFORM CONSOLE label and the page', async () => {
    await showLayout();
    expect(pageText()).toContain('PLATFORM CONSOLE — the LIMS provider staff only');
    expect(pageText()).toContain('CHILD-CONTENT');
  });

  it('tenant-staff session (even a tenant admin) gets "Platform access only" and never sees the children', async () => {
    resetApi(['identity.user.manage', 'identity.settings.manage'], 'tenant_staff');
    await showLayout();
    expect(pageText()).toContain('Platform access only');
    expect(pageText()).not.toContain('CHILD-CONTENT');
    expect(apiCalls()).toBe(0);
  });
});

describe('PL-1 Home', () => {
  beforeEach(() => {
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${P}/dead-letters`] = (c) => HttpResponse.json(page(c.url.searchParams.get('state') === 'open' ? [deadLetter(1), deadLetter(2)] : [deadLetter(1), deadLetter(2), deadLetter(3, { state: 'replayed' })]));
    routes[`GET ${P}/support-sessions`] = (c) => {
      const all = [supportSession(1), supportSession(2, { status: 'ended', ended_at: '2026-11-10T04:30:00.000Z' })];
      const s = c.url.searchParams.get('status');
      return HttpResponse.json(page(s ? all.filter((x) => x.status === s) : all));
    };
    routes[`GET ${P}/ird-annexes`] = () => HttpResponse.json({ data: [
      annex(1, T_ALPHA, 'annex_2', 'completed'), annex(2, T_ALPHA, 'annex_3', 'completed'), annex(3, T_ALPHA, 'annex_7', 'completed'),
      annex(4, T_BETA, 'annex_2', 'completed'), annex(5, T_BETA, 'annex_3', 'in_preparation'), annex(6, T_BETA, 'annex_7', 'not_started'),
      annex(7, T_GAMMA, 'annex_2', 'not_started'), annex(8, T_GAMMA, 'annex_3', 'not_started'), annex(9, T_GAMMA, 'annex_7', 'not_started'),
    ] });
  });

  it('shows the four tiles: tenants by status, open dead letters, active support sessions, tenants with incomplete IRD annexes', async () => {
    await show('page');
    const t = pageText();
    expect(t).toMatch(/Tenants by status/i);
    expect(t).toMatch(/Active\s*1/); expect(t).toMatch(/Suspended\s*1/); expect(t).toMatch(/Provisioning\s*1/);
    expect(t).toMatch(/Open dead letters\s*2\b/i);
    expect(t).toMatch(/Active support sessions\s*1\b/i);
    expect(t).toMatch(/Tenants with incomplete IRD annexes\s*2\b/i);
    await axeClean();
  });

  it('refuses without platform.tenant.read and makes no API call', async () => {
    resetApi([]);
    expect(refused(await showOrThrown('page'))).toBe(true);
    expect(apiCalls()).toBe(0);
  });

  it('one failing read does not blank the whole home: shows an ErrorState with the request id', async () => {
    routes[`GET ${P}/dead-letters`] = () => problem('common.dependency_unavailable', 503);
    await show('page');
    expect(pageText()).toContain('req-t26-0001');
  });
});

describe('PL-2 Tenants list', () => {
  beforeEach(() => { routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS)); });

  it('columns Code, Display name, Status, Users, Centres, IRD readiness, Created; one row per tenant with a text status label and a link to the detail page', async () => {
    await show('tenants/page');
    const g = gridNamed(/tenants/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Code', 'Display name', 'Status', 'Users', 'Centres', 'IRD readiness', 'Created']));
    const rows = rowTexts(g);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/alpha.*Synthetic alpha.*Active/i);
    expect(rows[1]).toMatch(/beta.*Suspended/i);
    expect(rows[2]).toMatch(/gamma.*Provisioning/i);
    expect(within(g).getByRole('link', { name: /alpha/i }).getAttribute('href')).toBe(`/platform/tenants/${T_ALPHA}`);
    await axeClean();
  });

  it('manager sees [Provision tenant] linking to /platform/tenants/new; read-only support staff does not', async () => {
    await show('tenants/page');
    expect(screen.getByRole('link', { name: /provision tenant/i }).getAttribute('href')).toBe('/platform/tenants/new');
    cleanup(); resetApi(SUPPORT);
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    await show('tenants/page');
    expect(screen.queryByRole('link', { name: /provision tenant/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /provision tenant/i })).toBeNull();
  });

  it('empty list → "No tenants yet"; 50 per page with Load more following next_cursor', async () => {
    routes[`GET ${P}/tenants`] = (c) => HttpResponse.json(c.url.searchParams.get('cursor') ? page([TENANTS[2]!]) : page([TENANTS[0]!], 'CUR2'));
    await show('tenants/page');
    expect(callsTo('GET', `${P}/tenants`)[0]!.url.searchParams.get('limit') ?? '50').toBe('50');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(rowTexts(gridNamed(/tenants/i))).toHaveLength(2));
    expect(callsTo('GET', `${P}/tenants`).at(-1)!.url.searchParams.get('cursor')).toBe('CUR2');
    cleanup();
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page([]));
    await show('tenants/page');
    expect(pageText()).toContain('No tenants yet');
  });

  it('refuses without platform.tenant.read and makes no API call', async () => {
    resetApi([]);
    expect(refused(await showOrThrown('tenants/page'))).toBe(true);
    expect(apiCalls()).toBe(0);
  });
});

describe('PL-2 Provision tenant (AC-E1.1, AC-E1.2)', () => {
  const POST = `${P}/tenants`;
  async function fillValid(code = 'synthetic_gamma') {
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/^tenant code/i), code);
    await u.type(screen.getByLabelText(/^legal name/i), 'Synthetic Gamma Pvt. Ltd.');
    await u.type(screen.getByLabelText(/^display name/i), 'Synthetic Gamma Lab');
    await u.type(screen.getByLabelText(/branch code/i), 'MAIN');
    await u.type(screen.getByLabelText(/branch name/i), 'Main Branch');
    await u.type(screen.getByLabelText(/centre code/i), 'C01');
    await u.type(screen.getByLabelText(/centre name/i), 'Main Centre');
    await u.selectOptions(screen.getByLabelText(/centre type/i), 'own');
    await u.type(screen.getByLabelText(/administrator email/i), 'admin@synthetic-gamma.example.test');
    await u.type(screen.getByLabelText(/administrator full name/i), 'Synthetic Admin');
    return u;
  }
  const submit = () => screen.getByRole('button', { name: /^provision tenant$/i });

  it('single page with sections Tenant, First branch, First centre, First administrator; timezone is read-only text "Asia/Kathmandu"', async () => {
    await show('tenants/new/page');
    for (const h of [/^tenant$/i, /first branch/i, /first centre/i, /first administrator/i]) expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    expect(pageText()).toContain('Asia/Kathmandu');
    const tz = screen.queryByLabelText(/timezone/i) as HTMLInputElement | null;
    if (tz) expect(tz.readOnly || tz.disabled).toBe(true);
    expect((screen.getByLabelText(/^tenant code/i) as HTMLInputElement).maxLength).toBe(32);
    expect((screen.getByLabelText(/^legal name/i) as HTMLInputElement).maxLength).toBe(200);
    expect((screen.getByLabelText(/^display name/i) as HTMLInputElement).maxLength).toBe(120);
    await axeClean();
  });

  it('valid submit → POST /tenants with the contract body, an Idempotency-Key and no tenant_id; then a checklist of created items and "Invitation sent"', async () => {
    routes[`POST ${POST}`] = () => HttpResponse.json(tenantDto(T_GAMMA, 'synthetic_gamma', 'provisioning'), { status: 201 });
    await show('tenants/new/page');
    const u = await fillValid();
    await u.click(submit());
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    const c = callsTo('POST', POST)[0]!;
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic-t26');
    const b = bodyOf(c);
    expect(b).toMatchObject({
      code: 'synthetic_gamma', legal_name: 'Synthetic Gamma Pvt. Ltd.', display_name: 'Synthetic Gamma Lab',
      first_branch: { code: 'MAIN', name: 'Main Branch' }, first_centre: { code: 'C01', name: 'Main Centre', kind: 'own' },
      first_admin: { email: 'admin@synthetic-gamma.example.test', display_name: 'Synthetic Admin' },
    });
    expect(b.tenant_id).toBeUndefined();
    expect(b.timezone === undefined || b.timezone === 'Asia/Kathmandu').toBe(true);
    await waitFor(() => expect(pageText()).toContain('Invitation sent'));
    for (const item of [/tenant/i, /branch/i, /centre/i, /roles/i, /settings/i, /feature flags/i, /ird annex/i]) expect(screen.getAllByText(item).length).toBeGreaterThan(0);
  });

  it('double click on Provision sends one request (same Idempotency-Key semantics)', async () => {
    let release!: () => void;
    routes[`POST ${POST}`] = () => new Promise<Response>((res) => { release = () => res(HttpResponse.json(tenantDto(T_GAMMA, 'synthetic_gamma', 'provisioning'), { status: 201 })); });
    await show('tenants/new/page');
    const u = await fillValid();
    await u.dblClick(submit());
    await waitFor(() => expect(callsTo('POST', POST).length).toBeGreaterThan(0));
    release();
    await waitFor(() => expect(pageText()).toContain('Invitation sent'));
    expect(callsTo('POST', POST)).toHaveLength(1);
  });

  it.each(['Synthetic-Gamma', 'ab', '1gamma', 'gamma lab'])('rejects the tenant code %j in the form (pattern ^[a-z][a-z0-9_]{2,31}$) without calling the API', async (code) => {
    await show('tenants/new/page');
    const u = await fillValid(code.slice(0, 40));
    await u.click(submit());
    expect(callsTo('POST', POST)).toHaveLength(0);
    expect(screen.getAllByRole('alert').length + screen.getAllByText(/tenant code/i).length).toBeGreaterThan(0);
  });

  it('caps the tenant code at 32 characters: typing 33 leaves 32 (max of ^[a-z][a-z0-9_]{2,31}$)', async () => {
    await show('tenants/new/page');
    const input = screen.getByLabelText(/^tenant code/i) as HTMLInputElement;
    await userEvent.setup().type(input, 'x'.repeat(33));
    expect(input.value).toBe('x'.repeat(32));
  });

  it('rejects a malformed administrator email and a non-9-digit PAN without calling the API', async () => {
    await show('tenants/new/page');
    const u = await fillValid();
    await u.clear(screen.getByLabelText(/administrator email/i));
    await u.type(screen.getByLabelText(/administrator email/i), 'not-an-email');
    await u.click(submit());
    expect(callsTo('POST', POST)).toHaveLength(0);
    await u.clear(screen.getByLabelText(/administrator email/i));
    await u.type(screen.getByLabelText(/administrator email/i), 'admin@synthetic-gamma.example.test');
    await u.type(screen.getByLabelText(/^pan/i), '12345');
    await u.click(submit());
    expect(callsTo('POST', POST)).toHaveLength(0);
  });

  it('409 identity.code_duplicate stays on the form with an inline message at the code field; nothing else is lost', async () => {
    routes[`POST ${POST}`] = () => problem('identity.code_duplicate', 409);
    await show('tenants/new/page');
    const u = await fillValid('alpha');
    await u.click(submit());
    await waitFor(() => expect(pageText()).toMatch(/already (exists|in use|taken)|duplicate/i));
    expect((screen.getByLabelText(/^legal name/i) as HTMLInputElement).value).toBe('Synthetic Gamma Pvt. Ltd.');
    expect(lastNav()).toBeUndefined();
    expect(screen.queryByText('Invitation sent')).toBeNull();
  });

  it('refuses without platform.tenant.manage (support staff) and makes no API call', async () => {
    resetApi(SUPPORT);
    expect(refused(await showOrThrown('tenants/new/page'))).toBe(true);
    expect(apiCalls()).toBe(0);
  });
});

describe('PL-3 Tenant detail — Overview and lifecycle (AC-E1.3, AC-E2.1; 03-APP-FLOW T2..T5)', () => {
  const ONE = `${P}/tenants/${T_ALPHA}`;
  const open = async (status: string, perms = SUPER) => {
    const saved = { ...routes }; // keep routes registered before open(); resetApi wipes them
    resetApi(perms);
    Object.assign(routes, saved);
    routes[`GET ${ONE}`] = () => HttpResponse.json(tenantDetail(T_ALPHA, 'alpha', status));
    await show('tenants/[tenant_id]/page', { params: { tenant_id: T_ALPHA } });
  };
  const btn = (n: RegExp) => screen.queryByRole('button', { name: n });

  it('tabs: Overview, Settings, Feature flags, IRD annexes, Administrators, Support sessions; Overview shows counts, annex readiness and the status Timeline (history in order)', async () => {
    await open('active');
    expect(screen.getAllByRole('tab').map((t) => norm(t.textContent))).toEqual(['Overview', 'Settings', 'Feature flags', 'IRD annexes', 'Administrators', 'Support sessions']);
    const t = pageText();
    expect(t).toContain('Synthetic alpha');
    expect(t).toMatch(/Users\s*7/); expect(t).toMatch(/Branches\s*2/); expect(t).toMatch(/Centres\s*3/);
    expect(t).toMatch(/incomplete/i);
    expect(t.indexOf('Provisioning')).toBeLessThan(t.lastIndexOf('Active'));
    await axeClean();
  });

  it.each([
    ['provisioning', [/^activate$/i, /^terminate/i], [/^suspend/i, /^reactivate$/i]],
    ['active', [/^suspend/i], [/^activate$/i, /^reactivate$/i, /^terminate/i]],
    ['suspended', [/^reactivate$/i, /^terminate/i], [/^activate$/i, /^suspend/i]],
    ['offboarded', [], [/^activate$/i, /^suspend/i, /^reactivate$/i, /^terminate/i]],
  ])('%s: shows only the legal transitions (T2..T5; offboarded is final)', async (status, shown, hidden) => {
    await open(status);
    for (const n of shown) expect(btn(n), String(n)).not.toBeNull();
    for (const n of hidden) expect(btn(n), String(n)).toBeNull();
  });

  it('support staff (no platform.tenant.manage) sees no lifecycle buttons', async () => {
    await open('active', SUPPORT);
    for (const n of [/^activate$/i, /^suspend/i, /^reactivate$/i, /^terminate/i]) expect(btn(n)).toBeNull();
  });

  it('Activate → POST /activate with If-Match "<version>"; success refreshes', async () => {
    routes[`POST ${ONE}/activate`] = () => HttpResponse.json(tenantDto(T_ALPHA, 'alpha', 'active'));
    await open('provisioning');
    await userEvent.click(btn(/^activate$/i)!);
    const confirm = screen.queryByRole('dialog');
    if (confirm) await userEvent.click(within(confirm).getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/activate`)).toHaveLength(1));
    expect(callsTo('POST', `${ONE}/activate`)[0]!.headers.get('if-match')).toBe('"3"');
    await waitFor(() => expect(router_refreshed()).toBe(true));
  });

  it('409 identity.tenant_not_ready on Activate shows a clear banner and leaves the tenant unchanged (AC-E1.3)', async () => {
    routes[`POST ${ONE}/activate`] = () => problem('identity.tenant_not_ready', 409);
    await open('provisioning');
    await userEvent.click(btn(/^activate$/i)!);
    const confirm = screen.queryByRole('dialog');
    if (confirm) await userEvent.click(within(confirm).getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(pageText()).toMatch(/not ready/i));
    expect(pageText()).toMatch(/administrator/i);
    expect(pageText()).toMatch(/branch/i);
    expect(pageText()).toMatch(/centre/i);
  });

  it('Suspend needs a reason (1–500): empty → no request; with reason → POST /suspend {reason_text} with If-Match', async () => {
    routes[`POST ${ONE}/suspend`] = () => HttpResponse.json(tenantDto(T_ALPHA, 'alpha', 'suspended'));
    await open('active');
    await userEvent.click(btn(/^suspend/i)!);
    const d = dialog();
    await userEvent.click(within(d).getByRole('button', { name: /^suspend/i }));
    expect(callsTo('POST', `${ONE}/suspend`)).toHaveLength(0);
    const reason = within(d).getByRole('textbox', { name: /reason/i }) as HTMLTextAreaElement;
    expect(reason.maxLength).toBe(500);
    await userEvent.type(reason, 'Unpaid invoice 2026-10, ticket TCK-7');
    await userEvent.click(within(d).getByRole('button', { name: /^suspend/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/suspend`)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', `${ONE}/suspend`)[0])).toEqual({ reason_text: 'Unpaid invoice 2026-10, ticket TCK-7' });
    expect(callsTo('POST', `${ONE}/suspend`)[0]!.headers.get('if-match')).toBe('"3"');
  });

  it('Reactivate → POST /reactivate with If-Match', async () => {
    routes[`POST ${ONE}/reactivate`] = () => HttpResponse.json(tenantDto(T_ALPHA, 'alpha', 'active'));
    await open('suspended');
    await userEvent.click(btn(/^reactivate$/i)!);
    const confirm = screen.queryByRole('dialog');
    if (confirm) await userEvent.click(within(confirm).getByRole('button', { name: /^reactivate$/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/reactivate`)).toHaveLength(1));
    expect(callsTo('POST', `${ONE}/reactivate`)[0]!.headers.get('if-match')).toBe('"3"');
  });

  it('Terminate requires a reason AND typing the tenant code exactly; wrong code → no request; right code → POST /terminate {confirm_code, reason_text}', async () => {
    routes[`POST ${ONE}/terminate`] = () => HttpResponse.json(tenantDto(T_ALPHA, 'alpha', 'offboarded'));
    await open('suspended');
    await userEvent.click(btn(/^terminate/i)!);
    const d = dialog();
    expect(within(d).getByRole('button', { name: /^terminate/i })).toBeTruthy();
    await userEvent.type(within(d).getByRole('textbox', { name: /reason/i }), 'Contract ended, ticket TCK-9');
    const code = within(d).getByRole('textbox', { name: /type the tenant code|confirm.*code|tenant code/i });
    await userEvent.type(code, 'alph');
    await userEvent.click(within(d).getByRole('button', { name: /^terminate/i }));
    expect(callsTo('POST', `${ONE}/terminate`)).toHaveLength(0);
    await userEvent.type(code, 'a');
    await userEvent.click(within(d).getByRole('button', { name: /^terminate/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/terminate`)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', `${ONE}/terminate`)[0])).toEqual({ confirm_code: 'alpha', reason_text: 'Contract ended, ticket TCK-9' });
  });

  it('409 common.version_conflict → the reload dialog with exact copy; [Reload] refreshes', async () => {
    routes[`POST ${ONE}/reactivate`] = () => problem('common.version_conflict', 409);
    await open('suspended');
    await userEvent.click(btn(/^reactivate$/i)!);
    const confirm = screen.queryByRole('dialog');
    if (confirm) await userEvent.click(within(confirm).getByRole('button', { name: /^reactivate$/i }));
    await waitFor(() => expect(pageText()).toContain('This record was changed by someone else. Reload to see the latest version.'));
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(router_refreshed() || lastNav() !== undefined).toBe(true);
  });

  it('403 auth.mfa_required → the step-up dialog with the exact copy and a log-in-again button (04-UI-UX §3)', async () => {
    routes[`POST ${ONE}/suspend`] = () => problem('auth.mfa_required', 403);
    await open('active');
    await userEvent.click(btn(/^suspend/i)!);
    const d = dialog();
    await userEvent.type(within(d).getByRole('textbox', { name: /reason/i }), 'Policy breach');
    await userEvent.click(within(d).getByRole('button', { name: /^suspend/i }));
    await waitFor(() => expect(pageText()).toContain('This action needs two-step verification. Log in again with your authenticator code.'));
  });

  it('404 common.not_found → not-found page; refuses without platform.tenant.read before any call', async () => {
    routes[`GET ${ONE}`] = () => problem('common.not_found', 404);
    await expect(show('tenants/[tenant_id]/page', { params: { tenant_id: T_ALPHA } })).rejects.toThrow(/NEXT_NOT_FOUND/);
    resetApi([]);
    expect(refused(await showOrThrown('tenants/[tenant_id]/page', { params: { tenant_id: T_ALPHA } }))).toBe(true);
    expect(apiCalls()).toBe(0);
  });

  it('a malformed tenant_id param never reaches the API (path-injection guard)', async () => {
    for (const bad of ['../../staff', 'alpha', `${T_ALPHA}/suspend`, '%2e%2e']) {
      resetApi(SUPER);
      const msg = await showOrThrown('tenants/[tenant_id]/page', { params: { tenant_id: bad } });
      expect(msg === undefined || /NEXT_NOT_FOUND|NEXT_REDIRECT/.test(msg)).toBe(true);
      expect(apiCalls(), `API called for tenant_id ${bad}`).toBe(0);
    }
  });
});

describe('PL-3 Tenant detail — Settings / Flags / Administrators tabs', () => {
  const ONE = `${P}/tenants/${T_ALPHA}`;
  const SETTINGS = { calendar_display: 'AD_BS', timezone: 'Asia/Kathmandu', idle_timeout_minutes: 30, absolute_session_hours: 8, password_min_length: 12, support_access_mode: 'notify', report_link_ttl_days: 7, release_requires_payment: false, partial_release_allowed: true, letterhead_default: 'with', numbering_prefix: 'ALP', whatsapp_enabled: false, sms_enabled: true, email_enabled: true, ird_pan: '123456789', display_name: 'Synthetic alpha', legal_name_snapshot: 'alpha Legal Pvt. Ltd.', version: 5 };
  beforeEach(async () => {
    routes[`GET ${ONE}`] = () => HttpResponse.json(tenantDetail(T_ALPHA, 'alpha', 'active'));
    routes[`GET ${ONE}/settings`] = () => HttpResponse.json(SETTINGS);
    await show('tenants/[tenant_id]/page', { params: { tenant_id: T_ALPHA } });
  });

  it('Settings tab loads the platform view and saves only the changed field with PATCH + If-Match "<settings version>"', async () => {
    routes[`PATCH ${ONE}/settings`] = () => HttpResponse.json({ ...SETTINGS, ird_pan: '987654321', version: 6 });
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    const pan = (await screen.findByLabelText(/ird pan|^pan/i)) as HTMLInputElement;
    expect(pan.value).toBe('123456789');
    await userEvent.clear(pan); await userEvent.type(pan, '987654321');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PATCH', `${ONE}/settings`)).toHaveLength(1));
    expect(bodyOf(callsTo('PATCH', `${ONE}/settings`)[0])).toEqual({ ird_pan: '987654321' });
    expect(callsTo('PATCH', `${ONE}/settings`)[0]!.headers.get('if-match')).toBe('"5"');
  });

  it('Settings: a server out-of-range error (identity.setting_out_of_range) is shown inline and the form keeps the typed value', async () => {
    routes[`PATCH ${ONE}/settings`] = () => problem('identity.setting_out_of_range', 422);
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    const idle = (await screen.findByLabelText(/idle timeout/i)) as HTMLInputElement;
    await userEvent.clear(idle); await userEvent.type(idle, '9999');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect((screen.getByLabelText(/idle timeout/i) as HTMLInputElement).value).toBe('9999');
  });

  it('Administrators tab: invite an additional tenant admin → POST /admin-invitations {email, display_name}; success toast, no raw invitation link shown', async () => {
    routes[`POST ${ONE}/admin-invitations`] = () => HttpResponse.json({ membership_id: '01a1a98a-ac40-7000-8000-0000000000aa', invitation: { status: 'sent', expires_at: '2026-11-18T04:00:00.000Z' } }, { status: 201 });
    await userEvent.click(screen.getByRole('tab', { name: 'Administrators' }));
    await userEvent.type(await screen.findByLabelText(/^email/i), 'second.admin@synthetic-alpha.example.test');
    await userEvent.type(screen.getByLabelText(/full name|display name/i), 'Second Admin');
    await userEvent.click(screen.getByRole('button', { name: /invite/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/admin-invitations`)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', `${ONE}/admin-invitations`)[0])).toMatchObject({ email: 'second.admin@synthetic-alpha.example.test', display_name: 'Second Admin' });
    expect(callsTo('POST', `${ONE}/admin-invitations`)[0]!.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(pageText()).toMatch(/invitation sent/i));
    expect(pageText()).not.toMatch(/https?:\/\/\S*(token|invite)/i);
  });

  it('Administrators tab: 422/409 from the API (e.g. identity.user_exists) shows an inline error', async () => {
    routes[`POST ${ONE}/admin-invitations`] = () => problem('identity.user_exists', 409);
    await userEvent.click(screen.getByRole('tab', { name: 'Administrators' }));
    await userEvent.type(await screen.findByLabelText(/^email/i), 'second.admin@synthetic-alpha.example.test');
    await userEvent.type(screen.getByLabelText(/full name|display name/i), 'Second Admin');
    await userEvent.click(screen.getByRole('button', { name: /invite/i }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
  });
});

// LD-114 (2026-11-11): the platform read of a tenant's feature flags is NOT approved (CR-C2-T26 items 1-5 rejected; no contract change).
// The Feature-flags tab therefore shows an empty state and makes no request (no listFeatureFlagsAsPlatform, no listTenantFlagsAction).
describe('PL-3 Feature flags tab (LD-114: empty state, no list, no request)', () => {
  const ONE = `${P}/tenants/${T_ALPHA}`;
  let before = 0;
  beforeEach(async () => {
    routes[`GET ${ONE}`] = () => HttpResponse.json(tenantDetail(T_ALPHA, 'alpha', 'active'));
    await show('tenants/[tenant_id]/page', { params: { tenant_id: T_ALPHA } });
    before = apiCalls();
    await userEvent.click(screen.getByRole('tab', { name: 'Feature flags' }));
  });

  it('shows an empty state saying flags cannot be listed on the platform console yet; no switch, no Approval reference field', async () => {
    expect(await screen.findByText(/flags cannot be listed on the platform console yet/i)).toBeTruthy();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryAllByLabelText(/approval reference/i)).toHaveLength(0);
  });

  it('opening the tab makes no API request at all (no feature-flags read, no flag write)', async () => {
    await screen.findByText(/flags cannot be listed on the platform console yet/i);
    expect(apiCalls()).toBe(before);
    expect(callsTo('GET', `${ONE}/feature-flags`)).toHaveLength(0);
  });
});

