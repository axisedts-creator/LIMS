// packages/fakes/contract-tests/PaymentProviderPort.contract.ts — IC §4.9 contract cases (CV §8.4). Runs against the fake, the
// phase stub (`phase1Stub` subset: cases tagged [phase1Stub]) and the real C15 implementation (sandbox gateways).
// Ledger spy: the caller's ctx.ports.BillingPort (recordGatewayPayment / getOrderBalance). Alert spy: `impl.alerts` when the
// implementation exposes one [CONV].
import { beforeEach, describe, expect, it } from "vitest";
import type { ContractHarness } from "../src/harness";

type MakeImpl = () => Promise<ContractHarness>;
const id = (n: number) => `01900000-0000-7000-8000-0000000c15${n.toString(16).padStart(2, "0")}`;
const O1 = id(1), O_ZERO = id(2), O_SMALL = id(3), INTENT = id(4), APPROVAL = id(5);
const RETURN = "https://app.lims.test/pay/done", CANCEL = "https://app.lims.test/pay/cancel";
const DUE = 150000;

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e: any) { return e?.code ?? "non_lims_error"; }
}

/** Ledger spy standing in for BillingPort (one ledger row per (gateway, gatewayTxnRef), 04 P6). */
function ledgerSpy(dueByOrder: Record<string, number>) {
  const calls: any[] = [];
  const rows = () => new Set(calls.map((c) => `${c.gateway}:${c.gatewayTxnRef}`)).size;
  const balance = (orderId: string) => ({ orderId, invoiced: { amountPaisa: dueByOrder[orderId] ?? 0, currency: "NPR" }, paid: { amountPaisa: 0, currency: "NPR" },
    credited: { amountPaisa: 0, currency: "NPR" }, balanceDue: { amountPaisa: dueByOrder[orderId] ?? 0, currency: "NPR" }, balanceVersion: 1, asOf: "2026-11-05T04:15:00.000Z" });
  return {
    calls, rows,
    BillingPort: {
      async getOrderBalance(_c: unknown, i: { orderId: string }) { return balance(i.orderId); },
      async recordGatewayPayment(_c: unknown, i: any) {
        const duplicate = calls.some((c) => c.gateway === i.gateway && c.gatewayTxnRef === i.gatewayTxnRef);
        calls.push(i);
        return { ledgerEntryId: id(0x80 + rows()), duplicate, balance: balance(i.orderId) };
      },
      async recordGatewayRefund(_c: unknown, i: any) { return { ledgerEntryId: id(0xc0), duplicate: false, balance: balance(i.orderId) }; },
    },
  };
}

export function runPaymentProviderPortContract(makeImpl: MakeImpl, opts: { phase1Stub?: boolean } = {}): void {
  // Cases without the [phase1Stub] tag need C15 (Phase 1.5–2) and are skipped for the stub (every method → gateway_not_available).
  const full = (fn: () => Promise<void>) => async (t: { skip: () => void }) => { if (opts.phase1Stub) return t.skip(); await fn(); };

  describe("PaymentProviderPort contract (IC §4.9)", () => {
    let h: ContractHarness;
    let A: string;
    let spy: ReturnType<typeof ledgerSpy>;
    beforeEach(async () => {
      h = await makeImpl();
      A = h.ctxFor("A").tenantId;
      spy = ledgerSpy({ [O1]: DUE, [O_ZERO]: 0, [O_SMALL]: 999 });
    });
    const ctx = (now?: string) => h.ctxFor("A:system", { ports: { BillingPort: spy.BillingPort } as any, ...(now ? { now: () => now as any } : {}) });
    const seed = (gatewayStatus: string, extra: object = {}, gatewayAmountPaisa?: number) => h.seed({
      orders: [
        { id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus, ...(gatewayAmountPaisa !== undefined ? { gatewayAmountPaisa } : {}) },
        { id: O_ZERO, tenantId: A, dueAmountPaisa: 0 },
        { id: O_SMALL, tenantId: A, dueAmountPaisa: 999 },
      ],
      returnUrlHosts: ["app.lims.test"],
      ...extra,
    });
    const create = (gateway = "esewa", key = "chk-1", orderId = O1, c = ctx()) =>
      h.impl.createIntent(c, { orderId, gateway, idempotencyKey: key, returnUrl: RETURN, cancelUrl: CANCEL });
    const settled = () => h.events.ofType("payments.intent.settled.v1");
    /** An open intent created ~1 h before NOW (expiresAt 04:00Z) for time-window cases. */
    const seedOpen = (gateway: string, gatewayStatus: string, status = "pending") => seed(gatewayStatus, {
      intents: [{ id: INTENT, tenantId: A, orderId: O1, gateway, status, amountPaisa: DUE, refundedPaisa: 0, gatewayTxnRef: "SYN-TXN-0001",
                  idempotencyKey: "seeded-1", expiresAt: "2026-11-05T04:00:00.000Z" }],
    });
    const BEFORE_GRACE = "2026-11-05T04:05:00.000Z", AFTER_GRACE = "2026-11-05T06:00:00.000Z";

    it("(1) second open intent → payments.intent_open_exists", full(async () => {
      await seed("PENDING");
      await create("esewa", "chk-1");
      expect(await codeOf(create("esewa", "chk-2"))).toBe("payments.intent_open_exists");
    }));
    it("(2) replay same key → same intent", full(async () => {
      await seed("PENDING");
      const a = await create(), b = await create();
      expect(b.intentId).toBe(a.intentId);
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(true);
      expect(b.amount).toEqual({ amountPaisa: DUE, currency: "NPR" });
    }));
    it("(3) nothing due → payments.nothing_due", full(async () => {
      await seed("PENDING");
      expect(await codeOf(create("esewa", "chk-z", O_ZERO))).toBe("payments.nothing_due");
    }));
    it("(4) each settled status string → settled + ledger spy", full(async () => {
      for (const [gateway, raw] of [["esewa", "COMPLETE"], ["khalti", "Completed"]] as const) {
        h = await makeImpl();
        spy = ledgerSpy({ [O1]: DUE });
        await seed(raw);
        const i = await create(gateway);
        const v = await h.impl.verify(ctx(), { intentId: i.intentId });
        expect(v.status, raw).toBe("settled");
        expect(spy.calls).toHaveLength(1);
        expect(spy.calls[0]).toMatchObject({ intentId: i.intentId, orderId: O1, gateway, amount: { amountPaisa: DUE, currency: "NPR" } });
        expect(settled()).toHaveLength(1);
      }
    }));
    it("(5) each hold status → held_for_review, no ledger write; PENDING/NOT_FOUND/Initiated non-terminal until expires_at + grace", full(async () => {
      const holds = [["esewa", "AMBIGUOUS"], ["esewa", "AMBIGIOUS"], ["esewa", "FULL_REFUND"], ["esewa", "PARTIAL_REFUND"], ["esewa", "SOMETHING_NEW"],
                     ["khalti", "Pending"], ["khalti", "Refunded"], ["khalti", "Partially Refunded"], ["khalti", "Something New"]];
      for (const [gateway, raw] of holds) {
        h = await makeImpl(); spy = ledgerSpy({ [O1]: DUE });
        await seedOpen(gateway!, raw!);
        expect((await h.impl.verify(ctx(BEFORE_GRACE), { intentId: INTENT })).status, raw).toBe("held_for_review");
        expect(spy.calls, raw).toHaveLength(0);
        expect(settled(), raw).toHaveLength(0);
      }
      for (const [gateway, raw, after] of [["esewa", "PENDING", "held_for_review"], ["khalti", "Initiated", "held_for_review"], ["esewa", "NOT_FOUND", "expired"]]) {
        h = await makeImpl(); spy = ledgerSpy({ [O1]: DUE });
        await seedOpen(gateway!, raw!);
        expect((await h.impl.verify(ctx(BEFORE_GRACE), { intentId: INTENT })).status, raw).toBe("pending");
        expect((await h.impl.verify(ctx(AFTER_GRACE), { intentId: INTENT })).status, raw).toBe(after);
        expect(spy.calls, raw).toHaveLength(0);
      }
    }));
    it("(6) amount mismatch → held_for_review + alert spy", full(async () => {
      await seed("COMPLETE", {}, DUE - 100);
      const i = await create();
      expect((await h.impl.verify(ctx(), { intentId: i.intentId })).status).toBe("held_for_review");
      expect(spy.calls).toHaveLength(0);
      expect(settled()).toHaveLength(0);
      if ("alerts" in h.impl) expect((h.impl as any).alerts).toEqual([expect.objectContaining({ intentId: i.intentId })]);
    }));
    it("(7) eSewa code: 0 → status unchanged (retry)", full(async () => {
      await seed("code:0");
      const i = await create();
      const before = (await h.impl.getIntent(ctx(), { intentId: i.intentId })).status;
      expect((await h.impl.verify(ctx(), { intentId: i.intentId })).status).toBe(before);
      expect(spy.calls).toHaveLength(0);
    }));
    it("(8) refund > captured → payments.refund_exceeds_captured", full(async () => {
      await seed("COMPLETE");
      const i = await create();
      await h.impl.verify(ctx(), { intentId: i.intentId });
      expect(await codeOf(h.impl.refund(ctx(), { intentId: i.intentId, amount: { amountPaisa: DUE + 1, currency: "NPR" }, reasonCode: "duplicate_payment",
        idempotencyKey: "rf-1", approvalId: APPROVAL }))).toBe("payments.refund_exceeds_captured");
    }));
    it("(9) refund without approval → payments.refund_requires_approval", full(async () => {
      await seed("COMPLETE");
      const i = await create();
      await h.impl.verify(ctx(), { intentId: i.intentId });
      expect(await codeOf(h.impl.refund(ctx(), { intentId: i.intentId, amount: { amountPaisa: 100, currency: "NPR" }, reasonCode: "duplicate_payment",
        idempotencyKey: "rf-1" } as any))).toBe("payments.refund_requires_approval");
    }));
    it("(10) fonepay → payments.gateway_not_available while B8 open [phase1Stub]", async () => {
      await seed("COMPLETE");
      expect(await codeOf(create("fonepay"))).toBe("payments.gateway_not_available");
    });
    it("(11) verify twice after settle → one ledger entry", full(async () => {
      await seed("COMPLETE");
      const i = await create();
      expect((await h.impl.verify(ctx(), { intentId: i.intentId })).status).toBe("settled");
      expect((await h.impl.verify(ctx(), { intentId: i.intentId })).status).toBe("settled");
      expect(spy.rows()).toBe(1);
      expect(settled()).toHaveLength(1);
    }));
    it("(12) getIntent returns action only while open", full(async () => {
      await seed("COMPLETE");
      const i = await create();
      expect((await h.impl.getIntent(ctx(), { intentId: i.intentId })).action).toBeDefined();
      await h.impl.verify(ctx(), { intentId: i.intentId });
      const g = await h.impl.getIntent(ctx(), { intentId: i.intentId });
      expect(g.status).toBe("settled");
      expect(g.action).toBeUndefined();
    }));
    it("(13) cancelIntent on an intent the gateway reports paid → settled", full(async () => {
      await seed("COMPLETE");
      const i = await create();
      expect((await h.impl.cancelIntent(ctx(), { intentId: i.intentId, reasonCode: "user_cancelled" })).status).toBe("settled");
      expect(spy.calls).toHaveLength(1);
    }));
    it("(14) eSewa NOT_FOUND after deadline → expired", full(async () => {
      await seedOpen("esewa", "NOT_FOUND");
      expect((await h.impl.verify(ctx(AFTER_GRACE), { intentId: INTENT })).status).toBe("expired");
    }));
    it("(15) return URL off-allowlist → payments.return_url_not_allowed", full(async () => {
      await seed("PENDING");
      expect(await codeOf(h.impl.createIntent(ctx(), { orderId: O1, gateway: "esewa", idempotencyKey: "chk-u",
        returnUrl: "https://attacker.invalid/steal", cancelUrl: CANCEL }))).toBe("payments.return_url_not_allowed");
    }));
    it("(16) Khalti due 999 paisa → payments.amount_not_supported", full(async () => {
      await seed("Initiated");
      expect(await codeOf(create("khalti", "chk-k", O_SMALL))).toBe("payments.amount_not_supported");
    }));
    it("(17) late success on expired → held_for_review", full(async () => {
      await seedOpen("esewa", "COMPLETE", "expired");
      expect((await h.impl.verify(ctx(AFTER_GRACE), { intentId: INTENT })).status).toBe("held_for_review");
      expect(spy.calls).toHaveLength(0);
    }));
    it("(18) refund replay same key → same refund, replayed: true", full(async () => {
      await seed("COMPLETE");
      const i = await create();
      await h.impl.verify(ctx(), { intentId: i.intentId });
      const input = { intentId: i.intentId, amount: { amountPaisa: 5000, currency: "NPR" }, reasonCode: "duplicate_payment", idempotencyKey: "rf-1", approvalId: APPROVAL };
      const a = await h.impl.refund(ctx(), input), b = await h.impl.refund(ctx(), input);
      expect(b.refundId).toBe(a.refundId);
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(true);
    }));
  });
}
