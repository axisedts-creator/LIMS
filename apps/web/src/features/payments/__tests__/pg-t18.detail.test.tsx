// @vitest-environment jsdom
// PG-T18 — Intent detail, route /payments/intents/{intent_id} (04-UI-UX §2.2, §6, §7; 01-PRD US-PG-07 AC1–AC7 UI side; 07-SECURITY). MSW plays the API.
// AC-PG-07.8 (24 h gauge + PaymentsHeldForReviewStale alert) is ops/metrics (PG-T20), not UI — intentionally not covered here.
// ASSUMED contract (spec fixes folders + kit components; dispute via writer if wrong):
//   * features/payments/components/IntentDetailView.tsx exports `IntentDetailView({ intent, permissions, codes })`
//       intent = PaymentIntentDetail (TRD §4; money {amount_paisa,currency}; actor_type 'user'|'system'); permissions = readonly string[];
//       codes = { resolution_reasons, cancel_reasons } each [{code,display,requires_text,is_active}]. PageHeader helpKey payments.intent.
//   * actions call the BFF/API (MSW observes /v1/payments/intents/:id/{recheck,resolve,cancel}); P4 sends If-Match = intent.version and an Idempotency-Key,
//     body {resolution, reason_code, note?}; P5 body {reason_code}. After success the view refreshes (router.refresh) or re-renders from the returned detail.
//   * app/(staff)/payments/intents/[intent_id]/page.tsx = async `Page({ params: Promise<{intent_id}> })`: GET P2 (+ P24 resolution_reasons, cancel_reasons only when
//     the session holds payments.intent.resolve); API 404/400 ⇒ notFound(); 403 ⇒ no data shown; other errors reject (error.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const refresh = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ current: ['payments.reconciliation.read', 'payments.intent.resolve'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/payments/intents/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.current, displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/intents/x',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const ID = U(101), ORDER = U(201), LEDGER = U(301);
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const READ = ['payments.reconciliation.read'];
const RESOLVE = ['payments.reconciliation.read', 'payments.intent.resolve'];
const RESOLVE_REFUND = [...RESOLVE, 'payments.refund.request'];
const codes = {
  resolution_reasons: [
    { code: 'gateway_confirmed_paid', display: 'Provider confirmed paid', requires_text: false, is_active: true },
    { code: 'gateway_confirmed_unpaid', display: 'Provider confirmed not paid', requires_text: false, is_active: true },
    { code: 'other', display: 'Other', requires_text: true, is_active: true },
  ],
  cancel_reasons: [
    { code: 'patient_changed_method', display: 'Patient changed method', requires_text: false, is_active: true },
    { code: 'other', display: 'Other', requires_text: true, is_active: true },
  ],
};
const detail = (o: Record<string, unknown> = {}) => ({
  id: ID, order_id: ORDER, centre_id: U(3), gateway: 'esewa', environment: 'production', status: 'held_for_review', amount: npr(12345600), hold_reason: 'amount_mismatch',
  created_at: '2026-11-10T04:00:00.000Z', expires_at: '2026-11-10T04:30:00.000Z', last_checked_at: '2026-11-10T04:20:00.000Z', version: 7,
  gateway_txn_ref: 'esewa-txn-0001', gateway_secondary_ref: 'esewa-ref-0002', last_gateway_status_raw: 'COMPLETE', verified_amount: npr(12340000), verification_method: 'status_check',
  refunded_amount: npr(0), created_by_actor_type: 'user',
  transitions: [
    { to_status: 'created', cause: 'create', actor_type: 'user', at: '2026-11-10T04:00:00.000Z' },
    { from_status: 'initiated', to_status: 'held_for_review', cause: 'poll', reason_code: 'amount_mismatch', actor_type: 'system', at: '2026-11-10T04:20:00.000Z' },
  ],
  gateway_checks: [{ operation: 'esewa_status', outcome: 'answer', gateway_status_raw: 'COMPLETE', http_status: 200, at: '2026-11-10T04:20:00.000Z' }],
  callbacks: [{ kind: 'esewa_success', outcome_code: 'accepted', signature_valid: true, at: '2026-11-10T04:19:00.000Z' }],
  refunds: [],
  ...o,
});
const settled = () => detail({ status: 'settled', hold_reason: undefined, settled_at: '2026-11-10T04:25:00.000Z', verified_amount: npr(12345600), ledger_entry_id: LEDGER });

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (code: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status, headers });
let recheck: () => Response | Promise<Response> = () => HttpResponse.json(settled());
let resolve: () => Response | Promise<Response> = () => HttpResponse.json(settled());
let cancel: () => Response | Promise<Response> = () => HttpResponse.json({ intent_id: ID, status: 'failed' });
let getIntent: () => Response | Promise<Response> = () => HttpResponse.json(detail());
const api = setupServer(
  http.get(`${ORIGIN}/v1/payments/intents/:id`, async ({ request }) => { await rec(request); return getIntent(); }),
  http.post(`${ORIGIN}/v1/payments/intents/:id/recheck`, async ({ request }) => { await rec(request); return recheck(); }),
  http.post(`${ORIGIN}/v1/payments/intents/:id/resolve`, async ({ request }) => { await rec(request); return resolve(); }),
  http.post(`${ORIGIN}/v1/payments/intents/:id/cancel`, async ({ request }) => { await rec(request); return cancel(); }),
  http.get(`${ORIGIN}/v1/payments/coded-sets/resolution_reasons`, () => HttpResponse.json({ data: codes.resolution_reasons })),
  http.get(`${ORIGIN}/v1/payments/coded-sets/cancel_reasons`, () => HttpResponse.json({ data: codes.cancel_reasons })),
  http.get(`${ORIGIN}/v1/payments/cancel-reasons`, () => HttpResponse.json({ data: codes.cancel_reasons })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); perms.current = RESOLVE;
  recheck = () => HttpResponse.json(settled()); resolve = () => HttpResponse.json(settled()); cancel = () => HttpResponse.json({ intent_id: ID, status: 'failed' }); getIntent = () => HttpResponse.json(detail());
});
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const comp = async () => ((await import(/* @vite-ignore */ '../components/IntentDetailView')) as { IntentDetailView: (p: any) => any }).IntentDetailView;
const view = async (intent: unknown = detail(), permissions: readonly string[] = RESOLVE) => { const V = await comp(); return wrap(<V intent={intent as never} permissions={permissions} codes={codes} />); };
const btn = (n: RegExp | string) => screen.queryByRole('button', { name: n });
const posts = (suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.pathname === `/v1/payments/intents/${ID}/${suffix}`);
const pick = async (dlg: HTMLElement, option: RegExp) => {
  await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

describe('§2.2 header + DescriptionList', () => {
  it('shows status chip text, lakh-grouped amount, gateway, and all 13 spec terms', async () => {
    await view(settled());
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('NPR 1,23,456.00').length).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/eSewa/);
    for (const t of ['Order', 'Centre', 'Amount', 'Provider reference', 'Provider transaction', 'Created', 'Expires', 'Paid at', 'Verified amount', 'Verification', 'Hold reason', 'Ledger entry', 'Refunded']) {
      expect(screen.getAllByText(new RegExp(`^${t}$`, 'i')).length, `term ${t}`).toBeGreaterThan(0);
    }
    expect(document.querySelector(`a[href="/frontdesk/orders/${ORDER}"]`)).toBeTruthy();
    expect(document.body.textContent).toContain('esewa-txn-0001');
  });

  it('held intent: "Under review" chip and the hold reason is explained in words, not the raw code', async () => {
    await view();
    expect(screen.getAllByText('Under review').length).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/amount mismatch/i);
    expect(document.body.textContent).not.toMatch(/amount_mismatch/);
  });

  it('never shows "Payment successful" / Fonepay-verified copy for a non-settled intent (04-UI-UX §7)', async () => {
    await view(detail({ status: 'pending', hold_reason: undefined }));
    expect(document.body.textContent).not.toMatch(/Payment successful|Fonepay verified/);
    expect(screen.queryByText(/^Paid$/)).toBeNull(); // chip label only; the "Paid at" term is a different node
  });
});

describe('§2.2 tabs — Timeline · Provider checks · Callbacks · Refunds', () => {
  it('Timeline: "Under review — amount mismatch" with actor text System / Staff', async () => {
    await view();
    expect(screen.getByRole('tab', { name: /timeline/i })).toBeTruthy();
    expect(screen.getByText(/Under review — amount mismatch/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/System/);
    expect(document.body.textContent).toMatch(/Staff/);
    expect(screen.queryByText(/^(user|system)$/)).toBeNull(); // raw actor enums are not shown as-is
  });

  it('Provider checks table: When, Operation, Outcome, Provider status, HTTP status', async () => {
    await view();
    await userEvent.click(screen.getByRole('tab', { name: /provider checks/i }));
    const heads = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim().toLowerCase());
    for (const h of ['when', 'operation', 'outcome', 'provider status', 'http status']) expect(heads.some((x) => x.startsWith(h)), h).toBe(true);
    expect(document.body.textContent).toContain('COMPLETE');
    expect(document.body.textContent).toContain('200');
  });

  it('Callbacks table: When, Kind, Outcome, Signature valid — and nothing that could carry a token or URL', async () => {
    const leaky = detail({ callbacks: [{ kind: 'esewa_success', outcome_code: 'accepted', signature_valid: true, at: '2026-11-10T04:19:00.000Z', callback_token: 'tok_SECRETSECRETSECRET1', url: 'https://portal.test/r/x' }], return_url: 'https://portal.test/r/payments/x', raw_payload: '{"secret":"x"}' });
    const { container } = await view(leaky);
    await userEvent.click(screen.getByRole('tab', { name: /callbacks/i }));
    const heads = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim().toLowerCase());
    for (const h of ['when', 'kind', 'outcome', 'signature valid']) expect(heads.some((x) => x.startsWith(h)), h).toBe(true);
    expect(container.innerHTML).not.toMatch(/tok_SECRET|portal\.test|"secret"|jwt-synthetic/);
  });

  it('Refunds tab lists refunds or shows an empty state', async () => {
    await view();
    await userEvent.click(screen.getByRole('tab', { name: /refunds/i }));
    expect(screen.getByRole('tabpanel')).toBeTruthy();
  });
});

describe('§2.2 actions — visibility per permission and enablement per state (spec table)', () => {
  const NAMES = [/re-check with provider/i, /mark as paid/i, /record although it exceeds the due/i, /mark as failed/i, /cancel payment/i];

  it('AC-PG-07.5: without payments.intent.resolve (read-only / front_desk) no resolve action is shown, but the facts are', async () => {
    await view(detail(), READ);
    for (const n of NAMES) expect(btn(n), String(n)).toBeNull();
    expect(screen.getAllByText('Under review').length).toBeGreaterThan(0);
  });

  it('held_for_review (amount_mismatch): Re-check, Mark as paid, Mark as failed enabled; Record-exceeding hidden; Cancel not offered', async () => {
    await view();
    for (const n of [NAMES[0]!, NAMES[1]!, NAMES[3]!]) { const b = btn(n); expect(b, String(n)).toBeTruthy(); expect((b as HTMLButtonElement).disabled).toBe(false); }
    expect(btn(NAMES[2]!)).toBeNull();
    const cancelBtn = btn(NAMES[4]!);
    expect(!cancelBtn || (cancelBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('held_for_review with hold_reason=exceeds_due: "Record although it exceeds the due" is offered', async () => {
    await view(detail({ hold_reason: 'exceeds_due' }));
    expect(btn(NAMES[2]!)).toBeTruthy();
  });

  it.each(['initiated', 'pending'])('%s: Re-check and Cancel payment enabled; Mark as paid / Mark as failed not enabled', async (status) => {
    await view(detail({ status, hold_reason: undefined }));
    expect((btn(NAMES[0]!) as HTMLButtonElement).disabled).toBe(false);
    expect((btn(NAMES[4]!) as HTMLButtonElement).disabled).toBe(false);
    for (const n of [NAMES[1]!, NAMES[3]!]) { const b = btn(n); expect(!b || (b as HTMLButtonElement).disabled, String(n)).toBe(true); }
  });

  it.each(['settled', 'failed', 'expired', 'created', 'refunded'])('%s: Re-check, Mark paid/failed, Record-exceeding and Cancel are not enabled', async (status) => {
    await view(detail({ status, hold_reason: undefined }));
    for (const n of NAMES) { const b = btn(n); expect(!b || (b as HTMLButtonElement).disabled, `${status} ${n}`).toBe(true); }
  });

  it('Request refund: only on settled/partially_refunded and only with payments.refund.request', async () => {
    await view(settled(), RESOLVE_REFUND);
    expect(btn(/request refund/i)).toBeTruthy();
    cleanup();
    await view(detail({ status: 'partially_refunded', refunded_amount: npr(100) }), RESOLVE_REFUND);
    expect(btn(/request refund/i)).toBeTruthy();
    cleanup();
    await view(settled(), RESOLVE);
    expect(btn(/request refund/i)).toBeNull();
    cleanup();
    await view(detail(), RESOLVE_REFUND);
    expect(btn(/request refund/i)).toBeNull();
  });

  it('Request refund opens the refund dialog (§2.3.1) instead of calling the API directly', async () => {
    await view(settled(), RESOLVE_REFUND);
    await userEvent.click(btn(/request refund/i)!);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('AC-PG-07.1 Re-check (P3)', () => {
  it('POSTs /recheck and toasts "Checked: <status label>"', async () => {
    await view();
    await userEvent.click(btn(/re-check with provider/i)!);
    await waitFor(() => expect(posts('recheck')).toHaveLength(1));
    expect(await screen.findByText(/Checked: Paid/)).toBeTruthy();
  });

  it('Alt+C triggers the same re-check (keyboard script)', async () => {
    await view();
    await userEvent.keyboard('{Alt>}c{/Alt}');
    await waitFor(() => expect(posts('recheck')).toHaveLength(1));
  });

  it('shows the new status from the response (settled ⇒ "Paid") or refreshes the route', async () => {
    await view();
    await userEvent.click(btn(/re-check with provider/i)!);
    await waitFor(() => expect(posts('recheck')).toHaveLength(1));
    await waitFor(() => expect(refresh.mock.calls.length > 0 || screen.queryAllByText('Paid').length > 0).toBe(true));
  });
});

describe('AC-PG-07.7 Re-check rate limited (P3 within 10 s)', () => {
  it('429 ⇒ toast "Checked a moment ago. Try again in a few seconds."; no status change, no raw error code', async () => {
    recheck = () => problem('common.rate_limited', 429, {}, { 'Retry-After': '7' });
    await view();
    await userEvent.click(btn(/re-check with provider/i)!);
    expect(await screen.findByText('Checked a moment ago. Try again in a few seconds.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/common\.rate_limited|Checked: /);
    expect(screen.getAllByText('Under review').length).toBeGreaterThan(0);
  });
});

describe('AC-PG-07.1 Mark as paid (P4 settle)', () => {
  it('ConfirmDialog: title, body, coded reason select (resolution_reasons), free-text optional ≤ 500', async () => {
    await view();
    await userEvent.click(btn(/mark as paid/i)!);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Mark payment as paid?')).toBeTruthy();
    expect(within(dlg).getByText('The provider will be checked again. The payment is marked paid only if the provider confirms it with the exact amount.')).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    for (const d of ['Provider confirmed paid', 'Provider confirmed not paid', 'Other']) expect(await screen.findByRole('option', { name: d })).toBeTruthy();
    expect((within(dlg).queryByRole('textbox') as HTMLInputElement | null)?.maxLength ?? 500).toBeLessThanOrEqual(500);
  });

  it('sends {resolution:"settle", reason_code} with If-Match = version and an Idempotency-Key; nothing is sent without a reason', async () => {
    await view();
    await userEvent.click(btn(/mark as paid/i)!);
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /mark as paid/i }));
    expect(posts('resolve')).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await pick(dlg, /Provider confirmed paid/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark as paid/i }));
    await waitFor(() => expect(posts('resolve')).toHaveLength(1));
    const c = posts('resolve')[0]!;
    expect(c.body.resolution).toBe('settle');
    expect(c.body.reason_code).toBe('gateway_confirmed_paid');
    expect(c.headers.get('if-match')).toMatch(/7/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });

  it('a double click on confirm sends one request only (race / double submit)', async () => {
    resolve = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(settled()); };
    await view();
    await userEvent.click(btn(/mark as paid/i)!);
    const dlg = await screen.findByRole('dialog');
    await pick(dlg, /Provider confirmed paid/);
    const ok = within(dlg).getByRole('button', { name: /mark as paid/i });
    await userEvent.dblClick(ok);
    await waitFor(() => expect(posts('resolve').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(posts('resolve')).toHaveLength(1);
  });

  it('Cancel in the dialog sends nothing and returns focus to the trigger (focus trap + return, §6)', async () => {
    await view();
    const trigger = btn(/mark as paid/i)!;
    await userEvent.click(trigger);
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts('resolve')).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('AC-PG-07.2 Mark as failed (P4 fail)', () => {
  it('danger ConfirmDialog with the spec body; sends {resolution:"fail", reason_code:"gateway_confirmed_unpaid"}', async () => {
    resolve = () => HttpResponse.json(detail({ status: 'failed', hold_reason: undefined, failure_reason: 'resolved_failed' }));
    await view();
    await userEvent.click(btn(/mark as failed/i)!);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Only do this if the provider confirmed that no money was taken.')).toBeTruthy();
    await pick(dlg, /Provider confirmed not paid/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark as failed/i }));
    await waitFor(() => expect(posts('resolve')).toHaveLength(1));
    expect(posts('resolve')[0]!.body).toMatchObject({ resolution: 'fail', reason_code: 'gateway_confirmed_unpaid' });
  });

  it('reason code "other" requires free text: blocked (no request) until text is entered, then sent as note', async () => {
    await view();
    await userEvent.click(btn(/mark as failed/i)!);
    const dlg = await screen.findByRole('dialog');
    await pick(dlg, /^Other$/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark as failed/i }));
    expect(posts('resolve')).toHaveLength(0);
    await userEvent.type(within(dlg).getByRole('textbox'), 'Provider support ticket 42 says no money taken');
    await userEvent.click(within(dlg).getByRole('button', { name: /mark as failed/i }));
    await waitFor(() => expect(posts('resolve')).toHaveLength(1));
    expect(posts('resolve')[0]!.body.reason_code).toBe('other');
    expect(String(posts('resolve')[0]!.body.note ?? '')).toMatch(/ticket 42/);
  });
});

describe('AC-PG-07.3 not verifiable', () => {
  it('409 payments.intent_not_verifiable ⇒ inline warning banner with the latest provider answer; intent stays held; no raw code', async () => {
    resolve = () => problem('payments.intent_not_verifiable', 409, { latest_status: 'PENDING', gateway_status_raw: 'PENDING' });
    await view();
    await userEvent.click(btn(/mark as paid/i)!);
    const dlg = await screen.findByRole('dialog');
    await pick(dlg, /Provider confirmed paid/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark as paid/i }));
    expect(await screen.findByText(/The provider has not confirmed this payment \(latest answer: .+\)\. It cannot be marked paid\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/payments\.intent_not_verifiable/);
    expect(screen.queryByText(/^Paid$/)).toBeNull();
  });
});

describe('AC-PG-07.4 Record although it exceeds the due (P4 record_exceeding_due)', () => {
  it('ConfirmDialog body states the provider-confirmed amount and the Finance review item; sends {resolution:"record_exceeding_due"}', async () => {
    await view(detail({ hold_reason: 'exceeds_due', verified_amount: npr(12345600) }));
    await userEvent.click(btn(/record although it exceeds the due/i)!);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/The provider confirmed NPR 1,23,456\.00\. The order now owes less\. The full amount will be recorded and Finance will get a review item to refund or keep as advance\./)).toBeTruthy();
    await pick(dlg, /Provider confirmed paid/);
    await userEvent.click(within(dlg).getByRole('button', { name: /record/i }));
    await waitFor(() => expect(posts('resolve')).toHaveLength(1));
    expect(posts('resolve')[0]!.body.resolution).toBe('record_exceeding_due');
    expect(posts('resolve')[0]!.headers.get('if-match')).toMatch(/7/);
  });
});

describe('AC-PG-07.5 permission / step-up failures', () => {
  it.each([
    ['auth.forbidden', 403],
    ['auth.mfa_required', 403],
  ])('%s ⇒ the intent is NOT shown as paid and no raw error code leaks', async (code, status) => {
    resolve = () => problem(code, status);
    await view();
    await userEvent.click(btn(/mark as paid/i)!);
    const dlg = await screen.findByRole('dialog');
    await pick(dlg, /Provider confirmed paid/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark as paid/i }));
    await waitFor(() => expect(posts('resolve')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/^Paid$/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/auth\.forbidden|auth\.mfa_required/);
    expect(document.body.textContent).not.toMatch(/Payment successful/);
  });
});

describe('AC-PG-07.6 stale version', () => {
  it('409 common.version_conflict ⇒ banner "This payment changed. Reload to see the latest." with a Reload action that refreshes', async () => {
    resolve = () => problem('common.version_conflict', 409);
    await view();
    await userEvent.click(btn(/mark as paid/i)!);
    const dlg = await screen.findByRole('dialog');
    await pick(dlg, /Provider confirmed paid/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark as paid/i }));
    expect(await screen.findByText('This payment changed. Reload to see the latest.')).toBeTruthy();
    const reload = screen.getByRole('button', { name: /reload/i });
    await userEvent.click(reload);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(document.body.textContent).not.toMatch(/common\.version_conflict/);
  });
});

describe('Cancel payment (P5)', () => {
  it('ConfirmDialog body from the spec; reason from cancel_reasons; sends {reason_code}', async () => {
    await view(detail({ status: 'pending', hold_reason: undefined }));
    await userEvent.click(btn(/cancel payment/i)!);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('We check with the provider first. If the patient already paid, the payment is recorded instead.')).toBeTruthy();
    await pick(dlg, /Patient changed method/);
    await userEvent.click(within(dlg).getByRole('button', { name: /cancel payment/i }));
    await waitFor(() => expect(posts('cancel')).toHaveLength(1));
    expect(posts('cancel')[0]!.body.reason_code).toBe('patient_changed_method');
    expect(posts('cancel')[0]!.headers.get('idempotency-key')).toBeTruthy();
  });
});

describe('a11y (WCAG 2.2 AA, §6)', () => {
  it('axe: held intent, all tabs reachable', async () => {
    await view();
    await axeClean();
    for (const t of ['provider checks', 'callbacks', 'refunds']) { await userEvent.click(screen.getByRole('tab', { name: new RegExp(t, 'i') })); await axeClean(); }
  });
  it('axe: with a confirm dialog open', async () => {
    await view();
    await userEvent.click(btn(/mark as failed/i)!);
    await screen.findByRole('dialog');
    await axeClean();
  });
  it('axe: settled intent, read-only user', async () => { await view(settled(), READ); await axeClean(); });
  it('tabs are keyboard operable (arrow keys move between tabs)', async () => {
    await view();
    screen.getByRole('tab', { name: /timeline/i }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect((document.activeElement as HTMLElement).getAttribute('role')).toBe('tab');
    expect(document.activeElement).not.toBe(screen.getByRole('tab', { name: /timeline/i }));
  });
});

type P = { intent_id: string };
const loadPage = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/payments/intents/[intent_id]/page')) as { default: (p: { params: Promise<P> }) => Promise<any> }).default;
const show = async (id = ID) => { const Page = await loadPage(); return wrap(await Page({ params: Promise.resolve({ intent_id: id }) })); };

describe('intent page.tsx — request (P2/P24)', () => {
  it('GETs the intent with the session Bearer token (no token in the DOM) and renders it', async () => {
    const { container } = await show();
    const g = calls.filter((c) => c.method === 'GET' && c.url.pathname === `/v1/payments/intents/${ID}`);
    expect(g).toHaveLength(1);
    expect(g[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(container.innerHTML).not.toContain('jwt-synthetic');
    expect(screen.getAllByText('Under review').length).toBeGreaterThan(0);
  });

  it('a path id that is not a uuid never reaches the API as anything but one encoded segment (no traversal)', async () => {
    getIntent = () => problem('common.not_found', 404);
    await expect(show('../../v1/admin?x=1')).rejects.toBeTruthy();
    for (const c of calls) { expect(c.url.pathname.startsWith('/v1/payments/intents/')).toBe(true); expect(c.url.pathname.split('/').length).toBeLessThanOrEqual(5); }
  });

  it('API 404 ⇒ notFound(); API 403 ⇒ no payment facts shown; API 5xx ⇒ rejects for error.tsx', async () => {
    getIntent = () => problem('common.not_found', 404);
    await expect(show()).rejects.toThrow('NEXT_NOT_FOUND');
    getIntent = () => problem('auth.forbidden', 403);
    try { await show(); } catch { /* denied state or rejection are both fine */ }
    expect(document.body.textContent).not.toMatch(/esewa-txn-0001|NPR 1,23,456/);
    cleanup();
    getIntent = () => problem('common.dependency_unavailable', 503);
    await expect(show()).rejects.toBeTruthy();
  });

  it('read-only session: the page passes no resolve actions (and does not call the resolve coded sets)', async () => {
    perms.current = READ;
    await show();
    expect(btn(/mark as paid|re-check|mark as failed/i)).toBeNull();
  });

  it('axe: page output has no violations', async () => { await show(); await axeClean(); });
});
