// BL-T13 event schema test: billing.invoice.issued.v1 for a PERIODIC credit bill (02-TRD §8.1 row invoice.issued; 03-IC §3.4 if/then/else; 08 A13 D-1 / P-5;
// contracts/events/billing.invoice.issued.v1.schema.json; PRD US-BL-10.1: "validates without order_id/centre_id").
// done_when: "invoice.issued without order_id/centre_id validates". These run against the REAL core publisher + schema, through the existing invoiceIssued publisher,
// so they PASS now (the schema and the publisher already exist); they pin the contract the BL-T13 service must produce (credit.periodic.test.ts asserts it end to end).
import { describe, expect, it } from 'vitest';
import { ctxFor, makeEventDb, rejection } from '../../../../core/events/__tests__/helpers.js';
import { createEvents } from '../../../../core/events/publish.js';
import { createBillingEvents } from '../publish.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const INV = V7('000000a00101'), PARTY = V7('000000b00001'), BRANCH = V7('000000010002'), ORDER = V7('000000050001'), CENTRE = V7('000000020002');
const M = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const totals = () => ({ gross: M(1200000), discount: M(0), exempt: M(1200000), taxable: M(0), vat: M(0), other_tax: M(0), net: M(1200000) });
const periodic = (over: Record<string, unknown> = {}) => ({
  invoice_id: INV, invoice_no: '083/84-000001', fiscal_year_bs: '2083/84', invoice_kind: 'tax_invoice', branch_id: BRANCH, issued_at: '2026-11-08T06:00:01.000Z', totals: totals(),
  credit_party_id: PARTY, is_periodic_credit_bill: true, ...over,
});
const orderInvoice = (over: Record<string, unknown> = {}) => ({
  invoice_id: INV, invoice_no: '083/84-000002', fiscal_year_bs: '2083/84', invoice_kind: 'tax_invoice', branch_id: BRANCH, issued_at: '2026-11-08T06:00:01.000Z', totals: totals(),
  order_id: ORDER, centre_id: CENTRE, ...over,
});
function setup() {
  const db = makeEventDb();
  const bl = createBillingEvents(createEvents({ producer: 'billing' }) as never) as any;
  return { db, ctx: ctxFor(db) as never, publish: (p: Record<string, unknown>) => db.transaction(() => bl.invoiceIssued(ctxFor(db) as never, p)), stored: () => db.events.filter((e) => e.eventType === 'billing.invoice.issued.v1') };
}
const without = (p: Record<string, unknown>, ...ks: string[]) => { const q = { ...p }; for (const k of ks) delete q[k]; return q; };

describe('billing.invoice.issued.v1 — periodic credit bill (D-1)', () => {
  it('validates WITHOUT order_id and centre_id: stored once, key <invoice_id>:issued, aggregate invoice seq 1, branch_id = the issuing branch', async () => {
    const { publish, stored } = setup();
    await publish(periodic());
    expect(stored()).toHaveLength(1);
    const e = stored()[0]!;
    expect(e.key).toBe(`${INV}:issued`);
    expect(e.envelope.aggregate).toEqual({ type: 'invoice', id: INV, seq: 1 });
    expect(e.envelope.payload).toEqual(periodic());
  });
  it('REQUIRES credit_party_id when is_periodic_credit_bill is true', async () => {
    const { publish, stored } = setup();
    expect((await rejection(publish(without(periodic(), 'credit_party_id')))).code).toBe('common.internal');
    expect(stored()).toHaveLength(0);
  });
  it('FORBIDS order_id or centre_id on a periodic bill (a stray centre would leak a centre-scoped row for a NULL-centre document)', async () => {
    for (const extra of [{ order_id: ORDER }, { centre_id: CENTRE }, { order_id: ORDER, centre_id: CENTRE }]) {
      const { publish, stored } = setup();
      expect((await rejection(publish(periodic(extra)))).code, JSON.stringify(Object.keys(extra))).toBe('common.internal');
      expect(stored()).toHaveLength(0);
    }
  });
  it('branch_id, invoice_no, totals and issued_at stay required for a periodic bill', async () => {
    for (const k of ['branch_id', 'invoice_no', 'totals', 'issued_at', 'fiscal_year_bs', 'invoice_id', 'invoice_kind']) {
      const { publish, stored } = setup();
      expect((await rejection(publish(without(periodic(), k)))).code, k).toBe('common.internal');
      expect(stored(), k).toHaveLength(0);
    }
  });
  it('no buyer / party / patient data can ride along (additionalProperties false, REQ-SEC-006)', async () => {
    for (const extra of [{ buyer_name: 'Synthetic Corp' }, { buyer_pan: '987654321' }, { party_name: 'Synthetic Corp' }, { patient_id: V7('000000040001') }, { period_month: '2026-10' }]) {
      const { publish, stored } = setup();
      expect((await rejection(publish(periodic(extra)))).code, JSON.stringify(extra)).toBe('common.internal');
      expect(stored()).toHaveLength(0);
    }
  });
  it('the order invoice branch is unchanged: order_id AND centre_id stay required when is_periodic_credit_bill is absent or false', async () => {
    const ok = setup();
    await ok.publish(orderInvoice());
    expect(ok.stored()).toHaveLength(1);
    for (const p of [without(orderInvoice(), 'order_id'), without(orderInvoice(), 'centre_id'), without(orderInvoice(), 'order_id', 'centre_id'), orderInvoice({ is_periodic_credit_bill: false, order_id: undefined })]) {
      const { publish, stored } = setup();
      expect((await rejection(publish(JSON.parse(JSON.stringify(p))))).code).toBe('common.internal');
      expect(stored()).toHaveLength(0);
    }
  });
  it('the same periodic invoice published twice in one tx is a duplicate no-op', async () => {
    const { db, ctx, stored } = setup();
    const bl = createBillingEvents(createEvents({ producer: 'billing' }) as never) as any;
    await db.transaction(async () => { await bl.invoiceIssued(ctx, periodic()); expect((await bl.invoiceIssued(ctx, periodic())).duplicate).toBe(true); });
    expect(stored()).toHaveLength(1);
  });
});
