// packages/fakes/contract-tests/BillingPort.contract.ts — IC §4.4 case list (CV §8.4). Runs against the fake (C0) and C4.
// Harness extensions [CONV]: `impl.__ledgerRows(ctx, orderId)` (count of ledger rows) and `impl.__reviewItems(ctx, orderId)`
// (`finance_review_items` kinds). A real-impl harness wires both to SQL reads.
import { beforeEach, describe, expect, it } from "vitest";

type Harness = { impl: any; seed(f: object): Promise<void>; ctxFor(k: string, over?: object): any; events: any; rollback(tx: unknown): void };
const id = (n: number) => `01900000-0000-7000-8000-0000000b1${n.toString(16).padStart(3, "0")}`;
const A = "01900000-0000-7000-8000-00000000000a";
const B = "01900000-0000-7000-8000-00000000000b";
const O_ZERO = id(1), O_DUE = id(2), O_CREDIT = id(3), O_OVR = id(4), O_B = id(5), O_PAID = id(6), INTENT = id(10), OVR = id(20);
const npr = (amountPaisa: number) => ({ amountPaisa, currency: "NPR" });

async function lims(p: Promise<unknown>, code: string) {
  let e: any;
  try { await p; } catch (x) { e = x; }
  expect(e, `expected ${code}, call resolved`).toBeDefined();
  expect(e.code).toBe(code);
}
const row = (orderId: string, tenantId: string, invoicedPaisa: number, paidPaisa = 0, extra: object = {}) =>
  ({ orderId, tenantId, invoicedPaisa, paidPaisa, creditedPaisa: 0, hasInvoice: true, balanceVersion: 1, ...extra });

export function runBillingPortContract(makeImpl: () => Promise<Harness>, _opts: { phase1Stub?: boolean } = {}): void {
  let h: Harness;
  const fixtures = (releaseRequiresPayment = true) => ({
    settings: [{ tenantId: A, releaseRequiresPayment }],
    orders: [row(O_ZERO, A, 0), row(O_DUE, A, 100000), row(O_CREDIT, A, 100000, 0, { creditPartyId: id(30) }),
      row(O_OVR, A, 100000, 0, { overrideId: OVR }), row(O_B, B, 100000), row(O_PAID, A, 100000, 100000)],
    intents: [{ intentId: INTENT, tenantId: A, orderId: O_DUE, amountPaisa: 40000 }],
  });
  beforeEach(async () => { h = await makeImpl(); await h.seed(fixtures()); });
  const sys = () => h.ctxFor("A:system");
  const pay = (over: object = {}) => ({ intentId: INTENT, orderId: O_DUE, gateway: "esewa", gatewayTxnRef: "TXN-0001", amount: npr(40000),
    verifiedAt: "2026-11-05T04:15:00.000Z", ...over });
  const refund = (over: object = {}) => ({ refundId: id(40), intentId: INTENT, orderId: O_DUE, gateway: "esewa", gatewayTxnRef: "TXN-0001",
    amount: npr(10000), reasonCode: "duplicate_payment", approvedByMembershipId: id(41), refundedAt: "2026-11-05T04:15:00.000Z", ...over });
  const hook = (name: string) => {
    const f = h.impl[name] ?? (h as any)[name];
    if (typeof f !== "function") throw new Error(`harness lacks ${name}`);
    return f.bind(h.impl);
  };

  describe("BillingPort contract (IC §4.4)", () => {
    it("(1) zero balance → eligible `zero_balance`", async () => {
      await expect(h.impl.getReleaseEligibility(sys(), { orderId: O_ZERO })).resolves.toMatchObject({ orderId: O_ZERO, eligible: true, basis: "zero_balance", balanceDue: npr(0) });
      await expect(h.impl.getReleaseEligibility(sys(), { orderId: O_PAID })).resolves.toMatchObject({ eligible: true, basis: "paid_in_full" });
    });
    it("(2) due outstanding + setting on → not eligible `due_outstanding`", async () => {
      await expect(h.impl.getReleaseEligibility(sys(), { orderId: O_DUE })).resolves.toMatchObject({ eligible: false, basis: "due_outstanding", balanceDue: npr(100000) });
    });
    it("(3) setting off → eligible `policy_not_enforced`", async () => {
      await h.seed(fixtures(false));
      await expect(h.impl.getReleaseEligibility(sys(), { orderId: O_DUE })).resolves.toMatchObject({ eligible: true, basis: "policy_not_enforced" });
    });
    it("(4) credit party → eligible `credit_party`", async () => {
      await expect(h.impl.getReleaseEligibility(sys(), { orderId: O_CREDIT })).resolves.toMatchObject({ eligible: true, basis: "credit_party" });
    });
    it("(5) override present → eligible `override` with id", async () => {
      await expect(h.impl.getReleaseEligibility(h.ctxFor("A"), { orderId: O_OVR })).resolves.toMatchObject({ eligible: true, basis: "override", overrideId: OVR });
    });
    it("(6) recordGatewayPayment twice → one ledger row, second `duplicate: true`", async () => {
      const a = await h.impl.recordGatewayPayment(sys(), pay());
      const b = await h.impl.recordGatewayPayment(sys(), pay());
      expect(a.duplicate).toBe(false);
      expect(b).toMatchObject({ ledgerEntryId: a.ledgerEntryId, duplicate: true });
      expect(b.balance.paid).toEqual(npr(40000));
      expect(await hook("__ledgerRows")(sys(), O_DUE)).toBe(1);
    });
    it("(7) amount mismatch → `billing.amount_mismatch`", async () => {
      await lims(h.impl.recordGatewayPayment(sys(), pay({ amount: npr(39999) })), "billing.amount_mismatch");
    });
    it("(8) overpayment → `billing.payment_exceeds_due`", async () => {
      await lims(h.impl.recordGatewayPayment(sys(), pay({ intentId: id(11), orderId: O_DUE, amount: npr(100001) })), "billing.payment_exceeds_due");
      expect(await hook("__ledgerRows")(sys(), O_DUE)).toBe(0);
    });
    it("(9) other tenant's order → not_found", async () => {
      await lims(h.impl.getReleaseEligibility(sys(), { orderId: O_B }), "common.not_found");
      await lims(h.impl.getOrderBalance(sys(), { orderId: O_B }), "common.not_found");
      await lims(h.impl.recordGatewayPayment(sys(), pay({ intentId: id(12), orderId: O_B })), "common.not_found");
    });
    it("(10) balanceVersion strictly increases after each recorded payment", async () => {
      const v0 = (await h.impl.getOrderBalance(sys(), { orderId: O_DUE })).balanceVersion;
      const a = await h.impl.recordGatewayPayment(sys(), pay());
      const b = await h.impl.recordGatewayPayment(sys(), pay({ intentId: id(13), gatewayTxnRef: "TXN-0002", amount: npr(1000) }));
      expect(a.balance.balanceVersion).toBeGreaterThan(v0);
      expect(b.balance.balanceVersion).toBeGreaterThan(a.balance.balanceVersion);
      expect(b.balance.balanceDue).toEqual(npr(59000));
    });
    it("(11) refund idempotent", async () => {
      await h.impl.recordGatewayPayment(sys(), pay());
      const a = await h.impl.recordGatewayRefund(sys(), refund());
      const b = await h.impl.recordGatewayRefund(sys(), refund());
      expect(a.duplicate).toBe(false);
      expect(b).toMatchObject({ ledgerEntryId: a.ledgerEntryId, duplicate: true });
      expect(b.balance.paid).toEqual(npr(30000));
    });
    it("(12) refund > refundable → `billing.ledger_reversal_invalid`", async () => {
      await h.impl.recordGatewayPayment(sys(), pay());
      await lims(h.impl.recordGatewayRefund(sys(), refund({ amount: npr(40001) })), "billing.ledger_reversal_invalid");
    });
    it("(13) `allowExceedsDue` records + review item", async () => {
      const r = await h.impl.recordGatewayPayment(sys(), pay({ intentId: id(14), amount: npr(120000), allowExceedsDue: true }));
      expect(r.duplicate).toBe(false);
      expect(r.balance.paid).toEqual(npr(120000));
      expect(await hook("__reviewItems")(sys(), O_DUE)).toContain("gateway_payment_exceeds_due");
    });
    it("(14) patient/portal actor → `auth.forbidden`", async () => {
      for (const k of ["A:patient", "A:portal"]) {
        await lims(h.impl.getReleaseEligibility(h.ctxFor(k), { orderId: O_DUE }), "auth.forbidden");
        await lims(h.impl.getOrderBalance(h.ctxFor(k), { orderId: O_DUE }), "auth.forbidden");
        await lims(h.impl.recordGatewayPayment(h.ctxFor(k), pay()), "auth.forbidden");
        await lims(h.impl.recordGatewayRefund(h.ctxFor(k), refund()), "auth.forbidden");
      }
    });
  });
}
