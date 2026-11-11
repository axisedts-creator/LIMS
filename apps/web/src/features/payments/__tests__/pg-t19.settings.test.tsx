// @vitest-environment jsdom
// PG-T19 — Payment gateways (settings), route /payments/settings (04-UI-UX §2.6, §6, §7; 01-PRD US-PG-10 AC1–AC5 UI side, US-PG-09 AC7 default-off Khalti refund API;
// 07-SECURITY REQ-SEC-058 write-only secret, ST-13; TRD P20–P23). MSW plays the API.
// ASSUMED contract (dispute via writer if wrong):
//   * features/payments/components/SettingsView.tsx exports `SettingsView({ environment, accounts, settings, permissions })`
//       environment = 'uat' | 'production' (the deployment's LIMS_PAYMENTS_GATEWAY_ENV); accounts = MerchantAccountDto[] for THAT environment (TRD §4); settings = PaymentSettingsDto
//       { refund_two_person_threshold: Money, purchase_order_label, reconciliation_enabled, version }. One kit `Card` (h2 = "eSewa" | "Khalti" | "Fonepay" | "Refunds and labels") each.
//       Secret input: type=password, maxLength 256, never pre-filled; when set the card shows "Set on <date> · fingerprint <8 hex>" and an input labelled "Replace secret key"
//       (CR-C15-011 `SecretField` is not in the kit yet; any component meeting these observable rules passes).
//   * Save → PUT /v1/payments/merchant-accounts/{gateway}/{environment} (If-Match = card version; none when the row is absent), body {is_enabled, esewa_product_code?, khalti_website_url?,
//       api_refunds_enabled?, secret?} — `secret` ONLY when the user typed one; Test → POST …/test; settings Save → PUT /v1/payments/settings {refund_two_person_threshold_paisa,
//       purchase_order_label, reconciliation_enabled} with If-Match = settings.version.
//   * app/(staff)/payments/settings/page.tsx = async server component: GET P20 + P23, deployment env from process.env.LIMS_PAYMENTS_GATEWAY_ENV, passes only allow-listed fields down.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ORIGIN, axeClean, card, isEnabled, noRawCodes, npr, problem, recorder, wrap, type Call } from './pg-t19.helpers';

const refresh = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ current: ['payments.merchant_config.read'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/payments/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.current, displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/settings',
}));

const READ = ['payments.merchant_config.read'];
const MANAGE = [...READ, 'payments.merchant_config.manage'];
const SECRET = 'sk_test_TYPED_SECRET_0123456789';
const esewa = (o: Record<string, unknown> = {}) => ({ gateway: 'esewa', environment: 'uat', is_enabled: true, esewa_product_code: 'LIMS_ESEWA_01', secret: { is_set: true, set_at: '2026-11-10T04:00:00.000Z', fingerprint: 'ab12cd34' }, api_refunds_enabled: false, version: 3, ...o });
const khalti = (o: Record<string, unknown> = {}) => ({ gateway: 'khalti', environment: 'uat', is_enabled: false, khalti_website_url: 'https://lab.example.test', secret: { is_set: true, set_at: '2026-11-10T04:00:00.000Z', fingerprint: 'ef56ab78' }, api_refunds_enabled: false, version: 5, ...o });
const settings = (o: Record<string, unknown> = {}) => ({ refund_two_person_threshold: npr(0), purchase_order_label: 'Synthetic Lab', reconciliation_enabled: true, version: 2, ...o });

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let putAccount: R, testAccount: R, putSettings: R, listAccounts: R;
let accountRows: unknown[] = [esewa(), khalti()];
const reset = () => {
  putAccount = () => HttpResponse.json(esewa({ secret: { is_set: true, set_at: '2026-11-12T04:00:00.000Z', fingerprint: '99aa88bb' }, version: 4 }));
  testAccount = () => HttpResponse.json({ outcome: 'reachable_key_valid', checked_at: '2026-11-12T04:00:00.000Z' });
  putSettings = () => HttpResponse.json(settings({ version: 3 }));
  accountRows = [esewa(), khalti()];
  listAccounts = () => HttpResponse.json({ data: accountRows });
};
reset();
const api = setupServer(
  http.get(`${ORIGIN}/v1/payments/merchant-accounts`, async ({ request }) => { await rec(request); return listAccounts(); }),
  http.put(`${ORIGIN}/v1/payments/merchant-accounts/:gateway/:env`, async ({ request }) => { await rec(request); return putAccount(); }),
  http.post(`${ORIGIN}/v1/payments/merchant-accounts/:gateway/:env/test`, async ({ request }) => { await rec(request); return testAccount(); }),
  http.get(`${ORIGIN}/v1/payments/settings`, async ({ request }) => { await rec(request); return HttpResponse.json(settings()); }),
  http.put(`${ORIGIN}/v1/payments/settings`, async ({ request }) => { await rec(request); return putSettings(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); perms.current = READ; reset(); delete process.env['LIMS_PAYMENTS_GATEWAY_ENV']; });
afterAll(() => api.close());

const comp = async () => ((await import(/* @vite-ignore */ '../components/SettingsView')) as { SettingsView: (p: any) => any }).SettingsView;
const view = async (permissions: readonly string[] = MANAGE, o: { environment?: string; accounts?: unknown[]; settings?: unknown } = {}) => {
  const V = await comp();
  return wrap(<V environment={o.environment ?? 'uat'} accounts={(o.accounts ?? [esewa(), khalti()]) as never} settings={(o.settings ?? settings()) as never} permissions={permissions} />);
};
const puts = (re: RegExp) => calls.filter((c) => c.method === 'PUT' && re.test(c.url.pathname));
const tests = () => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/test'));
const saveIn = (c: HTMLElement) => within(c).queryByRole('button', { name: /^save/i });
const textIn = (c: HTMLElement, name: RegExp) => within(c).getByRole('textbox', { name }) as HTMLInputElement;
const secretIn = (c: HTMLElement) => c.querySelector('input[type="password"]') as HTMLInputElement | null;
const retype = async (el: HTMLInputElement, v: string) => { await userEvent.clear(el); if (v) await userEvent.type(el, v); };
const flip = (c: HTMLElement, name: RegExp) => userEvent.click(within(c).getByRole('switch', { name }));

describe('§2.6 layout', () => {
  it('title; neutral banner "Environment: UAT" / "Environment: Production"; one card each for eSewa, Khalti, Fonepay and "Refunds and labels"', async () => {
    await view(MANAGE, { environment: 'uat' });
    expect(screen.getByRole('heading', { level: 1, name: /payment gateways/i })).toBeTruthy();
    expect(screen.getByText('Environment: UAT')).toBeTruthy();
    for (const n of ['eSewa', 'Khalti', 'Fonepay', 'Refunds and labels']) expect(card(new RegExp(`^${n}$`))).toBeTruthy();
    cleanup();
    await view(MANAGE, { environment: 'production', accounts: [esewa({ environment: 'production' }), khalti({ environment: 'production' })] });
    expect(screen.getByText('Environment: Production')).toBeTruthy();
    expect(screen.queryByText('Environment: UAT')).toBeNull();
  });

  it('eSewa card fields: Enabled switch, Product code (≤ 64), Secret key; Khalti card: Enabled, Website URL (≤ 300, help text), Secret key, "Use Khalti refund API" with its description', async () => {
    await view(MANAGE, { accounts: [] });
    const e = card(/^eSewa$/), k = card(/^Khalti$/);
    expect(within(e).getByRole('switch', { name: /^enabled$/i })).toBeTruthy();
    expect(textIn(e, /product code/i).maxLength).toBe(64);
    expect(within(e).getByText(/^Secret key/)).toBeTruthy();
    expect(within(k).getByRole('switch', { name: /^enabled$/i })).toBeTruthy();
    expect(textIn(k, /website url/i).maxLength).toBe(300);
    expect(within(k).getByText('Khalti requires your website address.')).toBeTruthy();
    expect(within(k).getByRole('switch', { name: /use khalti refund api/i })).toBeTruthy();
    expect(within(k).getByText('Only after the LIMS provider has confirmed the refund API in the sandbox. Otherwise refunds are done in the Khalti dashboard.')).toBeTruthy();
  });

  it('"Refunds and labels" card: Two-person threshold (help text), Order label sent to Khalti (≤ 50, help text), Nightly reconciliation', async () => {
    await view();
    const c = card(/^Refunds and labels$/);
    expect(within(c).getByRole('textbox', { name: /two-person threshold/i })).toBeTruthy();
    expect(within(c).getByText('Refunds above this amount always need a second approver. 0 = always.')).toBeTruthy();
    expect(textIn(c, /order label sent to khalti/i).maxLength).toBe(50);
    expect(within(c).getByText('Shown to the patient on the Khalti page. Do not include patient or test names.')).toBeTruthy();
    expect(within(c).getByRole('switch', { name: /nightly reconciliation/i })).toBeTruthy();
  });
});

describe('AC-PG-10.1 / REQ-SEC-058 / ST-13 — the secret is write-only', () => {
  it('a set secret shows only "Set on <date> · fingerprint ab12cd34" and an EMPTY password input labelled "Replace secret key"', async () => {
    await view();
    const c = card(/^eSewa$/);
    expect(c.textContent).toMatch(/Set on .*10\/11\/2026.* · fingerprint ab12cd34/);
    const s = secretIn(c)!;
    expect(s).toBeTruthy();
    expect(s.value).toBe('');
    expect(within(c).getByLabelText(/replace secret key/i)).toBe(s);
    expect(['off', 'new-password']).toContain(s.getAttribute('autocomplete'));
    expect(s.maxLength).toBe(256);
  });

  it('a not-yet-set secret: input labelled "Secret key" (password), no "Set on" text', async () => {
    await view(MANAGE, { accounts: [esewa({ secret: { is_set: false } })] });
    const c = card(/^eSewa$/);
    expect(c.textContent).not.toMatch(/Set on|fingerprint/);
    expect(within(c).getByLabelText(/^secret key/i)).toBe(secretIn(c));
  });

  it('never displays, copies or pre-fills a secret even if the API leaks one; no show / reveal / copy control exists', async () => {
    const leaky = esewa({ secret: { is_set: true, fingerprint: 'ab12cd34', set_at: '2026-11-10T04:00:00.000Z', value: 'sk_live_LEAK_A' }, secret_plain: 'sk_live_LEAK_B', secret_ciphertext: 'c2VjcmV0LWxlYWs=' });
    const { container } = await view(MANAGE, { accounts: [leaky, khalti({ secret: { is_set: true, fingerprint: 'ef56ab78', set_at: '2026-11-10T04:00:00.000Z' }, secret_key: 'sk_live_LEAK_C' })] });
    expect(container.innerHTML).not.toMatch(/LEAK|c2VjcmV0/);
    for (const i of container.querySelectorAll<HTMLInputElement>('input')) expect(i.value).not.toMatch(/LEAK/);
    expect(screen.queryByRole('button', { name: /show|reveal|copy/i })).toBeNull();
  });

  it('typing a secret and saving PUTs it once, in the body only; afterwards the input is empty and the typed value appears nowhere (DOM, toast, URL)', async () => {
    await view();
    const c = card(/^eSewa$/);
    await userEvent.type(secretIn(c)!, SECRET);
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/merchant-accounts\/esewa\/uat$/)).toHaveLength(1));
    const p = puts(/esewa\/uat$/)[0]!;
    expect(p.body.secret).toBe(SECRET);
    expect(p.url.href).not.toContain(SECRET);
    expect(p.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(secretIn(card(/^eSewa$/))!.value).toBe('');
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('saving without typing a secret sends NO `secret` key (the stored one is kept) and only allow-listed fields', async () => {
    await view();
    await userEvent.click(saveIn(card(/^eSewa$/))!);
    await waitFor(() => expect(puts(/esewa\/uat$/)).toHaveLength(1));
    const b = puts(/esewa\/uat$/)[0]!.body;
    expect('secret' in b).toBe(false);
    expect(b).toMatchObject({ is_enabled: true, esewa_product_code: 'LIMS_ESEWA_01' });
    expect(Object.keys(b).every((k) => ['is_enabled', 'esewa_product_code', 'khalti_website_url', 'api_refunds_enabled', 'secret'].includes(k))).toBe(true);
  });

  it('a failed save does not leave the typed secret anywhere in the page text or error message', async () => {
    putAccount = () => problem('common.validation_failed', 400, { detail: `bad ${SECRET}` });
    await view();
    const c = card(/^eSewa$/);
    await userEvent.type(secretIn(c)!, SECRET);
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/esewa\/uat$/)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).not.toContain(SECRET);
    noRawCodes();
  });

  it('If-Match = the card version; an absent row is created without If-Match', async () => {
    await view();
    await userEvent.click(saveIn(card(/^eSewa$/))!);
    await waitFor(() => expect(puts(/esewa\/uat$/)).toHaveLength(1));
    expect(puts(/esewa\/uat$/)[0]!.headers.get('if-match')).toMatch(/3/);
    cleanup();
    calls.length = 0;
    await view(MANAGE, { accounts: [] });
    const c = card(/^eSewa$/);
    await userEvent.type(textIn(c, /product code/i), 'NEW_CODE_1');
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/esewa\/uat$/)).toHaveLength(1));
    expect(puts(/esewa\/uat$/)[0]!.headers.get('if-match')).toBeNull();
  });
});

describe('AC-PG-10.3 environment rules and validation', () => {
  it('production: product code EPAYTEST is refused client-side (nothing sent); UAT: accepted', async () => {
    await view(MANAGE, { environment: 'production', accounts: [esewa({ environment: 'production', esewa_product_code: 'LIVE_CODE' })] });
    let c = card(/^eSewa$/);
    await retype(textIn(c, /product code/i), 'EPAYTEST');
    await userEvent.click(saveIn(c)!);
    expect(puts(/esewa/)).toHaveLength(0);
    expect(c.querySelector('[aria-invalid="true"]')).toBeTruthy();
    cleanup();
    await view(MANAGE, { environment: 'uat' });
    c = card(/^eSewa$/);
    await retype(textIn(c, /product code/i), 'EPAYTEST');
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/esewa\/uat$/)).toHaveLength(1));
    expect(puts(/esewa\/uat$/)[0]!.body.esewa_product_code).toBe('EPAYTEST');
  });

  it('PUT goes to the deployment environment only (production ⇒ …/esewa/production), never the other one', async () => {
    await view(MANAGE, { environment: 'production', accounts: [esewa({ environment: 'production' }), khalti({ environment: 'production' })] });
    await userEvent.click(saveIn(card(/^eSewa$/))!);
    await waitFor(() => expect(puts(/esewa/)).toHaveLength(1));
    expect(puts(/esewa/)[0]!.url.pathname).toBe('/v1/payments/merchant-accounts/esewa/production');
    expect(calls.some((c) => /\/uat(\/|$)/.test(c.url.pathname))).toBe(false);
  });

  it.each(['bad code!', 'has space', 'x<y>', ''])('product code %j (not ^[A-Za-z0-9_-]+$ / empty while enabled) sends nothing', async (bad) => {
    await view();
    const c = card(/^eSewa$/);
    await retype(textIn(c, /product code/i), bad);
    await userEvent.click(saveIn(c)!);
    expect(puts(/esewa/)).toHaveLength(0);
  });

  it('enabling without a stored secret and without a typed one is blocked (nothing sent); with a typed secret + product code it is sent', async () => {
    await view(MANAGE, { accounts: [esewa({ is_enabled: false, secret: { is_set: false } })] });
    const c = card(/^eSewa$/);
    await flip(c, /^enabled$/i);
    await userEvent.click(saveIn(c)!);
    expect(puts(/esewa/)).toHaveLength(0);
    expect(c.querySelector('[aria-invalid="true"]')).toBeTruthy();
    await userEvent.type(secretIn(c)!, SECRET);
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/esewa/)).toHaveLength(1));
    expect(puts(/esewa/)[0]!.body).toMatchObject({ is_enabled: true, esewa_product_code: 'LIMS_ESEWA_01', secret: SECRET });
  });

  it('Khalti website URL must be https: http://, javascript: and non-URLs send nothing; https is accepted', async () => {
    await view();
    const c = card(/^Khalti$/);
    for (const bad of ['http://lab.example.test', 'javascript:alert(1)', 'lab.example.test', 'ftp://lab.example.test']) {
      await retype(textIn(c, /website url/i), bad);
      await userEvent.click(saveIn(c)!);
    }
    expect(puts(/khalti/)).toHaveLength(0);
    await retype(textIn(c, /website url/i), 'https://lab.example.test/home');
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/khalti\/uat$/)).toHaveLength(1));
    expect(puts(/khalti\/uat$/)[0]!.body.khalti_website_url).toBe('https://lab.example.test/home');
  });

  it('AC-PG-09.7 UI: "Use Khalti refund API" is OFF by default and is sent as api_refunds_enabled (false unless the admin turns it on)', async () => {
    await view(MANAGE, { accounts: [] });
    const c = card(/^Khalti$/);
    const sw = within(c).getByRole('switch', { name: /use khalti refund api/i }) as HTMLInputElement;
    expect(sw.checked ?? sw.getAttribute('aria-checked') === 'true').toBeFalsy();
    await userEvent.type(textIn(c, /website url/i), 'https://lab.example.test');
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/khalti/)).toHaveLength(1));
    expect(puts(/khalti/)[0]!.body.api_refunds_enabled ?? false).toBe(false);
    calls.length = 0;
    await flip(c, /use khalti refund api/i);
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/khalti/)).toHaveLength(1));
    expect(puts(/khalti/)[0]!.body.api_refunds_enabled).toBe(true);
  });

  it('server 400 common.validation_failed ⇒ plain inline text, no raw code; 409 common.version_conflict ⇒ "changed / reload" guidance', async () => {
    putAccount = () => problem('common.validation_failed', 400);
    await view();
    await userEvent.click(saveIn(card(/^eSewa$/))!);
    await waitFor(() => expect(puts(/esewa/)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    noRawCodes();
    expect(document.querySelector('[role="alert"], [aria-invalid="true"], .lims-banner')).toBeTruthy();
    cleanup();
    putAccount = () => problem('common.version_conflict', 409);
    await view();
    await userEvent.click(saveIn(card(/^eSewa$/))!);
    expect(await screen.findByText(/changed|reload/i)).toBeTruthy();
    noRawCodes();
  });

  it('a double click on Save sends one request only (race / double submit)', async () => {
    putAccount = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(esewa({ version: 4 })); };
    await view();
    await userEvent.dblClick(saveIn(card(/^eSewa$/))!);
    await new Promise((r) => setTimeout(r, 250));
    expect(puts(/esewa/)).toHaveLength(1);
  });
});

describe('AC-PG-10.2 Test connection (P22) — outcome texts', () => {
  const testBtn = (c: HTMLElement) => within(c).getByRole('button', { name: /test connection/i });
  it.each([
    ['khalti', 'reachable_key_valid', 'Khalti accepted the key.'],
    ['esewa', 'reachable_key_unverifiable', 'eSewa is reachable. eSewa does not let us check the secret key without a real payment — make a small test payment in UAT before going live.'],
    ['khalti', 'auth_failed', 'The provider rejected the key.'],
    ['esewa', 'unreachable', 'Could not reach the provider. Try again later.'],
  ])('%s / %s ⇒ "%s" (HTTP 200 body, not an error code)', async (gateway, outcome, text) => {
    testAccount = () => HttpResponse.json({ outcome, checked_at: '2026-11-12T04:00:00.000Z' });
    await view();
    await userEvent.click(testBtn(card(gateway === 'esewa' ? /^eSewa$/ : /^Khalti$/)));
    await waitFor(() => expect(tests()).toHaveLength(1));
    expect(tests()[0]!.url.pathname).toBe(`/v1/payments/merchant-accounts/${gateway}/uat/test`);
    expect(tests()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(await screen.findByText(text)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/reachable_key|auth_failed|unreachable\b/);
  });

  it('the test never sends the secret or any typed value (body empty)', async () => {
    await view();
    const c = card(/^eSewa$/);
    await userEvent.type(secretIn(c)!, SECRET);
    await userEvent.click(testBtn(c));
    await waitFor(() => expect(tests()).toHaveLength(1));
    expect(JSON.stringify(tests()[0]!.body ?? {})).not.toContain(SECRET);
  });

  it('a double click runs one test only', async () => {
    testAccount = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json({ outcome: 'reachable_key_valid', checked_at: '2026-11-12T04:00:00.000Z' }); };
    await view();
    await userEvent.dblClick(testBtn(card(/^Khalti$/)));
    await new Promise((r) => setTimeout(r, 250));
    expect(tests()).toHaveLength(1);
  });

  it('transport/API failure of the test call itself ⇒ plain text, no raw code', async () => {
    testAccount = () => problem('common.dependency_unavailable', 503);
    await view();
    await userEvent.click(testBtn(card(/^Khalti$/)));
    await waitFor(() => expect(tests()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    noRawCodes();
  });
});

describe('AC-PG-10.4 Fonepay (blocked B8)', () => {
  it('every input is disabled, nothing can be saved or tested, and the card says why', async () => {
    await view(MANAGE, { accounts: [esewa(), khalti(), { gateway: 'fonepay', environment: 'uat', is_enabled: false, secret: { is_set: false }, api_refunds_enabled: false, version: 1 }] });
    const c = card(/^Fonepay$/);
    expect(within(c).getByText('Waiting for the Fonepay merchant integration document from your bank (blocker B8).')).toBeTruthy();
    for (const i of c.querySelectorAll<HTMLInputElement>('input, textarea, select')) expect(i.disabled || i.readOnly, i.outerHTML).toBe(true);
    for (const s of within(c).queryAllByRole('switch')) expect(isEnabled(s)).toBe(false);
    for (const b of within(c).queryAllByRole('button')) expect(isEnabled(b), b.textContent ?? '').toBe(false);
  });
  it('even a hand-fired click on a Fonepay control sends no request', async () => {
    await view();
    const c = card(/^Fonepay$/);
    for (const b of within(c).queryAllByRole('button')) await userEvent.click(b);
    expect(calls.filter((x) => /fonepay/.test(x.url.pathname))).toHaveLength(0);
  });
  it('never says Fonepay is live or verified', async () => {
    await view();
    expect(document.body.textContent).not.toMatch(/Fonepay[^.]{0,30}(verified|live and|is live)|Payment successful/i);
  });
});

describe('AC-PG-10.5 permissions', () => {
  it('without payments.merchant_config.manage: values are visible, but no field is editable and Save / Test connection are absent or disabled', async () => {
    await view(READ);
    expect(card(/^eSewa$/).textContent).toMatch(/fingerprint ab12cd34/);
    for (const i of document.querySelectorAll<HTMLInputElement>('input, textarea')) expect(i.disabled || i.readOnly, i.outerHTML).toBe(true);
    for (const b of screen.queryAllByRole('button', { name: /^save|test connection/i })) expect(isEnabled(b), b.textContent ?? '').toBe(false);
    for (const s of screen.queryAllByRole('switch')) expect(isEnabled(s)).toBe(false);
  });
  it('with manage: eSewa / Khalti / settings Save and Test connection are enabled', async () => {
    await view(MANAGE);
    for (const n of [/^eSewa$/, /^Khalti$/, /^Refunds and labels$/]) expect(isEnabled(saveIn(card(n)))).toBe(true);
    expect(isEnabled(within(card(/^eSewa$/)).getByRole('button', { name: /test connection/i }))).toBe(true);
  });
  it('403 auth.forbidden from the API (stale permissions) ⇒ plain permission text, no raw code', async () => {
    putAccount = () => problem('auth.forbidden', 403);
    await view(MANAGE);
    await userEvent.click(saveIn(card(/^eSewa$/))!);
    expect(await screen.findByText(/permission/i)).toBeTruthy();
    noRawCodes();
  });
});

describe('§2.6 "Refunds and labels" (P23)', () => {
  const open = async () => { await view(MANAGE); return card(/^Refunds and labels$/); };
  it('Save PUTs /v1/payments/settings {refund_two_person_threshold_paisa (integer), purchase_order_label, reconciliation_enabled} with If-Match = settings.version', async () => {
    const c = await open();
    await retype(textIn(c, /two-person threshold/i), '5,000.00');
    await retype(textIn(c, /order label sent to khalti/i), 'Synthetic Lab (Main)');
    await flip(c, /nightly reconciliation/i);
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/\/v1\/payments\/settings$/)).toHaveLength(1));
    const p = puts(/settings$/)[0]!;
    expect(p.body).toEqual({ refund_two_person_threshold_paisa: 500000, purchase_order_label: 'Synthetic Lab (Main)', reconciliation_enabled: false });
    expect(p.headers.get('if-match')).toMatch(/2/);
    expect(p.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it.each(['', 'Ali <script>', 'Patient: Ram', 'semi;colon'])('order label %j (empty or outside ^[A-Za-z0-9 .,&()-]+$; > 50 is covered by the maxLength assertion) sends nothing', async (bad) => {
    const c = await open();
    await retype(textIn(c, /order label sent to khalti/i), bad.slice(0, 80));
    await userEvent.click(saveIn(c)!);
    expect(puts(/settings$/)).toHaveLength(0);
  });
  it('a negative / non-numeric threshold is never submitted; 0 is allowed ("0 = always")', async () => {
    const c = await open();
    for (const bad of ['-1', 'abc']) { await retype(textIn(c, /two-person threshold/i), bad); await userEvent.click(saveIn(c)!); }
    expect(puts(/settings$/).filter((p) => p.body.refund_two_person_threshold_paisa < 0 || !Number.isInteger(p.body.refund_two_person_threshold_paisa))).toHaveLength(0);
    await retype(textIn(c, /two-person threshold/i), '0');
    await userEvent.click(saveIn(c)!);
    await waitFor(() => expect(puts(/settings$/).at(-1)?.body.refund_two_person_threshold_paisa).toBe(0));
  });
  it('without manage the settings card cannot be saved', async () => {
    await view(READ);
    const c = document.body.textContent?.includes('Refunds and labels') ? card(/^Refunds and labels$/) : null;
    if (c) expect(isEnabled(saveIn(c))).toBe(false);
  });
});

describe('§6 a11y', () => {
  it('axe: no violations (manage, read-only, production, with an error shown)', async () => {
    await view(MANAGE);
    await axeClean();
    cleanup();
    await view(READ);
    await axeClean();
    cleanup();
    await view(MANAGE, { environment: 'production', accounts: [esewa({ environment: 'production' })] });
    await axeClean();
    cleanup();
    putAccount = () => problem('common.validation_failed', 400);
    await view(MANAGE);
    await userEvent.click(saveIn(card(/^eSewa$/))!);
    await waitFor(() => expect(puts(/esewa/)).toHaveLength(1));
    await axeClean();
  });
});

type SP = Record<string, string | string[] | undefined>;
const loadPage = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/payments/settings/page')) as { default: (p?: { searchParams?: Promise<SP> }) => Promise<any> }).default;
const show = async () => { const Page = await loadPage(); return wrap(await Page({ searchParams: Promise.resolve({}) })); };

describe('settings page.tsx — requests (P20 / P23)', () => {
  it('no payments.merchant_config.read ⇒ not found and no API call at all', async () => {
    perms.current = [];
    await expect(show()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('GET P20 + P23 with the Bearer token (never in the DOM); shows only the deployment environment — the other environment\'s data is not rendered', async () => {
    process.env['LIMS_PAYMENTS_GATEWAY_ENV'] = 'production';
    perms.current = MANAGE;
    accountRows = [esewa({ environment: 'production', esewa_product_code: 'PROD_CODE_77' }), esewa({ environment: 'uat', esewa_product_code: 'UAT_ONLY_CODE' }), khalti({ environment: 'production' }), khalti({ environment: 'uat', khalti_website_url: 'https://uat-only.example.test' })];
    const { container } = await show();
    expect(calls.some((c) => c.url.pathname === '/v1/payments/merchant-accounts')).toBe(true);
    expect(calls.some((c) => c.url.pathname === '/v1/payments/settings')).toBe(true);
    expect(calls.every((c) => c.headers.get('authorization') === 'Bearer jwt-synthetic')).toBe(true);
    expect(container.innerHTML).not.toContain('jwt-synthetic');
    expect(screen.getByText('Environment: Production')).toBeTruthy();
    expect(textIn(card(/^eSewa$/), /product code/i).value).toBe('PROD_CODE_77');
    expect(container.innerHTML).not.toMatch(/UAT_ONLY_CODE|uat-only\.example/);
  });

  it('UAT deployment shows the UAT rows (and not the production ones)', async () => {
    process.env['LIMS_PAYMENTS_GATEWAY_ENV'] = 'uat';
    perms.current = MANAGE;
    accountRows = [esewa({ environment: 'production', esewa_product_code: 'PROD_CODE_77' }), esewa({ environment: 'uat', esewa_product_code: 'UAT_ONLY_CODE' })];
    await show();
    expect(screen.getByText('Environment: UAT')).toBeTruthy();
    expect(textIn(card(/^eSewa$/), /product code/i).value).toBe('UAT_ONLY_CODE');
    expect(document.body.innerHTML).not.toContain('PROD_CODE_77');
  });

  it('allow-list at the server → client boundary: secret-looking fields the API should never send are not passed down (props contain no LEAK)', async () => {
    process.env['LIMS_PAYMENTS_GATEWAY_ENV'] = 'uat';
    perms.current = MANAGE;
    accountRows = [esewa({ secret: { is_set: true, fingerprint: 'ab12cd34', set_at: '2026-11-10T04:00:00.000Z', value: 'LEAK_1' }, secret_plain: 'LEAK_2', secret_ciphertext: 'LEAK_3', secret_nonce: 'LEAK_4' })];
    const Page = await loadPage();
    const tree = await Page({ searchParams: Promise.resolve({}) });
    expect(JSON.stringify(tree)).not.toMatch(/LEAK/);
    wrap(tree);
    expect(document.body.innerHTML).not.toMatch(/LEAK/);
  });

  it('API 403 shows no account data; API 5xx rejects so error.tsx renders', async () => {
    process.env['LIMS_PAYMENTS_GATEWAY_ENV'] = 'uat';
    perms.current = MANAGE;
    listAccounts = () => problem('auth.forbidden', 403);
    try { await show(); } catch { /* may reject or render a denied state */ }
    expect(document.body.textContent).not.toMatch(/LIMS_ESEWA_01|fingerprint/);
    cleanup();
    listAccounts = () => problem('common.dependency_unavailable', 503);
    await expect(show()).rejects.toBeTruthy();
  });

  it('axe: page output has no violations', async () => { process.env['LIMS_PAYMENTS_GATEWAY_ENV'] = 'uat'; perms.current = MANAGE; await show(); await axeClean(); });
});
