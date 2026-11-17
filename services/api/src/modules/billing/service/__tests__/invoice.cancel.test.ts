// BL-T10 cancel (service/invoice.service.ts#cancel, B4): invoice cancelled + full credit note in ONE transaction, gapless CN series, cbms_cancel_state set at cancel, events.
// PRD US-BL-04.1/.2/.3/.5 (04.4 = permission gating, see t10.contract.test.ts); 02-TRD §6.3, §8.1 (billing.invoice.cancelled.v1 key <invoice_id>:cancelled, aggregate seq = invoice version after
// cancel), §9 (CBMS documents invoice_cancellation + credit_note), §12 (series CN, allocation LAST); 03-APP-FLOW §2.11; 05-SCHEMA invoices/credit_notes/credit_note_lines guards; 07-SECURITY (no PHI).
// done_when: "Credit note gapless series; tasks resolve; cbms_cancel_state set at cancel; events".
// Fails now: invoice.service.ts has no cancel/credit, events/publish.ts has no invoiceCancelled (TypeError: svc.cancel is not a function).
// ASSUMED API (writer: object via a dispute if wrong): see the header of t10.helpers.ts.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { createBillingEvents } from '../../events/publish.js';
import { createInvoiceService } from '../invoice.service.js';
import { BASE, cnNo, COMPONENTS, IDS, INVOICE_MUTABLE, makeT10World, seedTask, TASK_IDS, TENANT_A, TENANT_B, USER, type T10World } from './t10.helpers.js';
import { errCode, FY_LONG, issueInput, line, money, REQ_ID } from './t06.helpers.js';

const L1 = line();                                                                                             // CBC: 100000 taxable + 13000 VAT = 113000
const L2 = line({ lineRef: 'L2', orderItemId: '01a1a98a-ac40-7000-8000-000000060002', orderableId: '01a1a98a-ac40-7000-8000-000000070002', code: 'LIP', name: 'Lipid profile',
  unitPrice: { amountPaisa: 50000, currency: 'NPR' }, tax: { vat: 'exempt' } });                                // LIP: 50000 exempt = 50000
const LINES = [L1, L2];
const NET = 163000;

const svcOf = (w: T10World) => createInvoiceService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never }) as any;
async function issued(w: T10World, over: Record<string, unknown> = {}) {
  const ctx = w.ctx(); const input = await issueInput(ctx, { lines: LINES, ...over });
  return w.tx(() => svcOf(w).issue(ctx, input as never)) as Promise<{ invoiceId: string; invoiceNo: string }>;
}
const cancel = (w: T10World, invoiceId: string, over: Record<string, unknown> = {}, ctx = w.ctx()) =>
  w.tx(() => svcOf(w).cancel(ctx, { invoiceId, reasonCode: 'billing_error', ...over })) as Promise<{ creditNoteId: string; creditNoteNo: string }>;
const credit = (w: T10World, invoiceId: string, lines: unknown[], over: Record<string, unknown> = {}, ctx = w.ctx()) =>
  w.tx(() => svcOf(w).credit(ctx, { invoiceId, lines, reasonCode: 'billing_error', ...over })) as Promise<{ creditNoteId: string; creditNoteNo: string }>;
const invOf = (w: T10World, id: string) => w.s.invoices.find((i) => i.id === id)!;
const typesSince = (w: T10World, n: number) => w.db.events.slice(n).map((e) => e.eventType);
const lineIds = (w: T10World, invoiceId: string) => w.s.lines.filter((l) => l.invoice_id === invoiceId).sort((a, b) => a.line_no - b.line_no).map((l) => l.id as string);
const sum = (rows: any[], k: string) => rows.reduce((t, r) => t + Number(r[k]), 0);

describe('US-BL-04.1 cancel: one transaction, invoice cancelled + full credit note + two events', () => {
  it('invoice row: status cancelled, is_active false, cancellation fields set, credited_total = net, version +1; NO other column changed (invoices__mutable_columns)', async () => {
    const w = makeT10World(); const ref = await issued(w);
    const before = structuredClone(invOf(w, ref.invoiceId));
    const cn = await cancel(w, ref.invoiceId, { reasonText: '  duplicate keyed  ' });
    const after = invOf(w, ref.invoiceId);
    expect(after).toMatchObject({ status: 'cancelled', is_active: false, cancelled_by: USER, cancel_reason_code: 'billing_error', cancel_reason_text: 'duplicate keyed',
      credit_note_id: cn.creditNoteId, credited_total_paisa: NET, version: before.version + 1, updated_by: USER });
    expect(after.cancelled_at).toMatch(/^2026-11-08T06:00:0\d\.\d{3}Z$/);
    for (const k of Object.keys(before)) if (!INVOICE_MUTABLE.has(k)) expect(after[k], `immutable column ${k}`).toEqual(before[k]);
    expect(after.invoice_no).toBe(ref.invoiceNo);
  });
  it('credit note: kind cancellation, series CN, FY 2083/84, seq 1, number from the tenant creditNoteNoPattern, snapshots invoice/buyer, totals = the invoice totals, cbms_state pending', async () => {
    const w = makeT10World(); const ref = await issued(w);
    const cn = await cancel(w, ref.invoiceId, { reasonCode: 'billing_error' });
    expect(cn.creditNoteNo).toBe(cnNo(1));
    expect(w.x().creditNotes).toHaveLength(1);
    const row = w.x().creditNotes[0], inv = invOf(w, ref.invoiceId);
    expect(row).toMatchObject({
      id: cn.creditNoteId, tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, series: 'CN', fiscal_year_bs: FY_LONG, credit_note_seq: 1, credit_note_no: cnNo(1), kind: 'cancellation',
      invoice_id: ref.invoiceId, invoice_no: ref.invoiceNo, invoice_fiscal_year_bs: FY_LONG, order_id: IDS.order, buyer_name: 'Synthetic Buyer One', buyer_pan: '123456789',
      reason_code: 'billing_error', is_active: true, cbms_state: 'pending', created_by: USER,
    });
    expect(row.issued_at).toBe(inv.cancelled_at);                                  // one server instant for the cancellation and its credit note
    expect(row.credit_note_date_bs).toMatch(/^2083-\d{2}-\d{2}$/);
    for (const c of COMPONENTS) expect(Number(row[c]), c).toBe(Number(inv[c]));
    expect(Number(row.net_paisa)).toBe(NET);
  });
  it('credit note lines: one per invoice line, amounts = the line, sums = the note (credit_note_lines__amounts__ck holds for each)', async () => {
    const w = makeT10World(); const ref = await issued(w); const ids = lineIds(w, ref.invoiceId);
    const cn = await cancel(w, ref.invoiceId);
    const rows = w.x().cnLines;
    expect(rows.map((r) => [r.invoice_line_id, r.credit_note_id, r.tenant_id, r.centre_id])).toEqual(ids.map((id) => [id, cn.creditNoteId, TENANT_A, IDS.centre]));
    for (const r of rows) {
      const src = w.s.lines.find((l) => l.id === r.invoice_line_id)!;
      for (const c of COMPONENTS) expect(Number(r[c]), `${src.code}.${c}`).toBe(Number(src[c]));
    }
    for (const c of COMPONENTS) expect(sum(rows, c)).toBe(Number(w.x().creditNotes[0][c]));
  });
  it('events after the issue ones: exactly billing.invoice.cancelled.v1 THEN billing.balance.changed.v1 (cause invoice_cancelled, version 2), keys and aggregates per TRD §8.1', async () => {
    const w = makeT10World(); const ref = await issued(w); const n = w.db.events.length;
    const cn = await cancel(w, ref.invoiceId, { reasonText: 'secret reason text' });
    expect(typesSince(w, n)).toEqual(['billing.invoice.cancelled.v1', 'billing.balance.changed.v1']);
    const [c, b] = w.db.events.slice(n).map((e) => e.envelope);
    const inv = invOf(w, ref.invoiceId);
    expect(c.idempotency_key).toBe(`${ref.invoiceId}:cancelled`);
    expect(c.aggregate).toEqual({ type: 'invoice', id: ref.invoiceId, seq: inv.version });
    expect(inv.version).toBe(2);
    expect(c.payload).toEqual({ invoice_id: ref.invoiceId, invoice_no: ref.invoiceNo, fiscal_year_bs: FY_LONG, order_id: IDS.order, credit_note_id: cn.creditNoteId, credit_note_no: cnNo(1),
      reason_code: 'billing_error', cancelled_at: inv.cancelled_at, credited_total: money(NET) });
    expect(b.idempotency_key).toBe(`${IDS.order}:balance:2`);
    expect(b.aggregate).toEqual({ type: 'order_balance', id: IDS.order, seq: 2 });
    expect(b.payload).toMatchObject({ order_id: IDS.order, balance_version: 2, invoiced: money(NET), paid: money(0), credited: money(NET), balance_due: money(0), cause: 'invoice_cancelled' });
  });
  it('no PHI / free text anywhere it must not be: events, CBMS jobs and the activity row carry no buyer name, PAN or cancel-reason text (07-SECURITY §logs; REQ-SEC-006)', async () => {
    const w = makeT10World(); const ref = await issued(w); const n = w.db.events.length;
    await cancel(w, ref.invoiceId, { reasonCode: 'other', reasonText: 'patient Synthetic Buyer One asked, PAN 123456789' });
    const blob = JSON.stringify([w.db.events.slice(n), w.s.cbms, w.s.activity.slice(1)]);
    for (const secret of ['Synthetic Buyer One', '123456789', 'asked', 'Synthetic Street 1']) expect(blob, secret).not.toContain(secret);
  });
  it('activity: an invoice_cancelled row for the invoice with actor, request id and the invoice number (audit trail B27)', async () => {
    const w = makeT10World(); const ref = await issued(w);
    await cancel(w, ref.invoiceId);
    const a = w.s.activity.filter((r) => r.action === 'invoice_cancelled');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ tenant_id: TENANT_A, document_kind: 'invoice', document_id: ref.invoiceId, document_no: ref.invoiceNo, actor_id: USER, actor_type: 'user', request_id: REQ_ID, created_by: USER });
  });
});

describe('cbms_cancel_state is set AT cancel (TRD §9, 05-SCHEMA invoices__cbms_cancel__ck)', () => {
  it('real-time duty (default): invoice cbms_cancel_state pending + credit note cbms_state pending; jobs for invoice_cancellation (keyed by the INVOICE id) and credit_note (keyed by the credit note id)', async () => {
    const w = makeT10World(); const ref = await issued(w); const before = w.s.cbms.length;
    const cn = await cancel(w, ref.invoiceId);
    expect(invOf(w, ref.invoiceId)).toMatchObject({ cbms_cancel_state: 'pending', cbms_state: 'pending' }); // the invoice's own state is untouched
    expect(w.s.cbms.slice(before)).toEqual(expect.arrayContaining([
      { tenantId: TENANT_A, documentKind: 'invoice_cancellation', documentId: ref.invoiceId },
      { tenantId: TENANT_A, documentKind: 'credit_note', documentId: cn.creditNoteId }]));
    expect(w.s.cbms.slice(before)).toHaveLength(2);
  });
  it('tenant ird.cbmsRealtimeRequired = false: both states not_required and NO job is enqueued', async () => {
    const w = makeT10World({ tenantSettings: { ird: { pan: '999999999', cbmsRealtimeRequired: false } } }); const ref = await issued(w); const before = w.s.cbms.length;
    await cancel(w, ref.invoiceId);
    expect(invOf(w, ref.invoiceId).cbms_cancel_state).toBe('not_required');
    expect(w.x().creditNotes[0].cbms_state).toBe('not_required');
    expect(w.s.cbms).toHaveLength(before);
  });
  it('unknown setting (ird missing) fails closed to pending, never silently skips the tax authority', async () => {
    const w = makeT10World({ tenantSettings: { ird: undefined } }); const ref = await issued(w);
    await cancel(w, ref.invoiceId);
    expect(invOf(w, ref.invoiceId).cbms_cancel_state).toBe('pending');
  });
});

describe('credit note numbering: own gapless series CN, allocated LAST (TRD §12)', () => {
  it('one CN allocation: series CN (not INV, not INV:<branch> even under branch scope), FY 2083/84, actor = ctx.actor.id; no repo call between it and insertCreditNote', async () => {
    const w = makeT10World({ billingSettings: { invoice_series_scope: 'branch' }, tenantSettings: { numbering: { invoiceNoPattern: '{branch}/{fy}-{seq:6}', creditNoteNoPattern: 'CN-{fy}-{seq:6}' } } });
    const ref = await issued(w, { branchCode: 'KTM' });
    await cancel(w, ref.invoiceId);
    expect(w.cnCalls()).toHaveLength(1);
    expect(w.cnCalls()[0]).toMatchObject({ tenantId: TENANT_A, series: 'CN', fiscalYearBs: FY_LONG, actorId: USER });
    const firstInsert = w.repoCalls.findIndex((c) => c.name === 'insertCreditNote');
    expect(firstInsert).toBeGreaterThan(-1);
    expect(w.cnCalls()[0].atRepoCall).toBe(firstInsert);
  });
  it('3 cancellations of 3 orders: CN seq 1,2,3 gapless and issued_at non-decreasing; INV numbering is a separate series and keeps counting', async () => {
    const w = makeT10World(); const order = (i: number) => `01a1a98a-ac40-7000-8000-0000000d${String(i).padStart(4, '0')}`;
    const refs = [];
    for (let i = 0; i < 3; i++) refs.push(await issued(w, { orderId: order(i), lines: [line({ orderItemId: `01a1a98a-ac40-7000-8000-0000000e${String(i).padStart(4, '0')}` })] }));
    for (const r of refs) await cancel(w, r.invoiceId);
    expect(w.x().creditNotes.map((c) => [c.credit_note_seq, c.credit_note_no])).toEqual([[1, cnNo(1)], [2, cnNo(2)], [3, cnNo(3)]]);
    const at = w.x().creditNotes.map((c) => c.issued_at); expect([...at].sort()).toEqual(at);
    expect(w.x().counters).toEqual({ INV: 3, CN: 3 });
  });
  it('rollback gives the number back: a failure after the allocation leaves no CN, no events, the invoice issued, and the NEXT cancel gets the same seq 1 (no gap)', async () => {
    const w = makeT10World(); const a = await issued(w); const n = w.db.events.length; const snap = structuredClone(invOf(w, a.invoiceId));
    const orig = (w.repo as any).insertCreditNoteLines; let boom = true;
    (w.repo as any).insertCreditNoteLines = async (...args: any[]) => { if (boom) { boom = false; throw new Error('injected'); } return (orig as any)(...args); };
    await expect(cancel(w, a.invoiceId)).rejects.toThrow('injected');
    expect(w.x().creditNotes).toHaveLength(0); expect(w.x().cnLines).toHaveLength(0); expect(w.x().counters['CN'] ?? 0).toBe(0);
    expect(invOf(w, a.invoiceId)).toEqual(snap);
    expect(w.db.events).toHaveLength(n);
    const cn = await cancel(w, a.invoiceId);
    expect(cn.creditNoteNo).toBe(cnNo(1));
  });
  it('event publish failure also rolls the whole cancel back (nothing stored, counter returned)', async () => {
    const w = makeT10World(); const a = await issued(w); const snap = structuredClone(invOf(w, a.invoiceId));
    w.db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    expect(await errCode(cancel(w, a.invoiceId))).not.toBeInstanceOf(TypeError);
    expect(w.x().creditNotes).toHaveLength(0); expect(w.x().counters['CN'] ?? 0).toBe(0); expect(invOf(w, a.invoiceId)).toEqual(snap);
    expect(w.db.events).toHaveLength(2); // only the issue events
  });
  it('billing.counter_busy from the counter propagates unchanged and nothing is written', async () => {
    const w = makeT10World(); const a = await issued(w); const snap = structuredClone(invOf(w, a.invoiceId)); const n = w.db.events.length;
    w.counter.failCn = () => new LimsError('billing.counter_busy');
    expect((await errCode(cancel(w, a.invoiceId))).code).toBe('billing.counter_busy');
    expect(w.x().creditNotes).toHaveLength(0); expect(invOf(w, a.invoiceId)).toEqual(snap); expect(w.db.events).toHaveLength(n);
  });
  it('pattern problems are found BEFORE allocating: missing creditNoteNoPattern or a pattern with an unknown token -> common.internal (the only declared code on cancelInvoice; review BL-T10 item 2), counter untouched', async () => {
    for (const numbering of [{ invoiceNoPattern: '{fy}-{seq:6}' }, { invoiceNoPattern: '{fy}-{seq:6}', creditNoteNoPattern: 'CN-{nope}-{seq:6}' }]) {
      const w = makeT10World(); const a = await issued(w); w.tenantSettings['numbering'] = numbering;
      expect((await errCode(cancel(w, a.invoiceId))).code).toBe('common.internal');
      expect(w.cnCalls()).toHaveLength(0); expect(w.x().creditNotes).toHaveLength(0);
    }
  });
  it('an invoice from an earlier fiscal year: the credit note takes the CURRENT year number and records invoice_fiscal_year_bs; the event carries the invoice\'s own year', async () => {
    const w = makeT10World(); const a = await issued(w); const inv = invOf(w, a.invoiceId);
    Object.assign(inv, { fiscal_year_bs: '2082/83', invoice_no: '082/83-000042', invoice_seq: 42 });
    await cancel(w, a.invoiceId);
    expect(w.x().creditNotes[0]).toMatchObject({ fiscal_year_bs: FY_LONG, invoice_fiscal_year_bs: '2082/83', invoice_no: '082/83-000042', credit_note_no: cnNo(1) });
    expect(w.db.events.find((e) => e.eventType === 'billing.invoice.cancelled.v1')!.envelope.payload).toMatchObject({ fiscal_year_bs: '2082/83', invoice_no: '082/83-000042' });
  });
});

describe('US-BL-04.2 reason rules', () => {
  const nothing = (w: T10World, snap: unknown, n: number) => {
    expect(w.cnCalls()).toHaveLength(0); expect(w.x().creditNotes).toHaveLength(0); expect(w.db.events).toHaveLength(n); expect(w.s.invoices.map((i) => i.status)).toEqual(['issued']); expect(snap).toBeTruthy();
  };
  for (const [name, over] of [['reason other without text', { reasonCode: 'other' }], ['reason other with blank text', { reasonCode: 'other', reasonText: '   ' }]] as const)
    it(`${name} -> 422 billing.cancel_reason_required, no counter call, nothing written`, async () => {
      const w = makeT10World(); const a = await issued(w); const n = w.db.events.length;
      const e = await errCode(cancel(w, a.invoiceId, over));
      expect(e.code).toBe('billing.cancel_reason_required'); expect(e.statusCode ?? 422).toBe(422);
      nothing(w, e, n);
    });
  it('reason other WITH text is accepted and the trimmed text is stored', async () => {
    const w = makeT10World(); const a = await issued(w);
    await cancel(w, a.invoiceId, { reasonCode: 'other', reasonText: ' wrong patient ' });
    expect(invOf(w, a.invoiceId)).toMatchObject({ cancel_reason_code: 'other', cancel_reason_text: 'wrong patient' });
    expect(w.x().creditNotes[0]).toMatchObject({ reason_code: 'other', reason_text: 'wrong patient' });
  });
  it('malformed input -> 400 common.validation_failed with the body pointer, nothing written: reason_code missing / not a code / 65 chars, reason_text > 500 or with a control character', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ reasonCode: undefined }, '/reason_code'], [{ reasonCode: 'Bad Code!' }, '/reason_code'], [{ reasonCode: 'x'.repeat(65) }, '/reason_code'],
      [{ reasonText: 'a'.repeat(501) }, '/reason_text'], [{ reasonText: 'bad\u0007text' }, '/reason_text'], [{ reasonText: 42 }, '/reason_text'],
    ];
    for (const [over, path] of cases) {
      const w = makeT10World(); const a = await issued(w); const n = w.db.events.length;
      const e = await errCode(cancel(w, a.invoiceId, over));
      expect([e.code, e.errors?.map((x: any) => x.path)], JSON.stringify(over)).toEqual(['common.validation_failed', [path]]);
      nothing(w, e, n);
    }
  });
  it('invoice id that is not a UUID -> common.validation_failed (never reaches SQL)', async () => {
    const w = makeT10World(); await issued(w);
    expect((await errCode(cancel(w, "x'; DROP TABLE billing.invoices;--"))).code).toBe('common.validation_failed');
    expect(w.repoCalls.some((c) => c.name === 'getInvoiceForUpdate')).toBe(false);
  });
});

describe('US-BL-04.3 already cancelled', () => {
  it('second cancel -> 409 billing.invoice_already_cancelled; no second credit note, no counter call, no event, invoice unchanged', async () => {
    const w = makeT10World(); const a = await issued(w); await cancel(w, a.invoiceId);
    const snap = structuredClone(invOf(w, a.invoiceId)); const n = w.db.events.length; const calls = w.cnCalls().length;
    const e = await errCode(cancel(w, a.invoiceId, { reasonCode: 'duplicate_invoice' }));
    expect(e.code).toBe('billing.invoice_already_cancelled'); expect(e.statusCode).toBe(409);
    expect(w.x().creditNotes).toHaveLength(1); expect(w.cnCalls()).toHaveLength(calls); expect(w.db.events).toHaveLength(n); expect(invOf(w, a.invoiceId)).toEqual(snap);
  });
  it('the already-cancelled check comes before the reason check only for the state: cancelled + reason other without text -> already_cancelled (state wins, nothing to explain)', async () => {
    const w = makeT10World(); const a = await issued(w); await cancel(w, a.invoiceId);
    expect((await errCode(cancel(w, a.invoiceId, { reasonCode: 'other' }))).code).toBe('billing.invoice_already_cancelled');
  });
  it('the DB backstop: a cancellation credit note already exists for the invoice (unique index) -> the cancel fails and rolls back, it never issues a second one', async () => {
    const w = makeT10World(); const a = await issued(w); const n = w.db.events.length;
    w.x().creditNotes.push({ id: '01a1a98a-ac40-7000-8000-00000000cc01', tenant_id: TENANT_A, invoice_id: a.invoiceId, kind: 'cancellation', series: 'CN', fiscal_year_bs: FY_LONG, credit_note_seq: 0, issued_at: '2026-01-01T00:00:00.000Z', net_paisa: 1 });
    expect(await errCode(cancel(w, a.invoiceId))).not.toBeInstanceOf(TypeError); // a real refusal, not a missing method
    expect(w.x().creditNotes).toHaveLength(1); expect(w.db.events).toHaveLength(n); expect(w.x().counters['CN'] ?? 0).toBe(0);
  });
});

describe('tenancy (A11): the tenant comes from ctx only; other tenants\' invoices do not exist', () => {
  it('unknown invoice id and an invoice of tenant B -> 404 common.not_found, no side effects; a smuggled input.tenantId is ignored', async () => {
    const w = makeT10World(); const a = await issued(w);
    const other = { ...structuredClone(invOf(w, a.invoiceId)), id: '01a1a98a-ac40-7000-8000-00000000b001', tenant_id: TENANT_B, invoice_no: 'B-000001' };
    w.s.invoices.push(other); const n = w.db.events.length;
    for (const [id, extra] of [['01a1a98a-ac40-7000-8000-00000000ffff', {}], [other.id, {}], [other.id, { tenantId: TENANT_B, tenant_id: TENANT_B }]] as const) {
      const e = await errCode(cancel(w, id, extra));
      expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
    }
    expect(w.x().creditNotes).toHaveLength(0); expect(w.db.events).toHaveLength(n); expect(w.cnCalls()).toHaveLength(0);
    expect(w.s.invoices.map((i) => i.status)).toEqual(['issued', 'issued']);
    expect(w.repoCalls.filter((c) => c.name === 'getInvoiceForUpdate').every((c) => c.args.tenantId === TENANT_A)).toBe(true);
  });
  it('every repo call of a cancel carries the caller\'s tenant', async () => {
    const w = makeT10World(); const a = await issued(w); const from = w.repoCalls.length;
    await cancel(w, a.invoiceId);
    const mine = w.repoCalls.slice(from);
    expect(mine.length).toBeGreaterThan(4);
    expect(mine.every((c) => (c.args.tenantId ?? c.args.tenant_id) === TENANT_A)).toBe(true);
  });
  it('no actor / no tx on the context -> auth.unauthenticated, nothing touched', async () => {
    const w = makeT10World(); const a = await issued(w);
    for (const bad of [{ actor: undefined }, { tx: undefined }, { tenantId: undefined }]) {
      expect((await errCode(cancel(w, a.invoiceId, {}, w.ctx(bad)))).code).toBe('auth.unauthenticated');
    }
    expect(w.x().creditNotes).toHaveLength(0);
  });
});

describe('US-BL-04.5 partially credited invoice: the cancellation credit note covers only the remaining uncredited amount', () => {
  it('line 2 fully credited first -> cancel credits line 1 only (113000): note net 113000, ONE note line, invoice credited_total 163000, event credited_total 163000, balance credited 163000 at version 3, CN seq 2', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1, id2] = lineIds(w, a.invoiceId);
    await credit(w, a.invoiceId, [{ invoiceLineId: id2 }]);
    expect(invOf(w, a.invoiceId)).toMatchObject({ status: 'issued', credited_total_paisa: 50000 });
    const n = w.db.events.length;
    const cn = await cancel(w, a.invoiceId);
    expect(cn.creditNoteNo).toBe(cnNo(2));
    const note = w.x().creditNotes.find((c) => c.id === cn.creditNoteId);
    expect(note).toMatchObject({ kind: 'cancellation', net_paisa: 113000, gross_paisa: 100000, vat_paisa: 13000, exempt_paisa: 0 });
    expect(w.x().cnLines.filter((l) => l.credit_note_id === cn.creditNoteId).map((l) => [l.invoice_line_id, Number(l.net_paisa)])).toEqual([[id1, 113000]]);
    expect(invOf(w, a.invoiceId)).toMatchObject({ status: 'cancelled', credited_total_paisa: NET });
    const [c, b] = w.db.events.slice(n).map((e) => e.envelope);
    expect(c.payload.credited_total).toEqual(money(NET));
    expect(b.payload).toMatchObject({ balance_version: 3, credited: money(NET), invoiced: money(NET), cause: 'invoice_cancelled' });
  });
  it('line 1 half credited (56500 = 50000 + 6500 VAT) -> the cancellation note takes the exact remainder of line 1 (56500, same component split) plus all of line 2', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1, id2] = lineIds(w, a.invoiceId);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 56500 }]);
    const cn = await cancel(w, a.invoiceId);
    const rows = w.x().cnLines.filter((l) => l.credit_note_id === cn.creditNoteId);
    const l1 = rows.find((r) => r.invoice_line_id === id1)!, l2 = rows.find((r) => r.invoice_line_id === id2)!;
    expect([Number(l1.net_paisa), Number(l1.gross_paisa), Number(l1.taxable_paisa), Number(l1.vat_paisa)]).toEqual([56500, 50000, 50000, 6500]);
    expect(Number(l2.net_paisa)).toBe(50000);
    // over ALL credit notes of the invoice every line is credited exactly once in full (no cent drift from rounding)
    for (const c of COMPONENTS) for (const [id, src] of [[id1, w.s.lines[0]], [id2, w.s.lines[1]]] as const)
      expect(sum(w.x().cnLines.filter((l) => l.invoice_line_id === id), c), `${c} ${id}`).toBe(Number(src[c]));
    expect(sum(w.x().creditNotes, 'net_paisa')).toBe(NET);
  });
  it('an invoice with nothing left to credit cannot be cancelled into a zero-value note: rejected, nothing written (spec gap: the code is not named — credit_notes__totals__ck forbids net 0)', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1, id2] = lineIds(w, a.invoiceId);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1 }, { invoiceLineId: id2 }]);
    const n = w.db.events.length; const notes = w.x().creditNotes.length;
    const e = await errCode(cancel(w, a.invoiceId));
    expect(e).toBeInstanceOf(LimsError);
    expect(w.x().creditNotes).toHaveLength(notes); expect(w.db.events).toHaveLength(n); expect(invOf(w, a.invoiceId).status).toBe('issued');
  });
});

describe('open credit_note_required tasks of the invoice are resolved by the cancellation (03-APP-FLOW §2.11 "resolve open tasks of the invoice")', () => {
  it('open tasks of THIS invoice -> resolved by the cancellation credit note; a task of another invoice and one of another tenant stay open', async () => {
    const w = makeT10World(); const a = await issued(w); const b = await issued(w, { orderId: IDS.order2, lines: [line({ orderItemId: '01a1a98a-ac40-7000-8000-000000060009' })] });
    const ids = lineIds(w, a.invoiceId);
    seedTask(w, { id: TASK_IDS.t1, invoice_id: a.invoiceId, invoice_line_ids: [ids[0]!], cause: 'order_cancelled' });
    seedTask(w, { id: TASK_IDS.t2, invoice_id: b.invoiceId, invoice_line_ids: lineIds(w, b.invoiceId), order_id: IDS.order2 });
    seedTask(w, { id: TASK_IDS.tB, tenant_id: TENANT_B, invoice_id: a.invoiceId, invoice_line_ids: [ids[0]!] });
    const cn = await cancel(w, a.invoiceId);
    const t = (id: string) => w.x().tasks.find((r) => r.id === id);
    expect(t(TASK_IDS.t1)).toMatchObject({ status: 'resolved', resolved_by_credit_note_id: cn.creditNoteId, resolved_by: USER, version: 2 });
    expect(t(TASK_IDS.t1).resolved_at).toBe(invOf(w, a.invoiceId).cancelled_at);
    expect(t(TASK_IDS.t2)).toMatchObject({ status: 'open', resolved_by_credit_note_id: null });
    expect(t(TASK_IDS.tB)).toMatchObject({ status: 'open', resolved_by_credit_note_id: null });
  });
});

describe('periodic credit bill (no order): cancel works, there is no balance to change', () => {
  it('purpose periodic_credit, order_id NULL: credit note without order/centre, invoice.cancelled WITHOUT order_id, and NO billing.balance.changed.v1 (TRD §8.1)', async () => {
    const w = makeT10World(); const party = '01a1a98a-ac40-7000-8000-000000b00001'; const id = '01a1a98a-ac40-7000-8000-00000000d001';
    w.s.invoices.push({ id, tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: null, series: 'INV', fiscal_year_bs: FY_LONG, invoice_seq: 1, invoice_no: '083/84-000001', invoice_kind: 'tax_invoice',
      purpose: 'periodic_credit', order_id: null, patient_id: null, credit_party_id: party, is_periodic_credit_bill: true, period_month: '2026-10-01', buyer_name: 'Synthetic Credit Party',
      buyer_pan: null, issued_at: BASE, gross_paisa: 100000, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 100000, vat_paisa: 13000, other_tax_paisa: 0, net_paisa: 113000,
      status: 'issued', is_active: true, cbms_state: 'pending', version: 1, credited_total_paisa: 0, cancelled_at: null, cbms_cancel_state: null, created_by: USER });
    w.s.lines.push({ id: '01a1a98a-ac40-7000-8000-00000000d101', tenant_id: TENANT_A, invoice_id: id, centre_id: null, line_no: 1, line_kind: 'orderable', code: 'CBC', name: 'Complete blood count',
      gross_paisa: 100000, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 100000, vat_paisa: 13000, other_tax_paisa: 0, net_paisa: 113000 });
    const n = w.db.events.length;
    await cancel(w, id);
    expect(w.x().creditNotes[0]).toMatchObject({ order_id: null, centre_id: null, credit_party_id: party, kind: 'cancellation', net_paisa: 113000 });
    expect(typesSince(w, n)).toEqual(['billing.invoice.cancelled.v1']);
    expect(w.db.events[n]!.envelope.payload).not.toHaveProperty('order_id');
  });
});
