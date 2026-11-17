// BL-T09 print: B3 printInvoice / B6 printCreditNote service (invoice.service.ts#print, printLog.repo.ts).
// Spec: 03-APP-FLOW §2.10 (+ §5 "Concurrent print"), 02-TRD §5 B3/B6 + access-log table, PRD US-BL-03.1–.3, 07-SECURITY (A6 reprint-as-original, activity whitelist, REQ-SEC-096/097),
//   05-SCHEMA print_log (UNIQUE tenant+kind+doc+print_no, CHECK is_copy = print_no>1) and invoices print guard (+1 only), openapi InvoicePrint / CreditNotePrint.
// done_when: "Original/copy marks; concurrent prints distinct numbers; access_log invoice.print / credit_note.print".
// Fails now: createInvoiceService() has no print / printCreditNote (and the repo has no insertPrintLog / markCreditNotePrinted / listCreditNoteLines).
// ASSUMED API (writer: object via a dispute if wrong):
//   createInvoiceService(deps).print(ctx, { invoiceId, reasonCode? })            -> InvoicePrint   (snake_case, as the openapi body: { print_no, copy_mark?, document })
//   createInvoiceService(deps).printCreditNote(ctx, { creditNoteId, reasonCode? }) -> CreditNotePrint
//   Order: validate input -> load row (tenant from ctx; unknown/other tenant -> common.not_found) -> IdentityPort.assertRole(ctx, { permission: 'billing.invoice.reprint', centreId? })
//          -> ctx.audit.access must exist (else common.internal, nothing written) -> mark*Printed (row lock, RETURNING) -> insertPrintLog -> insertActivity -> audit.access.
//   Everything in the caller's ctx.tx: any throw rolls the count bump back. Tenant, actor and clock come from ctx only (input.tenantId etc. are ignored).
import { describe, expect, it } from 'vitest';
import { createInvoiceService } from '../invoice.service.js';
import { BASE, BUYER_NAME, BUYER_PAN, cancelledInvoice, COPY_MARK, creditNoteRow, IDS, invoiceRow, makePrintWorld, MEMBERSHIP, OTHER_USER, pgError, rejects, REASONS, REQ_ID, TENANT_A, TENANT_B, USER, type PrintWorld } from './t09.helpers.js';

const svcOf = (w: PrintWorld) => createInvoiceService({ repo: w.repo as never, counter: { allocate: async () => { throw new Error('print must never allocate a number'); } } as never, events: {} as never }) as any;
const setup = (opts: Parameters<typeof makePrintWorld>[0] = {}) => { const w = makePrintWorld(opts); return { w, svc: svcOf(w) }; };
const printInv = (w: PrintWorld, svc: any, over: Record<string, unknown> = {}, ctxOver: Record<string, unknown> = {}) => w.inTx((ctx) => svc.print(ctx, { invoiceId: IDS.inv, ...over }), ctxOver);
const printCn = (w: PrintWorld, svc: any, over: Record<string, unknown> = {}, ctxOver: Record<string, unknown> = {}) => w.inTx((ctx) => svc.printCreditNote(ctx, { creditNoteId: IDS.cn, ...over }), ctxOver);
const noWrites = (w: PrintWorld) => { expect(w.writes(), 'no repo write may happen').toEqual([]); expect(w.s.printLog).toHaveLength(0); expect(w.s.activity).toHaveLength(0); expect(w.s.access).toHaveLength(0); };

describe('US-BL-03.1 first print: original, no copy mark', () => {
  it('print_count 0 -> print_no 1, copy_mark key absent (top level and document), print_count 1, last_printed_at set', async () => {
    const { w, svc } = setup();
    const r = await printInv(w, svc);
    expect(Object.keys(r).sort()).toEqual(['document', 'print_no']);
    expect(r.print_no).toBe(1);
    expect('copy_mark' in r).toBe(false);
    expect('copy_mark' in r.document).toBe(false);
    expect(r.document).toMatchObject({ id: IDS.inv, invoice_no: '083/84-000001', status: 'issued', print_no: 1 });
    expect(w.invoice()).toMatchObject({ print_count: 1, last_printed_at: BASE });
  });
  it('print_log row: kind invoice, document_no, print_no 1, is_copy false, centre, printed_at = server clock, created_by = ctx actor; one row only', async () => {
    const { w, svc } = setup();
    await printInv(w, svc, { reasonCode: 'first_print' });
    expect(w.s.printLog).toHaveLength(1);
    expect(w.s.printLog[0]).toMatchObject({ tenant_id: TENANT_A, centre_id: IDS.centre, document_kind: 'invoice', document_id: IDS.inv, document_no: '083/84-000001', print_no: 1, is_copy: false,
      reason_code: 'first_print', printed_at: BASE, created_by: USER });
    expect(typeof w.s.printLog[0].id).toBe('string');
  });
  it('document carries the template data: buyer/seller, lines, totals, dual dates, payment block, branding; nothing outside the InvoicePrint document keys', async () => {
    const { w, svc } = setup();
    const { document: d } = await printInv(w, svc);
    expect(d).toMatchObject({ invoice_date_bs: '2083-07-22', fiscal_year_bs: '2083/84', invoice_kind: 'tax_invoice', is_active: true, buyer: { name: BUYER_NAME }, seller: { name: 'Synthetic Lab Pvt Ltd' } });
    expect(d.lines).toHaveLength(1);
    expect(d.totals.net).toEqual({ amount_paisa: 113000, currency: 'NPR' });
    expect(d.dates).toEqual({ bs: '2083-07-22', ad: expect.stringMatching(/^2026-11-08/) });
    expect(d.payment_block).toEqual({ paid: { amount_paisa: 50000, currency: 'NPR' }, balance_due: { amount_paisa: 63000, currency: 'NPR' } });
    expect(d.branding).toMatchObject({ legal_name: 'Synthetic Lab Pvt Ltd', address_lines: ['Synthetic Road 2', 'Kathmandu'], phones: ['01-5550000'] });
    expect(d.branding.images.map((i: any) => i.kind).sort()).toEqual(['letterhead_footer', 'letterhead_header', 'logo']);
    expect(d.branding.images[0]).toEqual({ kind: expect.any(String), mime_type: 'image/png', base64: 'iVBORw0KGgo=' });
    expect('cancelled_banner' in d).toBe(false);
    expect('cancellation' in d).toBe(false);
  });
});

describe('US-BL-03.2 reprint: copy mark, one print_log row per print', () => {
  it('print_count 1 -> print_no 2 and copy_mark "Copy of Original / प्रतिलिपि" on the top level and in the document', async () => {
    const { w, svc } = setup({ invoices: [invoiceRow({ print_count: 1 })] });
    const r = await printInv(w, svc, { reasonCode: 'reprint' });
    expect(r.print_no).toBe(2);
    expect(r.copy_mark).toBe(COPY_MARK);
    expect(r.document).toMatchObject({ print_no: 2, copy_mark: COPY_MARK });
    expect(w.invoice().print_count).toBe(2);
  });
  it('three sequential prints: print_no 1,2,3; only the first is an original; print_log has exactly three rows (is_copy f,t,t) each with the user and time', async () => {
    const { w, svc } = setup();
    const out = [await printInv(w, svc), await printInv(w, svc, { reasonCode: 'printer_fault' }), await printInv(w, svc, { reasonCode: 'customer_copy' })];
    expect(out.map((r: any) => r.print_no)).toEqual([1, 2, 3]);
    expect(out.map((r: any) => r.copy_mark)).toEqual([undefined, COPY_MARK, COPY_MARK]);
    const log = w.logFor('invoice', IDS.inv);
    expect(log.map((p) => [p.print_no, p.is_copy, p.reason_code ?? null])).toEqual([[1, false, null], [2, true, 'printer_fault'], [3, true, 'customer_copy']]);
    for (const p of log) expect(p).toMatchObject({ created_by: USER, printed_at: BASE });
  });
  it('A6: a reprint can never be an original — print_no >= 2 always has the mark, whatever reason_code (incl. first_print) the client sends', async () => {
    const { w, svc } = setup({ invoices: [invoiceRow({ print_count: 4 })] });
    for (const reasonCode of [...REASONS, undefined]) {
      const r = await printInv(w, svc, reasonCode === undefined ? {} : { reasonCode });
      expect(r.copy_mark, String(reasonCode)).toBe(COPY_MARK);
      expect(r.print_no).toBeGreaterThanOrEqual(5);
    }
    expect(w.s.printLog.every((p) => p.is_copy === true)).toBe(true);
  });
  it('the number comes from the locked UPDATE ... RETURNING, not from a client value or a stale read: input print_no / printCount are ignored', async () => {
    const { w, svc } = setup({ invoices: [invoiceRow({ print_count: 1 })] });
    const r = await printInv(w, svc, { printNo: 1, print_no: 1, printCount: 0, print_count: 0, isCopy: false });
    expect(r.print_no).toBe(2);
    expect(w.s.printLog[0]).toMatchObject({ print_no: 2, is_copy: true });
  });
  it('printing never allocates a document number or touches invoice content (print_count/last_printed_at/updated_* only)', async () => {
    const { w, svc } = setup();
    const before = structuredClone(w.invoice());
    await printInv(w, svc);
    const after = w.invoice();
    for (const k of Object.keys(before)) if (!['print_count', 'last_printed_at', 'updated_by'].includes(k)) expect(after[k], k).toEqual(before[k]);
    expect(w.names().filter((n) => n.startsWith('insertInvoice') || n === 'allocate')).toEqual([]);
  });
});

describe('US-BL-03.3 cancelled invoice: prints with a CANCELLED banner and still counts', () => {
  const cancelled = () => setup({ invoices: [cancelledInvoice()], creditNotes: [creditNoteRow()] });
  it('banner mentions CANCELLED; document.cancellation has date, reason and the credit-note number; print_count still increments; print_log row written', async () => {
    const { w, svc } = cancelled();
    const r = await printInv(w, svc);
    expect(r.print_no).toBe(1);
    expect(r.document.status).toBe('cancelled');
    expect(r.document.cancelled_banner).toMatch(/CANCELLED/);
    expect(r.document.cancellation).toMatchObject({ cancelled_at: '2026-11-08T05:30:00.000Z', reason_code: 'billing_error', credit_note_id: IDS.cn, credit_note_no: 'CN-083/84-000001' });
    expect(w.invoice().print_count).toBe(1);
    expect(w.logFor('invoice', IDS.inv)).toHaveLength(1);
  });
  it('a reprint of a cancelled invoice carries both the banner and the copy mark', async () => {
    const { w, svc } = setup({ invoices: [cancelledInvoice({ print_count: 2 })], creditNotes: [creditNoteRow()] });
    const r = await printInv(w, svc);
    expect(r).toMatchObject({ print_no: 3, copy_mark: COPY_MARK });
    expect(r.document.cancelled_banner).toMatch(/CANCELLED/);
  });
  it('the cancellation reason text is carried when set; an issued invoice has neither banner nor cancellation', async () => {
    const { w, svc } = setup({ invoices: [cancelledInvoice({ cancel_reason_code: 'other', cancel_reason_text: 'Synthetic: wrong patient' })], creditNotes: [creditNoteRow()] });
    expect((await printInv(w, svc)).document.cancellation).toMatchObject({ reason_code: 'other', reason_text: 'Synthetic: wrong patient' });
  });
});

describe('B6 printCreditNote: credit_note series, same rules', () => {
  const withCn = (over: Record<string, unknown> = {}) => setup({ invoices: [cancelledInvoice()], creditNotes: [creditNoteRow(over)] });
  it('first print -> print_no 1, no copy mark; credit_notes.print_count 1; print_log kind credit_note with the credit_note_no; the invoice counter is untouched', async () => {
    const { w, svc } = withCn();
    const r = await printCn(w, svc, { reasonCode: 'first_print' });
    expect(Object.keys(r).sort()).toEqual(['document', 'print_no']);
    expect(r.print_no).toBe(1);
    expect('copy_mark' in r).toBe(false);
    expect(r.document).toMatchObject({ id: IDS.cn, credit_note_no: 'CN-083/84-000001', invoice_no: '083/84-000001', kind: 'cancellation', print_no: 1 });
    expect(w.creditNote().print_count).toBe(1);
    expect(w.invoice().print_count).toBe(0);
    expect(w.s.printLog).toEqual([expect.objectContaining({ document_kind: 'credit_note', document_id: IDS.cn, document_no: 'CN-083/84-000001', print_no: 1, is_copy: false, centre_id: IDS.centre, created_by: USER })]);
    expect(w.logFor('invoice', IDS.inv)).toHaveLength(0);
  });
  it('reprint -> print_no n+1 with the copy mark, is_copy true; numbering is independent of the invoice print count', async () => {
    const { w, svc } = setup({ invoices: [cancelledInvoice({ print_count: 7 })], creditNotes: [creditNoteRow({ print_count: 1 })] });
    const r = await printCn(w, svc, { reasonCode: 'reprint' });
    expect(r).toMatchObject({ print_no: 2, copy_mark: COPY_MARK });
    expect(r.document).toMatchObject({ print_no: 2, copy_mark: COPY_MARK });
    expect(w.s.printLog[0]).toMatchObject({ document_kind: 'credit_note', print_no: 2, is_copy: true, reason_code: 'reprint' });
    expect(w.invoice().print_count).toBe(7);
  });
  it('document carries lines, totals, dual dates and branding (CreditNotePrint)', async () => {
    const { w, svc } = withCn();
    const { document: d } = await printCn(w, svc);
    expect(d.lines).toHaveLength(1);
    expect(d.totals.net).toEqual({ amount_paisa: 113000, currency: 'NPR' });
    expect(d).toMatchObject({ credit_note_date_bs: '2083-07-22', reason_code: 'billing_error', dates: { bs: '2083-07-22' } });
    expect(d.branding.legal_name).toBe('Synthetic Lab Pvt Ltd');
  });
  it('unknown credit note and another tenant\'s credit note -> common.not_found, nothing written', async () => {
    const { w, svc } = setup({ creditNotes: [creditNoteRow({ id: IDS.cnOther, tenant_id: TENANT_B })] });
    for (const id of [IDS.cn2, IDS.cnOther]) expect((await rejects(printCn(w, svc, { creditNoteId: id }))).code).toBe('common.not_found');
    noWrites(w);
  });
});

describe('done_when: concurrent prints get distinct numbers (03-APP-FLOW §5 "Concurrent print")', () => {
  it('5 parallel prints of one invoice (5 transactions) -> print_no {1..5} each exactly once; one original, four copies; 5 log rows; print_count 5; 5 activity + 5 access rows', async () => {
    const { w, svc } = setup();
    const res = await Promise.all(Array.from({ length: 5 }, () => printInv(w, svc)));
    expect(res.map((r: any) => r.print_no).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(res.filter((r: any) => r.copy_mark === undefined)).toHaveLength(1);
    expect(res.find((r: any) => r.copy_mark === undefined).print_no).toBe(1);
    expect(res.filter((r: any) => r.copy_mark === COPY_MARK)).toHaveLength(4);
    expect(w.logFor('invoice', IDS.inv).map((p) => p.print_no).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(w.invoice().print_count).toBe(5);
    expect(w.s.activity.filter((a) => a.action === 'invoice_printed')).toHaveLength(5);
    expect(w.s.access.filter((a) => a.action === 'invoice.print')).toHaveLength(5);
  });
  it('parallel reprints starting at print_count 1 -> {2,3,4}, all with the copy mark (the 03-APP-FLOW row: "print_no 2 and 3, both copies")', async () => {
    const { w, svc } = setup({ invoices: [invoiceRow({ print_count: 1 })] });
    const res = await Promise.all([printInv(w, svc), printInv(w, svc), printInv(w, svc)]);
    expect(res.map((r: any) => r.print_no).sort()).toEqual([2, 3, 4]);
    expect(res.every((r: any) => r.copy_mark === COPY_MARK)).toBe(true);
  });
  it('parallel prints of two different invoices and of an invoice and its credit note are independent series', async () => {
    const { w, svc } = setup({ invoices: [cancelledInvoice(), invoiceRow({ id: IDS.inv2, invoice_no: '083/84-000002', invoice_seq: 2 })], creditNotes: [creditNoteRow()] });
    const [a, b, c, d, e] = await Promise.all([printInv(w, svc), printInv(w, svc, { invoiceId: IDS.inv2 }), printCn(w, svc), printInv(w, svc), printInv(w, svc, { invoiceId: IDS.inv2 })]);
    expect([a.print_no, d.print_no].sort()).toEqual([1, 2]);
    expect([b.print_no, e.print_no].sort()).toEqual([1, 2]);
    expect(c.print_no).toBe(1);
  });
  it('a transaction that fails after taking its number leaves no gap and no row: the next print reuses that number (count bump rolled back with the tx)', async () => {
    const { w, svc } = setup();
    w.failOn.insertPrintLog = () => pgError('XX000', 'boom');
    await rejects(printInv(w, svc));
    expect(w.invoice().print_count).toBe(0);
    expect(w.s.printLog).toHaveLength(0);
    w.failOn.insertPrintLog = undefined;
    const r = await printInv(w, svc);
    expect(r.print_no).toBe(1);
    expect('copy_mark' in r).toBe(false);
  });
});

describe('access_log (REQ-SEC-096/097): invoice.print / credit_note.print on every print, in the same transaction', () => {
  it('invoice: exactly one ctx.audit.access({ action: "invoice.print", entityType: "invoice", entityId, centreId, outcome: "allowed" })', async () => {
    const { w, svc } = setup();
    await printInv(w, svc);
    expect(w.s.access).toHaveLength(1);
    expect(w.s.access[0]).toMatchObject({ action: 'invoice.print', entityType: 'invoice', entityId: IDS.inv, centreId: IDS.centre, outcome: 'allowed' });
  });
  it('credit note: action "credit_note.print", entityType "credit_note", entityId = the credit note id', async () => {
    const { w, svc } = setup({ invoices: [cancelledInvoice()], creditNotes: [creditNoteRow()] });
    await printCn(w, svc);
    expect(w.s.access).toHaveLength(1);
    expect(w.s.access[0]).toMatchObject({ action: 'credit_note.print', entityType: 'credit_note', entityId: IDS.cn, centreId: IDS.centre, outcome: 'allowed' });
  });
  it('every print (also copies) writes its own row; the access entry is well-formed for core ctx.audit.access (two-segment code, scalar detail only) and carries no patient data', async () => {
    const { w, svc } = setup();
    await printInv(w, svc); await printInv(w, svc, { reasonCode: 'printer_fault' });
    expect(w.s.access.map((a) => a.action)).toEqual(['invoice.print', 'invoice.print']);
    for (const a of w.s.access) {
      expect(a.action).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(Object.values(a.detail ?? {}).every((v) => ['string', 'number', 'boolean'].includes(typeof v))).toBe(true);
      expect(JSON.stringify(a)).not.toContain(BUYER_NAME);
      expect(JSON.stringify(a)).not.toContain(BUYER_PAN);
    }
  });
  it('fail closed: no ctx.audit.access -> common.internal and nothing written (no print without its access-log row)', async () => {
    const { w, svc } = setup();
    expect((await rejects(printInv(w, svc, {}, { audit: undefined }))).code).toBe('common.internal');
    noWrites(w);
    expect(w.invoice().print_count).toBe(0);
  });
  it('the access-log write fails -> the whole print is rolled back (count, print_log, activity)', async () => {
    const { w, svc } = setup();
    w.accessError = () => new Error('audit down');
    await rejects(printInv(w, svc));
    expect(w.invoice().print_count).toBe(0);
    expect(w.s.printLog).toHaveLength(0);
    expect(w.s.activity).toHaveLength(0);
  });
});

describe('billing.activity_log (07-SECURITY §8.6: whitelisted, non-PHI details)', () => {
  it('invoice: action invoice_printed, document_kind/id/no, actor + membership, request id, server time; details ⊆ { reason_code, print_no } and include print_no', async () => {
    const { w, svc } = setup({ invoices: [invoiceRow({ print_count: 1 })] });
    await printInv(w, svc, { reasonCode: 'customer_copy' });
    expect(w.s.activity).toHaveLength(1);
    const a = w.s.activity[0];
    expect(a).toMatchObject({ tenant_id: TENANT_A, centre_id: IDS.centre, action: 'invoice_printed', document_kind: 'invoice', document_id: IDS.inv, document_no: '083/84-000001',
      actor_id: USER, actor_membership_id: MEMBERSHIP, actor_type: 'user', occurred_at: BASE, request_id: REQ_ID, created_by: USER });
    expect(a.details.print_no).toBe(2);
    expect(Object.keys(a.details).every((k) => ['reason_code', 'print_no'].includes(k))).toBe(true);
    expect(JSON.stringify(a.details)).not.toContain(BUYER_NAME);
  });
  it('credit note: action credit_note_printed, document_kind credit_note', async () => {
    const { w, svc } = setup({ invoices: [cancelledInvoice()], creditNotes: [creditNoteRow()] });
    await printCn(w, svc);
    expect(w.s.activity).toEqual([expect.objectContaining({ action: 'credit_note_printed', document_kind: 'credit_note', document_id: IDS.cn, document_no: 'CN-083/84-000001' })]);
    expect(w.s.activity[0].details.print_no).toBe(1);
  });
});

describe('authorisation + tenancy (07-SECURITY: edit/print-count reset, cross-centre, REQ-SEC-099)', () => {
  it('assertRole(billing.invoice.reprint, { centreId = the invoice centre }) runs before any write — invoice and credit note', async () => {
    const { w, svc } = setup({ invoices: [cancelledInvoice()], creditNotes: [creditNoteRow()] });
    await printInv(w, svc); await printCn(w, svc);
    expect(w.s.assertRoleCalls).toEqual([{ permission: 'billing.invoice.reprint', centreId: IDS.centre }, { permission: 'billing.invoice.reprint', centreId: IDS.centre }]);
  });
  it('assertRole rejects (auth.forbidden) -> rejected as is, nothing written, count unchanged', async () => {
    const { w, svc } = setup();
    const { LimsError } = await import('../../../../core/errors.js');
    w.assertRoleError = () => new LimsError('auth.forbidden');
    expect((await rejects(printInv(w, svc))).code).toBe('auth.forbidden');
    noWrites(w);
    expect(w.invoice().print_count).toBe(0);
  });
  it('an invoice with no centre: assertRole gets no centreId (finance only, 03-APP-FLOW §2.10 step 1)', async () => {
    const { w, svc } = setup({ invoices: [invoiceRow({ id: IDS.invNullCentre, centre_id: null })] });
    await printInv(w, svc, { invoiceId: IDS.invNullCentre });
    expect(w.s.assertRoleCalls).toHaveLength(1);
    expect(w.s.assertRoleCalls[0].permission).toBe('billing.invoice.reprint');
    expect(w.s.assertRoleCalls[0].centreId).toBeUndefined();
  });
  it('no IdentityPort on ctx -> common.internal, nothing written (fail closed)', async () => {
    const { w, svc } = setup();
    expect((await rejects(printInv(w, svc, {}, { ports: {} }))).code).toBe('common.internal');
    noWrites(w);
  });
  it('unknown invoice and another tenant\'s invoice answer the same common.not_found; nothing written; the other tenant\'s count is untouched', async () => {
    const { w, svc } = setup({ invoices: [invoiceRow(), invoiceRow({ id: IDS.invOther, tenant_id: TENANT_B })] });
    const a = await rejects(printInv(w, svc, { invoiceId: IDS.unknown }));
    const b = await rejects(printInv(w, svc, { invoiceId: IDS.invOther }));
    expect([a.code, b.code]).toEqual(['common.not_found', 'common.not_found']);
    noWrites(w);
    expect(w.invoice(IDS.invOther).print_count).toBe(0);
  });
  it('tenant comes from ctx only: every repo call carries ctx.tenantId; input.tenantId / tenant_id are ignored', async () => {
    const { w, svc } = setup({ invoices: [invoiceRow(), invoiceRow({ id: IDS.invOther, tenant_id: TENANT_B })] });
    await printInv(w, svc, { tenantId: TENANT_B, tenant_id: TENANT_B });
    expect(w.calls.length).toBeGreaterThan(0);
    expect(w.calls.every((c) => c.tenantId === TENANT_A)).toBe(true);
    expect((await rejects(printInv(w, svc, { invoiceId: IDS.invOther, tenantId: TENANT_B }))).code).toBe('common.not_found');
  });
  it('no ctx actor / tx -> auth.unauthenticated, nothing read or written', async () => {
    const { w, svc } = setup();
    expect((await rejects(printInv(w, svc, {}, { actor: undefined }))).code).toBe('auth.unauthenticated');
    expect((await rejects(printInv(w, svc, {}, { tx: undefined }))).code).toBe('auth.unauthenticated');
    expect(w.calls).toHaveLength(0);
  });
});

describe('input validation (before any read or write)', () => {
  it.each([['not-a-uuid'], [''], [42], [undefined], [null]])('invoiceId %j -> common.validation_failed /invoice_id', async (bad) => {
    const { w, svc } = setup();
    const e = await rejects(w.inTx((ctx) => svc.print(ctx, { invoiceId: bad })));
    expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(e.errors)).toContain('/invoice_id');
    expect(w.calls).toHaveLength(0);
  });
  it.each([['not-a-uuid'], [undefined]])('creditNoteId %j -> common.validation_failed /credit_note_id', async (bad) => {
    const { w, svc } = setup();
    const e = await rejects(w.inTx((ctx) => svc.printCreditNote(ctx, { creditNoteId: bad })));
    expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(e.errors)).toContain('/credit_note_id');
    expect(w.calls).toHaveLength(0);
  });
  it.each([['bogus'], ['FIRST_PRINT'], [''], [1], [{}], ['reprint; DROP TABLE billing.print_log']])('reasonCode %j -> common.validation_failed /reason_code, nothing written', async (bad) => {
    const { w, svc } = setup();
    const e = await rejects(printInv(w, svc, { reasonCode: bad }));
    expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(e.errors)).toContain('/reason_code');
    noWrites(w);
    expect(w.invoice().print_count).toBe(0);
  });
  it('the four documented reason codes are accepted for both documents', async () => {
    const { w, svc } = setup({ invoices: [cancelledInvoice()], creditNotes: [creditNoteRow()] });
    for (const reasonCode of REASONS) { await printInv(w, svc, { reasonCode }); await printCn(w, svc, { reasonCode }); }
    expect(w.s.printLog).toHaveLength(8);
  });
});

describe('static: layering + SQL discipline (grep-level, independent of the fakes)', () => {
  it('print_log is append-only in the repo: printLog.repo.ts INSERTs, never UPDATE/DELETE; markInvoicePrinted keeps its +1-only form', async () => {
    const { readFileSync } = await import('node:fs');
    const dir = new URL('../../repository/', import.meta.url);
    const log = readFileSync(new URL('printLog.repo.ts', dir), 'utf8');
    expect(log).toMatch(/INSERT\s+INTO\s+billing\.print_log/i);
    expect(log).not.toMatch(/\bUPDATE\s+billing\.print_log\b|\bDELETE\s+FROM\s+billing\.print_log\b/i);
    const cn = readFileSync(new URL('creditNotes.repo.ts', dir), 'utf8');
    expect(cn).toMatch(/print_count\s*=\s*print_count\s*\+\s*1/i);
    expect(cn).toMatch(/RETURNING\s+print_count/i);
    expect(cn).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
  it('invoice.service.ts print goes through the repo seam only: no raw SQL strings in the service', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../invoice.service.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/markInvoicePrinted/);
    expect(src).toMatch(/insertPrintLog/);
    expect(src).not.toMatch(/\bSELECT\b[\s\S]{0,40}\bFROM\b\s+billing\./i);
    expect(src).not.toMatch(/\bUPDATE\s+billing\./i);
  });
  it('OTHER_USER fixture sanity: a second actor prints as a copy and is recorded as that user', async () => {
    const { w, svc } = setup();
    await printInv(w, svc);
    await printInv(w, svc, {}, { actor: { type: 'user', id: OTHER_USER, membershipId: MEMBERSHIP } });
    expect(w.logFor('invoice', IDS.inv).map((p) => p.created_by)).toEqual([USER, OTHER_USER]);
    expect(w.invoice().updated_by).toBe(OTHER_USER);
  });
});
