// BL-T10 partial credit note (service/invoice.service.ts#credit, B5) + credit_note_tasks resolution (repository/creditNoteTasks.repo.ts).
// PRD US-BL-05.1/.2 (400 common.validation_failed, path /lines/0/amount_paisa — 08 A13 P-1), US-BL-04.3 (cancelled invoice), US-BL-04.2 (reason rules);
// 03-APP-FLOW §2.11 B5 (lines with optional amounts = remaining; component split proportional with largest-remainder rounding; credited_total_paisa += net; kind partial; resolves listed tasks;
// balance event credit_note_issued); 02-TRD §6.3/§8.1/§9; 05-SCHEMA credit_notes / credit_note_lines (ck) / credit_note_tasks / invoices lifecycle guard; 07-SECURITY A11 (tenancy).
// Fails now: invoice.service.ts has no credit() (TypeError: svc.credit is not a function). ASSUMED API: see the header of t10.helpers.ts.
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createInvoiceService } from '../invoice.service.js';
import { cnNo, COMPONENTS, IDS, INVOICE_MUTABLE, makeT10World, seedTask, TASK_IDS, TENANT_A, TENANT_B, USER, type T10World } from './t10.helpers.js';
import { errCode, FY_LONG, issueInput, line, money } from './t06.helpers.js';

const L1 = line();                                                                                             // CBC 100000 + 13000 VAT = 113000
const L2 = line({ lineRef: 'L2', orderItemId: '01a1a98a-ac40-7000-8000-000000060002', orderableId: '01a1a98a-ac40-7000-8000-000000070002', code: 'LIP', name: 'Lipid profile',
  unitPrice: { amountPaisa: 50000, currency: 'NPR' }, tax: { vat: 'exempt' } });                                // LIP 50000 exempt
const NET = 163000;
const svcOf = (w: T10World) => createInvoiceService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never }) as any;
async function issued(w: T10World, over: Record<string, unknown> = {}) {
  const ctx = w.ctx(); const input = await issueInput(ctx, { lines: [L1, L2], ...over });
  return w.tx(() => svcOf(w).issue(ctx, input as never)) as Promise<{ invoiceId: string; invoiceNo: string }>;
}
const credit = (w: T10World, invoiceId: string, lines: unknown[], over: Record<string, unknown> = {}, ctx = w.ctx()) =>
  w.tx(() => svcOf(w).credit(ctx, { invoiceId, lines, reasonCode: 'billing_error', ...over })) as Promise<{ creditNoteId: string; creditNoteNo: string }>;
const cancel = (w: T10World, invoiceId: string) => w.tx(() => svcOf(w).cancel(w.ctx(), { invoiceId, reasonCode: 'billing_error' })) as Promise<{ creditNoteId: string }>;
const invOf = (w: T10World, id: string) => w.s.invoices.find((i) => i.id === id)!;
const lineIds = (w: T10World, invoiceId: string) => w.s.lines.filter((l) => l.invoice_id === invoiceId).sort((a, b) => a.line_no - b.line_no).map((l) => l.id as string);
const sum = (rows: any[], k: string) => rows.reduce((t, r) => t + Number(r[k]), 0);
const task = (w: T10World, id: string) => w.x().tasks.find((t) => t.id === id)!;

describe('US-BL-05.1 partial credit note for a removed item resolves the open task', () => {
  async function setup() {
    const w = makeT10World(); const a = await issued(w); const [id1, id2] = lineIds(w, a.invoiceId);
    seedTask(w, { id: TASK_IDS.t1, invoice_id: a.invoiceId, invoice_line_ids: [id2!], cause: 'item_removed' });
    return { w, a, id1: id1!, id2: id2! };
  }
  it('credit note: kind partial, series CN seq 1, references the invoice and the LINE, amounts = the whole line, cbms_state pending; returns its id and number', async () => {
    const { w, a, id2 } = await setup();
    const cn = await credit(w, a.invoiceId, [{ invoiceLineId: id2 }], { reasonCode: 'patient_request', reasonText: 'item removed', resolvesTaskIds: [TASK_IDS.t1] });
    expect(cn.creditNoteNo).toBe(cnNo(1));
    expect(w.x().creditNotes).toHaveLength(1);
    expect(w.x().creditNotes[0]).toMatchObject({ id: cn.creditNoteId, tenant_id: TENANT_A, kind: 'partial', series: 'CN', fiscal_year_bs: FY_LONG, credit_note_seq: 1, credit_note_no: cnNo(1),
      invoice_id: a.invoiceId, invoice_no: a.invoiceNo, order_id: IDS.order, centre_id: IDS.centre, branch_id: IDS.branch, reason_code: 'patient_request', reason_text: 'item removed',
      net_paisa: 50000, exempt_paisa: 50000, vat_paisa: 0, cbms_state: 'pending', created_by: USER });
    expect(w.x().cnLines).toHaveLength(1);
    expect(w.x().cnLines[0]).toMatchObject({ credit_note_id: cn.creditNoteId, invoice_line_id: id2, tenant_id: TENANT_A, centre_id: IDS.centre, net_paisa: 50000, exempt_paisa: 50000, gross_paisa: 50000 });
  });
  it('the task resolves: status resolved, resolved_by_credit_note_id = the note, resolved_by = actor, resolved_at set, version +1', async () => {
    const { w, a, id2 } = await setup();
    const cn = await credit(w, a.invoiceId, [{ invoiceLineId: id2 }], { resolvesTaskIds: [TASK_IDS.t1] });
    expect(task(w, TASK_IDS.t1)).toMatchObject({ status: 'resolved', resolved_by_credit_note_id: cn.creditNoteId, resolved_by: USER, version: 2 });
    expect(task(w, TASK_IDS.t1).resolved_at).toBe(w.x().creditNotes[0].issued_at);
  });
  it('a task that is NOT listed in resolves_task_ids stays open (finance decides; nothing is resolved implicitly)', async () => {
    const { w, a, id2 } = await setup();
    await credit(w, a.invoiceId, [{ invoiceLineId: id2 }]);
    expect(task(w, TASK_IDS.t1)).toMatchObject({ status: 'open', resolved_by_credit_note_id: null });
  });
  it('the invoice: still issued/active; ONLY credited_total_paisa (+50000), version (+1), updated_by changed — every other column identical (REQ: no invoice column except credited_total_paisa/version/updated_*)', async () => {
    const { w, a, id2 } = await setup(); const before = structuredClone(invOf(w, a.invoiceId));
    await credit(w, a.invoiceId, [{ invoiceLineId: id2 }], { resolvesTaskIds: [TASK_IDS.t1] });
    const after = invOf(w, a.invoiceId);
    expect(after).toMatchObject({ status: 'issued', is_active: true, credited_total_paisa: 50000, version: before.version + 1, updated_by: USER, cancelled_at: null, credit_note_id: null, cbms_cancel_state: null });
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    expect(changed.sort()).toEqual(['credited_total_paisa', 'version'].sort());
    for (const k of changed) expect(INVOICE_MUTABLE.has(k)).toBe(true);
  });
  it('the balance drops by the line net: ONE billing.balance.changed.v1 (cause credit_note_issued, version 2, credited 50000, balance_due 113000); no invoice.cancelled event', async () => {
    const { w, a, id2 } = await setup(); const n = w.db.events.length;
    await credit(w, a.invoiceId, [{ invoiceLineId: id2 }], { resolvesTaskIds: [TASK_IDS.t1] });
    const ev = w.db.events.slice(n);
    expect(ev.map((e) => e.eventType)).toEqual(['billing.balance.changed.v1']);
    expect(ev[0]!.envelope.idempotency_key).toBe(`${IDS.order}:balance:2`);
    expect(ev[0]!.envelope.payload).toMatchObject({ order_id: IDS.order, balance_version: 2, invoiced: money(NET), paid: money(0), credited: money(50000), balance_due: money(113000), cause: 'credit_note_issued' });
  });
  it('CBMS: a credit_note job is enqueued (keyed by the credit note id); no invoice_cancellation job; tenant with cbmsRealtimeRequired=false -> not_required and no job', async () => {
    const { w, a, id2 } = await setup(); const before = w.s.cbms.length;
    const cn = await credit(w, a.invoiceId, [{ invoiceLineId: id2 }]);
    expect(w.s.cbms.slice(before)).toEqual([{ tenantId: TENANT_A, documentKind: 'credit_note', documentId: cn.creditNoteId }]);
    const off = makeT10World({ tenantSettings: { ird: { pan: '999999999', cbmsRealtimeRequired: false } } }); const b = await issued(off); const bn = off.s.cbms.length;
    await credit(off, b.invoiceId, [{ invoiceLineId: lineIds(off, b.invoiceId)[1]! }]);
    expect(off.x().creditNotes[0].cbms_state).toBe('not_required'); expect(off.s.cbms).toHaveLength(bn);
  });
  it('activity: credit_note_issued for the credit note (document_kind credit_note, number, actor); the event/jobs/activity carry no buyer name, PAN or reason text', async () => {
    const { w, a, id2 } = await setup(); const n = w.db.events.length;
    const cn = await credit(w, a.invoiceId, [{ invoiceLineId: id2 }], { reasonCode: 'other', reasonText: 'Synthetic Buyer One wanted it removed' });
    const act = w.s.activity.filter((r) => r.action === 'credit_note_issued');
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ tenant_id: TENANT_A, document_kind: 'credit_note', document_id: cn.creditNoteId, document_no: cnNo(1), actor_id: USER });
    const blob = JSON.stringify([w.db.events.slice(n), w.s.cbms, w.s.activity.slice(1)]);
    for (const secret of ['Synthetic Buyer One', '123456789', 'wanted it removed']) expect(blob, secret).not.toContain(secret);
  });
  it('defaults: amount_paisa omitted = the line\'s remaining; two lines in one note; numbers are gapless across notes and kinds (partial, partial, cancellation = CN 1,2,3)', async () => {
    const { w, a, id1, id2 } = await setup();
    const c1 = await credit(w, a.invoiceId, [{ invoiceLineId: id1 }, { invoiceLineId: id2 }]);
    expect(Number(w.x().creditNotes[0].net_paisa)).toBe(NET);
    expect(w.x().cnLines.filter((l) => l.credit_note_id === c1.creditNoteId)).toHaveLength(2);
    expect(invOf(w, a.invoiceId)).toMatchObject({ status: 'issued', credited_total_paisa: NET });
    const w2 = makeT10World(); const b = await issued(w2); const [x1, x2] = lineIds(w2, b.invoiceId);
    await credit(w2, b.invoiceId, [{ invoiceLineId: x2 }]); await credit(w2, b.invoiceId, [{ invoiceLineId: x1, amountPaisa: 1000 }]); await cancel(w2, b.invoiceId);
    expect(w2.x().creditNotes.map((c) => [c.credit_note_seq, c.credit_note_no, c.kind])).toEqual([[1, cnNo(1), 'partial'], [2, cnNo(2), 'partial'], [3, cnNo(3), 'cancellation']]);
  });
  it('credit notes of an invoice never exceed its net: line credited in two steps (100000 then the default remainder 13000) ends at exactly 113000 per line, per component, no cent drift', async () => {
    const { w, a, id1 } = await setup();
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100000 }]);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1 }]);
    const src = w.s.lines.find((l) => l.id === id1)!;
    for (const c of COMPONENTS) expect(sum(w.x().cnLines.filter((l) => l.invoice_line_id === id1), c), c).toBe(Number(src[c]));
  });
});

describe('component split: proportional, largest-remainder, always a valid credit_note_lines row (credit_note_lines__amounts__ck)', () => {
  it('exact halves: 56500 of 113000 taxable line -> gross 50000, taxable 50000, vat 6500, exempt 0', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 56500 }]);
    expect(w.x().cnLines[0]).toMatchObject({ net_paisa: 56500, gross_paisa: 50000, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 50000, vat_paisa: 6500, other_tax_paisa: 0 });
    expect(w.x().creditNotes[0]).toMatchObject({ net_paisa: 56500, gross_paisa: 50000, vat_paisa: 6500 });                       // note = sum of its lines
  });
  it('discounted line: 101700 net (gross 100000, discount 10000, taxable 90000, vat 11700), credit 50850 -> gross 50000, discount 5000, taxable 45000, vat 5850', async () => {
    const w = makeT10World(); const a = await issued(w, { lines: [L1], discounts: [{ scope: 'line', lineRef: 'L1', kind: 'amount', amountPaisa: 10000 }] });
    const [id1] = lineIds(w, a.invoiceId);
    expect(Number(w.s.lines[0].net_paisa)).toBe(101700);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 50850 }]);
    expect(w.x().cnLines[0]).toMatchObject({ net_paisa: 50850, gross_paisa: 50000, discount_paisa: 5000, taxable_paisa: 45000, vat_paisa: 5850 });
  });
  it('exempt line partial: 12345 of the 50000 exempt line -> exempt 12345, gross 12345, no VAT', async () => {
    const w = makeT10World(); const a = await issued(w); const [, id2] = lineIds(w, a.invoiceId);
    await credit(w, a.invoiceId, [{ invoiceLineId: id2, amountPaisa: 12345 }]);
    expect(w.x().cnLines[0]).toMatchObject({ net_paisa: 12345, gross_paisa: 12345, exempt_paisa: 12345, taxable_paisa: 0, vat_paisa: 0 });
  });
  for (const amount of [1, 2, 7, 33333, 56499, 99999, 112999]) {
    it(`awkward amount ${amount} of the 113000 line: net = amount exactly, every component within the line, ck holds, and crediting the REST afterwards lands exactly on the line (no drift)`, async () => {
      const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); const src = w.s.lines.find((l) => l.id === id1)!;
      await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: amount }]);     // the fake enforces credit_note_lines__amounts__ck on insert (throws otherwise)
      const first = w.x().cnLines[0];
      expect(Number(first.net_paisa)).toBe(amount);
      for (const c of COMPONENTS) { expect(Number(first[c]), c).toBeGreaterThanOrEqual(0); expect(Number(first[c]), c).toBeLessThanOrEqual(Number(src[c])); }
      expect(Number(first.net_paisa)).toBe(Number(first.exempt_paisa) + Number(first.taxable_paisa) + Number(first.vat_paisa) + Number(first.other_tax_paisa));
      await credit(w, a.invoiceId, [{ invoiceLineId: id1 }]);
      for (const c of COMPONENTS) expect(sum(w.x().cnLines, c), c).toBe(Number(src[c]));
    });
  }
});

describe('US-BL-05.2 over-credit -> 400 common.validation_failed at /lines/<i>/amount_paisa; nothing is written, no number is consumed', () => {
  const untouched = (w: T10World, notes: number, events: number) => {
    expect(w.x().creditNotes).toHaveLength(notes); expect(w.x().cnLines).toHaveLength(0); expect(w.db.events).toHaveLength(events);
  };
  it('amount above the line\'s remaining net -> path /lines/0/amount_paisa (400, not 422/409); counter not called; open task stays open', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); seedTask(w, { id: TASK_IDS.t1, invoice_id: a.invoiceId, invoice_line_ids: [id1!] });
    const n = w.db.events.length; const snap = structuredClone(invOf(w, a.invoiceId));
    const e = await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 113001 }], { resolvesTaskIds: [TASK_IDS.t1] }));
    expect([e.code, e.statusCode, e.errors?.map((x: any) => x.path)]).toEqual(['common.validation_failed', 400, ['/lines/0/amount_paisa']]);
    untouched(w, 0, n); expect(w.cnCalls()).toHaveLength(0); expect(invOf(w, a.invoiceId)).toEqual(snap); expect(task(w, TASK_IDS.t1).status).toBe('open');
  });
  it('the index points at the offending line (second line 50001 > 50000) and the FIRST valid line is not stored either (all or nothing)', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1, id2] = lineIds(w, a.invoiceId); const n = w.db.events.length;
    const e = await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 1000 }, { invoiceLineId: id2, amountPaisa: 50001 }]));
    expect(e.errors?.map((x: any) => x.path)).toEqual(['/lines/1/amount_paisa']);
    untouched(w, 0, n);
  });
  it('remaining is net MINUS what earlier credit notes took: 100000 credited, another 13001 -> rejected; exactly the remaining 13000 -> accepted', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100000 }]); const n = w.db.events.length; const notes = w.x().creditNotes.length;
    expect((await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 13001 }]))).errors?.map((x: any) => x.path)).toEqual(['/lines/0/amount_paisa']);
    expect(w.x().creditNotes).toHaveLength(notes); expect(w.db.events).toHaveLength(n);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 13000 }]);
    expect(invOf(w, a.invoiceId).credited_total_paisa).toBe(113000);
    expect((await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1 }]))).code).toBe('common.validation_failed'); // nothing remains: the default amount is never a 0-value note
  });
  it('the same line twice in one request cannot double-dip: 80000 + 80000 of a 113000 line -> rejected at /lines/1/invoice_line_id', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); const n = w.db.events.length;
    const e = await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 80000 }, { invoiceLineId: id1, amountPaisa: 80000 }]));
    expect([e.code, e.errors?.map((x: any) => x.path)]).toEqual(['common.validation_failed', ['/lines/1/invoice_line_id']]);
    untouched(w, 0, n);
  });
  for (const [name, amountPaisa, path] of [['zero', 0, '/lines/0/amount_paisa'], ['negative', -5, '/lines/0/amount_paisa'], ['fractional', 10.5, '/lines/0/amount_paisa'],
    ['string', '100', '/lines/0/amount_paisa'], ['beyond safe integer', 2 ** 53, '/lines/0/amount_paisa'], ['NaN', Number.NaN, '/lines/0/amount_paisa']] as const)
    it(`amount_paisa ${name} -> common.validation_failed ${path}`, async () => {
      const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); const n = w.db.events.length;
      const e = await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa }]));
      expect([e.code, e.errors?.map((x: any) => x.path)]).toEqual(['common.validation_failed', [path]]);
      untouched(w, 0, n); expect(w.cnCalls()).toHaveLength(0);
    });
  it('lines: [] / more than 200 / not an array -> /lines; a line id that is not a UUID, not on THIS invoice, or on another tenant\'s invoice -> /lines/0/invoice_line_id', async () => {
    const w = makeT10World(); const a = await issued(w); const b = await issued(w, { orderId: IDS.order2, lines: [line({ orderItemId: '01a1a98a-ac40-7000-8000-000000060009' })] });
    const foreign = { ...structuredClone(w.s.lines[0]), id: '01a1a98a-ac40-7000-8000-00000000f001', tenant_id: TENANT_B }; w.s.lines.push(foreign);
    for (const lines of [[], Array.from({ length: 201 }, () => ({ invoiceLineId: lineIds(w, a.invoiceId)[0] })), 'x']) {
      expect((await errCode(credit(w, a.invoiceId, lines as never))).errors?.map((x: any) => x.path), JSON.stringify(lines).slice(0, 30)).toEqual(['/lines']);
    }
    for (const id of ['not-a-uuid', lineIds(w, b.invoiceId)[0], foreign.id, '01a1a98a-ac40-7000-8000-00000000ffff']) {
      expect((await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id }]))).errors?.map((x: any) => x.path), String(id)).toEqual(['/lines/0/invoice_line_id']);
    }
    expect(w.x().creditNotes).toHaveLength(0); expect(w.cnCalls()).toHaveLength(0);
  });
});

describe('B5 reason rules and state', () => {
  it('reason other without / with blank text -> 422 billing.cancel_reason_required; with text accepted; reason_code malformed -> 400 /reason_code; reason_text > 500 -> /reason_text', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); const n = w.db.events.length;
    for (const reasonText of [undefined, '   ']) {
      const e = await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }], { reasonCode: 'other', reasonText }));
      expect([e.code, e.statusCode]).toEqual(['billing.cancel_reason_required', 422]);
    }
    for (const [over, path] of [[{ reasonCode: 'Bad Code!' }, '/reason_code'], [{ reasonCode: undefined }, '/reason_code'], [{ reasonText: 'a'.repeat(501) }, '/reason_text']] as const) {
      expect((await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }], over))).errors?.map((x: any) => x.path)).toEqual([path]);
    }
    expect(w.x().creditNotes).toHaveLength(0); expect(w.db.events).toHaveLength(n); expect(w.cnCalls()).toHaveLength(0);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }], { reasonCode: 'other', reasonText: 'goodwill' });
    expect(w.x().creditNotes[0]).toMatchObject({ reason_code: 'other', reason_text: 'goodwill' });
  });
  it('cancelled invoice -> 409 billing.invoice_already_cancelled; nothing written', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); await cancel(w, a.invoiceId);
    const n = w.db.events.length; const notes = w.x().creditNotes.length; const calls = w.cnCalls().length;
    const e = await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }]));
    expect([e.code, e.statusCode]).toEqual(['billing.invoice_already_cancelled', 409]);
    expect(w.x().creditNotes).toHaveLength(notes); expect(w.db.events).toHaveLength(n); expect(w.cnCalls()).toHaveLength(calls);
  });
  it('unknown invoice / invoice of another tenant -> 404 common.not_found, nothing written; input.tenantId is ignored', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId);
    const other = { ...structuredClone(invOf(w, a.invoiceId)), id: '01a1a98a-ac40-7000-8000-00000000b001', tenant_id: TENANT_B }; w.s.invoices.push(other);
    for (const [id, extra] of [['01a1a98a-ac40-7000-8000-00000000ffff', {}], [other.id, {}], [other.id, { tenantId: TENANT_B }]] as const) {
      expect((await errCode(credit(w, id, [{ invoiceLineId: id1, amountPaisa: 100 }], extra))).code).toBe('common.not_found');
    }
    expect(w.x().creditNotes).toHaveLength(0);
  });
  it('every repo call carries the caller\'s tenant; no actor / tx on the ctx -> auth.unauthenticated', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); const from = w.repoCalls.length;
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }]);
    expect(w.repoCalls.slice(from).every((c) => (c.args.tenantId ?? c.args.tenant_id) === TENANT_A)).toBe(true);
    for (const bad of [{ actor: undefined }, { tx: undefined }]) {
      expect((await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }], {}, w.ctx(bad)))).code).toBe('auth.unauthenticated');
    }
  });
  it('numbering: allocation LAST (no repo call between allocate and insertCreditNote); a failure after it (events) rolls everything back and the next note gets the same number', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId);
    await credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }]);
    expect(w.cnCalls()[0]).toMatchObject({ series: 'CN', fiscalYearBs: FY_LONG, actorId: USER });
    expect(w.cnCalls()[0].atRepoCall).toBe(w.repoCalls.findIndex((c) => c.name === 'insertCreditNote'));
    const snap = structuredClone(invOf(w, a.invoiceId)); const n = w.db.events.length;
    w.db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    expect(await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }]))).not.toBeInstanceOf(TypeError);
    expect(w.x().creditNotes).toHaveLength(1); expect(w.x().counters['CN']).toBe(1); expect(invOf(w, a.invoiceId)).toEqual(snap); expect(w.db.events).toHaveLength(n);
  });
});

describe('credit note number pattern problems (review BL-T10 item 2)', () => {
  it('missing or broken creditNoteNoPattern -> common.internal (declared on issuePartialCreditNote); no number allocated, nothing written', async () => {
    for (const numbering of [{ invoiceNoPattern: '{fy}-{seq:6}' }, { invoiceNoPattern: '{fy}-{seq:6}', creditNoteNoPattern: 'CN-{nope}-{seq:6}' }]) {
      const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); w.tenantSettings['numbering'] = numbering;
      const snap = structuredClone(invOf(w, a.invoiceId)); const n = w.db.events.length;
      expect((await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }]))).code).toBe('common.internal');
      expect(w.cnCalls()).toHaveLength(0); expect(w.x().creditNotes).toHaveLength(0); expect(invOf(w, a.invoiceId)).toEqual(snap); expect(w.db.events).toHaveLength(n);
    }
  });
});

describe('resolves_task_ids (B35 tasks): only open tasks of THIS invoice in THIS tenant', () => {
  it('several tasks resolved by one note; the repo is asked once for the whole list (no per-task writes in a loop that could half-apply)', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1, id2] = lineIds(w, a.invoiceId);
    seedTask(w, { id: TASK_IDS.t1, invoice_id: a.invoiceId, invoice_line_ids: [id1!] }); seedTask(w, { id: TASK_IDS.t2, invoice_id: a.invoiceId, invoice_line_ids: [id2!] });
    await credit(w, a.invoiceId, [{ invoiceLineId: id1 }, { invoiceLineId: id2 }], { resolvesTaskIds: [TASK_IDS.t1, TASK_IDS.t2] });
    expect([task(w, TASK_IDS.t1).status, task(w, TASK_IDS.t2).status]).toEqual(['resolved', 'resolved']);
    expect(w.repoCalls.filter((c) => c.name === 'resolveCreditNoteTasks')).toHaveLength(1);
  });
  it('a task of ANOTHER tenant or an unknown id -> 404 common.not_found (A11); nothing stored, the credit note is not issued', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId); const n = w.db.events.length;
    seedTask(w, { id: TASK_IDS.tB, tenant_id: TENANT_B, invoice_id: a.invoiceId, invoice_line_ids: [id1!] });
    for (const t of [TASK_IDS.tB, TASK_IDS.t3]) {
      expect((await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }], { resolvesTaskIds: [t] }))).code, t).toBe('common.not_found');
    }
    expect(w.x().creditNotes).toHaveLength(0); expect(w.db.events).toHaveLength(n); expect(w.x().counters['CN'] ?? 0).toBe(0); expect(task(w, TASK_IDS.tB).status).toBe('open');
  });
  it('a task that belongs to a different invoice of this tenant -> 400 common.validation_failed at /resolves_task_ids/0, task untouched, nothing stored', async () => {
    const w = makeT10World(); const a = await issued(w); const b = await issued(w, { orderId: IDS.order2, lines: [line({ orderItemId: '01a1a98a-ac40-7000-8000-000000060009' })] });
    seedTask(w, { id: TASK_IDS.t2, invoice_id: b.invoiceId, invoice_line_ids: lineIds(w, b.invoiceId), order_id: IDS.order2 }); const [id1] = lineIds(w, a.invoiceId);
    const e = await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }], { resolvesTaskIds: [TASK_IDS.t2] }));
    expect([e.code, e.errors?.map((x: any) => x.path)]).toEqual(['common.validation_failed', ['/resolves_task_ids/0']]);
    expect(task(w, TASK_IDS.t2).status).toBe('open'); expect(w.x().creditNotes).toHaveLength(0);
  });
  it('resolves_task_ids malformed (not an array, > 50 ids, non-UUID) -> 400 common.validation_failed on /resolves_task_ids…, nothing stored', async () => {
    const w = makeT10World(); const a = await issued(w); const [id1] = lineIds(w, a.invoiceId);
    seedTask(w, { id: TASK_IDS.t1, invoice_id: a.invoiceId, invoice_line_ids: [id1!] });
    for (const bad of ['x', Array.from({ length: 51 }, () => TASK_IDS.t1), ['nope']]) {
      const e = await errCode(credit(w, a.invoiceId, [{ invoiceLineId: id1, amountPaisa: 100 }], { resolvesTaskIds: bad }));
      expect(e.code, JSON.stringify(bad).slice(0, 20)).toBe('common.validation_failed');
      expect(e.errors?.every((x: any) => String(x.path).startsWith('/resolves_task_ids'))).toBe(true);
    }
    expect(w.x().creditNotes).toHaveLength(0); expect(task(w, TASK_IDS.t1).status).toBe('open');
  });
});
