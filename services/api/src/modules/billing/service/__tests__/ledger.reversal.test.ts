// BL-T11 B9 reverseLedgerEntry (US-BL-06.1, 02-TRD §5 B9, §6.5 "Reversal", 05-SCHEMA billing.ledger_reversal_guard, REQ-SEC-057).
// done_when: "Single reversal copying original capture fields ... privileged/aal2" (privilege/aal2 is the core pipeline's job: see ../../__tests__/contract/refund.permissions.static.test.ts).
// Fails now: ledger.service.ts has no reverseEntry.
// ASSUMED API (writer: object via a dispute if wrong):
//   createLedgerService({repo,counter,events}).reverseEntry(ctx, { ledgerEntryId, reasonCode, reasonText?, idempotencyKey }) -> { entry: LedgerEntryDto, balance, duplicate }
//   ctx.actor.membershipId = the reverser (approved_by_membership_id). Tenant and actor from ctx only. Replay = same idempotencyKey (ledger_entries.idempotency_key) on the same target.
//   Repo seams: see t11.helpers.ts header. The fake models ledger_reversal_guard, so a reversal that does not copy the original (or picks the wrong cash session) fails with reversal_mismatch.
//   Order: validate -> lock order_balances -> replay lookup -> load original -> already reversed? -> insert -> balance recompute (cause payment_reversed) -> activity.
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createLedgerService } from '../ledger.service.js';
import { CASHIER, errCode, F1, IDS, INVOICE, makeRefundWorld, money, npr, OTHER_TENANT, SESSION, TENANT_A, V7, type RefundWorld } from './t11.helpers.js';
import type { LedgerOpts } from './t08.helpers.js';

let n = 0;
const svcOf = (w: RefundWorld) => createLedgerService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never });
const input = (id: string, over: Record<string, unknown> = {}) => ({ ledgerEntryId: id, reasonCode: 'SYN_REVERSAL', reasonText: 'Synthetic mis-keyed cash', idempotencyKey: `t11-rev-${++n}`, ...over });
/** Order paid 2,250.00 in cash by CASHIER in an open session; balance row at v1 (paid in full). */
async function setup(opts: LedgerOpts = {}, seed?: (w: RefundWorld) => string) {
  const w = makeRefundWorld(opts);
  w.addSession({ id: SESSION(1), membership_id: CASHIER });
  const orig = seed ? seed(w) : w.seedPayment(1, { collected_by_membership_id: CASHIER, cash_session_id: SESSION(1), receipt_no: 'RC-083/84-000001', receipt_seq: 1, reference_text: null });
  await w.seedBalance();
  return { w, svc: svcOf(w), ctx: w.ctx(), orig };
}
const rev = (w: RefundWorld, svc: ReturnType<typeof svcOf>, ctx: never, id: string, over: Record<string, unknown> = {}) => w.tx(() => svc.reverseEntry(ctx, input(id, over) as never) as Promise<any>);

describe('US-BL-06.1 reverse a mis-recorded cash entry', () => {
  it('1: new reversal row: negative amount, reverses_entry_id, original collector/method/order/invoice/branch/centre/session copied, approver = reverser, no receipt number', async () => {
    const { w, svc, ctx, orig } = await setup();
    const r = await rev(w, svc, ctx, orig);
    expect(r.duplicate).toBe(false);
    expect(w.ledger()).toHaveLength(2);
    expect(w.ledger()[0]).toMatchObject({ id: orig, entry_kind: 'payment', amount_paisa: 225000 }); // the original is untouched
    const row = w.ledgerOf('reversal')[0];
    expect(row).toMatchObject({
      entry_kind: 'reversal', capture_kind: 'manual', method_code: 'cash', amount_paisa: -225000, reverses_entry_id: orig, order_id: IDS.order, invoice_id: INVOICE,
      branch_id: IDS.branch, centre_id: IDS.centre, collected_by_membership_id: CASHIER, approved_by_membership_id: F1, cash_session_id: SESSION(1),
      reason_code: 'SYN_REVERSAL', reason_text: 'Synthetic mis-keyed cash', receipt_no: null, receipt_seq: null,
    });
    expect(w.counterCalls, 'a reversal consumes no RC number').toHaveLength(0);
    expect(r.entry).toMatchObject({ id: row.id, entry_kind: 'reversal', capture_kind: 'manual', method_code: 'cash', amount: money(-225000), reverses_entry_id: orig, order_id: IDS.order, cash_session_id: SESSION(1) });
    expect(r.entry.collected_by.membership_id).toBe(CASHIER);
    expect(r.entry).not.toHaveProperty('receipt_no');
  });

  it('2: balance recomputed in the same transaction: paid 0, due 2,250.00, one billing.balance.changed.v1 (v2, cause payment_reversed, not releasable)', async () => {
    const { w, svc, ctx, orig } = await setup();
    const before = w.balanceEvents().length;
    const r = await rev(w, svc, ctx, orig);
    expect(r.balance).toMatchObject({ orderId: IDS.order, invoiced: npr(225000), paid: npr(0), balanceDue: npr(225000), balanceVersion: 2 });
    const ev = w.balanceEvents();
    expect(ev).toHaveLength(before + 1);
    expect(ev[before].payload).toMatchObject({ order_id: IDS.order, balance_version: 2, paid: money(0), balance_due: money(225000), cause: 'payment_reversed', release_eligible: false });
  });

  it('3: audited: one activity row on the new ledger entry by the reverser; the free reason text is never copied into the details', async () => {
    const { w, svc, ctx, orig } = await setup();
    const r = await rev(w, svc, ctx, orig, { reasonText: 'Synthetic note ZZ-UNIQUE-77' });
    const acts = (w.s as any).activity.filter((a: any) => a.document_id === r.entry.id);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ document_kind: 'ledger_entry', actor_membership_id: F1, tenant_id: TENANT_A });
    expect(JSON.stringify(acts[0])).not.toContain('ZZ-UNIQUE-77');
  });

  it('4: a second reversal of the same entry (new key) -> 409 billing.ledger_reversal_invalid, nothing written, no event', async () => {
    const { w, svc, ctx, orig } = await setup();
    await rev(w, svc, ctx, orig);
    const mark = w.repoCalls.length, ev = w.balanceEvents().length;
    const e = await errCode(rev(w, svc, ctx, orig));
    expect(e.code).toBe('billing.ledger_reversal_invalid');
    expect(w.writes(mark)).toEqual([]);
    expect(w.ledger()).toHaveLength(2);
    expect(w.balanceEvents()).toHaveLength(ev);
  });

  it('5: replay with the same idempotency key returns the same reversal (duplicate: true): no second row, no second event', async () => {
    const { w, svc, ctx, orig } = await setup();
    const first = await rev(w, svc, ctx, orig, { idempotencyKey: 'K-same' });
    const ev = w.balanceEvents().length;
    const again = await rev(w, svc, ctx, orig, { idempotencyKey: 'K-same' });
    expect(again.duplicate).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    expect(w.ledgerOf('reversal')).toHaveLength(1);
    expect(w.balanceEvents()).toHaveLength(ev);
  });

  it('6: the same key for a different entry -> common.idempotency_key_reused, nothing written', async () => {
    const { w, svc, ctx, orig } = await setup();
    const other = w.seedPayment(2, { collected_by_membership_id: CASHIER, cash_session_id: SESSION(1), amount_paisa: 5000 });
    await rev(w, svc, ctx, orig, { idempotencyKey: 'K-shared' });
    const mark = w.repoCalls.length;
    expect((await errCode(rev(w, svc, ctx, other, { idempotencyKey: 'K-shared' }))).code).toBe('common.idempotency_key_reused');
    expect(w.writes(mark)).toEqual([]);
  });

  it('7: a lost race (unique index ledger_entries__tenant_id_reverses__p_uq fires on insert) is still 409 billing.ledger_reversal_invalid, never a 500', async () => {
    const { w, svc, ctx, orig } = await setup();
    await rev(w, svc, ctx, orig);
    (w.repo as any).findReversalOf = async () => undefined; // the check-then-insert window
    const e = await errCode(rev(w, svc, ctx, orig));
    expect(e.code).toBe('billing.ledger_reversal_invalid');
  });

  it('8: only a payment can be reversed: a reversal row or a refund row -> billing.ledger_reversal_invalid, nothing written', async () => {
    const { w, svc, ctx, orig } = await setup();
    const r = await rev(w, svc, ctx, orig);
    const refund = w.seedPayment(9, { entry_kind: 'refund', amount_paisa: -1000, approved_by_membership_id: F1, reason_code: 'SYN_REASON', cash_session_id: null });
    for (const id of [r.entry.id, refund]) {
      const mark = w.repoCalls.length;
      expect((await errCode(rev(w, svc, ctx, id))).code, id).toBe('billing.ledger_reversal_invalid');
      expect(w.writes(mark)).toEqual([]);
    }
  });

  it('9: unknown entry and another tenant\'s entry -> 404 common.not_found, nothing written (tenant from ctx only; a tenantId in the input is ignored)', async () => {
    const { w, svc, ctx, orig } = await setup();
    const theirs = w.seedPayment(7, { tenant_id: OTHER_TENANT });
    for (const id of [V7('0000000b9999'), theirs]) {
      const mark = w.repoCalls.length;
      expect((await errCode(rev(w, svc, ctx, id, { tenantId: OTHER_TENANT }))).code, id).toBe('common.not_found');
      expect(w.writes(mark)).toEqual([]);
    }
    expect(w.ledger().filter((x: any) => x.tenant_id === OTHER_TENANT)).toHaveLength(1);
    expect(orig).toBeDefined();
  });
});

describe('cash_session_id of the reversal (TRD §6.5, ledger_reversal_guard)', () => {
  it('10: original session closed + reverser has an open session at the centre -> the reverser\'s session', async () => {
    const { w, svc, orig } = await setup();
    w.sessions().find((s: any) => s.id === SESSION(1)).status = 'closed';
    w.addSession({ id: SESSION(2), membership_id: F1 });
    const r = await rev(w, svc, w.ctx(), orig);
    expect(r.entry.cash_session_id).toBe(SESSION(2));
    expect(w.ledgerOf('reversal')[0].cash_session_id).toBe(SESSION(2));
  });
  it('11: original session closed + reverser has none -> NULL, and no session is created for a reversal', async () => {
    const { w, svc, orig } = await setup();
    w.sessions().find((s: any) => s.id === SESSION(1)).status = 'closed';
    const r = await rev(w, svc, w.ctx(), orig);
    expect(r.entry).not.toHaveProperty('cash_session_id');
    expect(w.ledgerOf('reversal')[0].cash_session_id).toBeNull();
    expect(w.names()).not.toContain('insertCashSession');
  });
  it('12: home_collection original (no session): reverser with an open session at the centre -> that session; without -> NULL', async () => {
    const mk = (w: RefundWorld) => w.seedPayment(3, { capture_kind: 'home_collection', collected_by_membership_id: CASHIER, cash_session_id: null });
    const a = await setup({}, mk);
    a.w.addSession({ id: SESSION(2), membership_id: F1 });
    expect((await rev(a.w, a.svc, a.ctx, a.orig)).entry.cash_session_id).toBe(SESSION(2));
    const b = await setup({}, mk);
    const r = await rev(b.w, b.svc, b.ctx, b.orig);
    expect(r.entry.capture_kind).toBe('home_collection');
    expect(b.w.ledgerOf('reversal')[0].cash_session_id).toBeNull();
  });
  it('13: gateway original: gateway, gateway_txn_ref, intent_id copied, collected_by stays NULL', async () => {
    const { w, svc, ctx, orig } = await setup({}, (x) => x.seedPayment(4, { capture_kind: 'gateway', collected_by_membership_id: null, cash_session_id: null, method_code: 'esewa',
      gateway: 'esewa', gateway_txn_ref: 'SYN-TXN-1', intent_id: V7('000000ee0001') }));
    await rev(w, svc, ctx, orig);
    expect(w.ledgerOf('reversal')[0]).toMatchObject({ capture_kind: 'gateway', method_code: 'esewa', gateway: 'esewa', gateway_txn_ref: 'SYN-TXN-1', intent_id: V7('000000ee0001'), collected_by_membership_id: null, approved_by_membership_id: F1 });
  });
});

describe('validation, atomicity, concurrency (REQ-SEC-057)', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['reasonCode empty', { reasonCode: '' }], ['reasonCode missing', { reasonCode: undefined }], ['reasonCode not a string', { reasonCode: 7 }], ['reasonCode 65 chars', { reasonCode: 'x'.repeat(65) }],
    ['reasonText 501 chars', { reasonText: 'x'.repeat(501) }], ['ledgerEntryId not a uuid', { ledgerEntryId: 'nope' }], ['idempotencyKey missing', { idempotencyKey: undefined }],
  ];
  for (const [name, over] of bad) {
    it(`14: ${name} -> common.validation_failed, nothing written, no lock taken`, async () => {
      const { w, svc, ctx, orig } = await setup();
      const mark = w.repoCalls.length;
      const e = await errCode(w.tx(() => svc.reverseEntry(ctx, { ...input(orig), ...over } as never) as Promise<any>));
      expect(e.code).toBe('common.validation_failed');
      expect(w.writes(mark)).toEqual([]);
      expect(w.names().slice(mark)).not.toContain('lockOrderBalance');
    });
  }

  it('15: order_balances is locked before the reversal is inserted (TRD §12 lock order); no RC counter is touched', async () => {
    const { w, svc, ctx, orig } = await setup();
    const mark = w.repoCalls.length;
    await rev(w, svc, ctx, orig);
    const names = w.names().slice(mark);
    expect(names.indexOf('lockOrderBalance')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('lockOrderBalance')).toBeLessThan(names.indexOf('insertLedgerEntry'));
    expect(w.repoCalls.slice(mark).find((c) => c.name === 'lockOrderBalance')!.args).toMatchObject({ tenantId: TENANT_A, orderId: IDS.order });
  });

  it('16: balance upsert fails -> the whole reversal rolls back (ledger, activity, events)', async () => {
    const { w, svc, ctx, orig } = await setup();
    const ev = w.balanceEvents().length;
    (w.repo as any).upsertOrderBalance = async () => { throw new Error('boom'); };
    await expect(rev(w, svc, ctx, orig)).rejects.toThrow('boom');
    expect(w.ledger()).toHaveLength(1);
    expect((w.s as any).activity.filter((a: any) => a.document_kind === 'ledger_entry')).toHaveLength(0);
    expect(w.balanceEvents()).toHaveLength(ev);
  });

  it('17: every repo call carries the ctx tenant', async () => {
    const { w, svc, ctx, orig } = await setup();
    const mark = w.repoCalls.length;
    await rev(w, svc, ctx, orig);
    for (const c of w.repoCalls.slice(mark)) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(TENANT_A);
  });

  it('18: an actor without a membership cannot be the approver -> rejected, nothing written', async () => {
    const { w, svc, orig } = await setup();
    const ctx = w.ctx({ actor: { type: 'user', id: V7('000000030009') } });
    const mark = w.repoCalls.length;
    await expect(rev(w, svc, ctx, orig)).rejects.toMatchObject({ code: expect.stringMatching(/^(auth\.|common\.validation_failed)/) });
    expect(w.writes(mark)).toEqual([]);
  });
});
