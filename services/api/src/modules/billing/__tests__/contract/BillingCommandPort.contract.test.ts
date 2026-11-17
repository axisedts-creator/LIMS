// BL-T07: BillingCommandPort on the REAL implementation (ports/BillingCommandPort.impl.ts) — TRD §6.3 / IC §4.15 contract cases, run through the shared
// suite packages/fakes/contract-tests/BillingCommandPort.contract.ts (cases 1–15; the plan row says "11", the shared file has grown to 15 and all must pass),
// plus C4-side behaviour the shared suite cannot see: persistence through the real services, credit charge/void/credit-note paths, tenancy of every repo call,
// receipt numbering, atomicity (no own transaction), manifest wiring. US-FD-03.1–.7 / US-FD-04.1–.4 (consumed via frontdesk), REQ-SEC tenancy.
// Fails now: ../../ports/BillingCommandPort.impl.js does not exist.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBillingCommandPortContract } from '../../../../../../../packages/fakes/contract-tests/BillingCommandPort.contract';
import { realHarness } from './harness.js';

// ---- 1. the shared contract suite against the real impl ----
runBillingCommandPortContract(realHarness());

// ---- 2. additions ----
const id = (n: number) => `01900000-0000-7000-8000-0000000c4${n.toString(16).padStart(3, '0')}`;
const O_NEW = id(1), O_INV = id(2), O_CHG = id(3), O_B = id(4), O_CR = id(5);
const P_OK = id(0x11), P_LOCKED = id(0x12), P_LIMIT = id(0x14);
const PERIODIC_INV = id(0x22), ITEM1 = id(0x31), ITEM2 = id(0x32), PL = id(0x41), BRANCH = id(0x42), CENTRE = id(0x43), PATIENT = id(0x44);
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
const line = (ref: string, paisa: number, extra: object = {}) => ({
  lineRef: ref, orderableId: id(0x100 + ref.length), orderableKind: 'test' as const, code: ref, name: `Synthetic ${ref}`, priority: 'routine' as const,
  unitPrice: npr(paisa), tax: { vat: 'taxable' as const, vatRateBp: 1300 }, priceListId: PL, priceListVersion: 1, priceSource: 'tenant_default' as const, ...extra,
});
const LINES = [line('CBC', 50000, { orderItemId: ITEM1 }), line('LFT', 120000, { orderItemId: ITEM2, priority: 'urgent', urgentSurcharge: npr(20000) })];

async function boot() {
  const h: any = await realHarness()();
  const A = h.ctxFor('A').tenantId, B = h.ctxFor('B').tenantId;
  await h.seed({
    orders: [O_NEW, O_INV, O_CHG, O_CR].map((i) => ({ id: i, tenantId: A })).concat([{ id: O_B, tenantId: B }]),
    invoices: [{ id: id(0x51), tenantId: A, orderId: O_INV, purpose: 'registration', invoiceNo: '2083/84-000900', fiscalYearBs: '2083/84', issuedAt: '2026-11-01T04:15:00.000Z', netPaisa: 100000, orderItemIds: [] }],
    creditParties: [
      { id: P_OK, tenantId: A, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: null, outstandingPaisa: 0 },
      { id: P_LOCKED, tenantId: A, allowsCredit: true, isActive: true, isLocked: true, creditLimitPaisa: null, outstandingPaisa: 0 },
      { id: P_LIMIT, tenantId: A, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: 100000, outstandingPaisa: 90000 },
    ],
    creditCharges: [
      { id: id(0x21), tenantId: A, orderId: O_CHG, orderItemId: ITEM1, creditPartyId: P_OK, amountPaisa: 50000, periodicInvoiceId: PERIODIC_INV, invoiceLineId: id(0x23), voided: false },
      { id: id(0x24), tenantId: A, orderId: O_CHG, orderItemId: ITEM2, creditPartyId: P_OK, amountPaisa: 70000, periodicInvoiceId: null, invoiceLineId: null, voided: false },
    ],
  });
  return { h, A, B };
}
const issueInput = (orderId: string, expectedFingerprint: string, over: object = {}) =>
  ({ orderId, patientId: PATIENT, branchId: BRANCH, centreId: CENTRE, buyer: { name: 'Test Patient 0042' }, lines: LINES, discounts: [], expectedFingerprint, purpose: 'registration', ...over });
const pay = (orderId: string, paisa: number, captureKind: string, idempotencyKey: string, over: object = {}) =>
  ({ orderId, methodCode: 'cash', amount: npr(paisa), captureKind, idempotencyKey, issueReceiptNo: false, ...over });
const fail = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e) => e);
const quote = (h: any, discounts: object[] = []) => h.impl.computeQuote(h.ctxFor('A'), { lines: LINES, discounts });

describe('issueOrderInvoice persists through the real invoice service (US-FD-03.1, 03.2, 03.4)', () => {
  it('returns the ref whose totals equal the quote, publishes issued + balance.changed(invoice_issued) with the same invoice id and order id', async () => {
    const { h } = await boot();
    const q = await quote(h);
    const ref = await h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_NEW, q.fingerprint));
    expect(ref).toMatchObject({ fiscalYearBs: '2083/84' });
    expect(ref.invoiceNo).toMatch(/^083\/84-0*1$/);
    expect(ref.totals).toEqual(q.totals);
    const [issued] = h.events.ofType('billing.invoice.issued.v1');
    expect(issued.payload).toMatchObject({ invoice_id: ref.invoiceId, order_id: O_NEW, branch_id: BRANCH, centre_id: CENTRE });
    const [bal] = h.events.ofType('billing.balance.changed.v1');
    expect(bal.payload).toMatchObject({ order_id: O_NEW, cause: 'invoice_issued', balance_version: 1 });
    expect(bal.payload.invoiced.amount_paisa).toBe(q.totals.net.amountPaisa);
  });

  it('two orders get consecutive numbers (gapless); the summary shows the invoice and the full balance due', async () => {
    const { h } = await boot();
    const q = await quote(h);
    const a = await h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_NEW, q.fingerprint));
    const b = await h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_CR, q.fingerprint));
    expect(Number(b.invoiceNo.split('-').pop()) - Number(a.invoiceNo.split('-').pop())).toBe(1);
    const s = await h.impl.getOrderBillingSummary(h.ctxFor('A'), { orderId: O_NEW });
    expect(s).toMatchObject({ invoiceIds: [a.invoiceId], hasIssuedInvoice: true, creditChargeIds: [] });
    expect(s.balance).toMatchObject({ orderId: O_NEW, invoiced: q.totals.net, paid: npr(0), balanceDue: q.totals.net });
  });

  it('supplementary invoices for an order that already has a registration invoice are allowed; a bogus purpose is common.validation_failed', async () => {
    const { h } = await boot();
    const q = await quote(h);
    await h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_NEW, q.fingerprint));
    await expect(h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_NEW, q.fingerprint, { purpose: 'supplementary' }))).resolves.toMatchObject({ invoiceId: expect.any(String) });
    expect((await fail(h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_NEW, q.fingerprint, { purpose: 'periodic' })))).code).toBe('common.validation_failed');
  });

  it('a tampered line (price changed after quoting) is common.version_conflict and writes nothing (fingerprint is recomputed, never trusted)', async () => {
    const { h } = await boot();
    const q = await quote(h);
    const tampered = [{ ...LINES[0]!, unitPrice: npr(1) }, LINES[1]];
    expect((await fail(h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_NEW, q.fingerprint, { lines: tampered })))).code).toBe('common.version_conflict');
    expect(h.events.ofType('billing.invoice.issued.v1')).toHaveLength(0);
    expect((await h.impl.getOrderBillingSummary(h.ctxFor('A'), { orderId: O_NEW })).hasIssuedInvoice).toBe(false);
  });
});

describe('recordPayment through the real ledger service (US-FD-03.3, 03.6, 03.7)', () => {
  it('issueReceiptNo=false: no receipt number, no RC allocation; true: RC number from receiptNoPattern, next one gapless', async () => {
    const { h } = await boot();
    const none = await h.impl.recordPayment(h.ctxFor('A'), pay(O_INV, 10000, 'manual', 'p-1'));
    expect(none.receiptNo).toBeUndefined();
    const r1 = await h.impl.recordPayment(h.ctxFor('A'), pay(O_INV, 10000, 'manual', 'p-2', { issueReceiptNo: true }));
    const r2 = await h.impl.recordPayment(h.ctxFor('A'), pay(O_INV, 10000, 'manual', 'p-3', { issueReceiptNo: true }));
    expect(r1.receiptNo).toBe('RC-083/84-000001');
    expect(r2.receiptNo).toBe('RC-083/84-000002');
    expect(r2.balance).toMatchObject({ paid: npr(30000), balanceDue: npr(70000) });
  });

  it('balance.changed event is published per payment with cause payment_recorded and a strictly higher balance_version', async () => {
    const { h } = await boot();
    await h.impl.recordPayment(h.ctxFor('A'), pay(O_INV, 10000, 'manual', 'p-1'));
    await h.impl.recordPayment(h.ctxFor('A'), pay(O_INV, 10000, 'home_collection', 'p-2'));
    const ev = h.events.ofType('billing.balance.changed.v1').map((e: any) => e.payload);
    expect(ev.map((p: any) => p.cause)).toEqual(['payment_recorded', 'payment_recorded']);
    expect(ev[1].balance_version).toBeGreaterThan(ev[0].balance_version);
  });

  it('manual payment on an order with no invoice -> billing.order_not_invoiced; invalid amounts -> common.validation_failed (0, negative, fractional)', async () => {
    const { h } = await boot();
    expect((await fail(h.impl.recordPayment(h.ctxFor('A'), pay(O_NEW, 100, 'manual', 'p-1')))).code).toBe('billing.order_not_invoiced');
    for (const [i, bad] of [0, -5, 1.5].entries()) {
      expect((await fail(h.impl.recordPayment(h.ctxFor('A'), pay(O_INV, bad, 'manual', `p-bad-${i}`)))).code, String(bad)).toBe('common.validation_failed');
    }
  });

  it('home_collection with a method code unknown to the tenant is still recorded (D-128); the same idempotency key with another amount is common.idempotency_key_reused', async () => {
    const { h } = await boot();
    const r = await h.impl.recordPayment(h.ctxFor('A'), pay(O_INV, 20000, 'home_collection', 'p-h', { methodCode: 'old_cheque', collectedByMembershipId: id(0x61) }));
    expect(r).toMatchObject({ duplicate: false, exceedsDue: false });
    expect((await fail(h.impl.recordPayment(h.ctxFor('A'), pay(O_INV, 20001, 'home_collection', 'p-h', { methodCode: 'old_cheque' })))).code).toBe('common.idempotency_key_reused');
  });
});

describe('credit charges (US-FD-04.1–.4)', () => {
  it('recordCreditCharges: party snapshot upserted BEFORE the charges, one charge per computed line (incl. urgent surcharge), totals = quote totals', async () => {
    const { h } = await boot();
    const q = await quote(h);
    const r = await h.impl.recordCreditCharges(h.ctxFor('A'), { orderId: O_CR, creditPartyId: P_OK, branchId: BRANCH, centreId: CENTRE, patientDisplayName: 'Test Patient 0042', lines: LINES, discounts: [], expectedFingerprint: q.fingerprint });
    expect(r.totals).toEqual(q.totals);
    expect(r.chargeIds).toHaveLength(q.lines.length);
    expect(new Set(r.chargeIds).size).toBe(q.lines.length);
    const s = await h.impl.getOrderBillingSummary(h.ctxFor('A'), { orderId: O_CR });
    expect([...s.creditChargeIds].sort()).toEqual([...r.chargeIds].sort());
    expect(s.hasIssuedInvoice).toBe(false);
  });

  it('recordCreditCharges refuses a locked party (billing.credit_party_locked), an over-limit total (billing.credit_limit_exceeded) and a stale fingerprint (common.version_conflict) with nothing written', async () => {
    const { h } = await boot();
    const q = await quote(h);
    const call = (party: string, fp: string) => h.impl.recordCreditCharges(h.ctxFor('A'), { orderId: O_CR, creditPartyId: party, branchId: BRANCH, centreId: CENTRE, patientDisplayName: 'Test Patient 0042', lines: LINES, discounts: [], expectedFingerprint: fp });
    expect((await fail(call(P_LOCKED, q.fingerprint))).code).toBe('billing.credit_party_locked');
    expect((await fail(call(P_LIMIT, q.fingerprint))).code).toBe('billing.credit_limit_exceeded');
    expect((await fail(call(P_OK, '0'.repeat(64)))).code).toBe('common.version_conflict');
    expect((await h.impl.getOrderBillingSummary(h.ctxFor('A'), { orderId: O_CR })).creditChargeIds).toEqual([]);
  });

  it('assertCreditAllowed: a party of another tenant is common.not_found (no existence leak across tenants)', async () => {
    const { h } = await boot();
    expect((await fail(h.impl.assertCreditAllowed(h.ctxFor('B'), { creditPartyId: P_OK, additional: npr(1) }))).code).toBe('common.not_found');
  });

  it('voidCreditCharges voids the uninvoiced charge and reports the periodic-invoiced one; an orderItemIds filter limits the scope', async () => {
    const { h } = await boot();
    const none = await h.impl.voidCreditCharges(h.ctxFor('A'), { orderId: O_CHG, orderItemIds: [id(0x99)], reasonCode: 'item_removed' });
    expect(none).toEqual({ voided: 0, alreadyInvoiced: [] });
    const r = await h.impl.voidCreditCharges(h.ctxFor('A'), { orderId: O_CHG, reasonCode: 'item_removed' });
    expect(r).toEqual({ voided: 1, alreadyInvoiced: [id(0x21)] });
    const again = await h.impl.voidCreditCharges(h.ctxFor('A'), { orderId: O_CHG, reasonCode: 'item_removed' });
    expect(again.voided).toBe(0);                                       // idempotent
    expect((await h.impl.getOrderBillingSummary(h.ctxFor('A'), { orderId: O_CHG })).creditChargeIds).toEqual([id(0x21)]);
  });
});

describe('raiseCreditNoteRequirement (US-FD-03.6; TRD §6.3)', () => {
  it('order with an issued invoice -> required: true and one task for that invoice', async () => {
    const { h } = await boot();
    const q = await quote(h);
    const inv = await h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_NEW, q.fingerprint));
    const r = await h.impl.raiseCreditNoteRequirement(h.ctxFor('A'), { orderId: O_NEW, cause: 'order_cancelled', reasonCode: 'patient_request' });
    expect(r.required).toBe(true);
    expect(r.taskIds).toHaveLength(1);
    expect(inv.invoiceId).toBeDefined();
  });

  it('item_removed with orderItemIds that are on no invoice -> required: false; a bad cause is common.validation_failed', async () => {
    const { h } = await boot();
    const q = await quote(h);
    await h.impl.issueOrderInvoice(h.ctxFor('A'), issueInput(O_NEW, q.fingerprint));
    expect(await h.impl.raiseCreditNoteRequirement(h.ctxFor('A'), { orderId: O_NEW, orderItemIds: [id(0x99)], cause: 'item_removed', reasonCode: 'entry_error' })).toEqual({ required: false, taskIds: [] });
    expect((await fail(h.impl.raiseCreditNoteRequirement(h.ctxFor('A'), { orderId: O_NEW, cause: 'because', reasonCode: 'x' }))).code).toBe('common.validation_failed');
  });
});

describe('tenancy: every method on another tenant\'s order is common.not_found and writes nothing (REQ-SEC tenancy)', () => {
  it('payment / credit charges / void / credit-note requirement / summary / issue on O_B as tenant A', async () => {
    const { h } = await boot();
    const q = await quote(h);
    const A = h.ctxFor('A');
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['recordPayment', () => h.impl.recordPayment(A, pay(O_B, 100, 'home_collection', 'x-1'))],
      ['recordCreditCharges', () => h.impl.recordCreditCharges(A, { orderId: O_B, creditPartyId: P_OK, branchId: BRANCH, centreId: CENTRE, patientDisplayName: 'T', lines: LINES, discounts: [], expectedFingerprint: q.fingerprint })],
      ['voidCreditCharges', () => h.impl.voidCreditCharges(A, { orderId: O_B, reasonCode: 'x' })],
      ['raiseCreditNoteRequirement', () => h.impl.raiseCreditNoteRequirement(A, { orderId: O_B, cause: 'order_cancelled', reasonCode: 'x' })],
      ['getOrderBillingSummary', () => h.impl.getOrderBillingSummary(A, { orderId: O_B })],
      ['issueOrderInvoice', () => h.impl.issueOrderInvoice(A, issueInput(O_B, q.fingerprint))],
    ];
    for (const [name, call] of calls) expect((await fail(call())).code, name).toBe('common.not_found');
    expect(h.events.ofType('billing.invoice.issued.v1')).toHaveLength(0);
    expect(h.events.ofType('billing.balance.changed.v1')).toHaveLength(0);
  });
});

describe('static: atomicity and layering of ports/BillingCommandPort.impl.ts', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = () => readFileSync(join(dir, '..', '..', 'ports', 'BillingCommandPort.impl.ts'), 'utf8');

  it('runs in the caller\'s ctx.tx: no own transaction, pool or BEGIN/COMMIT (TRD §3 rule 1)', () => {
    const s = src();
    expect(s).not.toMatch(/\.transaction\s*\(|\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|getPool|new Pool|withTx|runInTx/);
    expect(s).toMatch(/ctx\.tx|ctx\)/);
  });

  it('never names frontdesk tables and never imports another module folder (02-CV §5.13); order existence goes through ctx.ports.FrontdeskPort', () => {
    const s = src();
    expect(s).not.toMatch(/frontdesk\.[a-z_]+/);
    expect(s).not.toMatch(/from\s+['"]\.\.\/\.\.\/(?!billing)[a-z]+\//);
    expect(s).toMatch(/FrontdeskPort/);
  });

  it('takes the tenant from ctx only: no tenant id / UUID literal in the implementation', () => {
    expect(src()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('billing manifest registers BillingCommandPort with all eight methods (TRD §6.3, PORT_OWNERS)', async () => {
    const { manifest } = await import('../../index.js');
    const port: any = (manifest.ports as any)?.BillingCommandPort;
    expect(port, 'manifest.ports.BillingCommandPort').toBeDefined();
    for (const m of ['computeQuote', 'assertCreditAllowed', 'issueOrderInvoice', 'recordCreditCharges', 'voidCreditCharges', 'recordPayment', 'raiseCreditNoteRequirement', 'getOrderBillingSummary']) {
      expect(typeof port[m], m).toBe('function');
    }
  });
});
