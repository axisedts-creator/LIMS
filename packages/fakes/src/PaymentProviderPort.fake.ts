// packages/fakes/src/PaymentProviderPort.fake.ts — C15 PaymentProviderPort fake (IC §4.9), sandbox mode.
// The gateway's answer for an order is `orders[].gatewayStatus` (eSewa: PENDING/COMPLETE/FULL_REFUND/PARTIAL_REFUND/AMBIGUOUS/
// AMBIGIOUS/NOT_FOUND/CANCELED/`code:0`; Khalti: Completed/Pending/Initiated/Refunded/Partially Refunded/User canceled/Expired/
// anything else = unknown) and `orders[].gatewayAmountPaisa` (amount-mismatch scenario). Fonepay is BLOCKED B8 →
// payments.gateway_not_available. On settle the fake calls `ctx.ports.BillingPort.recordGatewayPayment` (when the caller
// provides one — the ledger spy) and publishes `payments.intent.settled.v1`. Amount mismatches are appended to `alerts`.
import type { PaymentProviderPort, Gateway, IntentStatus, IntentAction } from "@lims/contracts/ports/PaymentProviderPort";
import {
  TENANT_A, TENANT_B, checkIdempotencyKey, err, forbidden, idFor, invalid, isStaffOrSystem, makeFake, notFound, nowOf, tenantOf,
  type FakeOpts,
} from "./base";

export interface PaymentOrderFixture { id: string; tenantId: string; dueAmountPaisa: number; gatewayStatus?: string; gatewayAmountPaisa?: number }
export interface PaymentIntentFixture {
  id: string; tenantId: string; orderId: string; gateway: Gateway; status: IntentStatus; amountPaisa: number; refundedPaisa: number;
  gatewayTxnRef: string; idempotencyKey?: string; expiresAt?: string; settledAt?: string;
}
export interface PaymentFixtures {
  orders: PaymentOrderFixture[];
  intents: PaymentIntentFixture[];
  /** Allowed return/cancel URL hosts (https only). */
  returnUrlHosts: string[];
  intentTtlSeconds: number;       // [CONV] fake value
  graceSeconds: number;           // expires_at + grace (CR-C15-001) [CONV] fake value
  khaltiMinAmountPaisa: number;   // [CONV] fake value: 999 paisa is below it (IC §4.9 case 16)
}
export interface PaymentAlert { intentId: string; kind: "amount_mismatch"; expectedPaisa: number; verifiedPaisa: number }

const defaults = (seed: number): PaymentFixtures => ({
  orders: [
    { id: idFor(seed, 0x10), tenantId: TENANT_A, dueAmountPaisa: 150000, gatewayStatus: "COMPLETE" },
    { id: idFor(seed, 0x11), tenantId: TENANT_B, dueAmountPaisa: 80000, gatewayStatus: "Completed" },
    { id: idFor(seed, 0x12), tenantId: TENANT_A, dueAmountPaisa: 0 },
  ],
  intents: [],
  returnUrlHosts: ["app.lims.test", "portal.invalid"],
  intentTtlSeconds: 900,
  graceSeconds: 600,
  khaltiMinAmountPaisa: 1000,
});

const OPEN: IntentStatus[] = ["created", "initiated", "pending"];
const money = (amountPaisa: number) => ({ amountPaisa, currency: "NPR" as const });
const ms = (iso: string) => Date.parse(iso);
type Outcome = "success" | "unchanged" | IntentStatus;

function outcomeOf(gateway: Gateway, raw: string | undefined, deadlinePassed: boolean): Outcome {
  if (gateway === "esewa") {
    if (raw === "COMPLETE") return "success";
    if (raw === "code:0" || raw === undefined) return "unchanged";            // service unavailable → retry, not failure
    if (raw === "PENDING") return deadlinePassed ? "held_for_review" : "unchanged";
    if (raw === "NOT_FOUND") return deadlinePassed ? "expired" : "unchanged";
    if (raw === "CANCELED") return "failed";
    return "held_for_review";                                                   // AMBIGUOUS/AMBIGIOUS/FULL_REFUND/PARTIAL_REFUND/unknown
  }
  if (raw === "Completed") return "success";
  if (raw === "Initiated" || raw === undefined) return deadlinePassed ? "held_for_review" : "unchanged";
  if (raw === "User canceled") return "failed";
  if (raw === "Expired") return "expired";
  return "held_for_review";                                                     // Pending/Refunded/Partially Refunded/unknown
}

export function createFakePaymentProviderPort(opts: FakeOpts<PaymentFixtures>) {
  let alerts: PaymentAlert[] = [];
  const fake = makeFake(defaults, opts, ({ fixtures, events, nextId }) => {
    const intents = fixtures.intents;
    const refunds: { refundId: string; tenantId: string; key: string; status: "completed" }[] = [];
    alerts = [];

    const guard = (ctx: any) => { const t = tenantOf(ctx); if (!isStaffOrSystem(ctx)) throw forbidden(); return t; };  // 08 R8
    const findIntent = (tenantId: string, id: unknown) => {
      const i = intents.find((x) => x.tenantId === tenantId && x.id === id);
      if (!i) throw notFound();
      return i;
    };
    const order = (i: PaymentIntentFixture) => fixtures.orders.find((o) => o.tenantId === i.tenantId && o.id === i.orderId);
    const actionOf = (i: PaymentIntentFixture): IntentAction => i.gateway === "esewa"
      ? { kind: "form_post", url: "https://esewa.sandbox.invalid/api/epay/main/v2/form",
          fields: { amount: String(i.amountPaisa / 100), transaction_uuid: i.gatewayTxnRef, product_code: "EPAYTEST" } }
      : { kind: "redirect", url: `https://khalti.sandbox.invalid/pay/${i.gatewayTxnRef}` };

    async function settle(ctx: any, i: PaymentIntentFixture, amountPaisa: number) {
      i.status = "settled";
      i.settledAt = nowOf(ctx);
      const bp = ctx.ports?.BillingPort;
      let ledgerEntryId: string | undefined;
      if (bp && typeof bp.recordGatewayPayment === "function") {
        ledgerEntryId = (await bp.recordGatewayPayment(ctx, {
          intentId: i.id, orderId: i.orderId, gateway: i.gateway, gatewayTxnRef: i.gatewayTxnRef, amount: money(amountPaisa), verifiedAt: i.settledAt,
        }))?.ledgerEntryId;
      }
      await events?.publish(ctx.tx, "payments.intent.settled.v1", {
        tenantId: i.tenantId, idempotencyKey: `payments.intent.settled.v1:${i.id}`, aggregate: { type: "payment_intent", id: i.id },
        payload: {
          intent_id: i.id, order_id: i.orderId, gateway: i.gateway, gateway_txn_ref: i.gatewayTxnRef, amount: { amount_paisa: amountPaisa, currency: "NPR" },
          verified_at: i.settledAt, verification_method: i.gateway === "esewa" ? "esewa_status_check" : "khalti_lookup",
          ...(ledgerEntryId ? { ledger_entry_id: ledgerEntryId } : {}),
        },
      });
    }

    async function doVerify(ctx: any, i: PaymentIntentFixture) {
      if (i.gateway === "fonepay") throw err("payments.gateway_not_available");
      const o = order(i);
      const raw = o?.gatewayStatus;
      const passed = i.expiresAt !== undefined && ms(nowOf(ctx)) > ms(i.expiresAt) + fixtures.graceSeconds * 1000;
      const out = outcomeOf(i.gateway, raw, passed);
      const verifiedPaisa = o?.gatewayAmountPaisa ?? i.amountPaisa;
      if (OPEN.includes(i.status)) {
        if (out === "success") {
          if (verifiedPaisa !== i.amountPaisa) {
            i.status = "held_for_review";
            alerts.push({ intentId: i.id, kind: "amount_mismatch", expectedPaisa: i.amountPaisa, verifiedPaisa });
          } else await settle(ctx, i, verifiedPaisa);
        } else if (out !== "unchanged") i.status = out;
      } else if (i.status === "expired" && out === "success") i.status = "held_for_review";   // late success (case 17)
      return { intentId: i.id, status: i.status, ...(raw !== undefined ? { gatewayStatusRaw: raw } : {}),
               ...(out === "success" ? { verifiedAmount: money(verifiedPaisa) } : {}) };
    }

    const port: PaymentProviderPort = {
      async createIntent(ctx, input) {
        const tenantId = guard(ctx);
        checkIdempotencyKey(input.idempotencyKey);                        // P-40 / A22.0
        if (!["esewa", "khalti", "fonepay"].includes(input.gateway)) throw invalid("gateway");
        if (input.gateway === "fonepay") throw err("payments.gateway_not_available");      // B8 open
        const prior = intents.find((x) => x.tenantId === tenantId && x.idempotencyKey === input.idempotencyKey);
        if (prior) return { intentId: prior.id, gateway: prior.gateway, amount: money(prior.amountPaisa), action: actionOf(prior),
                            ...(prior.expiresAt ? { expiresAt: prior.expiresAt as any } : {}), replayed: true };
        const o = fixtures.orders.find((x) => x.tenantId === tenantId && x.id === input.orderId);
        if (!o) throw notFound();
        for (const u of [input.returnUrl, input.cancelUrl]) {
          let ok = false;
          try { const url = new URL(u); ok = url.protocol === "https:" && fixtures.returnUrlHosts.includes(url.hostname); } catch { ok = false; }
          if (!ok) throw err("payments.return_url_not_allowed");
        }
        if (o.dueAmountPaisa <= 0) throw err("payments.nothing_due");
        if (input.gateway === "khalti" && o.dueAmountPaisa < fixtures.khaltiMinAmountPaisa) throw err("payments.amount_not_supported");
        if (intents.some((x) => x.tenantId === tenantId && x.orderId === o.id && OPEN.includes(x.status))) throw err("payments.intent_open_exists");
        const id = nextId();
        const i: PaymentIntentFixture = {
          id, tenantId, orderId: o.id, gateway: input.gateway, status: "initiated", amountPaisa: o.dueAmountPaisa, refundedPaisa: 0,
          gatewayTxnRef: `SYN-${id.slice(-12)}`, idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(ms(nowOf(ctx)) + fixtures.intentTtlSeconds * 1000).toISOString(),
        };
        intents.push(i);
        return { intentId: i.id, gateway: i.gateway, amount: money(i.amountPaisa), action: actionOf(i), expiresAt: i.expiresAt as any, replayed: false };
      },

      async verify(ctx, input) {
        return doVerify(ctx, findIntent(guard(ctx), input.intentId)) as any;
      },

      async refund(ctx, input) {
        const tenantId = guard(ctx);
        checkIdempotencyKey(input.idempotencyKey);                        // P-40 / A22.0
        const prior = refunds.find((r) => r.tenantId === tenantId && r.key === input.idempotencyKey);
        if (prior) return { refundId: prior.refundId, status: prior.status, replayed: true };
        if (typeof input.approvalId !== "string" || !input.approvalId) throw err("payments.refund_requires_approval");
        const amt = input.amount?.amountPaisa;
        if (!Number.isSafeInteger(amt) || amt <= 0 || input.amount.currency !== "NPR") throw invalid("amount");
        const i = findIntent(tenantId, input.intentId);
        if (i.gateway === "fonepay") throw err("payments.gateway_not_available");
        if (!["settled", "partially_refunded"].includes(i.status)) throw err("payments.refund_not_allowed");
        if (amt > i.amountPaisa - i.refundedPaisa) throw err("payments.refund_exceeds_captured");
        i.refundedPaisa += amt;
        i.status = i.refundedPaisa === i.amountPaisa ? "refunded" : "partially_refunded";
        const r = { refundId: nextId(), tenantId, key: input.idempotencyKey, status: "completed" as const };
        refunds.push(r);
        const bp = (ctx as any).ports?.BillingPort;
        if (bp && typeof bp.recordGatewayRefund === "function") {
          await bp.recordGatewayRefund(ctx, { refundId: r.refundId, intentId: i.id, orderId: i.orderId, gateway: i.gateway, gatewayTxnRef: i.gatewayTxnRef,
            amount: money(amt), reasonCode: input.reasonCode, approvedByMembershipId: input.approvalId, refundedAt: nowOf(ctx) });
        }
        return { refundId: r.refundId, status: r.status, replayed: false };
      },

      async getIntent(ctx, input) {
        const i = findIntent(guard(ctx), input.intentId);
        return {
          intentId: i.id, orderId: i.orderId, gateway: i.gateway, status: i.status, amount: money(i.amountPaisa), refundedAmount: money(i.refundedPaisa),
          ...(i.expiresAt ? { expiresAt: i.expiresAt } : {}), ...(i.settledAt ? { settledAt: i.settledAt } : {}),
          ...(OPEN.includes(i.status) ? { action: actionOf(i) } : {}),
        } as any;
      },

      async cancelIntent(ctx, input) {
        const i = findIntent(guard(ctx), input.intentId);
        if (!OPEN.includes(i.status)) throw err("payments.intent_invalid_transition");
        await doVerify(ctx, i);                                             // verifies first; settles instead if paid
        if (OPEN.includes(i.status)) i.status = "failed";                   // [CONV] no 'cancelled' IntentStatus
        return { intentId: i.id, status: i.status };
      },
    };
    return port;
  });
  Object.defineProperty(fake, "alerts", { get: () => alerts, enumerable: false });
  return fake as typeof fake & { readonly alerts: readonly PaymentAlert[] };
}
