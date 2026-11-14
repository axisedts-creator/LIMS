// packages/fakes/src/BillingCommandPort.fake.ts — fake of IC §4.15 (owner C4 `billing`; consumer `frontdesk` only).
import type { BillingCommandPort } from "@lims/contracts/ports/BillingCommandPort";
import {
  TENANT_A, TENANT_B, checkIdempotencyKey, err, idFor, invalid, makeFake, notFound, nowOf, requireStr, sha256Hex, stableJson, tenantOf,
  type FakeOpts,
} from "./base";

export interface BillingCommandFixtures {
  /** Fiscal years by start instant (synthetic [CONV]); allocation reads the clock at start and at allocation (08 A13 D-25). */
  fiscalYears: { code: string; startsAt: string }[];
  orders: { id: string; tenantId: string }[];
  invoices: { id: string; tenantId: string; orderId: string; purpose: "registration" | "supplementary" | "periodic"; invoiceNo: string;
    fiscalYearBs: string; issuedAt: string; netPaisa: number; orderItemIds: string[] }[];
  creditParties: { id: string; tenantId: string; allowsCredit: boolean; isActive: boolean; isLocked: boolean; creditLimitPaisa: number | null; outstandingPaisa: number }[];
  creditCharges: { id: string; tenantId: string; orderId: string; orderItemId: string | null; creditPartyId: string; amountPaisa: number;
    periodicInvoiceId: string | null; invoiceLineId: string | null; voided: boolean }[];
  payments: { id: string; tenantId: string; orderId: string; amountPaisa: number }[];
}

const defaults = (seed: number): BillingCommandFixtures => ({
  fiscalYears: [
    { code: "2082/83", startsAt: "2025-07-16T18:15:00.000Z" },
    { code: "2083/84", startsAt: "2026-07-16T18:15:00.000Z" },
  ],
  orders: [
    { id: idFor(seed, 0x401), tenantId: TENANT_A },
    { id: idFor(seed, 0x402), tenantId: TENANT_B },
  ],
  invoices: [],
  creditParties: [
    { id: idFor(seed, 0x411), tenantId: TENANT_A, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: 1_000_000, outstandingPaisa: 0 },
  ],
  creditCharges: [],
  payments: [],
});

const money = (amountPaisa: number) => ({ amountPaisa, currency: "NPR" as const });
const TOTAL_KEYS = ["gross", "discount", "exempt", "taxable", "vat", "otherTax", "net"] as const;
const intOk = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** Pure quote (C4 rules belong to C4; fake rounding is half-up per line [CONV]). */
async function compute(lines: any, discounts: any) {
  if (!Array.isArray(lines) || !Array.isArray(discounts)) throw invalid("lines_and_discounts_required");
  const rows: { l: any; kind: "orderable" | "urgent_surcharge"; gross: number }[] = [];
  for (const l of lines) {
    if (!l || !intOk(l.unitPrice?.amountPaisa)) throw invalid("unit_price_invalid");
    if (l.tax?.vat === "taxable" && l.tax.vatRateBp === undefined) throw err("catalog.tax_config_missing");
    if (l.tax?.otherTaxCode && l.tax.otherTaxRateBp === undefined) throw err("catalog.tax_config_missing");
    rows.push({ l, kind: "orderable", gross: l.unitPrice.amountPaisa });
    if (l.priority === "urgent" && l.urgentSurcharge) {
      if (!intOk(l.urgentSurcharge.amountPaisa)) throw invalid("urgent_surcharge_invalid");
      rows.push({ l, kind: "urgent_surcharge", gross: l.urgentSurcharge.amountPaisa });
    }
  }
  const disc = rows.map(() => 0);
  for (const d of discounts) {
    const targets = rows.map((r, i) => (d.scope === "bill" || (d.scope === "line" && r.kind === "orderable" && r.l.lineRef === d.lineRef) ? i : -1)).filter((i) => i >= 0);
    if (!targets.length) throw invalid("discount_target_unknown");
    const base = targets.reduce((s, i) => s + rows[i]!.gross - disc[i]!, 0);
    const amt = d.kind === "amount" ? d.amountPaisa : d.kind === "percent" && intOk(d.percentBp) && d.percentBp <= 10000 ? Math.floor((base * d.percentBp) / 10000) : NaN;
    if (!intOk(amt) || amt > base) throw invalid("discount_invalid");
    let left = amt;
    targets.forEach((i, k) => {
      const share = k === targets.length - 1 ? left : base === 0 ? 0 : Math.floor((amt * (rows[i]!.gross - disc[i]!)) / base);
      disc[i]! += share; left -= share;
    });
  }
  const computed = rows.map((r, i) => {
    const after = r.gross - disc[i]!;
    const taxable = r.l.tax?.vat === "taxable" ? after : 0;
    const vat = taxable ? Math.round((taxable * r.l.tax.vatRateBp) / 10000) : 0;
    const otherTax = r.l.tax?.otherTaxCode ? Math.round((after * r.l.tax.otherTaxRateBp) / 10000) : 0;
    return { ...r.l, lineKind: r.kind, gross: money(r.gross), discount: money(disc[i]!), exempt: money(after - taxable), taxable: money(taxable),
      vat: money(vat), otherTax: money(otherTax), ...(r.l.tax?.otherTaxCode ? { otherTaxCode: r.l.tax.otherTaxCode } : {}), net: money(after + vat + otherTax) };
  });
  const totals: any = {};
  for (const k of TOTAL_KEYS) totals[k] = money(computed.reduce((s, c: any) => s + c[k].amountPaisa, 0));
  const fingerprint = await sha256Hex(stableJson({ lines: computed, discounts, totals }));
  return { lines: computed, totals, fingerprint };
}

export function createFakeBillingCommandPort(opts: FakeOpts<BillingCommandFixtures>) {
  return makeFake<BillingCommandFixtures, BillingCommandPort>(defaults, opts, ({ fixtures: f, nextId, events }) => {
    const counters = new Map<string, number>();
    const idem = new Map<string, any>();
    const balanceVersion = new Map<string, number>();
    const fyOf = (iso: string) => {
      const fy = [...f.fiscalYears].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).filter((y) => y.startsAt <= iso).at(-1);
      if (!fy) throw err("billing.fiscal_year_closed");
      return fy.code;
    };
    const order = (t: string, id: unknown) => {
      const o = f.orders.find((x) => x.tenantId === t && x.id === id);
      if (!o) throw notFound();
      return o;
    };
    const balance = (t: string, orderId: string, asOf: string) => {
      const invoiced = f.invoices.filter((i) => i.tenantId === t && i.orderId === orderId).reduce((s, i) => s + i.netPaisa, 0);
      const paid = f.payments.filter((p) => p.tenantId === t && p.orderId === orderId).reduce((s, p) => s + p.amountPaisa, 0);
      return { orderId, invoiced: money(invoiced), paid: money(paid), credited: money(0), balanceDue: money(Math.max(0, invoiced - paid)),
        balanceVersion: balanceVersion.get(`${t}:${orderId}`) ?? 0, asOf } as any;
    };
    const bump = async (ctx: any, t: string, orderId: string, cause: string) => {
      const k = `${t}:${orderId}`;
      balanceVersion.set(k, (balanceVersion.get(k) ?? 0) + 1);
      const b = balance(t, orderId, nowOf(ctx));
      const p = (m: any) => ({ amount_paisa: m.amountPaisa, currency: "NPR" });
      await events?.publish(ctx.tx, "billing.balance.changed.v1", { tenantId: t, idempotencyKey: `${orderId}:${b.balanceVersion}`,
        aggregate: { type: "order", id: orderId }, payload: { order_id: orderId, balance_version: b.balanceVersion, invoiced: p(b.invoiced),
          paid: p(b.paid), credited: p(b.credited), balance_due: p(b.balanceDue), cause, release_eligible: b.balanceDue.amountPaisa === 0 } });
      return b;
    };
    const allocate = (ctx: any, fyAtStart: string) => {
      const fy = fyOf(nowOf(ctx));                       // second clock read: the FY changed during allocation → nothing allocated
      if (fy !== fyAtStart) throw err("billing.counter_busy", "fiscal_year_rollover");
      return fy;
    };
    const next = (t: string, series: string, fy: string) => {
      const k = `${t}:${series}:${fy}`;
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return n.toString().padStart(6, "0");
    };
    const assertCredit = (t: string, creditPartyId: unknown, additional: number) => {
      const p = f.creditParties.find((x) => x.tenantId === t && x.id === creditPartyId);
      if (!p) throw notFound();
      if (p.isLocked || !p.allowsCredit || !p.isActive) throw err("billing.credit_party_locked");
      if (!intOk(additional)) throw invalid("additional_invalid");
      if (p.creditLimitPaisa !== null && p.outstandingPaisa + additional > p.creditLimitPaisa) throw err("billing.credit_limit_exceeded");
      return p;
    };

    return {
      async computeQuote(_ctx, input) {
        const q = await compute(input.lines, input.discounts);
        const base = await compute(input.lines, []);
        return { ...q, baseFingerprint: base.fingerprint } as any;
      },
      async assertCreditAllowed(ctx, input) {
        assertCredit(tenantOf(ctx), input.creditPartyId, input.additional?.amountPaisa as number);
      },
      async issueOrderInvoice(ctx, input) {
        const t = tenantOf(ctx);
        const fy0 = fyOf(nowOf(ctx));
        order(t, input.orderId);
        if (!["registration", "supplementary"].includes(input.purpose)) throw invalid("purpose_invalid");
        const q = await compute(input.lines, input.discounts);
        if (q.fingerprint !== input.expectedFingerprint) throw err("common.version_conflict");
        if (input.purpose === "registration" && f.invoices.some((i) => i.tenantId === t && i.orderId === input.orderId && i.purpose === "registration"))
          throw invalid("registration_invoice_exists");
        const fy = allocate(ctx, fy0);
        const issuedAt = nowOf(ctx);
        const inv = { id: nextId(), tenantId: t, orderId: input.orderId, purpose: input.purpose, invoiceNo: `${fy}-${next(t, "invoice", fy)}`,
          fiscalYearBs: fy, issuedAt, netPaisa: q.totals.net.amountPaisa,
          orderItemIds: q.lines.map((l: any) => l.orderItemId).filter((x: unknown): x is string => typeof x === "string") };
        f.invoices.push(inv);
        const p = (m: any) => ({ amount_paisa: m.amountPaisa, currency: "NPR" });
        const totals: any = {};
        for (const k of TOTAL_KEYS) totals[k === "otherTax" ? "other_tax" : k] = p(q.totals[k]);
        await events?.publish(ctx.tx, "billing.invoice.issued.v1", { tenantId: t, idempotencyKey: inv.id, aggregate: { type: "invoice", id: inv.id },
          payload: { invoice_id: inv.id, invoice_no: inv.invoiceNo, fiscal_year_bs: fy, invoice_kind: "tax_invoice", order_id: input.orderId,
            branch_id: input.branchId, centre_id: input.centreId, issued_at: issuedAt, totals } });
        await bump(ctx, t, input.orderId, "invoice_issued");
        return { invoiceId: inv.id, invoiceNo: inv.invoiceNo, fiscalYearBs: fy, issuedAt, totals: q.totals } as any;
      },
      async recordCreditCharges(ctx, input) {
        const t = tenantOf(ctx);
        order(t, input.orderId);
        const q = await compute(input.lines, input.discounts);
        if (q.fingerprint !== input.expectedFingerprint) throw err("common.version_conflict");
        const party = assertCredit(t, input.creditPartyId, q.totals.net.amountPaisa);
        const chargeIds = q.lines.map((l: any) => {
          const c = { id: nextId(), tenantId: t, orderId: input.orderId, orderItemId: l.orderItemId ?? null, creditPartyId: party.id,
            amountPaisa: l.net.amountPaisa, periodicInvoiceId: null, invoiceLineId: null, voided: false };
          f.creditCharges.push(c);
          return c.id;
        });
        party.outstandingPaisa += q.totals.net.amountPaisa;
        return { chargeIds, totals: q.totals } as any;
      },
      async voidCreditCharges(ctx, input) {
        const t = tenantOf(ctx);
        order(t, input.orderId);
        requireStr(input.reasonCode, "reason_code_required");
        const items = input.orderItemIds;
        const hit = f.creditCharges.filter((c) => c.tenantId === t && c.orderId === input.orderId && !c.voided
          && (!items || (c.orderItemId !== null && items.includes(c.orderItemId as any))));
        const alreadyInvoiced = hit.filter((c) => c.periodicInvoiceId).map((c) => c.id);
        let voided = 0;
        for (const c of hit) if (!c.periodicInvoiceId) { c.voided = true; voided++; }
        return { voided, alreadyInvoiced } as any;
      },
      async recordPayment(ctx, input) {
        checkIdempotencyKey(input.idempotencyKey);
        const t = tenantOf(ctx);
        const prior = idem.get(`${t}:${input.idempotencyKey}`);
        if (prior) return { ...prior, duplicate: true, balance: balance(t, prior.orderId, nowOf(ctx)) } as any;
        const fy0 = fyOf(nowOf(ctx));
        order(t, input.orderId);
        if (!["manual", "home_collection"].includes(input.captureKind)) throw invalid("capture_kind_invalid");
        requireStr(input.methodCode, "method_code_required");
        const amount = input.amount?.amountPaisa;
        if (!intOk(amount) || amount === 0) throw invalid("amount_invalid");
        if (!f.invoices.some((i) => i.tenantId === t && i.orderId === input.orderId)) throw err("billing.order_not_invoiced");
        const due = balance(t, input.orderId, nowOf(ctx)).balanceDue.amountPaisa;
        const exceedsDue = amount > due;
        if (exceedsDue && input.captureKind === "manual") throw err("billing.payment_exceeds_due");
        let receiptNo: string | undefined;
        if (input.issueReceiptNo) { const fy = allocate(ctx, fy0); receiptNo = `RC-${fy}-${next(t, "receipt", fy)}`; }
        const ledgerEntryId = nextId();
        f.payments.push({ id: ledgerEntryId, tenantId: t, orderId: input.orderId, amountPaisa: amount });
        const b = await bump(ctx, t, input.orderId, "payment_recorded");
        const res = { ledgerEntryId, ...(receiptNo ? { receiptNo } : {}), exceedsDue, orderId: input.orderId };
        idem.set(`${t}:${input.idempotencyKey}`, res);
        const { orderId: _o, ...out } = res;
        return { ...out, duplicate: false, balance: b } as any;
      },
      async raiseCreditNoteRequirement(ctx, input) {
        const t = tenantOf(ctx);
        order(t, input.orderId);
        if (!["order_cancelled", "item_removed"].includes(input.cause)) throw invalid("cause_invalid");
        const items = input.orderItemIds as readonly string[] | undefined;
        const touches = (ids: (string | null)[]) => !items || ids.some((x) => x !== null && items.includes(x));
        const taskIds: string[] = [];
        for (const i of f.invoices) if (i.tenantId === t && i.orderId === input.orderId && touches(i.orderItemIds)) taskIds.push(nextId());
        const periodic = new Set(f.creditCharges.filter((c) => c.tenantId === t && c.orderId === input.orderId && c.periodicInvoiceId && touches([c.orderItemId]))
          .map((c) => c.periodicInvoiceId));
        for (const _p of periodic) taskIds.push(nextId());
        return { required: taskIds.length > 0, taskIds } as any;
      },
      async getOrderBillingSummary(ctx, input) {
        const t = tenantOf(ctx);
        order(t, input.orderId);
        const invoiceIds = f.invoices.filter((i) => i.tenantId === t && i.orderId === input.orderId).map((i) => i.id);
        return { invoiceIds, hasIssuedInvoice: invoiceIds.length > 0,
          creditChargeIds: f.creditCharges.filter((c) => c.tenantId === t && c.orderId === input.orderId && !c.voided).map((c) => c.id),
          balance: balance(t, input.orderId, nowOf(ctx)) } as any;
      },
    };
  });
}
