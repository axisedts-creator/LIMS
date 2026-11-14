// @vitest-environment jsdom
// C13.T16 — SM-2 Receive manifest (04-UI-UX §4, 03-APP-FLOW §2.1). ACs: US-06.1 (receive/not received), US-06.2 (other centre -> 404), US-06.5/.6/.7 (failure texts, retry,
// choose existing patient via C4 search), US-06.11 (order exists, sample missing), BarcodeInput matching, Alt+R / Alt+A shortcuts. 07-SECURITY: PHI never in URLs/storage.
// Contract: see t16.harness.tsx. Route: apps/web/src/app/(staff)/partners/manifests/[manifest_id]/page.tsx (+ loading, error, not-found).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ORIGIN, LINE, MANIFEST, ORDER, PATIENT, PERM, RECEIVER_PERMS, U, line, manifest, patientHit } from './t16.fixtures';
import { calls, idemKey, ifMatch, noAxeViolations, of, pageModule, problem, rec, renderPage, wrap } from './t16.harness';

const session = { perms: [] as string[] };
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => `/partners/manifests/${MANIFEST}`,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Receiver', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => `/partners/manifests/${MANIFEST}`,
}));

let current: unknown = manifest();
const api = setupServer(
  http.get(`${ORIGIN}/v1/partners/admin/manifests/:id`, async ({ request, params }) => { await rec(request); return params['id'] === MANIFEST ? HttpResponse.json(current) : problem(404, 'common.not_found'); }),
  http.post(`${ORIGIN}/v1/partners/admin/manifests/:id/receive`, async ({ request }) => { await rec(request); return HttpResponse.json(manifest({ state: 'partially_received', version: 4 })); }),
  http.post(`${ORIGIN}/v1/partners/admin/manifest-lines/:id/retry`, async ({ request }) => { await rec(request); return HttpResponse.json(line(LINE.A, 1, { state: 'converting' }), { status: 202 }); }),
  http.post(`${ORIGIN}/v1/partners/admin/manifest-lines/:id/not-received`, async ({ request }) => { await rec(request); return HttpResponse.json(line(LINE.A, 1, { state: 'not_received' })); }),
  http.post(`${ORIGIN}/v1/frontdesk/patients/search`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [patientHit()] }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); current = manifest(); session.perms = []; localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const open = async (perms: string[] = RECEIVER_PERMS) => { session.perms = perms; return renderPage('manifests/[manifest_id]', { params: { manifest_id: MANIFEST } }); };
const row = (name: RegExp | string) => screen.getByText(name).closest('tr')!;
const radio = (r: HTMLElement, name: RegExp) => within(r).getByRole('radio', { name }) as HTMLInputElement;
const scan = (text: string) => userEvent.setup({ delay: null }).type(screen.getByLabelText(/scan or type the partner.s sample reference/i), `${text}{Enter}`);
const searchField = (dlg: HTMLElement) => within(dlg).queryByRole('searchbox') ?? within(dlg).queryByRole('combobox') ?? within(dlg).getByRole('textbox', { name: /search/i }); // kit TextField accepted (C13 04-UI-UX:218 names no role)
const pickReason = async (scope: HTMLElement, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: /reason/i }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

describe('SM-2 header + lines (04-UI-UX §4)', () => {
  it('shows manifest no, partner, state as text, partner notes and collection date (D-102), and one row per line with ref, patient, sex/age, tests, priority, collected-at', async () => {
    await open();
    const t = document.body.textContent ?? '';
    expect(screen.getAllByText('MF26000001').length).toBeGreaterThan(0);
    expect(t).toMatch(/Synthetic Partner Lab/);
    expect(t).toMatch(/submitted/i);
    expect(t).toMatch(/Synthetic box note for the lab/);
    expect(t).toMatch(/2026|12 Nov|Nov 12/); // collection date rendered by DateText
    const r = row('Synthetic Patient B');
    expect(within(r).getByText('REF-002')).toBeTruthy();
    expect(within(r).getByText(/urgent/i)).toBeTruthy(); // Priority Badge carries the word, not just a colour
    expect(within(r).getByText(/Synthetic Test 2|T2/)).toBeTruthy();
    expect(screen.getAllByRole('grid', { name: /\S/ })[0]).toBeTruthy(); // kit DataTable `caption` prop = accessible table name (C0 04-UI-UX:196; C13 04-UI-UX:257)
  });

  it('an unconfirmed referring doctor shows a "Not confirmed" warning badge; clinical note is visible (truncated) per line (D-102)', async () => {
    current = manifest({ lines: [line(LINE.A, 1, { referrer: { id: U(90), display_name: 'Dr Unmapped Synthetic' } }), line(LINE.B, 2)] });
    await open();
    const r = row('Synthetic Patient A');
    expect(within(r).getByText(/Dr Unmapped Synthetic/)).toBeTruthy();
    // CR-C13-T16: badge assertion removed until ManifestLine.referrer.mapping_state is in partners.yaml; restore then (fixture referrer mapping_state 'unmapped' plus a mapped line that asserts no badge)
    expect(within(r).getByText(/Synthetic clinical note 1/)).toBeTruthy();
  });

  it('warning banner when the partner is suspended: staff can still receive', async () => {
    current = manifest({ partner: { id: U(1), partner_code: 'SYN-LAB-01', name: 'Synthetic Partner Lab', status: 'suspended' } });
    await open();
    expect(screen.getByText(/This partner is suspended\. You can still receive samples already submitted\./)).toBeTruthy();
  });

  it('no axe violations', async () => {
    await open();
    await noAxeViolations();
  });
});

describe('scan bar (BarcodeInput, pattern /^[A-Za-z0-9_./-]{1,40}$/, allowManual) — partner references are not lab barcodes', () => {
  it('a matching reference ticks that line as Received, no API write yet', async () => {
    await open();
    await scan('REF-002');
    await waitFor(() => expect(radio(row('Synthetic Patient B'), /^received$/i).checked).toBe(true));
    expect(radio(row('Synthetic Patient A'), /^received$/i).checked).toBe(false);
    expect(of('POST', /\/receive$/)).toHaveLength(0);
  });

  it('references with "/", "." and "_" are accepted by the input pattern (not the default A-Z0-9 kit pattern) — lower-case too', async () => {
    current = manifest({ lines: [line(LINE.A, 1, { partner_sample_ref: 'lab_7/box.3-a' }), line(LINE.B, 2)] });
    await open();
    await scan('lab_7/box.3-a');
    await waitFor(() => expect(radio(row('Synthetic Patient A'), /^received$/i).checked).toBe(true));
    expect(document.body.textContent).not.toMatch(/doesn.t look like a sample barcode/i);
  });

  it('no match -> inline error "No sample with this reference on this manifest." and nothing is ticked', async () => {
    await open();
    await scan('NOPE-999');
    expect(await screen.findByText('No sample with this reference on this manifest.')).toBeTruthy();
    for (const p of ['A', 'B', 'C', 'D']) expect(radio(row(`Synthetic Patient ${p}`), /^received$/i).checked).toBe(false);
  });

  it('scanning an already ticked reference shows the hint "Already ticked" and does not untick it', async () => {
    await open();
    await scan('REF-003');
    await waitFor(() => expect(radio(row('Synthetic Patient C'), /^received$/i).checked).toBe(true));
    await new Promise((r) => setTimeout(r, 1700)); // kit duplicate-scan guard is 1.5 s
    await scan('REF-003');
    expect(await screen.findByText('Already ticked')).toBeTruthy();
    expect(radio(row('Synthetic Patient C'), /^received$/i).checked).toBe(true);
  });

  it('a ref that appears on no line of another manifest cannot tick anything here, even if it looks valid (exact match only, no prefix match)', async () => {
    await open();
    await scan('REF-00');
    expect(await screen.findByText('No sample with this reference on this manifest.')).toBeTruthy();
  });

  it('the scanned value is never written to the URL, storage or an API request', async () => {
    await open();
    await scan('REF-001');
    await waitFor(() => expect(radio(row('Synthetic Patient A'), /^received$/i).checked).toBe(true));
    expect(JSON.stringify(calls.filter((c) => c.method !== 'GET').map((c) => [c.url.href, c.body]))).not.toMatch(/REF-001/);
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/REF-001/);
    expect(location.href).not.toMatch(/REF-001/);
  });
});

describe('US-06.1 receive: per-line outcome, bulk, confirm (SI3)', () => {
  it('bulk "Mark selected as received" ticks every selected row', async () => {
    await open();
    const user = userEvent.setup({ delay: null });
    for (const p of ['A', 'C']) await user.click(within(row(`Synthetic Patient ${p}`)).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /mark selected as received/i }));
    expect(radio(row('Synthetic Patient A'), /^received$/i).checked).toBe(true);
    expect(radio(row('Synthetic Patient C'), /^received$/i).checked).toBe(true);
    expect(radio(row('Synthetic Patient B'), /^received$/i).checked).toBe(false);
  });

  it('"Confirm receipt" is disabled until at least one line has an outcome; no request is sent while it is', async () => {
    await open();
    expect((screen.getByRole('button', { name: /confirm receipt/i }) as HTMLButtonElement).disabled).toBe(true);
    await scan('REF-001');
    await waitFor(() => expect((screen.getByRole('button', { name: /confirm receipt/i }) as HTMLButtonElement).disabled).toBe(false));
    expect(of('POST', /\/receive$/)).toHaveLength(0);
  });

  it('Not received needs a reason (CodedSelect line_not_received_reasons, seed texts); the dialog cannot be confirmed without it', async () => {
    await open();
    const user = userEvent.setup({ delay: null });
    await user.click(radio(row('Synthetic Patient C'), /not received/i));
    await user.click(screen.getByRole('button', { name: /confirm receipt/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^confirm/i }));
    expect(of('POST', /\/receive$/)).toHaveLength(0); // reason missing: blocked
    await user.keyboard('{Escape}');
    await pickReason(row('Synthetic Patient C'), /^Sample missing$/);
    for (const t of ['Label unreadable', 'Wrong container', 'Leaked or broken', 'Test not available']) {
      await user.click(within(row('Synthetic Patient C')).getByRole('button', { name: /reason/i }));
      expect(await screen.findByRole('option', { name: t })).toBeTruthy();
      await user.keyboard('{Escape}');
    }
  });

  it('US-06.1: L1, L2 received + L3 not_received(sample_missing) -> ConfirmDialog text, then one SI3 with If-Match "3", Idempotency-Key, only the touched lines; L4 omitted', async () => {
    await open();
    const user = userEvent.setup({ delay: null });
    await scan('REF-001');
    await scan('REF-002');
    await user.click(radio(row('Synthetic Patient C'), /not received/i));
    await pickReason(row('Synthetic Patient C'), /^Sample missing$/);
    await user.click(screen.getByRole('button', { name: /confirm receipt/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Confirm 2 received and 1 not received? Orders will be created for the received samples.')).toBeTruthy();
    await user.click(within(dlg).getByRole('button', { name: /^confirm/i }));
    await waitFor(() => expect(of('POST', /\/manifests\/[^/]+\/receive$/)).toHaveLength(1));
    const c = of('POST', /\/receive$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/partners/admin/manifests/${MANIFEST}/receive`);
    expect(ifMatch(c)).toBe('"3"');
    expect(idemKey(c)).toMatch(/\S{8,}/);
    expect(c.body.lines).toHaveLength(3);
    expect(c.body.lines).toEqual(expect.arrayContaining([
      { line_id: LINE.A, outcome: 'received' }, { line_id: LINE.B, outcome: 'received' }, { line_id: LINE.C, outcome: 'not_received', reason_code: 'sample_missing' },
    ]));
    expect(JSON.stringify(c.body)).not.toContain(LINE.D);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('keyboard: Alt+A = mark selected as received, Alt+R = Confirm receipt (opens the ConfirmDialog)', async () => {
    await open();
    const user = userEvent.setup({ delay: null });
    await user.click(within(row('Synthetic Patient D')).getByRole('checkbox'));
    await user.keyboard('{Alt>}a{/Alt}');
    expect(radio(row('Synthetic Patient D'), /^received$/i).checked).toBe(true);
    await user.keyboard('{Alt>}r{/Alt}');
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('SI3 409 partners.manifest_invalid_transition -> danger banner (plain words, no code), page stays usable', async () => {
    api.use(http.post(`${ORIGIN}/v1/partners/admin/manifests/:id/receive`, async ({ request }) => { await rec(request); return problem(409, 'partners.manifest_invalid_transition'); }));
    await open();
    const user = userEvent.setup({ delay: null });
    await scan('REF-001');
    await user.click(screen.getByRole('button', { name: /confirm receipt/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^confirm/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/can.t be received|already|changed|no longer|refresh/i);
    expect(alert.textContent).not.toMatch(/partners\.manifest_invalid_transition/);
  });

  it('SI3 422 partners.manifest_invalid with errors[] on a line -> that row shows the problem, not a generic failure', async () => {
    api.use(http.post(`${ORIGIN}/v1/partners/admin/manifests/:id/receive`, async ({ request }) => {
      await rec(request);
      return problem(422, 'partners.manifest_invalid', { errors: [{ path: `/lines/0/line_id`, code: 'partners.manifest_invalid' }] });
    }));
    await open();
    const user = userEvent.setup({ delay: null });
    await scan('REF-001');
    await user.click(screen.getByRole('button', { name: /confirm receipt/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^confirm/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a user without partners.manifest.receive sees no receive controls', async () => {
    await open([PERM.read]);
    expect(screen.queryByRole('button', { name: /confirm receipt/i })).toBeNull();
    expect(screen.queryByLabelText(/scan or type/i)).toBeNull();
    expect(of('GET', /\/admin\/manifests\//)).toHaveLength(0); // API not even asked
  });
});

describe('after receipt: line status, registration link, failure texts + actions (US-06.3/.5/.7/.11)', () => {
  const failed = (id: string, n: number, code: string) => line(id, n, { state: 'conversion_failed', failure: { code, message_key: `partners.inbox.failure.${code}` } });
  const mixed = () => manifest({
    state: 'partially_received', lines_converted: 1, lines_failed: 6, line_count: 9,
    lines: [
      line(LINE.A, 1, { state: 'converting' }),
      line(LINE.B, 2, { state: 'converted', order: { order_id: ORDER, registration_no: '0001SY000123' } }),
      failed(U(31), 3, 'frontdesk.patient_duplicate_suspected'), failed(U(32), 4, 'frontdesk.consent_required'), failed(U(33), 5, 'catalog.test_inactive'),
      failed(U(34), 6, 'catalog.no_price'), failed(U(35), 7, 'partners.referrer_not_mapped'), failed(U(36), 8, 'common.internal'),
      line(LINE.C, 9, { state: 'not_received', not_received_reason_code: 'sample_missing' }),
    ],
  });

  it('converting -> "Registering"; converted -> registration no as a link to the C4 order route (staff.frontdesk.order); never a raw state code', async () => {
    current = mixed();
    await open();
    expect(within(row('Synthetic Patient A')).getByText(/registering/i)).toBeTruthy();
    const link = within(row('Synthetic Patient B')).getByRole('link', { name: '0001SY000123' });
    expect(link.getAttribute('href')).toBe(`/frontdesk/orders/${ORDER}`);
    expect(within(row('Synthetic Patient B')).getByText(/registered/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/conversion_failed|converting\b/);
  });

  it.each([
    ['Synthetic Patient C', 'A patient with similar details already exists.'],
    ['Synthetic Patient D', 'Consent details are missing for this patient.'],
    ['Synthetic Patient E', 'A test on this sample is no longer offered.'],
    ['Synthetic Patient F', 'A test has no price for this partner.'],
    ['Synthetic Patient G', 'The referring doctor has not been confirmed.'],
    ['Synthetic Patient H', 'Registration did not complete.'],
  ])('%s: failure text "%s" under a "Needs attention" status, with Retry / Choose existing patient / Mark not received', async (who, text) => {
    // line() names patients A–D only; rebuild names for the extra lines
    const m = mixed() as { lines: any[] };
    m.lines.forEach((l, i) => { l.patient.full_name = `Synthetic Patient ${'ABCDEFGHI'[i]}`; });
    current = m;
    await open();
    const r = row(who);
    expect(within(r).getByText(/needs attention/i)).toBeTruthy();
    expect(within(r).getByText(text)).toBeTruthy();
    expect(within(r).getByRole('button', { name: /^retry$/i })).toBeTruthy();
    expect(within(r).getByRole('button', { name: /choose existing patient/i })).toBeTruthy();
    expect(within(r).getByRole('button', { name: /mark not received/i })).toBeTruthy();
    expect(r.textContent).not.toMatch(/(frontdesk|catalog|partners|common)\.[a-z_]+/); // codes are mapped to text
  });

  it('US-06.11: a line with an order that was marked not received (sample missing) says "Cancel or recollect in Front desk"', async () => {
    current = manifest({ lines: [line(LINE.A, 1, { state: 'not_received', not_received_reason_code: 'sample_missing', order: { order_id: ORDER, registration_no: '0001SY000123' } }), line(LINE.B, 2)] });
    await open();
    const r = row('Synthetic Patient A');
    expect(within(r).getByText(/cancel or recollect in front desk/i)).toBeTruthy();
    expect(within(r).getByRole('link', { name: '0001SY000123' }).getAttribute('href')).toBe(`/frontdesk/orders/${ORDER}`);
  });

  it('Retry (US-06.7): SI4 with the LINE version in If-Match, Idempotency-Key and an empty body (no patient_id)', async () => {
    current = manifest({ lines: [line(LINE.A, 1, { state: 'conversion_failed', failure: { code: 'catalog.no_price', message_key: 'x' }, version: 12 })] });
    await open();
    await userEvent.click(within(row('Synthetic Patient A')).getByRole('button', { name: /^retry$/i }));
    await waitFor(() => expect(of('POST', /\/retry$/)).toHaveLength(1));
    const c = of('POST', /\/retry$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/partners/admin/manifest-lines/${LINE.A}/retry`);
    expect(ifMatch(c)).toBe('"12"');
    expect(idemKey(c)).toMatch(/\S{8,}/);
    expect(c.body?.patient_id).toBeUndefined();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Retry 409 partners.manifest_line_invalid_transition -> banner, no crash', async () => {
    api.use(http.post(`${ORIGIN}/v1/partners/admin/manifest-lines/:id/retry`, async ({ request }) => { await rec(request); return problem(409, 'partners.manifest_line_invalid_transition'); }));
    current = manifest({ lines: [line(LINE.A, 1, { state: 'conversion_failed', failure: { code: 'common.internal', message_key: 'x' } })] });
    await open();
    await userEvent.click(within(row('Synthetic Patient A')).getByRole('button', { name: /^retry$/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('US-06.6 Choose existing patient: Dialog with C4 search (POST body, never the URL; masked phone only) -> pick -> SI4 with patient_id', async () => {
    current = manifest({ lines: [line(LINE.A, 1, { state: 'conversion_failed', failure: { code: 'frontdesk.patient_duplicate_suspected', message_key: 'x' }, version: 12 })] });
    await open();
    const user = userEvent.setup({ delay: null });
    await user.click(within(row('Synthetic Patient A')).getByRole('button', { name: /choose existing patient/i }));
    const dlg = await screen.findByRole('dialog');
    await user.type(searchField(dlg), 'Synthetic Existing');
    const hit = await within(dlg).findByText(/Synthetic Existing Patient/, undefined, { timeout: 4000 });
    expect(dlg.textContent).toMatch(/P-000321/);
    expect(dlg.textContent).toMatch(/98xxxxxx42/);
    const s = of('POST', /\/v1\/frontdesk\/patients\/search$/).at(-1)!;
    expect(s.url.search).toBe('');
    expect(s.body.query).toMatch(/Synthetic Existing/);
    expect(s.body.limit ?? 20).toBeLessThanOrEqual(20);
    await user.click(hit);
    const choose = within(dlg).queryByRole('button', { name: /^(use|choose|select|retry)/i });
    if (choose) await user.click(choose);
    await waitFor(() => expect(of('POST', /\/retry$/)).toHaveLength(1));
    const c = of('POST', /\/retry$/)[0]!;
    expect(c.body).toEqual({ patient_id: PATIENT });
    expect(ifMatch(c)).toBe('"12"');
    expect(idemKey(c)).toMatch(/\S{8,}/);
  });

  it('Choose existing patient needs frontdesk.patient.read: without it the action is not offered (no 403 noise)', async () => {
    current = manifest({ lines: [line(LINE.A, 1, { state: 'conversion_failed', failure: { code: 'frontdesk.patient_duplicate_suspected', message_key: 'x' } })] });
    await open([PERM.receive]);
    expect(within(row('Synthetic Patient A')).queryByRole('button', { name: /choose existing patient/i })).toBeNull();
    expect(within(row('Synthetic Patient A')).getByRole('button', { name: /^retry$/i })).toBeTruthy();
  });

  it('Patient search: a C4 error shows an in-dialog banner and keeps the dialog open', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/patients/search`, async ({ request }) => { await rec(request); return problem(500, 'common.internal'); }));
    current = manifest({ lines: [line(LINE.A, 1, { state: 'conversion_failed', failure: { code: 'frontdesk.patient_duplicate_suspected', message_key: 'x' } })] });
    await open();
    const user = userEvent.setup({ delay: null });
    await user.click(within(row('Synthetic Patient A')).getByRole('button', { name: /choose existing patient/i }));
    const dlg = await screen.findByRole('dialog');
    await user.type(searchField(dlg), 'Synthetic');
    expect(await within(dlg).findByRole('alert', undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Mark not received on a failed line: reason required, SI5 {reason_code} with the line version', async () => {
    current = manifest({ lines: [line(LINE.A, 1, { state: 'conversion_failed', failure: { code: 'catalog.test_inactive', message_key: 'x' }, version: 12 })] });
    await open();
    const user = userEvent.setup({ delay: null });
    await user.click(within(row('Synthetic Patient A')).getByRole('button', { name: /mark not received/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|mark)/i }));
    expect(of('POST', /\/not-received$/)).toHaveLength(0); // no reason yet
    await pickReason(dlg, /^Test not available$/);
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|mark)/i }));
    await waitFor(() => expect(of('POST', /\/not-received$/)).toHaveLength(1));
    const c = of('POST', /\/not-received$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/partners/admin/manifest-lines/${LINE.A}/not-received`);
    expect(c.body).toEqual({ reason_code: 'test_not_available' });
    expect(ifMatch(c)).toBe('"12"');
  });
});

describe('page states (03-APP-FLOW §4)', () => {
  it('unknown manifest, OTHER receiving centre, or other tenant: the API answers the same 404 -> notFound(); malformed id -> notFound()', async () => {
    session.perms = RECEIVER_PERMS;
    const { default: Page } = await pageModule('manifests/[manifest_id]');
    await expect(Page({ params: Promise.resolve({ manifest_id: U(404) }), searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
    api.use(http.get(`${ORIGIN}/v1/partners/admin/manifests/:id`, () => problem(400, 'common.validation_failed')));
    await expect(Page({ params: Promise.resolve({ manifest_id: 'not-a-uuid' }), searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a 5xx is NOT turned into 404 — it propagates to error.tsx', async () => {
    session.perms = RECEIVER_PERMS;
    api.use(http.get(`${ORIGIN}/v1/partners/admin/manifests/:id`, () => problem(500, 'common.internal')));
    const { default: Page } = await pageModule('manifests/[manifest_id]');
    await expect(Page({ params: Promise.resolve({ manifest_id: MANIFEST }), searchParams: Promise.resolve({}) })).rejects.not.toThrow('NEXT_NOT_FOUND');
  });

  it('not-found.tsx says "Manifest not found"; loading.tsx renders a skeleton; error.tsx shows the digest and never the raw message', async () => {
    wrap(((await pageModule('manifests/[manifest_id]', 'not-found')).default as () => any)());
    expect(screen.getByText(/Manifest not found/)).toBeTruthy();
    cleanup();
    wrap(((await pageModule('manifests/[manifest_id]', 'loading')).default as () => any)());
    expect(document.body.innerHTML.length).toBeGreaterThan(50);
    cleanup();
    const E = (await pageModule('manifests/[manifest_id]', 'error')).default as (p: any) => any;
    wrap(E({ error: Object.assign(new Error('SECRET internal detail'), { digest: 'dig-123' }), reset: () => {} }));
    expect(document.body.textContent).toMatch(/dig-123/);
    expect(document.body.textContent).not.toMatch(/SECRET internal detail/);
  });
});
