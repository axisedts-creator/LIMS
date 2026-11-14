// packages/fakes/contract-tests/BillingCommandPort.contract.ts — IC §4.15 contract cases (CV §8.4). Runs against the fake (C0)
// and the real C4 `billing` implementation. Fixture shape = BillingCommandFixtures (a real harness translates it).
import { describe, expect, it } from "vitest";
import type { ContractHarness } from "../src/harness";

const id = (n: number) => `01900000-0000-7000-8000-0000000c4${n.toString(16).padStart(3, "0")}`;
const O_NEW = id(1), O_INV = id(2), O_CHG = id(3), O_B = id(4);
const P_OK = id(0x11), P_LOCKED = id(0x12), P_NOCREDIT = id(0x13), P_LIMIT = id(0x14);
const CHG = id(0x21), PERIODIC_INV = id(0x22), ITEM = id(0x31);
const PL = id(0x41), BRANCH = id(0x42), CENTRE = id(0x43), PATIENT = id(0x44);

const npr = (amountPaisa: number) => ({ amountPaisa, currency: "NPR" as const });
const line = (ref: string, paisa: number, extra: object = {}) => ({
  lineRef: ref, orderableId: id(0x100 + ref.length), orderableKind: "test" as const, code: ref, name: `Synthetic ${ref}`, priority: "routine" as const,
  unitPrice: npr(paisa), tax: { vat: "taxable" as const, vatRateBp: 1300 }, priceListId: PL, priceListVersion: 1, priceSource: "tenant_default" as const, ...extra,
});
const LINES = [line("CBC", 50000), line("LFT", 120000, { priority: "urgent", urgentSurcharge: npr(20000) })];

async function rejects(p: Promise<unknown>, code: string, safeDetail?: string) {
  const e: any = await p.then(() => undefined, (x) => x);
  expect(e, `expected ${code}, call resolved`).toBeDefined();
  expect(e.code).toBe(code);
  if (safeDetail !== undefined) expect(e.safeDetail).toBe(safeDetail);
}

async function setup(makeImpl: () => Promise<ContractHarness>) {
  const h = await makeImpl();
  const tA = h.ctxFor("A").tenantId, tB = h.ctxFor("B").tenantId;
  const party = (pid: string, o: object) => ({ id: pid, tenantId: tA, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: null, outstandingPaisa: 0, ...o });
  await h.seed({
    orders: [{ id: O_NEW, tenantId: tA }, { id: O_INV, tenantId: tA }, { id: O_CHG, tenantId: tA }, { id: O_B, tenantId: tB }],
    invoices: [{ id: id(0x51), tenantId: tA, orderId: O_INV, purpose: "registration", invoiceNo: "2083/84-000900", fiscalYearBs: "2083/84",
      issuedAt: "2026-11-01T04:15:00.000Z", netPaisa: 100000, orderItemIds: [] }],
    creditParties: [party(P_OK, {}), party(P_LOCKED, { isLocked: true }), party(P_NOCREDIT, { allowsCredit: false }),
      party(P_LIMIT, { creditLimitPaisa: 100000, outstandingPaisa: 90000 })],
    creditCharges: [{ id: CHG, tenantId: tA, orderId: O_CHG, orderItemId: ITEM, creditPartyId: P_OK, amountPaisa: 50000,
      periodicInvoiceId: PERIODIC_INV, invoiceLineId: id(0x23), voided: false }],
  });
  return h;
}

const issueInput = (orderId: string, expectedFingerprint: string, purpose: "registration" | "supplementary" = "registration") => ({
  orderId, patientId: PATIENT, branchId: BRANCH, centreId: CENTRE, buyer: { name: "Test Patient 0042" }, lines: LINES, discounts: [], expectedFingerprint, purpose,
});
const pay = (orderId: string, paisa: number, captureKind: "manual" | "home_collection", idempotencyKey: string) => ({
  orderId, methodCode: "cash", amount: npr(paisa), captureKind, idempotencyKey, issueReceiptNo: false,
});

export function runBillingCommandPortContract(makeImpl: () => Promise<ContractHarness>, opts: { phase1Stub?: boolean } = {}): void {
  // No phase stub exists for BillingCommandPort (08 R9): the phase1Stub subset is empty.
  describe.skipIf(!!opts.phase1Stub)("BillingCommandPort contract (IC §4.15)", () => {
    it("(1) quote determinism (same input ⇒ same fingerprint)", async () => {
      const h = await setup(makeImpl);
      const a: any = await h.impl.computeQuote(h.ctxFor("A"), { lines: LINES, discounts: [] });
      const b: any = await h.impl.computeQuote(h.ctxFor("A"), { lines: LINES, discounts: [] });
      expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(b).toEqual(a);
      expect(a.lines.some((l: any) => l.lineKind === "urgent_surcharge")).toBe(true);
    });

    it("(2) fingerprint mismatch → common.version_conflict", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.issueOrderInvoice(h.ctxFor("A"), issueInput(O_NEW, "0".repeat(64))), "common.version_conflict");
    });

    it("(3) other-tenant order → common.not_found", async () => {
      const h = await setup(makeImpl);
      const q: any = await h.impl.computeQuote(h.ctxFor("A"), { lines: LINES, discounts: [] });
      await rejects(h.impl.issueOrderInvoice(h.ctxFor("A"), issueInput(O_B, q.fingerprint)), "common.not_found");
      await rejects(h.impl.getOrderBillingSummary(h.ctxFor("A"), { orderId: O_B }), "common.not_found");
    });

    it("(4) locked party → billing.credit_party_locked", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.assertCreditAllowed(h.ctxFor("A"), { creditPartyId: P_LOCKED, additional: npr(100) }), "billing.credit_party_locked");
      await expect(h.impl.assertCreditAllowed(h.ctxFor("A"), { creditPartyId: P_OK, additional: npr(100) })).resolves.toBeUndefined();
    });

    it("(5) limit → billing.credit_limit_exceeded", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.assertCreditAllowed(h.ctxFor("A"), { creditPartyId: P_LIMIT, additional: npr(10001) }), "billing.credit_limit_exceeded");
      await expect(h.impl.assertCreditAllowed(h.ctxFor("A"), { creditPartyId: P_LIMIT, additional: npr(10000) })).resolves.toBeUndefined();
    });

    it("(6) issue twice in one tx with same order+purpose registration → second throws common.validation_failed", async () => {
      const h = await setup(makeImpl);
      const ctx = h.ctxFor("A");
      const q: any = await h.impl.computeQuote(ctx, { lines: LINES, discounts: [] });
      const inv: any = await h.impl.issueOrderInvoice(ctx, issueInput(O_NEW, q.fingerprint));
      expect(inv.totals).toEqual(q.totals);
      expect(h.events.ofType("billing.invoice.issued.v1")).toHaveLength(1);
      await rejects(h.impl.issueOrderInvoice(ctx, issueInput(O_NEW, q.fingerprint)), "common.validation_failed");
      expect(h.events.ofType("billing.invoice.issued.v1")).toHaveLength(1);
    });

    it("(7) payment over due: manual → billing.payment_exceeds_due; home_collection → recorded with exceedsDue: true", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.recordPayment(h.ctxFor("A"), pay(O_INV, 150000, "manual", "pay-7-manual")), "billing.payment_exceeds_due");
      const r: any = await h.impl.recordPayment(h.ctxFor("A"), pay(O_INV, 150000, "home_collection", "pay-7-home"));
      expect(r).toMatchObject({ exceedsDue: true, duplicate: false });
      expect(typeof r.ledgerEntryId).toBe("string");
    });

    it("(8) same idempotencyKey → duplicate: true", async () => {
      const h = await setup(makeImpl);
      const a: any = await h.impl.recordPayment(h.ctxFor("A"), pay(O_INV, 40000, "manual", "pay-8"));
      const b: any = await h.impl.recordPayment(h.ctxFor("A"), pay(O_INV, 40000, "manual", "pay-8"));
      expect(a.duplicate).toBe(false);
      expect(b).toMatchObject({ duplicate: true, ledgerEntryId: a.ledgerEntryId });
      expect(b.balance.paid.amountPaisa).toBe(40000);
    });

    it("(9) raise requirement on order without invoice → required: false", async () => {
      const h = await setup(makeImpl);
      const r: any = await h.impl.raiseCreditNoteRequirement(h.ctxFor("A"), { orderId: O_NEW, cause: "order_cancelled", reasonCode: "patient_request" });
      expect(r).toEqual({ required: false, taskIds: [] });
    });

    it("(10) void charges after periodic invoicing → listed in alreadyInvoiced", async () => {
      const h = await setup(makeImpl);
      const r: any = await h.impl.voidCreditCharges(h.ctxFor("A"), { orderId: O_CHG, reasonCode: "item_removed" });
      expect(r.alreadyInvoiced).toEqual([CHG]);
      expect(r.voided).toBe(0);
    });

    it("(11) missing tax rate on a line → catalog.tax_config_missing", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.computeQuote(h.ctxFor("A"), { lines: [line("CBC", 50000, { tax: { vat: "taxable" } })], discounts: [] }), "catalog.tax_config_missing");
      await rejects(h.impl.computeQuote(h.ctxFor("A"), { lines: [line("CBC", 50000, { tax: { vat: "exempt", otherTaxCode: "HST" } })], discounts: [] }), "catalog.tax_config_missing");
    });

    it("(12) baseFingerprint equals the fingerprint of the same lines quoted with discounts: []", async () => {
      const h = await setup(makeImpl);
      const disc: any = await h.impl.computeQuote(h.ctxFor("A"), { lines: LINES, discounts: [{ scope: "bill", kind: "amount", amountPaisa: 10000 }] });
      const plain: any = await h.impl.computeQuote(h.ctxFor("A"), { lines: LINES, discounts: [] });
      expect(disc.baseFingerprint).toBe(plain.fingerprint);
      expect(disc.fingerprint).not.toBe(plain.fingerprint);
      expect(disc.totals.discount.amountPaisa).toBe(10000);
    });

    it("(13) raiseCreditNoteRequirement after (10) → required: true, task on the periodic invoice", async () => {
      const h = await setup(makeImpl);
      await h.impl.voidCreditCharges(h.ctxFor("A"), { orderId: O_CHG, reasonCode: "item_removed" });
      const r: any = await h.impl.raiseCreditNoteRequirement(h.ctxFor("A"), { orderId: O_CHG, cause: "order_cancelled", reasonCode: "item_removed" });
      expect(r.required).toBe(true);
      expect(r.taskIds).toHaveLength(1);
    });

    it("(14) credit party with allowsCredit = false → billing.credit_party_locked", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.assertCreditAllowed(h.ctxFor("A"), { creditPartyId: P_NOCREDIT, additional: npr(100) }), "billing.credit_party_locked");
    });

    it("(15) allocation across the FY boundary (injected clock) → billing.counter_busy with detail fiscal_year_rollover, no counter change", async () => {
      const h = await setup(makeImpl);
      const q: any = await h.impl.computeQuote(h.ctxFor("A"), { lines: LINES, discounts: [] });
      let reads = 0;                                   // first clock read before Shrawan 1 (synthetic FY start), later reads after it
      const now = () => (reads++ === 0 ? "2026-07-16T18:14:59.000Z" : "2026-07-16T18:15:01.000Z") as any;
      await rejects(h.impl.issueOrderInvoice(h.ctxFor("A", { now }), issueInput(O_NEW, q.fingerprint)), "billing.counter_busy", "fiscal_year_rollover");
      expect(h.events.ofType("billing.invoice.issued.v1")).toHaveLength(0);
      const s: any = await h.impl.getOrderBillingSummary(h.ctxFor("A"), { orderId: O_NEW });
      expect(s.hasIssuedInvoice).toBe(false);
      const retry: any = await h.impl.issueOrderInvoice(h.ctxFor("A"), issueInput(O_NEW, q.fingerprint));   // the caller's retry succeeds
      expect(retry.invoiceNo).toMatch(/0*1$/);         // counter untouched by the failed attempt: first number of the series
    });
  });
}
