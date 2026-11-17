// @vitest-environment jsdom
// PG-T19 — Gateway refunds, route /payments/refunds (04-UI-UX §2.3, §2.3.1, §2.3.2, §6, §7; 01-PRD US-PG-09 AC1–AC10 UI side; 07-SECURITY). MSW plays the API.
// ASSUMED contract (spec fixes folders + kit components; dispute via writer if wrong):
//   * features/payments/components/RefundsList.tsx exports `RefundsList({ refunds, permissions, currentMembershipId, codes, thresholdPaisa?, filter?, nextCursor?, hasPrevious? })`
//       refunds = RefundDto[] (TRD §4; money {amount_paisa,currency}; requested_by/approved_by {membership_id, display_name});
//       codes = { refund_reject_reasons, refund_fail_reasons, refund_hold_reasons } each [{code,display,requires_text,is_active}];
//       currentMembershipId = session actor.membershipId (self-approval is decided by requested_by.membership_id === me, unless amount ≤ thresholdPaisa).
//       Renders PageHeader (title contains "refunds", helpKey payments.refunds) + FilterBar + DataTable; every row action is a <button> INSIDE its row.
//   * features/payments/components/RefundRequestDialog.tsx exports `RefundRequestDialog({ intent, overpaid, refundReasons, isOpen, onClose })`
//       intent = PaymentIntentDetail (captured = verified_amount ?? amount, refunded = refunded_amount); overpaid = Money "order overpaid by" (from C4, page-supplied).
//       IntentDetailView (PG-T18) opens it from "Request refund" when given `codes.refund_reasons` + `overpaid`.
//   * actions call the API (MSW observes) with If-Match = refund.version (P9/P10/P11/P11b/P7b) + Idempotency-Key; P8 = Idempotency-Key only.
//   * app/(staff)/payments/refunds/page.tsx = async `Page({ searchParams })`: GET P6 + P24 (refund_reject_reasons, refund_fail_reasons, refund_hold_reasons).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ORIGIN, U, axeClean, describedText, isEnabled, noRawCodes, npr, pick, problem, recorder, wrap, type Call } from './pg-t19.helpers';

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ current: ['payments.reconciliation.read'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/payments/refunds',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.current, displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [], membershipId: ME } }),
  getRequestPathname: async () => '/payments/refunds',
}));

const A = U(11), ME = U(12), B = U(13);
const READ = ['payments.reconciliation.read'];
const APPROVE = [...READ, 'payments.refund.approve'];
const ALL = [...APPROVE, 'payments.intent.resolve', 'payments.refund.request'];
const codes = {
  refund_reject_reasons: [
    { code: 'not_eligible', display: 'Not eligible', requires_text: false, is_active: true },
    { code: 'wrong_amount', display: 'Wrong amount', requires_text: false, is_active: true },
    { code: 'other', display: 'Other', requires_text: true, is_active: true },
  ],
  refund_fail_reasons: [
    { code: 'gateway_confirmed_not_refunded', display: 'Provider confirmed no refund was made', requires_text: false, is_active: true },
    { code: 'refund_rejected_by_provider', display: 'Provider rejected the refund', requires_text: false, is_active: true },
    { code: 'other', display: 'Other', requires_text: true, is_active: true },
  ],
  refund_hold_reasons: [
    { code: 'refund_not_visible', display: 'Refund not visible at the provider yet', requires_text: false, is_active: true },
    { code: 'refund_kind_mismatch', display: 'Refund type does not match', requires_text: false, is_active: true },
    { code: 'api_outcome_unknown', display: 'Provider answer unknown', requires_text: false, is_active: true },
  ],
};
const refundReasons = [
  { code: 'test_cancelled', display: 'Test cancelled', requires_text: false, is_active: true },
  { code: 'overpayment', display: 'Overpayment', requires_text: false, is_active: true },
  { code: 'other', display: 'Other', requires_text: true, is_active: true },
];
const refund = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(400 + n), intent_id: U(100 + n), order_id: U(200 + n), gateway: 'khalti', mode: 'manual', status: 'pending_approval', amount: npr(225000), reason_code: 'test_cancelled',
  requested_by: { membership_id: A, display_name: 'Synthetic Finance A' }, requested_at: '2026-11-10T04:00:00.000Z', version: 1, ...o,
});
const approvedBy = { membership_id: B, display_name: 'Synthetic Finance B' };
const rows = [
  refund(1),                                                                                   // pending_approval, requested by A
  refund(2, { requested_by: { membership_id: ME, display_name: 'Synthetic Finance Me' } }),   // own request
  refund(3, { status: 'requested', gateway: 'esewa', approved_by: approvedBy, approved_at: '2026-11-10T05:00:00.000Z' }),
  refund(4, { status: 'held_for_review', approved_by: approvedBy, approved_at: '2026-11-10T05:00:00.000Z', held_reason: 'refund_not_visible', version: 3 }),
  refund(5, { status: 'requested', mode: 'api', approved_by: approvedBy, approved_at: '2026-11-10T05:00:00.000Z' }),
  refund(6, { status: 'completed', approved_by: approvedBy, completed_at: '2026-11-10T07:00:00.000Z' }),
  refund(7, { status: 'failed', failure_reason: 'gateway_confirmed_not_refunded' }),
  refund(8, { status: 'rejected', rejected_by: approvedBy, rejected_at: '2026-11-10T06:00:00.000Z' }),
];

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
const ok = (o: Record<string, unknown> = {}): R => () => HttpResponse.json(refund(1, { status: 'requested', ...o }));
let approve: R, reject: R, confirm: R, recheck: R, fail: R, create: R, list: R;
const reset = () => {
  approve = ok(); reject = ok({ status: 'rejected' }); confirm = ok({ status: 'completed' }); recheck = ok({ status: 'held_for_review' }); fail = ok({ status: 'failed' });
  create = () => HttpResponse.json(refund(9), { status: 201 }); list = () => HttpResponse.json({ data: rows, page: { limit: 50 } });
};
reset();
const api = setupServer(
  http.get(`${ORIGIN}/v1/payments/refunds`, async ({ request }) => { await rec(request); return list(); }),
  http.post(`${ORIGIN}/v1/payments/refunds/:id/approve`, async ({ request }) => { await rec(request); return approve(); }),
  http.post(`${ORIGIN}/v1/payments/refunds/:id/reject`, async ({ request }) => { await rec(request); return reject(); }),
  http.post(`${ORIGIN}/v1/payments/refunds/:id/confirm-manual`, async ({ request }) => { await rec(request); return confirm(); }),
  http.post(`${ORIGIN}/v1/payments/refunds/:id/recheck`, async ({ request }) => { await rec(request); return recheck(); }),
  http.post(`${ORIGIN}/v1/payments/refunds/:id/fail`, async ({ request }) => { await rec(request); return fail(); }),
  http.post(`${ORIGIN}/v1/payments/intents/:id/refunds`, async ({ request }) => { await rec(request); return create(); }),
  ...(['refund_reject_reasons', 'refund_fail_reasons', 'refund_hold_reasons'] as const).map((s) =>
    http.get(`${ORIGIN}/v1/payments/coded-sets/${s}`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: codes[s] }); })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-12T06:00:00Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); push.mockReset(); perms.current = READ; reset(); });
afterAll(() => api.close());

const comp = async () => ((await import(/* @vite-ignore */ '../components/RefundsList')) as { RefundsList: (p: any) => any }).RefundsList;
const view = async (permissions: readonly string[] = ALL, data: unknown[] = rows, extra: Record<string, unknown> = {}) => {
  const RefundsList = await comp();
  return wrap(<RefundsList refunds={data as never} permissions={permissions} currentMembershipId={ME} codes={codes} {...extra} />);
};
const rowOf = (n: number) => document.querySelector(`a[href="/payments/intents/${U(100 + n)}"]`)!.closest('tr') as HTMLElement;
const act = (n: number, name: RegExp) => within(rowOf(n)).queryByRole('button', { name });
const posts = (suffix: string, n?: number) => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith(`/${suffix}`) && (n === undefined || c.url.pathname.includes(U(400 + n))));
const dlgOf = async () => screen.findByRole('dialog');
const SECOND = 'A second person must approve this refund.';

describe('§2.3 RefundsList — table', () => {
  it('title mentions refunds; the nine columns in spec order', async () => {
    await view();
    expect(screen.getByRole('heading', { level: 1, name: /refunds/i })).toBeTruthy();
    const heads = screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim().toLowerCase());
    let at = -1;
    for (const w of ['requested', 'gateway', 'amount', 'status', 'mode', 'requested by', 'approved by', 'reason under review', 'intent']) {
      const i = heads.findIndex((h, k) => k > at && h.startsWith(w));
      expect(i, `column ${w} in ${heads.join('|')}`).toBeGreaterThan(at);
      at = i;
    }
  });

  it('row facts: gateway, lakh NPR amount, TEXT status with the spec label, Manual / Provider API mode, names (not membership ids), intent link', async () => {
    await view();
    const r1 = rowOf(1);
    expect(within(r1).getByText('Khalti')).toBeTruthy();
    expect(within(r1).getByText(/2,250\.00/)).toBeTruthy();
    expect(within(r1).getByText('Waiting for approval')).toBeTruthy();
    expect(within(r1).getByText('Manual')).toBeTruthy();
    expect(within(r1).getByText('Synthetic Finance A')).toBeTruthy();
    expect(r1.textContent).not.toContain(A);
    expect(within(rowOf(5)).getByText('Provider API')).toBeTruthy();
    expect(within(rowOf(5)).getByText('Refund in progress')).toBeTruthy();
    expect(within(rowOf(3)).getByText('eSewa')).toBeTruthy();
    expect(within(rowOf(3)).getByText('Synthetic Finance B')).toBeTruthy();
    expect(within(rowOf(6)).getByText('Completed')).toBeTruthy();
    expect(within(rowOf(7)).getByText('Failed')).toBeTruthy();
    expect(within(rowOf(8)).getByText('Rejected')).toBeTruthy();
  });

  it('held refund: status "Under review" and the hold reason by display text, never the raw code (§2.3 "Reason under review")', async () => {
    await view();
    const r4 = rowOf(4);
    expect(within(r4).getByText('Under review')).toBeTruthy();
    expect(within(r4).getByText('Refund not visible at the provider yet')).toBeTruthy();
    expect(r4.textContent).not.toMatch(/refund_not_visible/);
  });

  it('filters: status (the seven spec options), gateway, created range', async () => {
    await view();
    const box = screen.getByRole('listbox', { name: /status/i });
    for (const l of ['Waiting for approval', 'Approved', 'Refund in progress', 'Under review', 'Completed', 'Failed', 'Rejected']) expect(within(box).getByRole('option', { name: new RegExp(l, 'i') })).toBeTruthy();
    expect(screen.getAllByText(/gateway/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/created/i).length).toBeGreaterThan(0);
  });

  it('never renders callback tokens, return URLs, raw payloads, secrets or the bearer token even if the API leaks them (07-SECURITY)', async () => {
    const leaky = refund(10, { callback_token: 'tok_SECRETSECRETSECRET1', return_url: 'https://portal.test/r/payments/x', raw_payload: '{"secret":"x"}', secret: 'sk_live_LEAK' });
    const { container } = await view(ALL, [leaky]);
    expect(container.innerHTML).not.toMatch(/tok_SECRET|portal\.test|"secret"|sk_live_LEAK|jwt-synthetic/);
  });

  it('never shows "Payment successful" / "Fonepay verified" copy', async () => {
    await view();
    expect(document.body.textContent).not.toMatch(/Payment successful|Fonepay verified/);
  });
});

describe('§2.3 row actions — visibility per state and permission', () => {
  it('pending_approval: Approve + Reject (payments.refund.approve); nothing for completed / failed / rejected', async () => {
    await view(APPROVE);
    expect(isEnabled(act(1, /approve/i))).toBe(true);
    expect(isEnabled(act(1, /reject/i))).toBe(true);
    for (const n of [6, 7, 8]) for (const b of [/approve/i, /reject/i, /confirm refund done/i, /re-check/i, /mark refund failed/i]) expect(isEnabled(act(n, b))).toBe(false);
  });

  it('requested / held_for_review manual: Confirm refund done, Mark refund failed (approve perm), Re-check (payments.intent.resolve)', async () => {
    await view(ALL);
    for (const n of [3, 4]) {
      expect(isEnabled(act(n, /confirm refund done/i))).toBe(true);
      expect(isEnabled(act(n, /mark refund failed/i))).toBe(true);
      expect(isEnabled(act(n, /re-check/i))).toBe(true);
      expect(isEnabled(act(n, /approve/i))).toBe(false);
    }
  });

  it('api-mode refund in progress: no "Confirm refund done" (only manual refunds are confirmed by hand)', async () => {
    await view(ALL);
    expect(isEnabled(act(5, /confirm refund done/i))).toBe(false);
    expect(isEnabled(act(5, /re-check/i))).toBe(true);
  });

  it('permission floors: read-only sees no action; resolve-only sees Re-check only; approve-only sees no Re-check', async () => {
    await view(READ);
    for (const n of [1, 3, 4]) for (const b of [/approve/i, /reject/i, /confirm refund done/i, /re-check/i, /mark refund failed/i]) expect(isEnabled(act(n, b)), `${n} ${b}`).toBe(false);
    cleanup();
    await view([...READ, 'payments.intent.resolve']);
    expect(isEnabled(act(3, /re-check/i))).toBe(true);
    for (const b of [/approve/i, /reject/i, /confirm refund done/i, /mark refund failed/i]) expect(isEnabled(act(3, b))).toBe(false);
    cleanup();
    await view(APPROVE);
    expect(isEnabled(act(3, /re-check/i))).toBe(false);
    expect(isEnabled(act(3, /confirm refund done/i))).toBe(true);
  });
});

describe('AC-PG-09.3 Approve (P9) and the two-person rule', () => {
  it('own request: Approve is disabled and the reason "A second person must approve this refund." is available (tooltip / description)', async () => {
    await view(APPROVE);
    const b = act(2, /approve/i)!;
    expect(b).toBeTruthy();
    expect(isEnabled(b)).toBe(false);
    await userEvent.hover(b.parentElement ?? b);
    await waitFor(() => expect(document.body.textContent!.includes(SECOND) || describedText(b).includes(SECOND)).toBe(true));
  });

  it('own request within the tenant threshold (amount ≤ thresholdPaisa) may be approved; with threshold 0 / absent it may not', async () => {
    await view(APPROVE, rows, { thresholdPaisa: 225000 });
    expect(isEnabled(act(2, /approve/i))).toBe(true);
    cleanup();
    await view(APPROVE, rows, { thresholdPaisa: 0 });
    expect(isEnabled(act(2, /approve/i))).toBe(false);
  });

  it('own request, threshold 500000: amount ≤ threshold → Approve enabled; amount > threshold → disabled with the second-person hint', async () => {
    await view(APPROVE, rows, { thresholdPaisa: 500000 });
    expect(isEnabled(act(2, /approve/i))).toBe(true); // row 2 amount 225000 ≤ 500000
    cleanup();
    await view(APPROVE, rows, { thresholdPaisa: 100000 }); // 225000 > 100000
    const b = act(2, /approve/i)!;
    expect(isEnabled(b)).toBe(false);
    await userEvent.hover(b.parentElement ?? b);
    await waitFor(() => expect(document.body.textContent!.includes(SECOND) || describedText(b).includes(SECOND)).toBe(true));
  });

  it('another person\'s request: ConfirmDialog "Approve refund of NPR 2,250.00?" with the manual-mode next step and an optional note ≤ 500', async () => {
    await view(APPROVE);
    await userEvent.click(act(1, /approve/i)!);
    const dlg = await dlgOf();
    expect(within(dlg).getByText('Approve refund of NPR 2,250.00?')).toBeTruthy();
    expect(within(dlg).getByText('Refund the patient in the Khalti merchant dashboard, then confirm here.')).toBeTruthy();
    const note = within(dlg).getByRole('textbox');
    expect((note as HTMLInputElement).maxLength).toBeLessThanOrEqual(500);
    expect(note.hasAttribute('required')).toBe(false);
  });

  it('api-mode text: "The refund will be sent to Khalti automatically."', async () => {
    await view(APPROVE, [refund(1, { mode: 'api' })]);
    await userEvent.click(act(1, /approve/i)!);
    expect(within(await dlgOf()).getByText('The refund will be sent to Khalti automatically.')).toBeTruthy();
  });

  it('confirming POSTs /approve with If-Match = version, an Idempotency-Key, the note, and the Bearer token; then refreshes', async () => {
    await view(APPROVE);
    await userEvent.click(act(1, /approve/i)!);
    const dlg = await dlgOf();
    await userEvent.type(within(dlg).getByRole('textbox'), 'checked with finance lead');
    await userEvent.click(within(dlg).getByRole('button', { name: /^approve/i }));
    await waitFor(() => expect(posts('approve', 1)).toHaveLength(1));
    const c = posts('approve', 1)[0]!;
    expect(c.headers.get('if-match')).toMatch(/1/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(String(c.body?.note ?? '')).toMatch(/finance lead/);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a double click on confirm sends one request only (race / double submit)', async () => {
    approve = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(refund(1, { status: 'requested' })); };
    await view(APPROVE);
    await userEvent.click(act(1, /approve/i)!);
    const dlg = await dlgOf();
    await userEvent.dblClick(within(dlg).getByRole('button', { name: /^approve/i }));
    await waitFor(() => expect(posts('approve').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(posts('approve')).toHaveLength(1);
  });

  it('403 payments.refund_self_approval_forbidden (server decides) is shown as the same plain text, never the code', async () => {
    approve = () => problem('payments.refund_self_approval_forbidden', 403);
    await view(APPROVE);
    await userEvent.click(act(1, /approve/i)!);
    await userEvent.click(within(await dlgOf()).getByRole('button', { name: /^approve/i }));
    expect(await screen.findByText(new RegExp(SECOND))).toBeTruthy();
    noRawCodes();
  });

  it('422 payments.refund_exceeds_captured on approve and 409 payments.refund_not_allowed show plain text only', async () => {
    approve = () => problem('payments.refund_exceeds_captured', 422);
    await view(APPROVE);
    await userEvent.click(act(1, /approve/i)!);
    await userEvent.click(within(await dlgOf()).getByRole('button', { name: /^approve/i }));
    await waitFor(() => expect(posts('approve')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    noRawCodes();
  });

  it('409 common.version_conflict: "changed — reload" guidance, no raw code', async () => {
    approve = () => problem('common.version_conflict', 409);
    await view(APPROVE);
    await userEvent.click(act(1, /approve/i)!);
    await userEvent.click(within(await dlgOf()).getByRole('button', { name: /^approve/i }));
    expect(await screen.findByText(/changed|reload/i)).toBeTruthy();
    noRawCodes();
  });
});

describe('Reject (P10)', () => {
  it('danger ConfirmDialog requires a coded reason (refund_reject_reasons); nothing is sent without one', async () => {
    await view(APPROVE);
    await userEvent.click(act(1, /reject/i)!);
    const dlg = await dlgOf();
    await userEvent.click(within(dlg).getByRole('button', { name: /^reject/i }));
    expect(posts('reject')).toHaveLength(0);
    await pick(dlg, /Not eligible/);
    await userEvent.click(within(dlg).getByRole('button', { name: /^reject/i }));
    await waitFor(() => expect(posts('reject', 1)).toHaveLength(1));
    const c = posts('reject', 1)[0]!;
    expect(c.body.reason_code).toBe('not_eligible');
    expect(c.headers.get('if-match')).toMatch(/1/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
  });

  it('reason "other" needs a note before anything is sent', async () => {
    await view(APPROVE);
    await userEvent.click(act(1, /reject/i)!);
    const dlg = await dlgOf();
    await pick(dlg, /^Other$/);
    await userEvent.click(within(dlg).getByRole('button', { name: /^reject/i }));
    expect(posts('reject')).toHaveLength(0);
    await userEvent.type(within(dlg).getByRole('textbox'), 'Duplicate of refund already paid in dashboard');
    await userEvent.click(within(dlg).getByRole('button', { name: /^reject/i }));
    await waitFor(() => expect(posts('reject')).toHaveLength(1));
    expect(String(posts('reject')[0]!.body.note)).toMatch(/Duplicate/);
  });

  it('Cancel sends nothing and returns focus to the trigger (focus trap + return, §6)', async () => {
    await view(APPROVE);
    const trigger = act(1, /reject/i)!;
    await userEvent.click(trigger);
    await userEvent.click(within(await dlgOf()).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts('reject')).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('§2.3.2 / AC-PG-09.4–09.5 Confirm manual refund (P11)', () => {
  const open = async (n = 3) => {
    await view(ALL);
    await userEvent.click(act(n, /confirm refund done/i)!);
    return dlgOf();
  };
  const fill = async (dlg: HTMLElement, ref: string, date: string) => {
    const r = within(dlg).getByRole('textbox', { name: /provider refund reference/i });
    await userEvent.clear(r);
    if (ref) await userEvent.type(r, ref);
    const d = within(dlg).getByRole('textbox', { name: /refunded on/i });
    await userEvent.clear(d);
    if (date) await userEvent.type(d, date);
    await userEvent.tab();
  };
  const submit = (dlg: HTMLElement) => userEvent.click(within(dlg).getAllByRole('button').find((b) => /confirm/i.test(b.textContent ?? '') && !/cancel/i.test(b.textContent ?? ''))!);

  it('has "Provider refund reference" (maxLength 100) and "Refunded on" date fields', async () => {
    const dlg = await open();
    expect((within(dlg).getByRole('textbox', { name: /provider refund reference/i }) as HTMLInputElement).maxLength).toBe(100);
    expect(within(dlg).getByRole('textbox', { name: /refunded on/i })).toBeTruthy();
  });

  it('a malformed reference (not ^[A-Za-z0-9_.:/-]{1,100}$) or an empty one sends nothing', async () => {
    const dlg = await open();
    await fill(dlg, 'bad ref!<x>', '11/11/2026');
    await submit(dlg);
    expect(posts('confirm-manual')).toHaveLength(0);
    await fill(dlg, '', '11/11/2026');
    await submit(dlg);
    expect(posts('confirm-manual')).toHaveLength(0);
    expect(dlg.querySelector('[aria-invalid="true"]')).toBeTruthy();
  });

  it('a date after today or before the refund was approved sends nothing', async () => {
    const dlg = await open();
    await fill(dlg, 'KH-REF/123', '13/11/2026');
    await submit(dlg);
    expect(posts('confirm-manual')).toHaveLength(0);
    await fill(dlg, 'KH-REF/123', '09/11/2026');
    await submit(dlg);
    expect(posts('confirm-manual')).toHaveLength(0);
  });

  it('valid input POSTs {gateway_refund_reference, refunded_on:"2026-11-11"} with If-Match + Idempotency-Key; "completed" ⇒ toast "Refund confirmed by eSewa and recorded."', async () => {
    confirm = ok({ status: 'completed', gateway: 'esewa' });
    const dlg = await open(3);
    await fill(dlg, 'ES-REF_0001:A', '11/11/2026');
    await submit(dlg);
    await waitFor(() => expect(posts('confirm-manual', 3)).toHaveLength(1));
    const c = posts('confirm-manual', 3)[0]!;
    expect(c.body).toMatchObject({ gateway_refund_reference: 'ES-REF_0001:A', refunded_on: '2026-11-11' });
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(await screen.findByText('Refund confirmed by eSewa and recorded.')).toBeTruthy();
  });

  it('"held_for_review" ⇒ warning toast "Khalti does not show this refund yet. We will check again tonight."; never claims completed', async () => {
    confirm = ok({ status: 'held_for_review' });
    const dlg = await open(4);
    await fill(dlg, 'KH-REF-9', '11/11/2026');
    await submit(dlg);
    expect(await screen.findByText('Khalti does not show this refund yet. We will check again tonight.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/confirmed by Khalti and recorded/);
  });
});

describe('AC-PG-09.10 Re-check (P7b)', () => {
  it('POSTs /recheck and toasts "Checked with Khalti: <status label>"', async () => {
    recheck = ok({ status: 'completed' });
    await view(ALL);
    await userEvent.click(act(4, /re-check/i)!);
    await waitFor(() => expect(posts('recheck', 4)).toHaveLength(1));
    expect(await screen.findByText('Checked with Khalti: Completed')).toBeTruthy();
    expect(posts('recheck', 4)[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });

  it('refund still not visible ⇒ toast says "Under review"', async () => {
    recheck = ok({ status: 'held_for_review' });
    await view(ALL);
    await userEvent.click(act(3, /re-check/i)!);
    expect(await screen.findByText('Checked with Khalti: Under review')).toBeTruthy();
  });

  it('429 common.rate_limited ⇒ toast "Checked a moment ago. Try again in a few seconds."; no raw code, no status change', async () => {
    recheck = () => problem('common.rate_limited', 429, {}, { 'Retry-After': '7' });
    await view(ALL);
    await userEvent.click(act(4, /re-check/i)!);
    expect(await screen.findByText('Checked a moment ago. Try again in a few seconds.')).toBeTruthy();
    noRawCodes();
    expect(document.body.textContent).not.toMatch(/Checked with/);
  });

  it('a double click sends one request only', async () => {
    recheck = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(refund(4, { status: 'held_for_review' })); };
    await view(ALL);
    await userEvent.dblClick(act(4, /re-check/i)!);
    await new Promise((r) => setTimeout(r, 250));
    expect(posts('recheck')).toHaveLength(1);
  });

  it('503 payments.gateway_not_available ⇒ plain "provider not available" text, no raw code', async () => {
    recheck = () => problem('payments.gateway_not_available', 503);
    await view(ALL);
    await userEvent.click(act(4, /re-check/i)!);
    await waitFor(() => expect(posts('recheck')).toHaveLength(1));
    expect(await screen.findByText(/not available|try again/i)).toBeTruthy();
    noRawCodes();
  });
});

describe('AC-PG-09.9 Mark refund failed (P11b)', () => {
  const open = async (n = 3) => {
    await view(ALL);
    await userEvent.click(act(n, /mark refund failed/i)!);
    return dlgOf();
  };
  it('danger ConfirmDialog "Mark this refund as failed?" with the spec body naming the gateway', async () => {
    const dlg = await open();
    expect(within(dlg).getByText('Mark this refund as failed?')).toBeTruthy();
    expect(within(dlg).getByText('We check with eSewa first. Only do this if eSewa confirmed that no refund was made. No ledger entry is written, and a new refund can be requested.')).toBeTruthy();
  });

  it('requires a coded reason (refund_fail_reasons); sends {reason_code} with If-Match + Idempotency-Key', async () => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /mark.*failed/i }));
    expect(posts('fail')).toHaveLength(0);
    await pick(dlg, /Provider confirmed no refund was made/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark.*failed/i }));
    await waitFor(() => expect(posts('fail', 3)).toHaveLength(1));
    const c = posts('fail', 3)[0]!;
    expect(c.body.reason_code).toBe('gateway_confirmed_not_refunded');
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(c.headers.get('idempotency-key')).toBeTruthy();
  });

  it('code "other" (requires_text) needs free text before anything is sent; the note is limited to 500', async () => {
    const dlg = await open();
    await pick(dlg, /^Other$/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark.*failed/i }));
    expect(posts('fail')).toHaveLength(0);
    const t = within(dlg).getByRole('textbox') as HTMLInputElement;
    expect(t.maxLength).toBeLessThanOrEqual(500);
    await userEvent.type(t, 'Khalti support ticket 77 says nothing refunded');
    await userEvent.click(within(dlg).getByRole('button', { name: /mark.*failed/i }));
    await waitFor(() => expect(posts('fail')).toHaveLength(1));
    expect(String(posts('fail')[0]!.body.note)).toMatch(/ticket 77/);
  });

  it('409 payments.refund_not_allowed ⇒ banner "Khalti shows a refund for this payment. Use Re-check instead."', async () => {
    fail = () => problem('payments.refund_not_allowed', 409, { detail: 'gateway_shows_refund' });
    const dlg = await open();
    await pick(dlg, /Provider confirmed no refund was made/);
    await userEvent.click(within(dlg).getByRole('button', { name: /mark.*failed/i }));
    expect(await screen.findByText('eSewa shows a refund for this payment. Use Re-check instead.')).toBeTruthy();
    noRawCodes();
    expect(document.body.textContent).not.toMatch(/gateway_shows_refund/);
  });
});

describe('§2.3.1 / AC-PG-09.1, 09.2, 09.8 Request refund dialog (P8)', () => {
  const settledIntent = (o: Record<string, unknown> = {}) => ({
    id: U(101), order_id: U(201), centre_id: U(3), gateway: 'khalti', environment: 'production', status: 'settled', amount: npr(225000), verified_amount: npr(225000), refunded_amount: npr(0),
    created_at: '2026-11-10T04:00:00.000Z', version: 4, ...o,
  });
  const dlgComp = async () => ((await import(/* @vite-ignore */ '../components/RefundRequestDialog')) as { RefundRequestDialog: (p: any) => any }).RefundRequestDialog;
  const ui = (D: any, o: { intent?: unknown; overpaid?: unknown; isOpen?: boolean } = {}) => (
    <D intent={(o.intent ?? settledIntent()) as never} overpaid={(o.overpaid ?? npr(225000)) as never} refundReasons={refundReasons} isOpen={o.isOpen ?? true} onClose={vi.fn()} />
  );
  const show = async (o: { intent?: unknown; overpaid?: unknown } = {}) => { const D = await dlgComp(); return wrap(ui(D, o)); };
  const amount = () => screen.getByRole('textbox', { name: /amount/i }) as HTMLInputElement;
  const submit = () => userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /request refund/i }));
  const setAmount = async (v: string) => { await userEvent.clear(amount()); await userEvent.type(amount(), v); };

  it('shows the Amount field defaulting to the refundable amount, a coded Reason, a Details field, and the spec helper text', async () => {
    await show();
    const dlg = screen.getByRole('dialog');
    expect(amount().value).toMatch(/2,250\.00/);
    expect(within(dlg).getByText('Refundable now: NPR 2,250.00 (captured NPR 2,250.00, already refunded NPR 0.00, order overpaid by NPR 2,250.00)')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: /reason/i })).toBeTruthy();
    const details = within(dlg).getByRole('textbox', { name: /details/i }) as HTMLTextAreaElement;
    expect(details.maxLength).toBe(500);
  });

  it('refundable = min(captured − refunded, overpaid): partly refunded + small overpayment ⇒ the smaller one', async () => {
    await show({ intent: settledIntent({ status: 'partially_refunded', refunded_amount: npr(25000) }), overpaid: npr(100000) });
    expect(screen.getByText('Refundable now: NPR 1,000.00 (captured NPR 2,250.00, already refunded NPR 250.00, order overpaid by NPR 1,000.00)')).toBeTruthy();
    expect(amount().value).toMatch(/1,000\.00/);
  });

  it('AC-PG-09.1: submit POSTs /intents/{id}/refunds {refund_amount_paisa:225000, reason_code:"test_cancelled"} with an Idempotency-Key and the Bearer token', async () => {
    await show();
    await pick(screen.getByRole('dialog'), /Test cancelled/);
    await submit();
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    const c = calls[0]!;
    expect(c.url.pathname).toBe(`/v1/payments/intents/${U(101)}/refunds`);
    expect(c.body).toMatchObject({ refund_amount_paisa: 225000, reason_code: 'test_cancelled' });
    expect(Number.isInteger(c.body.refund_amount_paisa)).toBe(true);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a reason is required (nothing sent without one); reason "other" also requires Details', async () => {
    await show();
    await submit();
    expect(calls).toHaveLength(0);
    await pick(screen.getByRole('dialog'), /^Other$/);
    await submit();
    expect(calls).toHaveLength(0);
    await userEvent.type(screen.getByRole('textbox', { name: /details/i }), 'Customer paid twice by mistake');
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.reason_text).toMatch(/paid twice/);
  });

  it('AC-PG-09.2 (client side): more than the refundable amount, zero or empty sends nothing and shows "More than can be refunded (max NPR 2,250.00)"', async () => {
    await show();
    await pick(screen.getByRole('dialog'), /Test cancelled/);
    await setAmount('2,250.01');
    await submit();
    expect(calls).toHaveLength(0);
    expect(await screen.findByText('More than can be refunded (max NPR 2,250.00)')).toBeTruthy();
    await setAmount('0');
    await submit();
    expect(calls).toHaveLength(0);
  });

  it('AC-PG-09.2 (server side): 422 payments.refund_exceeds_captured ⇒ field error on Amount with the max, no raw code', async () => {
    create = () => problem('payments.refund_exceeds_captured', 422, { detail: 'exceeds refundable balance' });
    await show();
    await pick(screen.getByRole('dialog'), /Test cancelled/);
    await submit();
    expect(await screen.findByText('More than can be refunded (max NPR 2,250.00)')).toBeTruthy();
    noRawCodes();
    expect(document.body.textContent).not.toMatch(/exceeds refundable balance/);
  });

  it('409 payments.refund_not_allowed ⇒ banner "A refund is already in progress for this payment."', async () => {
    create = () => problem('payments.refund_not_allowed', 409);
    await show();
    await pick(screen.getByRole('dialog'), /Test cancelled/);
    await submit();
    expect(await screen.findByText('A refund is already in progress for this payment.')).toBeTruthy();
    noRawCodes();
  });

  it('AC-PG-09.8: the Idempotency-Key is generated when the dialog opens and re-used on retry; a freshly opened dialog gets a new key', async () => {
    let n = 0;
    create = () => (++n === 1 ? problem('common.dependency_unavailable', 503) : HttpResponse.json(refund(9), { status: 201 }));
    const D = await dlgComp();
    const r = wrap(ui(D));
    await pick(screen.getByRole('dialog'), /Test cancelled/);
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    await submit();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'));
    r.unmount();
    wrap(ui(D));
    await pick(screen.getByRole('dialog'), /Test cancelled/);
    await submit();
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.headers.get('idempotency-key')).not.toBe(calls[0]!.headers.get('idempotency-key'));
  });

  it('a double click on "Request refund" sends one request only (race / double submit)', async () => {
    create = async () => { await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(refund(9), { status: 201 }); };
    await show();
    await pick(screen.getByRole('dialog'), /Test cancelled/);
    await userEvent.dblClick(within(screen.getByRole('dialog')).getByRole('button', { name: /request refund/i }));
    await new Promise((r) => setTimeout(r, 250));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('Ctrl+Enter submits (keyboard script, §2.3.1)', async () => {
    await show();
    await pick(screen.getByRole('dialog'), /Test cancelled/);
    amount().focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
  });

  it('IntentDetailView "Request refund" opens this dialog (Amount + Reason) when given codes.refund_reasons and overpaid', async () => {
    const V = ((await import(/* @vite-ignore */ '../components/IntentDetailView')) as { IntentDetailView: (p: any) => any }).IntentDetailView;
    wrap(<V intent={settledIntent() as never} permissions={ALL} overpaid={npr(225000)} codes={{ resolution_reasons: [], cancel_reasons: [], refund_reasons: refundReasons }} />);
    await userEvent.click(screen.getByRole('button', { name: /request refund/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('textbox', { name: /amount/i })).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: /reason/i })).toBeTruthy();
  });

  it('axe: dialog open has no violations', async () => { await show(); await axeClean(); });
});

describe('§6 a11y — refunds list', () => {
  it('axe: no violations with rows', async () => { await view(); await axeClean(); });
  it('axe: no violations when empty', async () => { await view(ALL, []); await axeClean(); });
  it('axe: no violations with an approve dialog open', async () => { await view(APPROVE); await userEvent.click(act(1, /approve/i)!); await dlgOf(); await axeClean(); });
  it('axe: no violations with the confirm-manual dialog open', async () => { await view(ALL); await userEvent.click(act(3, /confirm refund done/i)!); await dlgOf(); await axeClean(); });
});

type SP = Record<string, string | string[] | undefined>;
const loadPage = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/payments/refunds/page')) as { default: (p: { searchParams: Promise<SP> }) => Promise<any> }).default;
const show = async (sp: SP = {}) => { const Page = await loadPage(); return wrap(await Page({ searchParams: Promise.resolve(sp) })); };

describe('refunds page.tsx — request (P6/P24)', () => {
  it('no payments.reconciliation.read ⇒ not found and no API call at all', async () => {
    perms.current = [];
    await expect(show()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('GET /v1/payments/refunds with sort=-created_at and a page limit; fetches the reject, fail and hold code sets; Bearer from the session, never in the DOM', async () => {
    perms.current = ALL;
    const { container } = await show();
    const l = calls.find((c) => c.url.pathname === '/v1/payments/refunds')!;
    expect(l).toBeTruthy();
    expect(l.url.searchParams.get('sort')).toMatch(/^-?created_at$/);
    expect(Number(l.url.searchParams.get('limit') ?? 50)).toBeLessThanOrEqual(50);
    expect(l.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    for (const s of ['refund_reject_reasons', 'refund_fail_reasons', 'refund_hold_reasons']) expect(calls.some((c) => c.url.pathname === `/v1/payments/coded-sets/${s}`), s).toBe(true);
    expect(container.innerHTML).not.toContain('jwt-synthetic');
    expect((await within(screen.getByRole('grid')).findAllByText('Synthetic Finance A', {}, { timeout: 3000 })).length).toBeGreaterThan(0);
  });

  it('forwards only whitelisted, well-formed params; drops tenant_id / evil / malformed values', async () => {
    perms.current = ALL;
    await show({ status: 'requested,held_for_review', gateway: 'khalti', evil: '1', tenant_id: 'other-tenant', intent_id: U(101) });
    const q = calls.find((c) => c.url.pathname === '/v1/payments/refunds')!.url.searchParams;
    expect(q.get('status')).toBe('requested,held_for_review');
    expect(q.get('gateway')).toBe('khalti');
    expect(q.has('evil')).toBe(false);
    expect(q.has('tenant_id')).toBe(false);
  });

  it.each([['status', 'requested&gateway=x'], ['status', 'not_a_status'], ['gateway', 'fonepay;drop'], ['created_at_from', '2026-11-1; drop'], ['intent_id', '../../etc/passwd']])('does not forward a malformed %s (%s)', async (key, bad) => {
    perms.current = ALL;
    await show({ [key]: bad });
    for (const c of calls) { expect(c.url.searchParams.get(key)).not.toBe(bad); expect(c.url.search).not.toMatch(/drop|passwd/); }
  });

  it('API 403 shows no refund rows; API 5xx rejects so error.tsx renders', async () => {
    perms.current = ALL;
    list = () => problem('auth.forbidden', 403);
    try { await show(); } catch { /* may reject or render a denied state */ }
    expect(document.body.textContent).not.toMatch(/Synthetic Finance A|NPR 2,250/);
    cleanup();
    list = () => problem('common.dependency_unavailable', 503);
    await expect(show()).rejects.toBeTruthy();
  });

  it('axe: page output has no violations', async () => { perms.current = ALL; await show(); await axeClean(); });
});
