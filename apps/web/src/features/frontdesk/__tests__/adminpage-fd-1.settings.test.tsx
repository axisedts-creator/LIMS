// @vitest-environment jsdom
// ADMINPAGE-FD-1 — /frontdesk/settings (C4 04-UI-UX 8.11 front desk part, F24 getFrontdeskSettings / updateFrontdeskSettings, LD-246, LD-255).
// Tested through the real page (async server component) + the real BFF/server-action chain against a mocked API (msw), as fd-t14.pages does:
//   page: apps/web/src/app/(staff)/frontdesk/settings/page.tsx, default export async ({searchParams?}) => element; session perms from getShellSession().
//   GET  /v1/frontdesk/settings  -> FrontdeskSettings (9 fields + version)
//   PUT  /v1/frontdesk/settings  -> If-Match `"<version>"`, body = the 9 fields (version optional and ignored by the API), returns the new FrontdeskSettings.
// Field labels use the spec wording of 04-UI-UX 8.11 (case-insensitive): "Discount self-limit (%)", "Discount self-limit (NPR)", "Absolute max %",
// "Require referrer", "Consent text version", "Registration SMS", "Label auto-print", "Buyer PAN pattern", "Search min chars"; a "Save" button.
// Units: percent fields are whole percent in the UI and basis points in the API (x100); NPR is rupees in the UI and integer paisa in the API (MoneyField).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const ORIGIN = 'http://api.test';
const MANAGE = 'frontdesk.settings.manage';
const S = `${ORIGIN}/v1/frontdesk/settings`;
const CONFLICT_COPY = 'This record was changed by someone else. Reload to see the latest version.';

const session = { perms: [] as string[] };
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
  discount_self_limit_bp: 500, discount_self_limit_paisa: 250000, discount_absolute_max_bp: 2000, require_referrer: false,
  consent_text_version: 'v3', registration_sms_enabled: true, label_autoprint: false, buyer_pan_pattern: '^[0-9]{9}$', patient_search_min_chars: 3, version: 7, ...o,
});
const FIELDS = ['discount_self_limit_bp', 'discount_self_limit_paisa', 'discount_absolute_max_bp', 'require_referrer', 'consent_text_version', 'registration_sms_enabled', 'label_autoprint', 'buyer_pan_pattern', 'patient_search_min_chars'];
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
const api = setupServer(http.get(S, getHandler), http.put(S, putOk));
beforeAll(() => api.listen({ onUnhandledRequest: 'error' })); // any other operation than F24 fails the test
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); session.perms = []; current = settings(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const SEG = 'settings'; // the page may not exist yet: resolved at run time so the suite fails per test (page missing), not at collection
const pageModule = async () => (await import(/* @vite-ignore */ `../../../app/(staff)/frontdesk/${SEG}/page`)) as { default: (p: any) => Promise<ReactNode> };
async function open(perms: string[] = [MANAGE]) {
  session.perms = perms;
  const { default: Page } = await pageModule();
  wrap(await Page({ searchParams: Promise.resolve({}) }));
  return userEvent.setup();
}
const L = {
  selfPct: /discount self-limit\s*\(?\s*%/i, selfNpr: /discount self-limit\s*\(?\s*npr/i, absMax: /absolute max/i, referrer: /require referrer/i,
  consent: /consent text version/i, sms: /registration sms/i, label: /label auto-?print/i, pan: /buyer pan pattern/i, minChars: /search min/i,
};
const field = (re: RegExp) => screen.getByLabelText(re) as HTMLInputElement;
const isOn = (el: HTMLElement) => ((el as HTMLInputElement).checked ?? el.getAttribute('aria-checked') === 'true') === true;
const saveBtn = () => screen.getByRole('button', { name: /^save/i });
const setText = async (user: ReturnType<typeof userEvent.setup>, re: RegExp, v: string) => { const el = field(re); await user.clear(el); if (v) await user.type(el, v); };
const alertText = () => [...document.querySelectorAll('[role="alert"],[role="alertdialog"]')].map((e) => e.textContent ?? '').join(' | ');
const statusText = () => [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? '').join(' | ');
const describedText = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
const expectNoBadPut = () => {
  for (const p of puts()) {
    const b = p.body;
    for (const k of ['discount_self_limit_bp', 'discount_absolute_max_bp']) { expect(Number.isInteger(b[k]) && b[k] >= 0 && b[k] <= 10000, `${k}=${b[k]} sent`).toBe(true); }
    expect(Number.isInteger(b.discount_self_limit_paisa) && b.discount_self_limit_paisa >= 0, 'paisa').toBe(true);
    expect([...String(b.consent_text_version)].length >= 1 && [...String(b.consent_text_version)].length <= 32, 'consent length').toBe(true);
    expect(String(b.buyer_pan_pattern).length <= 200, 'pan length').toBe(true);
    expect(Number.isInteger(b.patient_search_min_chars) && b.patient_search_min_chars >= 1 && b.patient_search_min_chars <= 100, 'min chars').toBe(true);
    expect(b.discount_self_limit_bp <= b.discount_absolute_max_bp, 'self-limit above absolute max sent').toBe(true);
    expect(() => new RegExp(b.buyer_pan_pattern), 'invalid regex sent').not.toThrow();
  }
};

describe('load (getFrontdeskSettings)', () => {
  it('reads F24 once with the bearer token and shows every spec field with its current value (bp -> %, paisa -> NPR)', async () => {
    await open();
    expect(gets()).toHaveLength(1);
    expect(gets()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(field(L.selfPct).value).toBe('5');
    expect(field(L.selfNpr).value).toMatch(/^2,?500(\.00)?$/);
    expect(field(L.absMax).value).toBe('20');
    expect(isOn(field(L.referrer))).toBe(false);
    expect(field(L.consent).value).toBe('v3');
    expect(isOn(field(L.sms))).toBe(true);
    expect(isOn(field(L.label))).toBe(false);
    expect(field(L.pan).value).toBe('^[0-9]{9}$');
    expect(field(L.minChars).value).toBe('3');
    expect(saveBtn()).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });

  it('a stored bp that is not a whole percent (1250 = 12.5 %) is shown exactly and an untouched save sends 1250 back (no silent rounding)', async () => {
    current = settings({ discount_self_limit_bp: 1250, discount_absolute_max_bp: 5000 });
    const user = await open();
    expect(field(L.selfPct).value).toBe('12.5');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.discount_self_limit_bp).toBe(1250);
  });

  it('a 5xx on load is not hidden: the page promise rejects so error.tsx renders (never a blank or default form)', async () => {
    session.perms = [MANAGE];
    api.use(http.get(S, () => problem(500, 'common.internal')));
    const { default: Page } = await pageModule();
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeTruthy();
  });
});

describe('save (updateFrontdeskSettings)', () => {
  it('edits every field, PUTs the 9 fields once with If-Match "<version>", converts % -> bp and NPR -> integer paisa, shows role=status success and no alert', async () => {
    const user = await open();
    await setText(user, L.selfPct, '10');
    await setText(user, L.selfNpr, '3000.50');
    await setText(user, L.absMax, '25');
    await user.click(field(L.referrer));
    await setText(user, L.consent, 'v4');
    await user.click(field(L.sms));
    await user.click(field(L.label));
    await setText(user, L.pan, '^[0-9]{10}$');
    await setText(user, L.minChars, '4');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const p = puts()[0]!;
    expect(p.headers.get('if-match')).toBe('"7"');
    const { version: _v, ...body } = p.body;
    expect(body).toEqual({
      discount_self_limit_bp: 1000, discount_self_limit_paisa: 300050, discount_absolute_max_bp: 2500, require_referrer: true, consent_text_version: 'v4',
      registration_sms_enabled: false, label_autoprint: true, buyer_pan_pattern: '^[0-9]{10}$', patient_search_min_chars: 4,
    });
    expect(Object.keys(body).sort()).toEqual([...FIELDS].sort());
    const key = p.headers.get('idempotency-key');
    if (key) expect(key).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    await waitFor(() => expect(statusText()).toMatch(/saved/i));
    expect(alertText()).toBe('');
  });

  it('the next save sends If-Match from the response of the previous one (7 -> 8), not the stale page version', async () => {
    const user = await open();
    await setText(user, L.consent, 'v4');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
    await waitFor(() => expect(statusText()).toMatch(/saved/i));
    await setText(user, L.consent, 'v5');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts().map((c) => c.headers.get('if-match'))).toEqual(['"7"', '"8"']);
  });

  it('a double click while the request is in flight sends ONE PUT (no duplicate write) and the button cannot be re-entered', async () => {
    let n = 0;
    api.use(http.put(S, async ({ request }) => { n++; await rec(request); await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(settings({ version: 8 })); }));
    const user = await open();
    await user.dblClick(saveBtn());
    await waitFor(() => expect(statusText()).toMatch(/saved/i));
    expect(n).toBe(1);
  });
});

describe('validation (matches the operation schema; nothing invalid is ever sent)', () => {
  it('self-limit % above the absolute max % is refused client-side: no PUT, role=alert names both fields, the field is aria-invalid and aria-describedby carries the text', async () => {
    const user = await open();
    await setText(user, L.selfPct, '50');
    await setText(user, L.absMax, '20');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).toMatch(/self-limit/i));
    expect(alertText()).toMatch(/absolute max/i);
    expect(puts()).toHaveLength(0);
    const el = field(L.selfPct);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(el)).toMatch(/absolute max|self-limit/i);
  });

  it.each([
    ['discount self-limit %', 'selfPct', '101'], ['absolute max %', 'absMax', '101'],
  ] as const)('%s above 100 is never sent (refused with an alert, or held to 100)', async (_n, key, bad) => {
    const user = await open();
    await setText(user, L.absMax, '100');
    await setText(user, L[key], bad);
    await user.click(saveBtn());
    await new Promise((r) => setTimeout(r, 100));
    expectNoBadPut();
    if (puts().length === 0) expect(alertText()).not.toBe('');
  });

  it('negative or non-numeric NPR / percent / min chars never reach the API', async () => {
    const user = await open();
    await setText(user, L.selfNpr, '-5');
    await setText(user, L.selfPct, '-3');
    await setText(user, L.minChars, '-1');
    await user.click(saveBtn());
    await new Promise((r) => setTimeout(r, 100));
    expectNoBadPut();
    if (puts().length === 0) expect(alertText()).not.toBe('');
  });

  it('search min chars 0 and 101 are outside 1..100 and never sent', async () => {
    const user = await open();
    for (const bad of ['0', '101']) { await setText(user, L.minChars, bad); await user.click(saveBtn()); }
    await new Promise((r) => setTimeout(r, 100));
    expectNoBadPut();
  });

  it('empty consent text version is refused (required, 1..32): no PUT and an alert; 33 characters are never sent', async () => {
    const user = await open();
    await setText(user, L.consent, '');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).not.toBe(''));
    expect(puts()).toHaveLength(0);
    expect(describedText(field(L.consent))).not.toBe('');
    await setText(user, L.consent, 'x'.repeat(33));
    await user.click(saveBtn());
    await new Promise((r) => setTimeout(r, 100));
    expectNoBadPut();
  });

  it('a buyer PAN pattern that is not a valid regular expression is refused as the API says (no PUT, alert names the field); a valid one is saved', async () => {
    const user = await open();
    await setText(user, L.pan, '([');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).toMatch(/pan/i));
    expect(puts()).toHaveLength(0);
    expect(field(L.pan).getAttribute('aria-invalid')).toBe('true');
    await setText(user, L.pan, '^[0-9]{9}$');
    await user.click(saveBtn());
    await waitFor(() => expect(puts()).toHaveLength(1));
  });

  it('a PAN pattern longer than 200 characters is never sent', async () => {
    const user = await open();
    await setText(user, L.pan, 'a'.repeat(201));
    await user.click(saveBtn());
    await new Promise((r) => setTimeout(r, 100));
    expectNoBadPut();
  });

  it('server 400 common.validation_failed with errors[].path -> inline role=alert text on THAT field (aria-invalid + aria-describedby), focus moves to it, no raw code shown', async () => {
    api.use(http.put(S, async ({ request }) => { await rec(request); return problem(400, 'common.validation_failed', { errors: [{ path: '/patient_search_min_chars', code: 'common.field_invalid', message: 'out of range' }] }); }));
    const user = await open();
    await setText(user, L.minChars, '1');
    await user.click(saveBtn());
    await waitFor(() => expect(field(L.minChars).getAttribute('aria-invalid')).toBe('true'));
    expect(describedText(field(L.minChars))).not.toBe('');
    expect(alertText()).not.toBe('');
    expect(alertText()).not.toContain('common.validation_failed');
    expect(document.activeElement).toBe(field(L.minChars));
    expect(statusText()).not.toMatch(/saved/i);
  });
});

describe('failures after Save', () => {
  it('409 common.version_conflict -> the shared reload message in a role=alert/alertdialog, the typed edit is kept, exactly one PUT, Reload refetches', async () => {
    api.use(http.put(S, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    const user = await open();
    await setText(user, L.consent, 'v9');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).toContain(CONFLICT_COPY));
    expect(puts()).toHaveLength(1);
    expect(field(L.consent).value).toBe('v9');
    expect(statusText()).not.toMatch(/saved/i);
    const reload = screen.getByRole('button', { name: /reload/i });
    await user.click(reload);
    await waitFor(() => expect(refresh.mock.calls.length + gets().length).toBeGreaterThan(1));
  });

  it('403 auth.mfa_required on Save -> role=alert with the two-step verification text (the settings permission is privileged / aal2), not a crash', async () => {
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
    expect(field(L.consent).disabled).toBe(false);
  });
});

describe('forbidden (frontdesk.settings.manage is required)', () => {
  it.each([[[]], [['frontdesk.order.read', 'frontdesk.discount.approve', 'billing.invoice.read']]])('perms %j: the API is never called and no settings control is shown (notFound or the permission-denied page)', async (perms) => {
    session.perms = perms as string[];
    const { default: Page } = await pageModule();
    let out: ReactNode | undefined;
    try { out = await Page({ searchParams: Promise.resolve({}) }); } catch (e) { expect(String((e as Error).message)).toBe('NEXT_NOT_FOUND'); }
    if (out !== undefined) {
      wrap(out);
      expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
      expect(screen.queryByLabelText(L.selfPct)).toBeNull();
      expect(screen.queryByLabelText(L.consent)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('session holds the permission but the API answers 403 auth.forbidden: no form, no crash (permission-denied state, not error.tsx)', async () => {
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
  it('every one of the 9 controls has a programmatic label (no unlabeled input)', async () => {
    await open();
    for (const re of Object.values(L)) expect(screen.getByLabelText(re)).toBeTruthy();
    const unlabeled = [...document.querySelectorAll('input,select,textarea')].filter((e) => !(e as HTMLInputElement).labels?.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && (e as HTMLInputElement).type !== 'hidden');
    expect(unlabeled.map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('axe finds no violations on the loaded form and on the form with errors (colour contrast comes from tokens and is checked elsewhere)', async () => {
    const user = await open();
    const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`);
    expect(await run()).toEqual([]);
    await setText(user, L.consent, '');
    await user.click(saveBtn());
    await waitFor(() => expect(alertText()).not.toBe(''));
    expect(await run()).toEqual([]);
  });

  it('keyboard only: Tab visits all 9 fields in the spec order and then Save; Space toggles a checkbox; Enter on Save writes once', async () => {
    const user = await open();
    const order = [L.selfPct, L.selfNpr, L.absMax, L.referrer, L.consent, L.sms, L.label, L.pan, L.minChars];
    const targets = order.map((re) => field(re));
    const seen: HTMLElement[] = [];
    for (let i = 0; i < 40 && document.activeElement !== saveBtn(); i++) { await user.tab(); seen.push(document.activeElement as HTMLElement); }
    expect(document.activeElement).toBe(saveBtn());
    const idx = targets.map((t) => seen.indexOf(t));
    expect(idx.every((i) => i >= 0), `fields not reachable by Tab: ${idx.join(',')}`).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx); // same order as the spec list
    targets[3]!.focus();
    await user.keyboard(' ');
    expect(isOn(targets[3]!)).toBe(true);
    saveBtn().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.require_referrer).toBe(true);
  });

  it('error text is announced: role=alert exists for errors and role=status for success, and they are different live regions', async () => {
    const user = await open();
    await setText(user, L.consent, '');
    await user.click(saveBtn());
    await waitFor(() => expect(within(document.body).queryAllByRole('alert').length).toBeGreaterThan(0));
    await setText(user, L.consent, 'v4');
    await user.click(saveBtn());
    await waitFor(() => expect(within(document.body).queryAllByRole('status').some((e) => /saved/i.test(e.textContent ?? ''))).toBe(true));
  });
});
