// BL-T11 two-person manual refunds: B10 requestRefund, B10a approveRefund, B10b rejectRefund, B10c listRefundRequests.
// Spec: 02-TRD §5 B10/B10a/B10b/B10c, §6.5 "Manual refund"; PRD US-BL-06.2/.3; 07-SECURITY REQ-SEC-055/056/057, abuse case A7/A8; 05-SCHEMA billing.refund_requests (+ two_person CHECK, guard);
//       08 A13 D-24. done_when: "refundable cap at request and approval; approver != requester; refund ledger row only on approval".
// Fails now: ../refund.service.js does not exist.
// ASSUMED API (writer: object via a dispute if wrong):
//   refund.service.ts : createRefundService({ repo, events: createBillingEvents(...) }) -> {
//     requestRefund(ctx,{ orderId, methodCode, refundAmountPaisa, reasonCode, reasonText?, reference? })      -> RefundRequestDto (snake_case, openapi; status 'pending')
//     approveRefund(ctx,{ refundRequestId, expectedVersion, note? })                                             -> RefundRequestDto (status 'approved', ledger_entry = LedgerEntryDto)
//     rejectRefund(ctx,{ refundRequestId, expectedVersion, note })                                               -> RefundRequestDto (status 'rejected')
//     listRefundRequests(ctx, query{ status?, order_id?, cursor?, limit? } (snake_case, as the handler gets it)  -> { data: RefundRequestDto[], page: { limit, next_cursor? } } }
//   Tenant, requester/approver come from ctx only (ctx.actor.membershipId). refundable = paid - (invoiced - credited) from repo.readOrderTotals (paid = signed ledger sum, refunds included).
//   Errors: > refundable -> billing.ledger_reversal_invalid; approver = requester -> billing.refund_self_approval_forbidden; not pending -> common.immutable_record; stale -> common.version_conflict.
//   Approve order: load request -> self check -> lock order_balances -> re-read totals (cap) -> approver's cash session (find or create) -> insert refund row -> balance recompute -> decide -> activity.
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createRefundService } from '../refund.service.js';
import { CASHIER, errCode, F1, F2, IDS, INVOICE, makeRefundWorld, money, OTHER_TENANT, REQ, SESSION, TENANT_A, V7, type RefundWorld } from './t11.helpers.js';
import type { LedgerOpts } from './t08.helpers.js';

const svcOf = (w: RefundWorld) => createRefundService({ repo: w.repo as never, events: createBillingEvents(w.events) as never });
const reqIn = (over: Record<string, unknown> = {}) => ({ orderId: IDS.order, methodCode: 'cash', refundAmountPaisa: 225000, reasonCode: 'SYN_REASON', reasonText: 'Synthetic cancelled visit', ...over });
/** Cancelled invoice (credited in full) that was paid 2,250.00 in cash by CASHIER: refundable 2,250.00. Balance row at v1. */
async function setup(opts: LedgerOpts & { credited?: number; paid?: number } = {}) {
  const w = makeRefundWorld(opts);
  w.setCredited(opts.credited ?? 225000);
  w.addSession({ id: SESSION(1), membership_id: CASHIER, status: 'closed' });
  const pay = w.seedPayment(1, { collected_by_membership_id: CASHIER, cash_session_id: SESSION(1), amount_paisa: opts.paid ?? 225000 });
  await w.seedBalance();
  return { w, svc: svcOf(w), f1: w.ctx(), f2: w.ctxF2(), pay };
}
const run = (w: RefundWorld, fn: () => Promise<any>) => w.tx(fn);
const request = (w: RefundWorld, svc: ReturnType<typeof svcOf>, ctx: never, over: Record<string, unknown> = {}) => run(w, () => svc.requestRefund(ctx, reqIn(over) as never));
const approve = (w: RefundWorld, svc: ReturnType<typeof svcOf>, ctx: never, id: string, over: Record<string, unknown> = {}) => run(w, () => svc.approveRefund(ctx, { refundRequestId: id, expectedVersion: 1, ...over } as never));
const reject = (w: RefundWorld, svc: ReturnType<typeof svcOf>, ctx: never, id: string, over: Record<string, unknown> = {}) => run(w, () => svc.rejectRefund(ctx, { refundRequestId: id, expectedVersion: 1, note: 'Synthetic: not needed', ...over } as never));

describe('US-BL-06.2 B10 requestRefund: pending request, no money moves', () => {
  it('1: F1 requests 2,250.00 cash -> RefundRequestDto pending v1 requested by F1; the request row carries the order\'s branch/centre', async () => {
    const { w, svc, f1 } = await setup();
    const dto = await request(w, svc, f1);
    expect(dto).toMatchObject({ order_id: IDS.order, method_code: 'cash', refund_amount: money(225000), reason_code: 'SYN_REASON', reason_text: 'Synthetic cancelled visit', status: 'pending', version: 1 });
    expect(dto.requested_by.membership_id).toBe(F1);
    expect(typeof dto.requested_at).toBe('string');
    expect(dto).not.toHaveProperty('ledger_entry');
    expect(dto).not.toHaveProperty('decided_by');
    expect(w.requests()).toHaveLength(1);
    expect(w.requests()[0]).toMatchObject({ id: dto.id, tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, order_id: IDS.order, refund_amount_paisa: 225000, status: 'pending', requested_by_membership_id: F1, ledger_entry_id: null });
  });

  it('2: nothing else happens: no ledger row, no balance write or event, no cash session, no RC number; one activity refund_requested', async () => {
    const { w, svc, f1 } = await setup();
    const mark = w.repoCalls.length, ev = w.balanceEvents().length, sessions = w.sessions().length;
    const dto = await request(w, svc, f1);
    expect(w.ledgerOf('refund')).toHaveLength(0);
    expect(w.ledger()).toHaveLength(1);
    expect(w.names().slice(mark)).not.toContain('insertLedgerEntry');
    expect(w.names().slice(mark)).not.toContain('upsertOrderBalance');
    expect(w.balanceEvents()).toHaveLength(ev);
    expect(w.sessions()).toHaveLength(sessions);
    expect(w.counterCalls).toHaveLength(0);
    const acts = w.activityOf('refund_requested');
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ document_id: dto.id, actor_membership_id: F1, tenant_id: TENANT_A });
  });

  it('3: the requester is the caller; a requestedByMembershipId / tenantId / status in the input is ignored', async () => {
    const { w, svc, f1 } = await setup();
    const dto = await request(w, svc, f1, { requestedByMembershipId: F2, tenantId: OTHER_TENANT, status: 'approved', decidedByMembershipId: F2 });
    expect(w.requests()[0]).toMatchObject({ tenant_id: TENANT_A, requested_by_membership_id: F1, status: 'pending', decided_by_membership_id: null });
    expect(dto.status).toBe('pending');
  });

  it('4: reference is trimmed into reference_text (DTO reference_masked) and is never copied into the activity details', async () => {
    const { w, svc, f1 } = await setup();
    const dto = await request(w, svc, f1, { reference: '  PAYOUT-AB12  ' });
    expect(dto.reference_masked).toBe('PAYOUT-AB12');
    expect(w.requests()[0].reference_text).toBe('PAYOUT-AB12');
    expect(JSON.stringify(w.activityOf('refund_requested'))).not.toContain('PAYOUT-AB12');
  });
});

describe('refundable cap at request: refundable = paid - (invoiced - credited) (TRD §6.5, REQ-SEC-055, abuse A8)', () => {
  it('5: cancelled invoice paid in full: exactly 2,250.00 passes, 2,250.01 -> 409 billing.ledger_reversal_invalid, nothing stored', async () => {
    const { w, svc, f1 } = await setup();
    const mark = w.repoCalls.length;
    const e = await errCode(request(w, svc, f1, { refundAmountPaisa: 225001 }));
    expect(e.code).toBe('billing.ledger_reversal_invalid');
    expect(w.requests()).toHaveLength(0);
    expect(w.writes(mark)).toEqual([]);
    expect((await request(w, svc, f1, { refundAmountPaisa: 225000 })).status).toBe('pending');
  });
  it('6: invoice still fully due (credited 0): refundable is 0, any request -> 409; nothing stored', async () => {
    const { w, svc, f1 } = await setup({ credited: 0 });
    expect((await errCode(request(w, svc, f1, { refundAmountPaisa: 1 }))).code).toBe('billing.ledger_reversal_invalid');
    expect(w.requests()).toHaveLength(0);
  });
  it('7: overpayment is refundable only above the due: paid 3,000.00, invoiced 2,250.00, credited 0 -> 750.00 ok, 750.01 -> 409', async () => {
    const { w, svc, f1 } = await setup({ credited: 0, paid: 300000 });
    expect((await errCode(request(w, svc, f1, { refundAmountPaisa: 75001 }))).code).toBe('billing.ledger_reversal_invalid');
    expect((await request(w, svc, f1, { refundAmountPaisa: 75000 })).refund_amount).toEqual(money(75000));
  });
  it('8: an earlier approved refund reduces what is refundable (signed ledger sum)', async () => {
    const { w, svc, f1, f2 } = await setup();
    const first = await request(w, svc, f1, { refundAmountPaisa: 150000 });
    await approve(w, svc, f2, first.id);
    expect((await errCode(request(w, svc, f1, { refundAmountPaisa: 75001 }))).code).toBe('billing.ledger_reversal_invalid');
    expect((await request(w, svc, f1, { refundAmountPaisa: 75000 })).status).toBe('pending');
  });
  // Review item 1: TRD §5 B10 / §6.5 define no credit-order refusal; only the refundable cap applies.
  it('8b: credit-mode order with refundable > 0 (paid 3,000.00, invoiced 2,250.00, credited 0) can be requested: 750.00 -> pending, 750.01 -> 409', async () => {
    const { w, svc, f1 } = await setup({ billingMode: 'credit', credited: 0, paid: 300000 });
    expect((await errCode(request(w, svc, f1, { refundAmountPaisa: 75001 }))).code).toBe('billing.ledger_reversal_invalid');
    expect((await request(w, svc, f1, { refundAmountPaisa: 75000 })).status).toBe('pending');
  });
  it('8c: credit-mode order with refundable <= 0 -> 409 billing.ledger_reversal_invalid (not common.validation_failed); nothing stored', async () => {
    const { w, svc, f1 } = await setup({ billingMode: 'credit', credited: 0 });
    const e = await errCode(request(w, svc, f1, { refundAmountPaisa: 1 }));
    expect(e.code).toBe('billing.ledger_reversal_invalid');
    expect(w.requests()).toHaveLength(0);
  });
});

describe('request validation and scoping', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['amount 0', { refundAmountPaisa: 0 }], ['amount negative', { refundAmountPaisa: -1 }], ['amount fractional', { refundAmountPaisa: 10.5 }], ['amount a string', { refundAmountPaisa: '100' }],
    ['amount above 2^53-1', { refundAmountPaisa: 9007199254740992 }], ['amount NaN', { refundAmountPaisa: Number.NaN }],
    ['reasonCode empty', { reasonCode: '' }], ['reasonCode missing', { reasonCode: undefined }], ['reasonText 501 chars', { reasonText: 'x'.repeat(501) }],
    ['reference 101 chars', { reference: 'x'.repeat(101) }], ['reference holds a 16-digit card number', { reference: 'card 4111111111111111' }],
    ['methodCode empty', { methodCode: '' }], ['methodCode unknown for the tenant', { methodCode: 'no_such_method' }], ['orderId not a uuid', { orderId: 'nope' }],
  ];
  for (const [name, over] of bad) {
    it(`9: ${name} -> common.validation_failed, nothing stored`, async () => {
      const { w, svc, f1 } = await setup();
      const mark = w.repoCalls.length;
      const e = await errCode(request(w, svc, f1, over));
      expect(e.code).toBe('common.validation_failed');
      expect(JSON.stringify(e.errors ?? [])).not.toContain('4111111111111111'); // never echo the value
      expect(w.requests()).toHaveLength(0);
      expect(w.writes(mark)).toEqual([]);
    });
  }
  it('10: unknown order and another tenant\'s order -> 404 common.not_found, nothing stored', async () => {
    const { w, svc } = await setup();
    const other = w.ctx({ tenantId: OTHER_TENANT });
    expect((await errCode(request(w, svc, other))).code).toBe('common.not_found');
    expect((await errCode(request(w, svc, w.ctx(), { orderId: IDS.order2 }))).code).toBe('common.not_found');
    expect(w.requests()).toHaveLength(0);
  });
  it('11: an actor without a membership cannot request -> rejected, nothing stored', async () => {
    const { w, svc } = await setup();
    const ctx = w.ctx({ actor: { type: 'user', id: V7('000000030009') } });
    await expect(request(w, svc, ctx)).rejects.toMatchObject({ code: expect.stringMatching(/^(auth\.|common\.validation_failed)/) });
    expect(w.requests()).toHaveLength(0);
  });
  it('12: every repo call carries the ctx tenant', async () => {
    const { w, svc, f1, f2 } = await setup();
    const mark = w.repoCalls.length;
    const dto = await request(w, svc, f1);
    await approve(w, svc, f2, dto.id);
    for (const c of w.repoCalls.slice(mark)) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(TENANT_A);
  });
});

describe('US-BL-06.2 B10a approveRefund by a second person: the refund ledger row exists only now', () => {
  it('13: F2 approves -> one refund row (negative, manual, approver = collector = F2, refund_request_id, request reason/method/reference), request approved with ledger_entry', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1, { reference: 'PAYOUT-AB12' });
    expect(w.ledgerOf('refund')).toHaveLength(0);
    const dto = await approve(w, svc, f2, q.id, { note: 'Synthetic ok' });
    expect(w.ledgerOf('refund')).toHaveLength(1);
    expect(w.ledger()).toHaveLength(2);
    const row = w.ledgerOf('refund')[0];
    expect(row).toMatchObject({
      entry_kind: 'refund', capture_kind: 'manual', method_code: 'cash', amount_paisa: -225000, order_id: IDS.order, branch_id: IDS.branch, centre_id: IDS.centre,
      refund_request_id: q.id, collected_by_membership_id: F2, approved_by_membership_id: F2, reason_code: 'SYN_REASON', reference_text: 'PAYOUT-AB12', receipt_no: null, receipt_seq: null,
    });
    expect(dto).toMatchObject({ id: q.id, status: 'approved', version: 2, refund_amount: money(225000) });
    expect(dto.decided_by.membership_id).toBe(F2);
    expect(typeof dto.decided_at).toBe('string');
    expect(dto.requested_by.membership_id).toBe(F1);
    expect(dto.ledger_entry).toMatchObject({ id: row.id, entry_kind: 'refund', capture_kind: 'manual', amount: money(-225000), method_code: 'cash', order_id: IDS.order });
    expect(dto.ledger_entry.collected_by.membership_id).toBe(F2);
    expect(w.requests()[0]).toMatchObject({ status: 'approved', decided_by_membership_id: F2, ledger_entry_id: row.id, decision_note: 'Synthetic ok', requested_by_membership_id: F1, version: 2 });
    expect(w.counterCalls, 'a refund pay-out has no RC number').toHaveLength(0);
  });

  it('14: balance recomputed in the same transaction: paid 0, one billing.balance.changed.v1 (v2, cause payment_reversed); activity refund_recorded by F2', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    const ev = w.balanceEvents().length;
    const dto = await approve(w, svc, f2, q.id);
    const events = w.balanceEvents();
    expect(events).toHaveLength(ev + 1);
    expect(events[ev].payload).toMatchObject({ order_id: IDS.order, balance_version: 2, invoiced: money(225000), paid: money(0), credited: money(225000), balance_due: money(0), cause: 'payment_reversed' });
    const acts = w.activityOf('refund_recorded');
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ document_kind: 'ledger_entry', document_id: dto.ledger_entry.id, actor_membership_id: F2, tenant_id: TENANT_A });
  });

  it('15: cash session = the approver\'s open session at the order\'s centre; none open -> one is created for the approver', async () => {
    const a = await setup();
    a.w.addSession({ id: SESSION(2), membership_id: F2 });
    const qa = await request(a.w, a.svc, a.f1);
    await approve(a.w, a.svc, a.f2, qa.id);
    expect(a.w.ledgerOf('refund')[0].cash_session_id).toBe(SESSION(2));
    expect(a.w.names()).not.toContain('insertCashSession');

    const b = await setup();
    const qb = await request(b.w, b.svc, b.f1);
    await approve(b.w, b.svc, b.f2, qb.id);
    const created = b.w.sessions().filter((s: any) => s.membership_id === F2);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'open', centre_id: IDS.centre, tenant_id: TENANT_A });
    expect(b.w.ledgerOf('refund')[0].cash_session_id).toBe(created[0].id);
  });

  it('16: the amount and method are the request\'s: an amount/method/order in the approve input is ignored', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    await approve(w, svc, f2, q.id, { refundAmountPaisa: 1, amountPaisa: 1, methodCode: 'card', orderId: IDS.order2 });
    expect(w.ledgerOf('refund')[0]).toMatchObject({ amount_paisa: -225000, method_code: 'cash', order_id: IDS.order });
  });
});

describe('US-BL-06.3 two-person rule: approver != requester (REQ-SEC-055)', () => {
  it('17: F1 approves F1\'s own request -> 403 billing.refund_self_approval_forbidden and NOTHING changes', async () => {
    const { w, svc, f1 } = await setup();
    const q = await request(w, svc, f1);
    const mark = w.repoCalls.length, ev = w.balanceEvents().length, sessions = w.sessions().length, acts = (w.s as any).activity.length;
    const e = await errCode(approve(w, svc, f1, q.id));
    expect(e.code).toBe('billing.refund_self_approval_forbidden');
    expect(w.writes(mark)).toEqual([]);
    expect(w.ledgerOf('refund')).toHaveLength(0);
    expect(w.requests()[0]).toMatchObject({ status: 'pending', decided_by_membership_id: null, ledger_entry_id: null, version: 1 });
    expect(w.sessions()).toHaveLength(sessions);
    expect(w.balanceEvents()).toHaveLength(ev);
    expect((w.s as any).activity).toHaveLength(acts);
  });
  it('18: the same person under another user id but the same membership is still the requester', async () => {
    const { w, svc, f1 } = await setup();
    const q = await request(w, svc, f1);
    const again = w.ctx({ actor: { type: 'user', id: V7('0000000300aa'), membershipId: F1 } });
    expect((await errCode(approve(w, svc, again, q.id))).code).toBe('billing.refund_self_approval_forbidden');
    expect(w.ledgerOf('refund')).toHaveLength(0);
  });
  it('19: a request approved elsewhere cannot be approved twice: second approval -> 409 common.immutable_record, still one refund row', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    await approve(w, svc, f2, q.id);
    const mark = w.repoCalls.length;
    expect((await errCode(approve(w, svc, f2, q.id, { expectedVersion: 2 }))).code).toBe('common.immutable_record');
    expect(w.ledgerOf('refund')).toHaveLength(1);
    expect(w.writes(mark)).toEqual([]);
  });
  it('20: a rejected request cannot be approved -> common.immutable_record, no ledger row', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    await reject(w, svc, f2, q.id);
    expect((await errCode(approve(w, svc, f2, q.id, { expectedVersion: 2 }))).code).toBe('common.immutable_record');
    expect(w.ledgerOf('refund')).toHaveLength(0);
  });
  it('21: stale If-Match version -> 409 common.version_conflict, nothing written', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    const mark = w.repoCalls.length;
    expect((await errCode(approve(w, svc, f2, q.id, { expectedVersion: 7 }))).code).toBe('common.version_conflict');
    expect(w.writes(mark)).toEqual([]);
    expect(w.requests()[0].status).toBe('pending');
  });
  it('22: unknown request and another tenant\'s request -> 404 common.not_found, nothing written', async () => {
    const { w, svc, f1 } = await setup();
    const q = await request(w, svc, f1);
    const mark = w.repoCalls.length;
    expect((await errCode(approve(w, svc, w.ctxF2({ tenantId: OTHER_TENANT }), q.id))).code).toBe('common.not_found');
    expect((await errCode(approve(w, svc, w.ctxF2(), REQ(404)))).code).toBe('common.not_found');
    expect(w.writes(mark)).toEqual([]);
  });
  it('23: an actor without a membership cannot approve -> rejected, nothing written', async () => {
    const { w, svc, f1 } = await setup();
    const q = await request(w, svc, f1);
    const mark = w.repoCalls.length;
    await expect(approve(w, svc, w.ctx({ actor: { type: 'user', id: V7('000000030009') } }), q.id)).rejects.toMatchObject({ code: expect.stringMatching(/^(auth\.|common\.validation_failed)/) });
    expect(w.writes(mark)).toEqual([]);
  });
});

describe('refundable cap re-checked at approval (TRD §6.5; US-BL-06.2 "a request or approval above the refundable amount")', () => {
  it('24: two pending requests of 2,250.00 against 2,250.00 refundable: the first approval wins, the second -> 409 billing.ledger_reversal_invalid and stays pending', async () => {
    const { w, svc, f1, f2 } = await setup();
    const a = await request(w, svc, f1);
    const b = await request(w, svc, f1);
    await approve(w, svc, f2, a.id);
    const mark = w.repoCalls.length;
    expect((await errCode(approve(w, svc, f2, b.id))).code).toBe('billing.ledger_reversal_invalid');
    expect(w.ledgerOf('refund')).toHaveLength(1);
    expect(w.requests().find((r: any) => r.id === b.id)).toMatchObject({ status: 'pending', ledger_entry_id: null, version: 1 });
    expect(w.writes(mark)).toEqual([]);
  });
  it('25: a payment reversal between request and approval shrinks refundable: approval -> 409, request still pending, no ledger row', async () => {
    const { w, svc, f1, f2, pay } = await setup();
    const q = await request(w, svc, f1);
    w.addLedger({ id: V7('0000000c0777'), entry_kind: 'reversal', amount_paisa: -225000, reverses_entry_id: pay, reason_code: 'SYN_REVERSAL', cash_session_id: null, collected_by_membership_id: CASHIER, invoice_id: INVOICE });
    expect((await errCode(approve(w, svc, f2, q.id))).code).toBe('billing.ledger_reversal_invalid');
    expect(w.ledgerOf('refund')).toHaveLength(0);
    expect(w.requests()[0]).toMatchObject({ status: 'pending', version: 1 });
  });
  it('26: order_balances is locked before the cap is re-read and before the refund row is inserted (TRD §12)', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    const mark = w.repoCalls.length;
    await approve(w, svc, f2, q.id);
    const names = w.names().slice(mark);
    const lock = names.indexOf('lockOrderBalance'), ins = names.indexOf('insertLedgerEntry');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(ins);
    expect(names.lastIndexOf('readOrderTotals', ins)).toBeGreaterThan(lock);
    expect(w.repoCalls.slice(mark)[lock]!.args).toMatchObject({ tenantId: TENANT_A, orderId: IDS.order });
  });
  it('27: the balance write fails -> the whole approval rolls back (no refund row, request still pending v1, no new session, no event)', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    const ev = w.balanceEvents().length, sessions = w.sessions().length;
    (w.repo as any).upsertOrderBalance = async () => { throw new Error('boom'); };
    await expect(approve(w, svc, f2, q.id)).rejects.toThrow('boom');
    expect(w.ledgerOf('refund')).toHaveLength(0);
    expect(w.requests()[0]).toMatchObject({ status: 'pending', ledger_entry_id: null, version: 1 });
    expect(w.sessions()).toHaveLength(sessions);
    expect(w.balanceEvents()).toHaveLength(ev);
    expect(w.activityOf('refund_recorded')).toHaveLength(0);
  });
  it('28: approval note > 500 chars -> common.validation_failed, nothing written', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    const mark = w.repoCalls.length;
    expect((await errCode(approve(w, svc, f2, q.id, { note: 'x'.repeat(501) }))).code).toBe('common.validation_failed');
    expect(w.writes(mark)).toEqual([]);
  });
});

describe('B10b rejectRefund (the requester may withdraw; no money moves)', () => {
  it('29: F2 rejects with a note -> rejected v2, decided_by F2, no ledger row, no balance event, no session, activity refund_rejected', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    const ev = w.balanceEvents().length, sessions = w.sessions().length;
    const dto = await reject(w, svc, f2, q.id, { note: 'Synthetic: wrong amount' });
    expect(dto).toMatchObject({ id: q.id, status: 'rejected', version: 2, note: 'Synthetic: wrong amount' });
    expect(dto.decided_by.membership_id).toBe(F2);
    expect(dto).not.toHaveProperty('ledger_entry');
    expect(w.requests()[0]).toMatchObject({ status: 'rejected', decided_by_membership_id: F2, decision_note: 'Synthetic: wrong amount', ledger_entry_id: null });
    expect(w.ledgerOf('refund')).toHaveLength(0);
    expect(w.balanceEvents()).toHaveLength(ev);
    expect(w.sessions()).toHaveLength(sessions);
    expect(w.activityOf('refund_rejected')).toHaveLength(1);
    expect(w.activityOf('refund_rejected')[0]).toMatchObject({ document_id: q.id, actor_membership_id: F2 });
  });
  it('30: the requester withdraws their own request this way (F1 rejects F1\'s request) -> rejected', async () => {
    const { w, svc, f1 } = await setup();
    const q = await request(w, svc, f1);
    const dto = await reject(w, svc, f1, q.id, { note: 'Synthetic: withdrawn' });
    expect(dto.status).toBe('rejected');
    expect(dto.decided_by.membership_id).toBe(F1);
    expect(w.ledgerOf('refund')).toHaveLength(0);
  });
  for (const [name, note] of [['empty', ''], ['missing', undefined], ['501 chars', 'x'.repeat(501)], ['not a string', 5]] as Array<[string, unknown]>) {
    it(`31: note ${name} -> common.validation_failed, request stays pending`, async () => {
      const { w, svc, f1, f2 } = await setup();
      const q = await request(w, svc, f1);
      const mark = w.repoCalls.length;
      expect((await errCode(reject(w, svc, f2, q.id, { note }))).code).toBe('common.validation_failed');
      expect(w.writes(mark)).toEqual([]);
      expect(w.requests()[0].status).toBe('pending');
    });
  }
  it('32: already decided -> common.immutable_record; stale version -> common.version_conflict; unknown / other tenant -> common.not_found', async () => {
    const { w, svc, f1, f2 } = await setup();
    const q = await request(w, svc, f1);
    expect((await errCode(reject(w, svc, f2, q.id, { expectedVersion: 9 }))).code).toBe('common.version_conflict');
    await reject(w, svc, f2, q.id);
    expect((await errCode(reject(w, svc, f2, q.id, { expectedVersion: 2 }))).code).toBe('common.immutable_record');
    expect((await errCode(reject(w, svc, f2, REQ(404)))).code).toBe('common.not_found');
    expect((await errCode(reject(w, svc, w.ctxF2({ tenantId: OTHER_TENANT }), q.id))).code).toBe('common.not_found');
  });
});

describe('B10c listRefundRequests (approver inbox)', () => {
  const list = (w: RefundWorld, svc: ReturnType<typeof svcOf>, ctx: never, query: Record<string, unknown> = {}) => w.tx(() => svc.listRefundRequests(ctx, query as never) as Promise<any>);
  it('33: status and order filters; newest first; page shape {data, page:{limit}}; tenant isolation', async () => {
    const { w, svc, f2 } = await setup();
    w.seedRequest(1); w.seedRequest(2, { status: 'rejected', decided_by_membership_id: F2, decided_at: '2026-11-08T06:30:00.000Z', decision_note: 'n' });
    w.seedRequest(3, { order_id: IDS.order2 }); w.seedRequest(4, { tenant_id: OTHER_TENANT });
    const all = await list(w, svc, f2, { limit: 50 });
    expect(all.data.map((r: any) => r.id)).toEqual([REQ(3), REQ(2), REQ(1)]);
    expect(all.page).toEqual({ limit: 50 });
    expect(all.data[0]).toMatchObject({ order_id: IDS.order2, method_code: 'cash', refund_amount: money(225000), status: 'pending', version: 1 });
    expect((await list(w, svc, f2, { status: 'pending' })).data.map((r: any) => r.id)).toEqual([REQ(3), REQ(1)]);
    expect((await list(w, svc, f2, { order_id: IDS.order })).data.map((r: any) => r.id)).toEqual([REQ(2), REQ(1)]);
    for (const c of w.repoCalls.filter((x) => x.name === 'pageRefundRequests')) expect(c.args.tenantId).toBe(TENANT_A);
  });
  it('34: keyset pagination: limit 2 over 5 requests -> three pages, no overlap, no gap, newest first; the last page has no next_cursor', async () => {
    const { w, svc, f2 } = await setup();
    for (let i = 1; i <= 5; i += 1) w.seedRequest(i);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const out = await list(w, svc, f2, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...out.data.map((r: any) => r.id));
      expect(out.page.limit).toBe(2);
      cursor = out.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([REQ(5), REQ(4), REQ(3), REQ(2), REQ(1)]);
    expect(cursor).toBeUndefined();
  });
  it('35: malformed / foreign cursor -> 400 common.invalid_cursor; bad limit or status -> common.validation_failed', async () => {
    const { w, svc, f2 } = await setup();
    for (const cursor of ['garbage', '!!!', Buffer.from(JSON.stringify(['-other', 'x', 'y'])).toString('base64url')]) {
      expect((await errCode(list(w, svc, f2, { cursor }))).code, cursor).toBe('common.invalid_cursor');
    }
    for (const q of [{ limit: 0 }, { limit: 201 }, { limit: 'x' }, { status: 'bogus' }, { order_id: 'nope' }]) {
      expect((await errCode(list(w, svc, f2, q))).code, JSON.stringify(q)).toBe('common.validation_failed');
    }
  });
  it('36: the list is read-only: no write, no event', async () => {
    const { w, svc, f2 } = await setup();
    w.seedRequest(1);
    const mark = w.repoCalls.length, ev = w.balanceEvents().length;
    await list(w, svc, f2, {});
    expect(w.writes(mark)).toEqual([]);
    expect(w.balanceEvents()).toHaveLength(ev);
  });
});
