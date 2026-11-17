// packages/fakes/src/BillingPort.fake.ts — BillingPort fake (IC §4.4; C0 TRD §5.4). Callers staff/system only (08 R8).
import type { BillingPort, OrderBalance, ReleaseEligibility } from "@lims/contracts/ports/BillingPort";
import { FIXED_NOW, TENANTS, err, forbidden, idFor, invalid, makeFake, notFound, requireStr, tenantOf, actorType, type FakeOpts } from "./base";

/** Programmable per-order balance (paisa). */
export interface BillingOrderRow {
  orderId: string; tenantId: string; invoicedPaisa: number; paidPaisa: number; creditedPaisa: number;
  hasInvoice: boolean; creditPartyId?: string; overrideId?: string; balanceVersion: number;
}
export interface BillingFixtures {
  settings: { tenantId: string; releaseRequiresPayment: boolean }[];
  orders: BillingOrderRow[];
  /** Intent amounts recorded by C15 (billing.amount_mismatch check). */
  intents: { intentId: string; tenantId: string; orderId: string; amountPaisa: number }[];
  ledger: { id: string; tenantId: string; orderId: string; kind: "payment" | "refund"; amountPaisa: number; key: string; captureKind: "gateway" }[];
  reviewItems: { id: string; tenantId: string; orderId: string; kind: string; ledgerEntryId: string }[];
}

function defaults(seed: number): BillingFixtures {
  const fx: BillingFixtures = { settings: [], orders: [], intents: [], ledger: [], reviewItems: [] };
  (["A", "B"] as const).forEach((k, i) => {
    const t = TENANTS[k];
    fx.settings.push({ tenantId: t, releaseRequiresPayment: true });
    fx.orders.push({ orderId: idFor(seed, 0x200 + i), tenantId: t, invoicedPaisa: 150000, paidPaisa: 0, creditedPaisa: 0, hasInvoice: true, balanceVersion: 1 });
  });
  return fx;
}

const money = (amountPaisa: number) => ({ amountPaisa, currency: "NPR" as const });

export function createFakeBillingPort(opts: FakeOpts<BillingFixtures>) {
  let cur: { reviewItems(ctx: any, orderId: string): string[]; ledgerRows(ctx: any, orderId: string): number };
  const fake = makeFake(defaults, opts, (s) => {
    const fx = s.fixtures;
    const guard = (ctx: any) => {
      const t = tenantOf(ctx);
      if (!["user", "system"].includes(actorType(ctx))) throw forbidden();   // 08 R8
      return t;
    };
    const orderOf = (t: string, orderId: unknown) => {
      const o = fx.orders.find((x) => x.orderId === orderId && x.tenantId === t);
      if (!o) throw notFound();
      return o;
    };
    const due = (o: BillingOrderRow) => o.invoicedPaisa - o.paidPaisa - o.creditedPaisa;
    const balance = (ctx: any, o: BillingOrderRow): OrderBalance => ({
      orderId: o.orderId as any, invoiced: money(o.invoicedPaisa), paid: money(o.paidPaisa), credited: money(o.creditedPaisa),
      balanceDue: money(due(o)), balanceVersion: o.balanceVersion, asOf: (ctx.now?.() ?? FIXED_NOW) as any,
    });
    const amountOf = (m: any) => {
      const a = m?.amountPaisa;
      if (!Number.isSafeInteger(a) || a <= 0 || m?.currency !== "NPR") throw invalid("amount_invalid");
      return a as number;
    };
    const publishBalance = async (ctx: any, o: BillingOrderRow) => {
      await s.events?.publish(ctx.tx, "billing.balance.changed.v1", {
        tenantId: o.tenantId, idempotencyKey: `billing.balance.changed:${o.orderId}:${o.balanceVersion}`, aggregate: { type: "order", id: o.orderId, seq: o.balanceVersion },
        payload: { order_id: o.orderId, balance_due_paisa: due(o), balance_version: o.balanceVersion },
      });
    };
    cur = {
      reviewItems: (ctx, orderId) => fx.reviewItems.filter((r) => r.tenantId === ctx.tenantId && r.orderId === orderId).map((r) => r.kind),
      ledgerRows: (ctx, orderId) => fx.ledger.filter((r) => r.tenantId === ctx.tenantId && r.orderId === orderId).length,
    };

    const methods: BillingPort = {
      async getReleaseEligibility(ctx, input) {
        const t = guard(ctx);
        const o = orderOf(t, input.orderId);
        const requires = fx.settings.find((x) => x.tenantId === t)?.releaseRequiresPayment ?? true;
        const d = due(o);
        const out = (eligible: boolean, basis: ReleaseEligibility["basis"], extra: object = {}): ReleaseEligibility =>
          ({ orderId: o.orderId as any, eligible, basis, balanceDue: money(d), evaluatedAt: (ctx.now?.() ?? FIXED_NOW) as any, ...extra });
        if (o.creditPartyId) return out(true, "credit_party");
        if (!o.hasInvoice) return out(!requires, requires ? "no_invoice" : "policy_not_enforced");   // [CONV]
        if (d <= 0) return out(true, o.paidPaisa > 0 ? "paid_in_full" : "zero_balance");
        if (o.overrideId) return out(true, "override", { overrideId: o.overrideId });
        if (!requires) return out(true, "policy_not_enforced");
        return out(false, "due_outstanding");
      },
      async recordGatewayPayment(ctx, input) {
        const t = guard(ctx);
        const key = `${requireStr(input.gateway)}:${requireStr(input.gatewayTxnRef)}`;
        const prior = fx.ledger.find((r) => r.tenantId === t && r.kind === "payment" && r.key === key);
        const o = orderOf(t, input.orderId);
        if (prior) return { ledgerEntryId: prior.id as any, duplicate: true, balance: balance(ctx, o) };
        const amount = amountOf(input.amount);
        const intent = fx.intents.find((x) => x.intentId === input.intentId && x.tenantId === t);
        if (intent && (intent.amountPaisa !== amount || intent.orderId !== o.orderId)) throw err("billing.amount_mismatch");
        const exceeds = amount > due(o);
        if (exceeds && input.allowExceedsDue !== true) throw err("billing.payment_exceeds_due");
        const row = { id: s.nextId(), tenantId: t, orderId: o.orderId, kind: "payment" as const, amountPaisa: amount, key, captureKind: "gateway" as const };
        fx.ledger.push(row);
        if (exceeds) fx.reviewItems.push({ id: s.nextId(), tenantId: t, orderId: o.orderId, kind: "gateway_payment_exceeds_due", ledgerEntryId: row.id });
        o.paidPaisa += amount;
        o.balanceVersion += 1;
        await publishBalance(ctx, o);
        return { ledgerEntryId: row.id as any, duplicate: false, balance: balance(ctx, o) };
      },
      async getOrderBalance(ctx, input) {
        const t = guard(ctx);
        return balance(ctx, orderOf(t, input.orderId));
      },
      async recordGatewayRefund(ctx, input) {
        const t = guard(ctx);
        const key = `gw_refund:${requireStr(input.refundId)}`;
        const o = orderOf(t, input.orderId);
        const prior = fx.ledger.find((r) => r.tenantId === t && r.kind === "refund" && r.key === key);
        if (prior) return { ledgerEntryId: prior.id as any, duplicate: true, balance: balance(ctx, o) };
        const amount = amountOf(input.amount);
        requireStr(input.approvedByMembershipId, "approval_required");
        const refundable = fx.ledger.filter((r) => r.tenantId === t && r.orderId === o.orderId).reduce((n, r) => n + (r.kind === "payment" ? r.amountPaisa : -r.amountPaisa), 0);
        if (amount > refundable) throw err("billing.ledger_reversal_invalid");
        const row = { id: s.nextId(), tenantId: t, orderId: o.orderId, kind: "refund" as const, amountPaisa: amount, key, captureKind: "gateway" as const };
        fx.ledger.push(row);
        o.paidPaisa -= amount;
        o.balanceVersion += 1;
        await publishBalance(ctx, o);
        return { ledgerEntryId: row.id as any, duplicate: false, balance: balance(ctx, o) };
      },
    };
    return methods;
  });
  /** Test hooks for the contract suite (`finance_review_items` kinds, ledger row count); not part of the port. */
  return Object.assign(fake, {
    __reviewItems: (ctx: any, orderId: string) => cur.reviewItems(ctx, orderId),
    __ledgerRows: (ctx: any, orderId: string) => cur.ledgerRows(ctx, orderId),
  });
}
