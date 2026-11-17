// BL-T12: BillingPort on the REAL implementation (ports/BillingPort.impl.ts) — 03-IC §4.4 cases 1–10 + 08 cases 11–14 through the shared suite
// packages/fakes/contract-tests/BillingPort.contract.ts, plus the C4-side behaviour that suite cannot see: TRD §6.2 eligibility order (rules 1–6), override expiry, gateway
// ledger rows without a collector (08 R8, CHECK ledger_entries__collector__ck), refund arithmetic, events, input validation, tenancy of every repo call, actor guard first.
// US-BL-07.1/.2, US-BL-08.1/.3/.4(port part), 07-SECURITY REQ-SEC-050/051/057, BillingPort row of the threat table, A14 (callback replay).
// Fails now: ../../ports/BillingPort.impl.js does not exist.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBillingPortContract } from '../../../../../../../packages/fakes/contract-tests/BillingPort.contract';
import { LimsError } from '../../../../core/errors.js';
import { IDS, V7 } from '../../service/__tests__/t11.helpers.js';
import { realBillingPortHarness } from './billingPort.harness.js';

// ---- 1. the shared contract suite against the real impl ----
runBillingPortContract(realBillingPortHarness());

// ---- 2. additions ----
const A = '01900000-0000-7000-8000-00000000000a', B = '01900000-0000-7000-8000-00000000000b';
const oid = (n: number) => V7(`0000000e${n.toString(16).padStart(4, '0')}`);
const O = { due: oid(1), noInv: oid(2), credit: oid(3), paid: oid(4), part: oid(5), ovr: oid(6), ovrPaid: oid(7), ovrNoInv: oid(8), over: oid(9), credited: oid(10), mixed: oid(11), other: oid(12), ovrOld: oid(13), ovrFuture: oid(14), b: oid(15) };
const INTENT = oid(0x20), INTENT2 = oid(0x21), OVR = oid(0x30);
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
const ord = (orderId: string, over: object = {}) => ({ orderId, tenantId: A, invoicedPaisa: 100000, paidPaisa: 0, creditedPaisa: 0, hasInvoice: true, balanceVersion: 1, ...over });
const WRITES = ['insertLedgerEntry', 'upsertOrderBalance', 'insertFinanceReviewItem', 'insertActivity', 'insertReleaseOverride', 'insertRefundRequest', 'insertCashSession', 'enqueueCbmsSync'];

async function boot(settingOn = true) {
  const h: any = await realBillingPortHarness()();
  await h.seed({
    settings: [{ tenantId: A, releaseRequiresPayment: settingOn }, { tenantId: B, releaseRequiresPayment: true }],
    orders: [
      ord(O.due), ord(O.noInv, { invoicedPaisa: 0, hasInvoice: false }), ord(O.credit, { creditPartyId: oid(0x40) }), ord(O.paid, { paidPaisa: 100000 }), ord(O.part, { paidPaisa: 99999 }),
      ord(O.ovr, { overrideId: OVR }), ord(O.ovrPaid, { paidPaisa: 100000, overrideId: oid(0x31) }), ord(O.ovrNoInv, { invoicedPaisa: 0, hasInvoice: false, overrideId: oid(0x32) }),
      ord(O.over, { paidPaisa: 120000 }), ord(O.credited, { creditedPaisa: 100000 }), ord(O.mixed, { paidPaisa: 60000, creditedPaisa: 40000 }), ord(O.other),
      ord(O.ovrOld, { overrideId: oid(0x33), overrideExpiresAt: '2026-11-09T00:00:00.000Z' }), ord(O.ovrFuture, { overrideId: oid(0x34), overrideExpiresAt: '2026-11-11T00:00:00.000Z' }),
      { ...ord(O.b), tenantId: B },
    ],
    intents: [{ intentId: INTENT, tenantId: A, orderId: O.due, amountPaisa: 40000 }],
  });
  const w = h.world;
  return { h, w, sys: () => h.ctxFor('A:system'), staff: () => h.ctxFor('A'),
    mark: () => w.repoCalls.length, since: (m: number) => w.repoCalls.slice(m).map((c: any) => c.name), writesSince: (m: number) => w.repoCalls.slice(m).map((c: any) => c.name).filter((n: string) => WRITES.includes(n)) };
}
const fail = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e) => e);
const pay = (over: object = {}) => ({ intentId: INTENT, orderId: O.due, gateway: 'esewa', gatewayTxnRef: 'TXN-1001', amount: npr(40000), verifiedAt: '2026-11-05T04:15:00.000Z', ...over });
const refund = (over: object = {}) => ({ refundId: oid(0x50), intentId: INTENT, orderId: O.due, gateway: 'esewa', gatewayTxnRef: 'TXN-1001', amount: npr(10000), reasonCode: 'duplicate_payment', approvedByMembershipId: oid(0x51), refundedAt: '2026-11-05T04:15:00.000Z', ...over });

describe('actor guard runs first and refuses everything but staff users and system (08 R8; REQ-SEC threat row BillingPort)', () => {
  const calls: Array<[string, (o: any) => unknown]> = [
    ['getReleaseEligibility', (o) => ({ orderId: o })], ['getOrderBalance', (o) => ({ orderId: o })],
    ['recordGatewayPayment', (o) => pay({ orderId: o })], ['recordGatewayRefund', (o) => refund({ orderId: o })],
  ];
  for (const actor of ['patient', 'portal', 'partner', 'device']) {
    it(`${actor}: auth.forbidden from every method, malformed input included; no repo call, no event, nothing stored`, async () => {
      const { h, w } = await boot();
      for (const [m, input] of calls) {
        for (const body of [input(O.due), undefined, {}, { orderId: 'not-a-uuid' }]) {
          const e = await fail(h.impl[m](h.ctxFor(`A:${actor}`), body));
          expect(e.code, `${m}/${actor}`).toBe('auth.forbidden');
        }
      }
      expect(w.repoCalls).toHaveLength(0);
      expect(w.db.events).toHaveLength(0);
      expect(h.impl.__ledgerRows(h.ctxFor('A:system'), O.due)).toBe(0);
    });
  }
  it('staff user and system actor are both served', async () => {
    const { h } = await boot();
    for (const c of [h.ctxFor('A'), h.ctxFor('A:system')]) {
      await expect(h.impl.getOrderBalance(c, { orderId: O.due })).resolves.toMatchObject({ orderId: O.due, balanceDue: npr(100000) });
    }
  });
});

describe('getReleaseEligibility: TRD §6.2 rules 1–6, first match wins (US-BL-07.1/.2)', () => {
  const ev = async (orderId: string, over: { settingOn?: boolean; ctx?: any } = {}) => {
    const b = await boot(over.settingOn ?? true);
    return { b, out: await b.h.impl.getReleaseEligibility(over.ctx ?? b.sys(), { orderId }) };
  };
  it('rule 1: policy off wins over credit party, override and missing invoice -> eligible policy_not_enforced', async () => {
    const b = await boot(false);
    for (const orderId of [O.credit, O.ovr, O.noInv, O.due, O.ovrNoInv]) {
      await expect(b.h.impl.getReleaseEligibility(b.sys(), { orderId }), orderId).resolves.toMatchObject({ eligible: true, basis: 'policy_not_enforced' });
    }
  });
  it('rule 2 before 3: a credit-party order with an active override is `credit_party` and carries no overrideId', async () => {
    const b = await boot();
    await b.h.seed({ orders: [ord(O.credit, { creditPartyId: oid(0x40), overrideId: oid(0x35) })] });
    const out = await b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.credit });
    expect(out).toMatchObject({ eligible: true, basis: 'credit_party' });
    expect('overrideId' in out).toBe(false);
  });
  it('rule 3 before 4/5/6: override beats no_invoice, paid_in_full and due_outstanding, and returns its id', async () => {
    const { b } = await ev(O.ovr);
    await expect(b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.ovrPaid })).resolves.toMatchObject({ eligible: true, basis: 'override', overrideId: oid(0x31), balanceDue: npr(0) });
    await expect(b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.ovrNoInv })).resolves.toMatchObject({ eligible: true, basis: 'override', overrideId: oid(0x32), balanceDue: npr(0) });
    await expect(b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.ovr })).resolves.toMatchObject({ eligible: true, basis: 'override', overrideId: OVR, balanceDue: npr(100000) });
  });
  it('an override only counts while unexpired at ctx.now(): expired -> due_outstanding, still running -> override; evaluatedAt = ctx.now()', async () => {
    const b = await boot();
    const now = '2026-11-10T00:00:00.000Z';
    const c = b.h.ctxFor('A:system', { now: () => now });
    await expect(b.h.impl.getReleaseEligibility(c, { orderId: O.ovrOld })).resolves.toMatchObject({ eligible: false, basis: 'due_outstanding', evaluatedAt: now });
    await expect(b.h.impl.getReleaseEligibility(c, { orderId: O.ovrFuture })).resolves.toMatchObject({ eligible: true, basis: 'override', overrideId: oid(0x34), evaluatedAt: now });
    const lookup = b.w.repoCalls.filter((x: any) => x.name === 'findActiveOverride');
    expect(lookup.length).toBeGreaterThan(0);
    for (const l of lookup) expect(l.args).toMatchObject({ tenantId: A, at: now });
  });
  it('rule 4: no issued invoice, no override -> not eligible `no_invoice`, balanceDue 0', async () => {
    const { out } = await ev(O.noInv);
    expect(out).toMatchObject({ orderId: O.noInv, eligible: false, basis: 'no_invoice', balanceDue: npr(0) });
  });
  it('rule 5: credited in full -> zero_balance; paid + credited -> paid_in_full; overpaid -> eligible paid_in_full; exact payment -> paid_in_full', async () => {
    const b = await boot();
    await expect(b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.credited })).resolves.toMatchObject({ eligible: true, basis: 'zero_balance', balanceDue: npr(0) });
    await expect(b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.mixed })).resolves.toMatchObject({ eligible: true, basis: 'paid_in_full', balanceDue: npr(0) });
    await expect(b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.over })).resolves.toMatchObject({ eligible: true, basis: 'paid_in_full' });
    await expect(b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.paid })).resolves.toMatchObject({ eligible: true, basis: 'paid_in_full' });
  });
  it('rule 6: one paisa short is still due_outstanding with balanceDue 1', async () => {
    const { out } = await ev(O.part);
    expect(out).toMatchObject({ eligible: false, basis: 'due_outstanding', balanceDue: npr(1) });
  });
  it('result shape is exactly the IC ReleaseEligibility (no extra keys, overrideId only for basis override)', async () => {
    const { out } = await ev(O.due);
    expect(Object.keys(out).sort()).toEqual(['balanceDue', 'basis', 'eligible', 'evaluatedAt', 'orderId']);
    expect(typeof out.evaluatedAt).toBe('string');
  });
  it('fails closed: an unreadable tenant policy is enforced; a failing IdentityPort rejects instead of releasing', async () => {
    const b = await boot();
    const blank = b.h.ctxFor('A:system', { ports: { IdentityPort: { getTenantSettings: async () => ({}) } } });
    await expect(b.h.impl.getReleaseEligibility(blank, { orderId: O.due })).resolves.toMatchObject({ eligible: false, basis: 'due_outstanding' });
    const broken = b.h.ctxFor('A:system', { ports: { IdentityPort: { getTenantSettings: async () => { throw new LimsError('common.internal'); } } } });
    // either outcome is safe; releasing (eligible: true) is not
    const out = await b.h.impl.getReleaseEligibility(broken, { orderId: O.due }).then((x: any) => x, (e: any) => e);
    if (out instanceof Error || out?.code) expect(out.code).toBe('common.internal'); else expect(out.eligible).toBe(false);
  });
  it('read only: no ledger / balance / activity write, no event; every repo call is scoped to ctx.tenantId', async () => {
    const b = await boot();
    const m = b.mark();
    await b.h.impl.getReleaseEligibility(b.staff(), { orderId: O.due });
    await b.h.impl.getOrderBalance(b.staff(), { orderId: O.due });
    expect(b.writesSince(m)).toEqual([]);
    expect(b.w.db.events).toHaveLength(0);
    expect(b.since(m).length).toBeGreaterThan(0);
    for (const c of b.w.repoCalls.slice(m)) expect(c.args.tenantId, c.name).toBe(A);
  });
  it('input shape: a non-uuid orderId -> common.validation_failed before any repo call', async () => {
    const b = await boot();
    for (const bad of [undefined, {}, { orderId: 'nope' }, { orderId: 42 }]) {
      const m = b.mark();
      expect((await fail(b.h.impl.getReleaseEligibility(b.sys(), bad))).code).toBe('common.validation_failed');
      expect(b.since(m)).toEqual([]);
    }
  });
  it('an order that exists only in another tenant -> common.not_found, never its balance', async () => {
    const b = await boot();
    expect((await fail(b.h.impl.getReleaseEligibility(b.sys(), { orderId: O.b }))).code).toBe('common.not_found');
    expect((await fail(b.h.impl.getReleaseEligibility(b.h.ctxFor('B:system'), { orderId: O.due }))).code).toBe('common.not_found');
  });
});

describe('recordGatewayPayment (US-BL-08.1; REQ-SEC-050/057; A14)', () => {
  it('writes ONE gateway ledger row with no collector, no cash session, no receipt; method = gateway; positive amount', async () => {
    const { h, w, sys, mark } = await boot();
    const m = mark();
    const r = await h.impl.recordGatewayPayment(sys(), pay());
    const ins = w.repoCalls.slice(m).filter((c: any) => c.name === 'insertLedgerEntry');
    expect(ins).toHaveLength(1);
    expect(ins[0].args).toMatchObject({ tenantId: A, orderId: O.due, entryKind: 'payment', captureKind: 'gateway', methodCode: 'esewa', amountPaisa: 40000, gateway: 'esewa',
      gatewayTxnRef: 'TXN-1001', intentId: INTENT, collectedByMembershipId: null });
    expect(ins[0].args.cashSessionId ?? null).toBeNull();
    expect(ins[0].args.receiptNo ?? null).toBeNull();
    expect(w.repoCalls.slice(m).map((c: any) => c.name)).not.toContain('insertCashSession');
    const row = w.ledgerRowsOf(A, O.due).find((e: any) => e.id === r.ledgerEntryId);
    expect(row).toMatchObject({ capture_kind: 'gateway', collected_by_membership_id: null, entry_kind: 'payment', cash_session_id: null, receipt_no: null });
  });
  it('a STAFF caller (verify in a staff request, TRD §6.2) still records without a collector: the staff membership is never attributed', async () => {
    const { h, w, staff } = await boot();
    await h.impl.recordGatewayPayment(staff(), pay());
    const ins = w.repoCalls.find((c: any) => c.name === 'insertLedgerEntry');
    expect(ins.args.collectedByMembershipId).toBeNull();
    expect(ins.args.userId).toBe(staff().actor.id);
  });
  it('ledger insert is preceded by the order_balances lock and the (gateway, txn ref) replay lookup (TRD §12): lock, then find, then insert', async () => {
    const { h, w, sys } = await boot();
    await h.impl.recordGatewayPayment(sys(), pay());
    const names = w.repoCalls.map((c: any) => c.name);
    expect(names.indexOf('lockOrderBalance')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('lockOrderBalance')).toBeLessThan(names.indexOf('findGatewayPayment'));
    expect(names.indexOf('findGatewayPayment')).toBeLessThan(names.indexOf('insertLedgerEntry'));
  });
  it('publishes ONE billing.balance.changed.v1 (cause gateway_payment_recorded, new version, release verdict); a replay publishes nothing and stores nothing', async () => {
    const { h, w, sys, mark } = await boot();
    const r = await h.impl.recordGatewayPayment(sys(), pay());
    const evs = w.balanceEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toMatchObject({ order_id: O.due, balance_version: 2, cause: 'gateway_payment_recorded', release_eligible: false, release_basis: 'due_outstanding' });
    expect(evs[0].payload.paid).toMatchObject({ amount_paisa: 40000 });
    expect(r.balance).toMatchObject({ orderId: O.due, balanceVersion: 2, balanceDue: npr(60000), paid: npr(40000) });
    const m = mark();
    const again = await h.impl.recordGatewayPayment(sys(), pay());
    expect(again).toMatchObject({ duplicate: true, ledgerEntryId: r.ledgerEntryId });
    expect(w.balanceEvents()).toHaveLength(1);
    expect(w.repoCalls.slice(m).map((c: any) => c.name).filter((n: string) => WRITES.includes(n))).toEqual([]);
    expect(w.ledgerRowsOf(A, O.due)).toHaveLength(1);
  });
  it('a replay with the same (gateway, txn ref) returns the ORIGINAL row even if the retry carries another amount (A14, IC invariant)', async () => {
    const { h, sys } = await boot();
    const a = await h.impl.recordGatewayPayment(sys(), pay());
    const b = await h.impl.recordGatewayPayment(sys(), pay({ amount: npr(1000) }));
    expect(b).toMatchObject({ duplicate: true, ledgerEntryId: a.ledgerEntryId });
    expect(b.balance.paid).toEqual(npr(40000));
  });
  it('the same txn ref on ANOTHER gateway is a different payment (unique is per gateway)', async () => {
    const { h, w, sys } = await boot();
    await h.impl.recordGatewayPayment(sys(), pay());
    const b = await h.impl.recordGatewayPayment(sys(), pay({ intentId: INTENT2, gateway: 'khalti', amount: npr(1000) }));
    expect(b.duplicate).toBe(false);
    expect(w.ledgerRowsOf(A, O.due)).toHaveLength(2);
  });
  it('lost race on the unique index (the winner committed after our lookup) -> duplicate:true with the winner row, not an error and not a second row', async () => {
    const { h, w, sys } = await boot();
    const a = await h.impl.recordGatewayPayment(sys(), pay());
    w.hideNextGatewayLookup = true;
    const b = await h.impl.recordGatewayPayment(sys(), pay());
    expect(b).toMatchObject({ duplicate: true, ledgerEntryId: a.ledgerEntryId });
    expect(w.ledgerRowsOf(A, O.due)).toHaveLength(1);
    expect(w.balanceEvents()).toHaveLength(1);
  });
  it('amount_mismatch is checked against the intent ref and writes nothing (no row, no event, no review item)', async () => {
    const { h, w, sys, mark } = await boot();
    const m = mark();
    expect((await fail(h.impl.recordGatewayPayment(sys(), pay({ amount: npr(40001) })))).code).toBe('billing.amount_mismatch');
    expect((await fail(h.impl.recordGatewayPayment(sys(), pay({ amount: npr(39999), allowExceedsDue: true })))).code).toBe('billing.amount_mismatch');
    expect(w.repoCalls.slice(m).map((c: any) => c.name).filter((n: string) => WRITES.includes(n))).toEqual([]);
    expect(w.db.events).toHaveLength(0);
  });
  it('an intent with no ref row (created by C16) skips the mismatch check: C15 amount is authoritative', async () => {
    const { h, sys } = await boot();
    await expect(h.impl.recordGatewayPayment(sys(), pay({ intentId: INTENT2, amount: npr(77777) }))).resolves.toMatchObject({ duplicate: false, balance: { paid: npr(77777) } });
  });
  it('the due itself is not "exceeding": amount == balance due records without a review item; one paisa over is refused without the flag', async () => {
    const { h, sys } = await boot();
    const ok = await h.impl.recordGatewayPayment(sys(), pay({ intentId: INTENT2, gatewayTxnRef: 'TXN-EQ', amount: npr(100000) }));
    expect(ok.balance).toMatchObject({ balanceDue: npr(0) });
    expect(h.impl.__reviewItems(sys(), O.due)).toEqual([]);
    expect((await fail(h.impl.recordGatewayPayment(sys(), pay({ orderId: O.other, intentId: oid(0x22), gatewayTxnRef: 'TXN-OV', amount: npr(100001) })))).code).toBe('billing.payment_exceeds_due');
  });
  it('allowExceedsDue + amount above due: full amount recorded, ONE gateway_payment_exceeds_due item pointing at the new ledger row, after the row; balance due goes negative', async () => {
    const { h, w, sys, mark } = await boot();
    const m = mark();
    const r = await h.impl.recordGatewayPayment(sys(), pay({ intentId: INTENT2, gatewayTxnRef: 'TXN-X', amount: npr(120000), allowExceedsDue: true }));
    const names = w.repoCalls.slice(m).map((c: any) => c.name);
    expect(names.indexOf('insertLedgerEntry')).toBeLessThan(names.indexOf('insertFinanceReviewItem'));
    const items = (w.s as any).reviewItems.filter((i: any) => i.order_id === O.due);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ tenant_id: A, kind: 'gateway_payment_exceeds_due', ledger_entry_id: r.ledgerEntryId, status: 'open' });
    expect(r.balance).toMatchObject({ paid: npr(120000), balanceDue: npr(-20000) });
    // replay raises no second item
    await h.impl.recordGatewayPayment(sys(), pay({ intentId: INTENT2, gatewayTxnRef: 'TXN-X', amount: npr(120000), allowExceedsDue: true }));
    expect((w.s as any).reviewItems.filter((i: any) => i.order_id === O.due)).toHaveLength(1);
  });
  it('allowExceedsDue on a payment that does NOT exceed raises no item', async () => {
    const { h, sys } = await boot();
    await h.impl.recordGatewayPayment(sys(), pay({ allowExceedsDue: true }));
    expect(h.impl.__reviewItems(sys(), O.due)).toEqual([]);
  });
  it('a payment against another order\'s invoice id is refused (id swap) and writes nothing', async () => {
    const { h, w, sys, mark } = await boot();
    const m = mark();
    const e = await fail(h.impl.recordGatewayPayment(sys(), pay({ invoiceId: w.invoiceIdOf(A, O.other) })));
    expect(e.code).toBe('common.validation_failed');
    expect(w.repoCalls.slice(m).map((c: any) => c.name).filter((n: string) => WRITES.includes(n))).toEqual([]);
    const ok = await h.impl.recordGatewayPayment(sys(), pay({ invoiceId: w.invoiceIdOf(A, O.due) }));
    expect(ok.duplicate).toBe(false);
  });
  const BAD: Array<[string, object]> = [
    ['amount 0', { amount: npr(0) }], ['amount negative', { amount: npr(-5) }], ['amount fractional', { amount: { amountPaisa: 1.5, currency: 'NPR' } }],
    ['amount as string', { amount: { amountPaisa: '40000', currency: 'NPR' } }], ['amount in USD', { amount: { amountPaisa: 40000, currency: 'USD' } }], ['amount missing', { amount: undefined }],
    ['unknown gateway', { gateway: 'stripe' }], ['gateway wrong case', { gateway: 'ESEWA' }], ['gateway missing', { gateway: undefined }],
    ['empty txn ref', { gatewayTxnRef: '' }], ['txn ref with control char', { gatewayTxnRef: 'T\u0000X' }], ['txn ref not a string', { gatewayTxnRef: 12345 }],
    ['intentId not a uuid', { intentId: 'nope' }], ['orderId not a uuid', { orderId: 'nope' }], ['verifiedAt not an instant', { verifiedAt: 'yesterday' }], ['allowExceedsDue not boolean', { allowExceedsDue: 'yes' }],
  ];
  for (const [label, over] of BAD) {
    it(`validation: ${label} -> common.validation_failed, nothing written`, async () => {
      const { h, w, sys, mark } = await boot();
      const m = mark();
      expect((await fail(h.impl.recordGatewayPayment(sys(), pay(over)))).code).toBe('common.validation_failed');
      expect(w.repoCalls.slice(m).map((c: any) => c.name).filter((n: string) => WRITES.includes(n))).toEqual([]);
      expect(w.db.events).toHaveLength(0);
    });
  }
  it('every repo call of every method carries the caller\'s tenant (a body never names a tenant)', async () => {
    const { h, w, sys } = await boot();
    // an impl may ignore the stray key or reject it; it must never act on it
    await h.impl.recordGatewayPayment(sys(), { ...pay(), tenantId: B }).catch(() => undefined);
    await h.impl.recordGatewayRefund(sys(), { ...refund(), tenantId: B }).catch(() => undefined);
    await h.impl.getOrderBalance(sys(), { orderId: O.due, tenantId: B }).catch(() => undefined);
    expect(w.repoCalls.length).toBeGreaterThan(0);
    for (const c of w.repoCalls) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(A);
  });
});

describe('recordGatewayRefund (08 CR-C15-002; US-BL-08.3)', () => {
  const paid = async () => { const b = await boot(); await b.h.impl.recordGatewayPayment(b.sys(), pay()); return b; };
  it('writes ONE negative refund row: capture gateway, no collector, approver + reason from the input, idempotency key gw_refund:<refundId>; no refund_requests row', async () => {
    const { h, w, sys, mark } = await paid();
    const m = mark();
    const r = await h.impl.recordGatewayRefund(sys(), refund());
    const ins = w.repoCalls.slice(m).filter((c: any) => c.name === 'insertLedgerEntry');
    expect(ins).toHaveLength(1);
    expect(ins[0].args).toMatchObject({ tenantId: A, orderId: O.due, entryKind: 'refund', captureKind: 'gateway', amountPaisa: -10000, reasonCode: 'duplicate_payment', approvedByMembershipId: oid(0x51),
      collectedByMembershipId: null, gateway: 'esewa', gatewayTxnRef: 'TXN-1001', intentId: INTENT, idempotencyKey: `gw_refund:${oid(0x50)}` });
    expect(w.repoCalls.slice(m).map((c: any) => c.name)).not.toContain('insertRefundRequest');
    expect(r).toMatchObject({ duplicate: false, balance: { paid: npr(30000), balanceDue: npr(70000) } });
    expect(w.ledgerRowsOf(A, O.due).map((e: any) => e.entry_kind).sort()).toEqual(['payment', 'refund']);
  });
  it('publishes ONE balance.changed (cause payment_reversed, version +1); a replay of the refundId publishes nothing', async () => {
    const { h, w, sys } = await paid();
    await h.impl.recordGatewayRefund(sys(), refund());
    const evs = w.balanceEvents();
    expect(evs).toHaveLength(2);
    expect(evs[1].payload).toMatchObject({ order_id: O.due, balance_version: 3, cause: 'payment_reversed' });
    await h.impl.recordGatewayRefund(sys(), refund());
    expect(w.balanceEvents()).toHaveLength(2);
    expect(w.ledgerRowsOf(A, O.due)).toHaveLength(2);
  });
  it('refundable = gateway payments of the intent minus earlier gateway refunds: partials add up to exactly the payment, one paisa more is refused', async () => {
    const { h, sys } = await paid();
    await h.impl.recordGatewayRefund(sys(), refund({ refundId: oid(0x60), amount: npr(25000) }));
    await h.impl.recordGatewayRefund(sys(), refund({ refundId: oid(0x61), amount: npr(15000) }));
    expect((await fail(h.impl.recordGatewayRefund(sys(), refund({ refundId: oid(0x62), amount: npr(1) })))).code).toBe('billing.ledger_reversal_invalid');
    await expect(h.impl.getOrderBalance(sys(), { orderId: O.due })).resolves.toMatchObject({ paid: npr(0) });
  });
  it('a replay of a fully-refunded refundId is duplicate:true (replay is checked before the refundable arithmetic)', async () => {
    const { h, sys } = await paid();
    const a = await h.impl.recordGatewayRefund(sys(), refund({ amount: npr(40000) }));
    const b = await h.impl.recordGatewayRefund(sys(), refund({ amount: npr(40000) }));
    expect(b).toMatchObject({ duplicate: true, ledgerEntryId: a.ledgerEntryId });
  });
  it('a refund with no gateway payment on the intent -> billing.ledger_reversal_invalid, nothing stored', async () => {
    const { h, w, sys, mark } = await boot();
    const m = mark();
    expect((await fail(h.impl.recordGatewayRefund(sys(), refund()))).code).toBe('billing.ledger_reversal_invalid');
    expect((await fail(h.impl.recordGatewayRefund(sys(), refund({ intentId: INTENT2 })))).code).toBe('billing.ledger_reversal_invalid');
    expect(w.repoCalls.slice(m).map((c: any) => c.name).filter((n: string) => WRITES.includes(n))).toEqual([]);
  });
  it('a refund on another tenant\'s order -> common.not_found', async () => {
    const { h, sys } = await paid();
    expect((await fail(h.impl.recordGatewayRefund(sys(), refund({ orderId: O.b })))).code).toBe('common.not_found');
  });
  it('a full gateway refund puts the order back to due_outstanding (the release gate re-closes)', async () => {
    const { h, sys } = await paid();
    await h.impl.recordGatewayPayment(sys(), pay({ intentId: INTENT2, gatewayTxnRef: 'TXN-2', amount: npr(60000) }));
    await expect(h.impl.getReleaseEligibility(sys(), { orderId: O.due })).resolves.toMatchObject({ eligible: true, basis: 'paid_in_full' });
    await h.impl.recordGatewayRefund(sys(), refund({ amount: npr(40000) }));
    await expect(h.impl.getReleaseEligibility(sys(), { orderId: O.due })).resolves.toMatchObject({ eligible: false, basis: 'due_outstanding', balanceDue: npr(40000) });
  });
  const BAD: Array<[string, object]> = [
    ['amount 0', { amount: npr(0) }], ['amount negative', { amount: npr(-1) }], ['amount fractional', { amount: { amountPaisa: 0.5, currency: 'NPR' } }], ['amount in USD', { amount: { amountPaisa: 1, currency: 'USD' } }],
    ['refundId not a uuid', { refundId: 'nope' }], ['approver missing', { approvedByMembershipId: undefined }], ['approver not a uuid', { approvedByMembershipId: 'me' }],
    ['reason missing', { reasonCode: undefined }], ['reason empty', { reasonCode: '' }], ['unknown gateway', { gateway: 'paypal' }], ['txn ref empty', { gatewayTxnRef: '' }], ['refundedAt not an instant', { refundedAt: 'soon' }],
  ];
  for (const [label, over] of BAD) {
    it(`validation: ${label} -> common.validation_failed, nothing written`, async () => {
      const { h, w, sys, mark } = await paid();
      const m = mark();
      expect((await fail(h.impl.recordGatewayRefund(sys(), refund(over)))).code).toBe('common.validation_failed');
      expect(w.repoCalls.slice(m).map((c: any) => c.name).filter((n: string) => WRITES.includes(n))).toEqual([]);
    });
  }
});

describe('getOrderBalance', () => {
  it('returns the four amounts, the stored balanceVersion and asOf = ctx.now(); credited counts against the due', async () => {
    const { h, sys } = await boot();
    const now = '2026-11-10T00:00:00.000Z';
    const out = await h.impl.getOrderBalance(h.ctxFor('A:system', { now: () => now }), { orderId: O.mixed });
    expect(out).toMatchObject({ orderId: O.mixed, invoiced: npr(100000), paid: npr(60000), credited: npr(40000), balanceDue: npr(0), balanceVersion: 1 });
    expect(Object.keys(out).sort()).toEqual(['asOf', 'balanceDue', 'balanceVersion', 'credited', 'invoiced', 'orderId', 'paid']);
    expect(typeof out.asOf).toBe('string');
    await expect(h.impl.getOrderBalance(sys(), { orderId: O.due })).resolves.toMatchObject({ balanceDue: npr(100000), balanceVersion: 1 });
  });
  it('unknown order and other tenant\'s order -> common.not_found; bad id -> common.validation_failed', async () => {
    const { h, sys } = await boot();
    expect((await fail(h.impl.getOrderBalance(sys(), { orderId: O.b }))).code).toBe('common.not_found');
    expect((await fail(h.impl.getOrderBalance(sys(), { orderId: oid(0xfff) }))).code).toBe('common.not_found');
    expect((await fail(h.impl.getOrderBalance(sys(), { orderId: 'nope' }))).code).toBe('common.validation_failed');
  });
});

describe('implementation hygiene and wiring (02-CV §5.13, REQ-SEC-057)', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = () => readFileSync(join(dir, '..', '..', 'ports', 'BillingPort.impl.ts'), 'utf8');
  it('BillingPort.impl.ts never updates or deletes ledger rows and never reads frontdesk tables', () => {
    const code = src().split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/UPDATE\s+billing\.ledger_entries|DELETE\s+FROM\s+billing\./i);
    expect(code).not.toMatch(/frontdesk\.[a-z_]+\s/i);
  });
  it('manifest registers BillingPort with its four methods; PORT_OWNERS agrees', async () => {
    const { manifest } = await import('../../index.js');
    const port: any = (manifest.ports as any)?.BillingPort;
    expect(port, 'manifest.ports.BillingPort').toBeDefined();
    for (const m of ['getReleaseEligibility', 'recordGatewayPayment', 'getOrderBalance', 'recordGatewayRefund']) expect(typeof port[m], m).toBe('function');
    expect((manifest.ports as any).BillingCommandPort).toBeDefined();
  });
  it('the manifest port refuses a patient actor before touching anything (the guard is in the shipped object, not only in the test factory)', async () => {
    const { manifest } = await import('../../index.js');
    const port: any = (manifest.ports as any).BillingPort;
    const ctx: any = { tenantId: A, actor: { type: 'patient', id: IDS.patient }, requestId: IDS.patient, tx: {}, now: () => '2026-11-05T04:15:00.000Z', ports: {} };
    for (const [m, input] of [['getReleaseEligibility', { orderId: O.due }], ['getOrderBalance', { orderId: O.due }], ['recordGatewayPayment', pay()], ['recordGatewayRefund', refund()]] as const) {
      expect((await fail(port[m](ctx, input))).code, m).toBe('auth.forbidden');
    }
  });
});
