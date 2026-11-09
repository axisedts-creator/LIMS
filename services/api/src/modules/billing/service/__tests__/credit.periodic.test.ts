// BL-T13 B21 issuePeriodicInvoice (02-TRD §5 B21, §8.1 invoice.issued row, §12; PRD US-BL-10.1/.2, US-BL-01 gapless; 05-SCHEMA invoices__subject__ck, credit_charges guard;
// 08 A13 D-1 / P-5; CR-C4-007). Fails now: ../credit.service.js does not exist.
// ASSUMED API: see t13.helpers.ts header (createCreditService({repo,counter,events}).issuePeriodicInvoice). Validation pointers are matched loosely (snake_case HTTP or camelCase service).
// SPEC GAPS (not tested, see notes): tax rate source for TAXABLE credit charges (charges carry no rate; invoice_lines.vat_rate_bp needs one) -> fixtures are exempt;
//   branch-scope {branch} code source (interim `branchCode`), cancellation of a periodic invoice.
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createCreditService } from '../credit.service.js';
import { account, BASE, BRANCH2, CH, charge, errCode, FOREIGN_BRANCH, makeT13World, PARTY, PARTY2, TENANT_A, TENANT_B, V7, type T13World } from './t13.helpers.js';

const PARTY_B_ID = V7('000000b000b2');
const svcOf = (w: T13World) => createCreditService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never });
const bill = (w: T13World, svc: ReturnType<typeof svcOf>, over: Record<string, unknown> = {}, ctx: never = w.ctx()) =>
  w.tx(() => svc.issuePeriodicInvoice(ctx, { creditPartyId: PARTY, periodMonth: '2026-10', branchId: BRANCH2, ...over } as never) as Promise<any>);
const twelve = () => { const w = makeT13World(); w.addCharges(1, 12); return { w, svc: svcOf(w) }; };
const hasPath = (e: any, re: RegExp) => (e.errors ?? []).some((x: any) => re.test(String(x.path)));

describe('US-BL-10.1 monthly bill for 12 uninvoiced charges', () => {
  it('one periodic invoice: credit_party_id, is_periodic_credit_bill, centre_id/order_id/patient_id NULL, request branch_id, buyer = account snapshot, INV number from the pattern', async () => {
    const { w, svc } = twelve();
    const r = await bill(w, svc);
    expect(w.invoicesOf()).toHaveLength(1);
    const inv = w.invoicesOf()[0];
    expect(inv).toMatchObject({
      id: r.invoiceId, tenant_id: TENANT_A, purpose: 'periodic_credit', credit_party_id: PARTY, is_periodic_credit_bill: true, period_month: '2026-10-01', centre_id: null,
      order_id: null, patient_id: null, branch_id: BRANCH2, series: 'INV', fiscal_year_bs: '2083/84', invoice_seq: 1, status: 'issued', invoice_kind: 'tax_invoice',
      buyer_name: 'Synthetic Corp', buyer_pan: '987654321', buyer_address: 'Synthetic Road 7',
    });
    expect(inv.invoice_no).toBe('083/84-000001');
    expect(r).toMatchObject({ invoiceId: inv.id, invoiceNo: '083/84-000001', fiscalYearBs: '2083/84' });
    expect(r.totals.net).toEqual({ amountPaisa: 1_200_000, currency: 'NPR' });
    expect(inv.net_paisa).toBe(1_200_000);
    expect(w.counterCalls).toHaveLength(1);
    expect(w.counterCalls[0]).toMatchObject({ tenantId: TENANT_A, series: 'INV', fiscalYearBs: '2083/84' });
  });

  it('one line per charge (line_kind credit_charge, credit_charge_id, no order_item_id/centre_id), line_no 1..12 in charge order, line sums = invoice totals', async () => {
    const { w, svc } = twelve();
    await bill(w, svc);
    const inv = w.invoicesOf()[0];
    const lines = w.s.lines.filter((l: any) => l.invoice_id === inv.id);
    expect(lines).toHaveLength(12);
    expect(lines.map((l: any) => l.line_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(lines.map((l: any) => l.credit_charge_id))).toEqual(new Set(w.charges().map((c: any) => c.id)));
    for (const l of lines) expect(l).toMatchObject({ tenant_id: TENANT_A, line_kind: 'credit_charge', order_item_id: null, centre_id: null, quantity: 1 });
    const chronological = [...w.charges()].sort((p: any, q: any) => (p.charged_at === q.charged_at ? (p.id < q.id ? -1 : 1) : p.charged_at < q.charged_at ? -1 : 1)).map((c: any) => c.id);
    expect(lines.map((l: any) => l.credit_charge_id)).toEqual(chronological);
    for (const col of ['gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'net_paisa']) {
      expect(lines.reduce((t: number, l: any) => t + Number(l[col]), 0), col).toBe(Number(inv[col]));
    }
  });

  it('line name = "<code> — <patient_display_name>" (03-APP-FLOW §2.14 step 3, review item 2)', async () => {
    const { w, svc } = twelve();
    await bill(w, svc);
    for (const l of w.s.lines) expect(l.name).toBe('CBC — Synthetic Patient');
  });

  it('interim fail-closed (review item 1, CR pending): a taxable or other-tax charge -> catalog.tax_config_missing, nothing stored; replace with a priceFor(...).tax test once the CR is ruled', async () => {
    for (const over of [{ vat_treatment: 'taxable' }, { other_tax_code: 'SYN_TAX' }]) {
      const w = makeT13World(); w.addCharge(1); w.addCharge(2, over);
      expect((await errCode(bill(w, svcOf(w)))).code, JSON.stringify(over)).toBe('catalog.tax_config_missing');
      expect(w.s.invoices).toHaveLength(0);
      expect(w.charges().every((c: any) => c.status === 'uninvoiced')).toBe(true);
    }
  });

  it('all 12 charges become invoiced and point at the invoice and their own line; none stays uninvoiced', async () => {
    const { w, svc } = twelve();
    await bill(w, svc);
    const inv = w.invoicesOf()[0];
    const byId = new Map(w.s.lines.map((l: any) => [l.id, l]));
    for (const c of w.charges()) {
      expect(c).toMatchObject({ status: 'invoiced', invoice_id: inv.id });
      expect((byId.get(c.invoice_line_id) as any).credit_charge_id).toBe(c.id);
      expect(c.invoiced_at).toBeTruthy();
    }
  });

  it('a charge discount is kept on the line and in the totals (pre-tax: gross - discount)', async () => {
    const w = makeT13World(); w.addCharge(1, { gross_paisa: 100000, discount_paisa: 20000 }); w.addCharge(2);
    await bill(w, svcOf(w));
    const lines = w.s.lines;
    expect(lines.find((l: any) => l.credit_charge_id === CH(1))).toMatchObject({ gross_paisa: 100000, discount_paisa: 20000, exempt_paisa: 80000, net_paisa: 80000 });
    expect(w.invoicesOf()[0]).toMatchObject({ gross_paisa: 200000, discount_paisa: 20000, exempt_paisa: 180000, net_paisa: 180000 });
  });

  it('only the requested party, month and status: other month, other party, voided, already-invoiced and other-tenant charges are untouched', async () => {
    const w = makeT13World({ accounts: [account(), account({ credit_party_id: PARTY2, party_display_name: 'Synthetic Other' }), account({ tenant_id: TENANT_B, credit_party_id: PARTY })] });
    w.addCharges(1, 3);
    w.addCharge(20, { period_month: '2026-09-01' });
    w.addCharge(21, { credit_party_id: PARTY2 });
    w.addCharge(22, { status: 'voided', voided_at: BASE });
    w.addCharge(23, { status: 'invoiced', invoice_id: V7('000000ff0001'), invoice_line_id: V7('000000ff0002') });
    w.addCharge(24, { tenant_id: TENANT_B });
    await bill(w, svcOf(w));
    const state = Object.fromEntries(w.charges().map((c: any) => [c.id, c.status]));
    expect([state[CH(1)], state[CH(2)], state[CH(3)]]).toEqual(['invoiced', 'invoiced', 'invoiced']);
    expect([state[CH(20)], state[CH(21)], state[CH(22)], state[CH(23)], state[CH(24)]]).toEqual(['uninvoiced', 'uninvoiced', 'voided', 'invoiced', 'uninvoiced']);
    expect(w.invoicesOf()[0].net_paisa).toBe(300000);
    expect(w.s.lines).toHaveLength(3);
  });

  it('invoice.issued is published once with key <invoice_id>:issued; the payload carries credit_party_id, is_periodic_credit_bill true and the REQUEST branch_id and has NO order_id / centre_id (D-1)', async () => {
    const { w, svc } = twelve();
    const r = await bill(w, svc);
    const ev = w.events_of('billing.invoice.issued.v1');
    expect(ev).toHaveLength(1);
    const e = ev[0]!.envelope;
    expect(e.idempotency_key).toBe(`${r.invoiceId}:issued`);
    expect(e.payload).toMatchObject({ invoice_id: r.invoiceId, invoice_no: '083/84-000001', fiscal_year_bs: '2083/84', branch_id: BRANCH2, credit_party_id: PARTY, is_periodic_credit_bill: true });
    expect(Object.keys(e.payload)).not.toContain('order_id');
    expect(Object.keys(e.payload)).not.toContain('centre_id');
    expect(JSON.stringify(e.payload)).not.toMatch(/Synthetic Corp|987654321|Synthetic Patient|Synthetic Road/); // no buyer / patient data in the event (REQ-SEC-006)
    expect(w.events_of('billing.balance.changed.v1')).toHaveLength(0); // no order, no order_balances row
    expect(w.repoCalls.some((c) => c.name === 'upsertOrderBalance')).toBe(false);
  });

  it('activity row periodic_invoice_issued (no centre, no patient names) and the CBMS invoice job is enqueued when ird.cbmsRealtimeRequired', async () => {
    const { w, svc } = twelve();
    const r = await bill(w, svc);
    expect(w.activity()).toHaveLength(1);
    expect(w.activity()[0]).toMatchObject({ tenant_id: TENANT_A, action: 'periodic_invoice_issued', document_kind: 'invoice', document_id: r.invoiceId, document_no: r.invoiceNo, centre_id: null, actor_id: expect.any(String) });
    expect(JSON.stringify(w.activity()[0].details ?? {})).not.toMatch(/Synthetic Patient|Synthetic Corp/);
    expect(w.s.cbms).toEqual([{ tenantId: TENANT_A, documentKind: 'invoice', documentId: r.invoiceId }]);
    expect(w.invoicesOf()[0].cbms_state).toBe('pending');
  });
});

describe('US-BL-10.2 month already billed', () => {
  it('second request for the same party+month -> 409 billing.credit_period_already_billed; no invoice, no counter allocation, no event, no activity', async () => {
    const { w, svc } = twelve();
    await bill(w, svc);
    const calls = w.counterCalls.length, events = w.db.events.length, acts = w.activity().length;
    const e = await errCode(bill(w, svc));
    expect(e.code).toBe('billing.credit_period_already_billed');
    expect(w.invoicesOf()).toHaveLength(1);
    expect(w.counterCalls.length).toBe(calls);
    expect(w.db.events.length).toBe(events);
    expect(w.activity().length).toBe(acts);
  });
  it('a month with no uninvoiced charges at all (only voided / other months) gives the same code and consumes no number', async () => {
    const w = makeT13World(); w.addCharge(1, { status: 'voided', voided_at: BASE }); w.addCharge(2, { period_month: '2026-09-01' });
    expect((await errCode(bill(w, svcOf(w)))).code).toBe('billing.credit_period_already_billed');
    expect(w.counterCalls).toHaveLength(0);
    expect(w.s.invoices).toHaveLength(0);
  });
  it('a charge added after the first bill (late order in the same month) can be billed by a new request: it is a new uninvoiced set, numbered next', async () => {
    const { w, svc } = twelve();
    await bill(w, svc);
    w.addCharge(30);
    const r = await bill(w, svc);
    expect(r.invoiceNo).toBe('083/84-000002');
    expect(w.invoicesOf()).toHaveLength(2);
    expect(w.charges().find((c: any) => c.id === CH(30))).toMatchObject({ status: 'invoiced', invoice_id: r.invoiceId });
  });
});

describe('gapless numbering and atomicity (US-BL-01 gapless, TRD §12)', () => {
  it('a failure after the number was allocated (marking the charges) rolls back invoice, lines, event, activity and the counter: the next bill gets the SAME number and the charges are still uninvoiced', async () => {
    const { w, svc } = twelve();
    const mark = (w.repo as any).markCreditChargesInvoiced;
    (w.repo as any).markCreditChargesInvoiced = async () => { throw new Error('boom'); };
    await expect(bill(w, svc)).rejects.toThrow('boom');
    expect(w.s.invoices).toHaveLength(0);
    expect(w.s.lines).toHaveLength(0);
    expect(w.db.events).toHaveLength(0);
    expect(w.charges().every((c: any) => c.status === 'uninvoiced')).toBe(true);
    (w.repo as any).markCreditChargesInvoiced = mark;
    expect((await bill(w, svc)).invoiceNo).toBe('083/84-000001');
  });
  it('counter busy -> billing.counter_busy surfaces, nothing is stored, the charges stay uninvoiced', async () => {
    const { w, svc } = twelve();
    const { LimsError } = await import('../../../../core/errors.js');
    w.counterFail = () => new LimsError('billing.counter_busy');
    expect((await errCode(bill(w, svc))).code).toBe('billing.counter_busy');
    expect(w.s.invoices).toHaveLength(0);
    expect(w.charges().every((c: any) => c.status === 'uninvoiced')).toBe(true);
  });
  it('a broken numbering pattern -> 409 billing.numbering_pattern_invalid BEFORE any allocation', async () => {
    const w = makeT13World({ tenantSettings: { numbering: { invoiceNoPattern: '{fy}-NOSEQ' } } }); w.addCharges(1, 2);
    expect((await errCode(bill(w, svcOf(w)))).code).toBe('billing.numbering_pattern_invalid');
    expect(w.counterCalls).toHaveLength(0);
    expect(w.charges().every((c: any) => c.status === 'uninvoiced')).toBe(true);
  });
  it('the charges are read with the row lock (lockUninvoicedCreditCharges) BEFORE the number is allocated, so two finance users cannot bill the same month twice', async () => {
    const { w, svc } = twelve();
    await bill(w, svc);
    const names = w.repoCalls.map((c) => c.name);
    expect(names.indexOf('lockUninvoicedCreditCharges')).toBeGreaterThanOrEqual(0);
    expect(w.counterCalls[0].atRepoCall).toBeGreaterThan(names.indexOf('lockUninvoicedCreditCharges'));
    expect(w.repoCalls.find((c) => c.name === 'lockUninvoicedCreditCharges')!.args).toMatchObject({ tenantId: TENANT_A, creditPartyId: PARTY, periodMonth: '2026-10-01' });
  });
});

describe('input and tenancy', () => {
  it('bad period_month / branch_id / party id -> 400 common.validation_failed naming the field; nothing read-for-update, nothing written', async () => {
    const { w, svc } = twelve();
    for (const [over, re] of [[{ periodMonth: '2026-13' }, /period_?month/i], [{ periodMonth: '2026-1' }, /period_?month/i], [{ periodMonth: '' }, /period_?month/i], [{ periodMonth: '2026-10-01' }, /period_?month/i],
      [{ periodMonth: undefined }, /period_?month/i], [{ branchId: 'not-a-uuid' }, /branch_?id/i], [{ branchId: undefined }, /branch_?id/i], [{ creditPartyId: 'x' }, /credit_?party_?id/i]] as const) {
      const e = await errCode(bill(w, svc, over as never));
      expect(e.code, JSON.stringify(over)).toBe('common.validation_failed');
      expect(hasPath(e, re), JSON.stringify(over)).toBe(true);
    }
    expect(w.wrote()).toEqual([]);
    expect(w.counterCalls).toHaveLength(0);
  });
  it('a branch that is not a branch of this tenant -> 400 common.validation_failed on branch_id; the allocated number is given back (rollback)', async () => {
    const { w, svc } = twelve();
    const e = await errCode(bill(w, svc, { branchId: FOREIGN_BRANCH }));
    expect(e.code).toBe('common.validation_failed');
    expect(hasPath(e, /branch_?id/i)).toBe(true);
    expect(w.s.invoices).toHaveLength(0);
    expect(w.charges().every((c: any) => c.status === 'uninvoiced')).toBe(true);
    expect((await bill(w, svc)).invoiceNo).toBe('083/84-000001');
  });
  it('unknown party -> 404 common.not_found; the party of ANOTHER tenant is also common.not_found (no existence leak) and nothing is written', async () => {
    const w = makeT13World({ accounts: [account(), account({ tenant_id: TENANT_B, credit_party_id: PARTY_B_ID })] }); w.addCharges(1, 2); w.addCharge(9, { tenant_id: TENANT_B, credit_party_id: PARTY_B_ID });
    const svc = svcOf(w);
    expect((await errCode(bill(w, svc, { creditPartyId: V7('000000b0ffff') }))).code).toBe('common.not_found');
    expect((await errCode(bill(w, svc, { creditPartyId: PARTY_B_ID }))).code).toBe('common.not_found');
    expect((await errCode(bill(w, svc, {}, w.ctx({ tenantId: TENANT_B })))).code).toBe('common.not_found'); // tenant B calling with tenant A's party id
    expect(w.s.invoices).toHaveLength(0);
    expect(w.charges().find((c: any) => c.id === CH(9))!.status).toBe('uninvoiced');
  });
  it('tenant and actor come from ctx only: input.tenantId / actorId are ignored', async () => {
    const { w, svc } = twelve();
    await bill(w, svc, { tenantId: TENANT_B, actorId: V7('00000003ffff') });
    expect(w.invoicesOf()[0].tenant_id).toBe(TENANT_A);
    expect(w.repoCalls.every((c) => (c.args.tenantId ?? c.args.tenant_id) === TENANT_A)).toBe(true);
  });
  it('a ctx without tenant / actor / tx -> auth.unauthenticated', async () => {
    const { w, svc } = twelve();
    expect((await errCode(svc.issuePeriodicInvoice({ ...(w.ctx() as object), tenantId: undefined } as never, { creditPartyId: PARTY, periodMonth: '2026-10', branchId: BRANCH2 } as never) as Promise<any>)).code).toBe('auth.unauthenticated');
  });
});
