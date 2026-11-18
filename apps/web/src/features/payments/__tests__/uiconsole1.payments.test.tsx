// @vitest-environment jsdom
// T0D-UICONSOLE-1 (3) payment review and (4) gateway refunds (LD-353 template 2 CONSOLE, rules 5, 6, 8). Same shared contract as uiconsole1.lab.test.tsx (src/__tests__/uiconsole1.contract.tsx).
// PAYMENT REVIEW (ReviewQueue({ intents, permissions, centres, holdReasons, filter?, nextCursor?, hasPrevious? }), route /payments/review, menu payments.nav.review):
//   list headers: Age first (live hh:mm since created_at), then at least Created, Gateway, Amount, Status (extra columns the screen already had may stay). Tiles Under review (status held_for_review),
//   Waiting for provider (status pending), Oldest age (the oldest UNDER REVIEW row, a dash when none). FilterBar keeps Status, Gateway, Hold reason, Created (the URL filters the page already reads).
//   Detail: gateway, amount, status, reason (hold reason text, never the code), last checked, link to the order and to the payment; History (Created, Checked when last_checked_at, Paid when settled_at).
//   Bar: a link to /payments/intents/{id} whose label ends with a shortcut "(O)". NO new action: no button in the bar.
// GATEWAY REFUNDS (RefundsList({ refunds, permissions, currentMembershipId, codes, thresholdPaisa?, filter?, nextCursor?, hasPrevious? }), route /payments/refunds, menu payments.nav.refunds):
//   list headers: Age first (live hh:mm since requested_at), then at least Requested, Gateway, Amount, Status. Tiles Pending approval (status pending_approval), With provider (approved, requested, held_for_review),
//   Oldest age (the oldest PENDING APPROVAL row). FilterBar keeps Status, Gateway, Created.
//   Detail: gateway, amount, status text, mode, requested by, approved by, reason under review, link to the payment; History (Requested, Approved when approved_at).
//   Sticky bar = the row actions the screen already has, for the selected refund, same gates: Approve + Reject (pending_approval, payments.refund.approve; Approve disabled on your own request above the threshold),
//   Confirm refund done (open state, manual mode, approve), Re-check (open state, payments.intent.resolve), Mark refund failed (open state, approve). The first action's label ends with a shortcut "(X)".
//   The dialogs stay as they are (Approve opens "Approve refund of ...").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { consoleContract } from '@/__tests__/uiconsole1.contract';
import { consolePages } from '@/__tests__/uiconsole1.pages';
import { actionBar, barActions, filterBars, hasAge, historyLabels, itemOf, norm, pickItem, shortcutOf } from '@/__tests__/uiconsole1.helpers';
import { refundStatus } from '../labels';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const push = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ perms: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/payments/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [], membershipId: ME } }),
  getRequestPathname: async () => '/payments/x',
}));

const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const A = U(11), ME = U(12), B = U(13);
const NOW = Date.parse('2026-11-16T06:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); cleanup(); push.mockReset(); session.perms = []; });

// ───────────────────────── payment review
const holdReasons = [
  { code: 'amount_mismatch', display: 'Amount does not match' }, { code: 'exceeds_due', display: 'Payment exceeds the amount due' }, { code: 'gateway_ambiguous', display: 'Provider answer unclear' },
];
const intent = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(100 + n), order_id: U(200 + n), centre_id: U(3), gateway: 'esewa', environment: 'production', status: 'held_for_review', amount: npr(12345600), hold_reason: 'amount_mismatch',
  created_at: ago(300), last_checked_at: ago(280), version: 2, ...o,
});
const h1 = intent(1);
const h2 = intent(2, { hold_reason: 'exceeds_due', created_at: ago(120), last_checked_at: undefined });
const p3 = intent(3, { gateway: 'khalti', status: 'pending', hold_reason: undefined, created_at: ago(60), last_checked_at: undefined });
const f4 = intent(4, { status: 'failed', hold_reason: undefined, failure_reason: 'gateway_cancelled', created_at: ago(900) });
const paid = intent(5, { status: 'settled', hold_reason: undefined, created_at: ago(40), last_checked_at: ago(20), settled_at: ago(10) });
const rqMount = async (rows: readonly unknown[]) => {
  const { ReviewQueue } = await import('../components/ReviewQueue');
  return render(<ToastProvider><ReviewQueue intents={rows as never} permissions={['payments.reconciliation.read']} centres={[]} holdReasons={holdReasons} /></ToastProvider>);
};

consoleContract({
  route: '/payments/review', menuKey: 'payments.nav.review', headers: ['Age', 'Created', 'Gateway', 'Amount', 'Status'], looseHeaders: true, tileLabels: ['Under review', 'Waiting for provider', 'Oldest age'],
  emptyText: 'No payments need review.', mount: rqMount, empty: [], one: [h1], oneId: U(101), many: [h1, h2, p3, f4], manyIds: [U(101), U(102), U(103), U(104)],
  tilesEmpty: { 'Under review': '0', 'Waiting for provider': '0', 'Oldest age': '—' }, tilesOne: { 'Under review': '1', 'Waiting for provider': '0', 'Oldest age': { ageMin: 300 } },
  // the failed intent is older (15 h) but not under review: the oldest age is the oldest UNDER REVIEW row
  tilesMany: { 'Under review': '2', 'Waiting for provider': '1', 'Oldest age': { ageMin: 300 } },
  marker: (id) => ({ [U(101)]: 'Amount does not match', [U(102)]: 'Payment exceeds the amount due', [U(103)]: 'Khalti', [U(104)]: 'Gateway cancelled' })[id]!,
});

describe('/payments/review detail, History, bar, filters and security', () => {
  it('the FilterBar keeps Status, Gateway, Hold reason and Created', async () => {
    const { container } = await rqMount([h1]);
    const text = norm(filterBars(container)[0]!.textContent);
    for (const s of ['Status', 'Gateway', 'Hold reason', 'Created']) expect(text, s).toContain(s);
  });

  it('choosing a Gateway in the FilterBar still pushes gateway= to the review route', async () => {
    const user = userEvent.setup();
    const { container } = await rqMount([h1]);
    await user.click(within(filterBars(container)[0]!).getByRole('button', { name: /gateway/i }));
    await user.click(await screen.findByRole('option', { name: 'Khalti' }));
    expect(String(push.mock.calls.at(-1)![0])).toMatch(/^\/payments\/review\?.*gateway=khalti/);
  });

  it('the Age cell is live-formatted hh:mm', async () => {
    const { container } = await rqMount([h1, h2]);
    const row = (id: string) => itemOf(container, id)!.closest('tr')!.textContent;
    expect(hasAge(row(U(101)), 300)).toBe(true);
    expect(hasAge(row(U(102)), 120)).toBe(true);
  });

  it('detail: gateway, amount, reason as text, links to the order and the payment; History = Created, Checked', async () => {
    const { container } = await rqMount([h1, h2, paid]);
    const d = pickItem(container, U(101));
    const text = norm(d.textContent);
    expect(text).toContain('eSewa');
    expect(text).toMatch(/1,23,456\.00/);
    expect(text).toContain('Amount does not match');
    expect(text).not.toContain('amount_mismatch');
    expect(d.querySelector(`a[href="/frontdesk/orders/${U(201)}"]`)).toBeTruthy();
    expect(d.querySelector(`a[href="/payments/intents/${U(101)}"]`)).toBeTruthy();
    expect(historyLabels(d)).toEqual(['Checked', 'Created']);
    expect(historyLabels(pickItem(container, U(102)))).toEqual(['Created']);
    expect(historyLabels(pickItem(container, U(105)))).toEqual(['Checked', 'Created', 'Paid']);
  });

  it('the sticky bar offers one link to the payment with a shortcut in its label and no button', async () => {
    const { container } = await rqMount([h1, h2]);
    pickItem(container, U(101));
    const first = barActions(container)[0]!;
    expect(first.getAttribute('href')).toBe(`/payments/intents/${U(101)}`);
    expect(shortcutOf(first), `"${first.textContent}" ends with (X)`).toBeTruthy();
    expect(actionBar(container)!.querySelectorAll('button')).toHaveLength(0);
  });

  it('XSS: a hold reason that is markup stays text', async () => {
    const { container } = await rqMount([intent(9, { hold_reason: '<img src=x onerror=alert(1)>' })]);
    pickItem(container, U(109));
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});

// ───────────────────────── gateway refunds
const codes = {
  refund_reject_reasons: [{ code: 'not_eligible', display: 'Not eligible', requires_text: false, is_active: true }],
  refund_fail_reasons: [{ code: 'gateway_confirmed_not_refunded', display: 'Provider confirmed no refund was made', requires_text: false, is_active: true }],
  refund_hold_reasons: [{ code: 'refund_not_visible', display: 'Refund not visible at the provider yet', requires_text: false, is_active: true }],
};
const READ = ['payments.reconciliation.read'];
const APPROVE = [...READ, 'payments.refund.approve'];
const ALL = [...APPROVE, 'payments.intent.resolve'];
const refund = (n: number, o: Record<string, unknown> = {}) => ({
  id: U(400 + n), intent_id: U(100 + n), order_id: U(200 + n), gateway: 'khalti', mode: 'manual', status: 'pending_approval', amount: npr(225000), reason_code: 'test_cancelled',
  requested_by: { membership_id: A, display_name: 'Synthetic Finance A' }, requested_at: ago(90), version: 1, ...o,
});
const approvedBy = { membership_id: B, display_name: 'Synthetic Finance B' };
const r1 = refund(1);
const r2 = refund(2, { requested_by: { membership_id: ME, display_name: 'Synthetic Finance Me' }, requested_at: ago(200) });
const r3 = refund(3, { status: 'requested', gateway: 'esewa', approved_by: approvedBy, approved_at: ago(60) });
const r4 = refund(4, { status: 'held_for_review', approved_by: approvedBy, approved_at: ago(60), held_reason: 'refund_not_visible', version: 3 });
const r5 = refund(5, { status: 'completed', approved_by: approvedBy, approved_at: ago(900), requested_at: ago(1000) });
const r6 = refund(6, { status: 'requested', mode: 'api', approved_by: approvedBy, approved_at: ago(30) });
const rfMount = async (rows: readonly unknown[], perms: readonly string[] = ALL, extra: { thresholdPaisa?: number } = {}) => {
  const { RefundsList } = await import('../components/RefundsList');
  return render(<ToastProvider><RefundsList refunds={rows as never} permissions={perms} currentMembershipId={ME} codes={codes} {...extra} /></ToastProvider>);
};
const button = (container: HTMLElement, name: RegExp) => within(actionBar(container)!).queryByRole('button', { name });
const enabled = (b: HTMLElement | null) => !!b && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true';

consoleContract({
  route: '/payments/refunds', menuKey: 'payments.nav.refunds', headers: ['Age', 'Requested', 'Gateway', 'Amount', 'Status'], looseHeaders: true, tileLabels: ['Pending approval', 'With provider', 'Oldest age'],
  emptyText: 'No refunds.', mount: (rows) => rfMount(rows), empty: [], one: [r1], oneId: U(401), many: [r1, r2, r3, r4, r5], manyIds: [U(401), U(402), U(403), U(404), U(405)],
  tilesEmpty: { 'Pending approval': '0', 'With provider': '0', 'Oldest age': '—' }, tilesOne: { 'Pending approval': '1', 'With provider': '0', 'Oldest age': { ageMin: 90 } },
  // the completed refund is older (16 h) but not pending approval: the oldest age is the oldest PENDING APPROVAL row (r2, 200 min)
  tilesMany: { 'Pending approval': '2', 'With provider': '2', 'Oldest age': { ageMin: 200 } },
  marker: (id) => ({ [U(401)]: 'Synthetic Finance A', [U(402)]: 'Synthetic Finance Me', [U(403)]: 'eSewa', [U(404)]: 'Refund not visible at the provider yet', [U(405)]: refundStatus('completed')[1] })[id]!,
});

describe('/payments/refunds detail, History, bar, gates and security', () => {
  it('the FilterBar keeps Status, Gateway and Created', async () => {
    const { container } = await rfMount([r1]);
    const text = norm(filterBars(container)[0]!.textContent);
    for (const s of ['Status', 'Gateway', 'Created']) expect(text, s).toContain(s);
  });

  it('detail: gateway, amount, status text, mode, requested by, approved by, hold reason as text; History = Requested, Approved', async () => {
    const { container } = await rfMount([r4]);
    const d = pickItem(container, U(404));
    const text = norm(d.textContent);
    for (const s of ['Khalti', 'Manual', 'Synthetic Finance A', 'Synthetic Finance B', 'Refund not visible at the provider yet', refundStatus('held_for_review')[1]]) expect(text, s).toContain(s);
    expect(text).toMatch(/2,250\.00/);
    expect(text).not.toContain('refund_not_visible');
    expect(d.querySelector(`a[href="/payments/intents/${U(104)}"]`)).toBeTruthy();
    expect(historyLabels(d)).toEqual(['Approved', 'Requested']);
    const { container: c2 } = await rfMount([r1]);
    expect(historyLabels(pickItem(c2, U(401)))).toEqual(['Requested']);
  });

  it('pending approval, another person asked: the bar offers Approve first (shortcut in its label) and Reject, nothing else', async () => {
    const { container } = await rfMount([r1]);
    pickItem(container, U(401));
    const first = barActions(container)[0]!;
    expect(first.textContent).toMatch(/^approve/i);
    expect(shortcutOf(first), `"${first.textContent}" ends with (X)`).toBeTruthy();
    expect(enabled(button(container, /^approve/i))).toBe(true);
    expect(button(container, /^reject/i)).toBeTruthy();
    expect(button(container, /re-check|confirm refund done|mark refund failed/i)).toBeNull();
  });

  it('your own request above the threshold: Approve is disabled (the server decides again); below the threshold it is enabled', async () => {
    const { container } = await rfMount([r2]);
    pickItem(container, U(402));
    expect(enabled(button(container, /^approve/i))).toBe(false);
    expect(button(container, /^reject/i)).toBeTruthy();
    cleanup();
    const { container: c2 } = await rfMount([r2], ALL, { thresholdPaisa: 300000 });
    pickItem(c2, U(402));
    expect(enabled(button(c2, /^approve/i))).toBe(true);
  });

  it('an open manual refund: Confirm refund done, Re-check and Mark refund failed (gated by permission); no Approve', async () => {
    const { container } = await rfMount([r3]);
    pickItem(container, U(403));
    expect(shortcutOf(barActions(container)[0])).toBeTruthy();
    for (const n of [/confirm refund done/i, /re-check/i, /mark refund failed/i]) expect(button(container, n), String(n)).toBeTruthy();
    expect(button(container, /^approve|^reject/i)).toBeNull();
    cleanup();
    const { container: c2 } = await rfMount([r3], [...READ, 'payments.intent.resolve']);
    pickItem(c2, U(403));
    expect(button(c2, /re-check/i)).toBeTruthy();
    expect(button(c2, /confirm refund done|mark refund failed/i)).toBeNull();
  });

  it('a provider API refund has no Confirm refund done; a completed refund has no action; a read-only user has no action button', async () => {
    const { container } = await rfMount([r6, r5]);
    pickItem(container, U(406));
    expect(button(container, /confirm refund done/i)).toBeNull();
    expect(button(container, /re-check/i)).toBeTruthy();
    pickItem(container, U(405));
    expect(actionBar(container)!.querySelectorAll('button')).toHaveLength(0);
    cleanup();
    const { container: c2 } = await rfMount([r1, r3], READ);
    for (const id of [U(401), U(403)]) { pickItem(c2, id); expect(actionBar(c2)?.querySelectorAll('button').length ?? 0).toBe(0); }
  });

  it('the Approve of the bar opens the same dialog as before', async () => {
    const user = userEvent.setup();
    const { container } = await rfMount([r1]);
    pickItem(container, U(401));
    await user.click(button(container, /^approve/i)!);
    expect(await screen.findByRole('dialog', { name: /approve refund of/i })).toBeTruthy();
  });

  it('XSS: a requester name that is markup stays text', async () => {
    const { container } = await rfMount([refund(9, { requested_by: { membership_id: A, display_name: '<img src=x onerror=alert(1)>' } })]);
    pickItem(container, U(409));
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getAllByText('<img src=x onerror=alert(1)>').length).toBeGreaterThan(0);
  });
});

// ───────────────────────── pages: NotAvailable, errors
consolePages(
  ORIGIN, (p) => { session.perms = p; },
  [
    { name: 'payment review', load: () => import('@/app/(staff)/payments/review/page'), menuKey: 'payments.nav.review', perms: READ, on500: 'throws' },
    { name: 'gateway refunds', load: () => import('@/app/(staff)/payments/refunds/page'), menuKey: 'payments.nav.refunds', perms: READ, on500: 'throws' },
  ],
  [
    { name: 'payment review', load: () => import('@/app/(staff)/payments/review/error'), menuKey: 'payments.nav.review' },
    { name: 'gateway refunds', load: () => import('@/app/(staff)/payments/refunds/error'), menuKey: 'payments.nav.refunds' },
  ],
);
