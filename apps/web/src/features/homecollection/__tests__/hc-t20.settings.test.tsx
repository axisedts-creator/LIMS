// @vitest-environment jsdom
// HC-T20 — W5 Settings (04-UI-UX §2.5; TRD H18, H19, §11.2; 08 A19 D-128 / D-129; CR-C17-003/010/014 pending). MSW plays the API.
// ASSUMED contract (spec fixes folders + kit components; dispute via the writer if wrong):
//   * components/SettingsForm.tsx exports `SettingsForm({ settings })` (SettingsDto = §11.2 keys + version). Kit `Form` sections (headings): "Sync & privacy", "Visit checks",
//     "Payments", "Handover", "Routes & messages". Field labels are the §2.5 captions (matched case-insensitively, prefix match).
//   * Submit = Ctrl+Enter from any field, or a Save button -> server action -> PUT /settings with Bearer and If-Match = settings.version; body = every §11.2 key (no `version`).
//   * Out-of-range / invalid input is stopped in the browser (no PUT) with a message next to the field; server 400 is shown as plain text; 409 shows a banner (as §2.1).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, SETTINGS, SETTINGS_KEYS, U, axeClean, fill, noRawCodes, problem, recorder, userEvent, wrap, type Call } from './hc-t20.helpers';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/homecollection/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['homecollection.settings.manage'], displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/homecollection/settings',
}));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let put: R;
const reset = () => { put = () => HttpResponse.json({ ...SETTINGS, version: 8 }); };
reset();
const api = setupServer(http.put(`${API}/settings`, async ({ request }) => { await rec(request); return put(); }));
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); reset(); });
afterAll(() => api.close());

const puts = () => calls.filter((c) => c.method === 'PUT');
const view = async (s: unknown = SETTINGS) => {
  const path = '../components/SettingsForm';
  const { SettingsForm } = (await import(/* @vite-ignore */ path)) as { SettingsForm: (p: any) => any };
  return wrap(<SettingsForm settings={s as never} />);
};
const f = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;
const submit = async (from: HTMLElement) => { from.focus(); await userEvent.keyboard('{Control>}{Enter}{/Control}'); };
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('layout (§2.5)', () => {
  it('title and the five sections', async () => {
    await view();
    expect(screen.getByRole('heading', { level: 1, name: /home collection settings/i })).toBeTruthy();
    for (const s of ['Sync & privacy', 'Visit checks', 'Payments', 'Handover', 'Routes & messages']) expect(screen.getByRole('heading', { name: s })).toBeTruthy();
  });
  it('every field shows the stored value', async () => {
    await view();
    expect(f(/^sync interval/i).value).toBe('300');
    expect(f(/^clear phone data after offline/i).value).toBe('16');
    expect(f(/^gps kept for/i).value).toBe('90');
    expect(f(/^minimum app version/i).value).toBe('1.10.0');
    expect(f(/^consent text version/i).value).toBe('hc-consent-v1');
    expect((screen.getByLabelText(/^consent text$/i) as HTMLTextAreaElement).value).toBe(SETTINGS.collection_consent_text);
    expect(f(/^confirmation at centre required/i).checked).toBe(true);
    expect(f(/^overdue after/i).value).toBe('4');
    expect(f(/^max visits per route/i).value).toBe('40');
    expect(f(/^clock tolerance/i).value).toBe('600');
    expect(f(/^allow maps hand-off/i).checked).toBe(true);
    expect(f(/^allow typed barcodes/i).checked).toBe(true);
  });
  it('units are shown: seconds, hours, days', async () => {
    await view();
    for (const u of [/seconds/i, /hours/i, /days/i]) expect(document.body.textContent).toMatch(u);
  });
  it('descriptions: maps hand-off sends only the address; staff SMS "not sent yet (Phase 1)"', async () => {
    await view();
    expect(document.body.textContent).toContain("Sends only the visit address (no name, tests or phone) to the phone's own maps app.");
    expect(document.body.textContent).toContain('Staff SMS are not sent yet (Phase 1).');
  });
  it('a11y + no raw codes', async () => { await view(); await axeClean(); noRawCodes(); });
});

describe('things that are not built yet stay switched off (CR-C17-003 / 010 / 014)', () => {
  it('Capture GPS point is disabled with "Needs the location component (pending)"', async () => {
    await view();
    expect(f(/^capture gps point/i).disabled).toBe(true);
    expect(document.body.textContent).toContain('Needs the location component (pending)');
  });
  it('SMS to patient on scheduling is disabled with "Needs the scheduling SMS template (pending)" and is never sent as true', async () => {
    await view();
    expect(f(/^sms to patient on scheduling/i).disabled).toBe(true);
    expect(document.body.textContent).toContain('Needs the scheduling SMS template (pending)');
    await submit(f(/^sync interval/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.notify_patient_on_assign).toBe(false);
    expect(puts()[0]!.body.capture_gps).toBe(false);
  });
  it('Second identifier: Phone number is selectable, Date of birth is disabled until CR-C17-003', async () => {
    await view();
    expect((screen.getByRole('radio', { name: /phone number/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /date of birth/i }) as HTMLInputElement).disabled).toBe(true);
  });
  it('even if the stored value says otherwise (tampered), a disabled switch is still not sent as true', async () => {
    await view({ ...SETTINGS, notify_patient_on_assign: true, capture_gps: true });
    await submit(f(/^sync interval/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.notify_patient_on_assign).toBe(false);
  });
});

describe('submit (H19)', () => {
  it('Ctrl+Enter sends PUT /settings: Bearer, If-Match = version, the full §11.2 key set (and nothing else), the edited value; toast, refresh', async () => {
    await view();
    await fill(f(/^sync interval/i), '120');
    await submit(f(/^sync interval/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const c = puts()[0]!;
    expect(c.url.pathname).toBe('/v1/homecollection/settings');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.headers.get('if-match')).toMatch(/7/);
    expect(Object.keys(c.body).sort()).toEqual(SETTINGS_KEYS);
    expect(c.body.sync_interval_seconds).toBe(120);
    expect(typeof c.body.offline_purge_hours).toBe('number'); // numbers, not strings
    expect(c.body.payment_methods).toEqual(SETTINGS.payment_methods);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(document.body.textContent).toMatch(/saved/i);
  });
  it('a Save button submits the same PUT', async () => {
    await view();
    await fill(f(/^overdue after/i), '6');
    await userEvent.click(screen.getAllByRole('button', { name: /^save/i })[0]!);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.handover_overdue_hours).toBe(6);
  });
  it('toggles are sent as booleans', async () => {
    await view();
    await userEvent.click(f(/^allow maps hand-off/i));
    await userEvent.click(f(/^confirmation at centre required/i));
    await submit(f(/^sync interval/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.map_handoff_enabled).toBe(false);
    expect(puts()[0]!.body.handover_confirmation_required).toBe(false);
  });
  it('409 version conflict -> a banner telling the admin the settings changed (no raw code), nothing overwritten silently', async () => {
    put = () => problem('common.version_conflict', 409);
    await view();
    await submit(f(/^sync interval/i));
    await waitFor(() => expect(document.body.textContent).toMatch(/changed|reload|refresh/i));
    noRawCodes();
    expect(document.body.textContent).not.toMatch(/saved/i);
  });
  it('server 400 is shown as plain text, never as a problem code', async () => {
    put = () => problem('common.validation_failed', 400, { errors: [{ pointer: '/payment_methods/0/code', code: 'invalid_code' }] });
    await view();
    await submit(f(/^sync interval/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    await settle();
    noRawCodes();
    expect(document.body.textContent).not.toMatch(/invalid_code|\/payment_methods/);
  });
  it('a double Ctrl+Enter is single-flight: one PUT', async () => {
    await view();
    const el = f(/^sync interval/i);
    el.focus();
    await userEvent.keyboard('{Control>}{Enter}{Enter}{/Control}');
    await settle();
    expect(puts()).toHaveLength(1);
  });
});

describe('ranges are enforced before anything is sent (TRD §11.2)', () => {
  const cases: [RegExp, string, string][] = [
    [/^sync interval/i, '59', '901'], [/^clear phone data after offline/i, '3', '25'], [/^gps kept for/i, '6', '366'],
    [/^overdue after/i, '0', '25'], [/^max visits per route/i, '0', '61'], [/^clock tolerance/i, '59', '3601'],
  ];
  it.each(cases)('%s: below and above the range -> no PUT and a message', async (label, lo, hi) => {
    await view();
    for (const bad of [lo, hi]) {
      await fill(f(label), bad);
      await submit(f(label));
      await waitFor(() => expect(document.body.textContent).toMatch(/between|at least|at most|must be|invalid|required|too/i), { timeout: 10000 });
      expect(puts(), `${label} = ${bad}`).toHaveLength(0);
    }
  });
  it.each([[/^sync interval/i, '60'], [/^sync interval/i, '900'], [/^clear phone data after offline/i, '4'], [/^clear phone data after offline/i, '24'], [/^max visits per route/i, '60']])('%s = %s (boundary) is accepted', async (label, ok) => {
    await view();
    await fill(f(label), ok);
    await submit(f(label));
    await waitFor(() => expect(puts()).toHaveLength(1));
  });
  it('Minimum app version must be semver (and ≤ 20 chars): "1.x", "latest", "1.2" and a 21-char string are refused', async () => {
    await view();
    const el = f(/^minimum app version/i);
    expect(el.maxLength).toBe(20);
    for (const bad of ['1.x', 'latest', '1.2', '1.2.3.4']) {
      await fill(el, bad);
      await submit(el);
      await settle();
      expect(puts(), bad).toHaveLength(0);
    }
    await fill(el, '2.0.1');
    await submit(el);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.min_app_version).toBe('2.0.1');
  });
  it('Consent text version ≤ 40 and Consent text ≤ 2000 are length-limited, with a character count on the text; empty consent text is refused', async () => {
    await view();
    expect(f(/^consent text version/i).maxLength).toBe(40);
    const t = screen.getByLabelText(/^consent text$/i) as HTMLTextAreaElement;
    expect(t.maxLength).toBe(2000);
    expect(document.body.textContent).toMatch(/\d+\s*\/\s*2000/);
    await fill(t, '');
    await submit(t);
    await settle();
    expect(puts()).toHaveLength(0);
  });
});

describe('payment methods (D-128: only C4\'s six seed codes; 1..10; each code at most once)', () => {
  const rows = () => screen.getAllByRole('row').filter((r) => within(r).queryByLabelText(/^label/i));
  it('lists the stored methods with code, label (≤ 40) and "Reference required"', async () => {
    await view();
    expect(rows()).toHaveLength(4);
    const r = rows()[1]!;
    expect((within(r).getByLabelText(/^label/i) as HTMLInputElement).value).toBe('Fonepay QR');
    expect((within(r).getByLabelText(/^label/i) as HTMLInputElement).maxLength).toBe(40);
    expect((within(r).getByLabelText(/reference required/i) as HTMLInputElement).checked).toBe(true);
  });
  it('the code Select offers exactly cash, card, esewa, khalti, fonepay_qr, bank_transfer (shown as their names)', async () => {
    await view();
    await userEvent.click(within(rows()[0]!).getByRole('button', { name: /code|method/i }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names.sort()).toEqual(['Bank transfer', 'Card', 'Cash', 'Fonepay QR', 'Khalti', 'eSewa'].sort());
  });
  it('removing the last remaining method is not possible (min 1)', async () => {
    await view({ ...SETTINGS, payment_methods: [SETTINGS.payment_methods[0]] });
    const rm = within(rows()[0]!).queryByRole('button', { name: /remove|delete/i });
    if (rm) expect((rm as HTMLButtonElement).disabled || rm.getAttribute('aria-disabled') === 'true').toBe(true);
  });
  it('adding is blocked at 10 methods', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ code: ['cash', 'card', 'esewa', 'khalti', 'fonepay_qr', 'bank_transfer'][i % 6]!, display: `Method ${i}`, requires_reference: false }));
    await view({ ...SETTINGS, payment_methods: ten });
    const add = screen.queryByRole('button', { name: /add (payment )?method/i }) as HTMLButtonElement | null;
    if (add) expect(add.disabled || add.getAttribute('aria-disabled') === 'true').toBe(true);
  });
  it('the same code twice -> no PUT and a message', async () => {
    await view();
    await userEvent.click(within(rows()[2]!).getByRole('button', { name: /code|method/i })); // esewa -> cash
    await userEvent.click(await screen.findByRole('option', { name: 'Cash' }));
    // LD-171: wait for the popover to close and row 3 to show Cash before submitting (slow jsdom renders).
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 10000 });
    await waitFor(() => expect(within(rows()[2]!).getByRole('button', { name: /code|method/i }).textContent).toMatch(/cash/i), { timeout: 10000 });
    await submit(f(/^sync interval/i));
    await waitFor(() => expect(document.body.textContent).toMatch(/once|duplicate|already|unique/i), { timeout: 10000 });
    expect(puts()).toHaveLength(0);
  });
  it('an unknown code in stored data is not silently submitted as another code (no PUT until fixed)', async () => {
    await view({ ...SETTINGS, payment_methods: [{ code: 'bitcoin', display: 'Coin', requires_reference: false }] });
    await submit(f(/^sync interval/i));
    await settle();
    expect(puts()).toHaveLength(0);
  });
  it('editing a label and the reference flag is sent in payment_methods', async () => {
    await view();
    await fill(within(rows()[0]!).getByLabelText(/^label/i), 'Cash at door');
    await userEvent.click(within(rows()[0]!).getByLabelText(/reference required/i));
    await submit(f(/^sync interval/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body.payment_methods[0]).toEqual({ code: 'cash', display: 'Cash at door', requires_reference: true });
  });
});
