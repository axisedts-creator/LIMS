// BL-T06 invoice issue (service/invoice.service.ts#issue): number allocation LAST, invoice + lines + activity + CBMS job, balance, and the two events at their exact triggers.
// PRD US-BL-01.1–.5, US-BL-13.1/.3, US-FD-03.1/.4/.5; 02-TRD §6.3 (issueOrderInvoice), §8.1, §9, §12; 03-APP-FLOW state table row `issued`; 07-SECURITY (no PHI in events/activity, tenant scoping).
// done_when: "Issued/balance events at exact triggers; balance_version strictly increasing; one balance event per change".
// Fails now: ../invoice.service.js does not exist.
// ASSUMED API (writer: object via a dispute if wrong):
//   invoice.service.ts : createInvoiceService(deps: { repo, counter, events }) -> { issue(ctx, input) } ; balance via createBalanceService over the same repo/events (balance.service.test.ts)
//   input  = BillingCommandPort.issueOrderInvoice input (TRD §6.3) + optional branchCode (series INV:<branchCode> under branch scope) + optional `entry` (LD-25, invoice.downtime.test.ts)
//   output = IssuedInvoiceRef { invoiceId, invoiceNo, fiscalYearBs, issuedAt, totals }  (invoiceNo from IdentityPort numbering.invoiceNoPattern via domain/numberFormat; issuedAt = counter allocatedAt)
//   Order inside the tx: fingerprint check (computeQuote) -> counter.allocate (LAST before the insert) -> insertInvoice -> insertInvoiceLines -> activity -> CBMS job/state -> balance -> events (invoice.issued, then balance.changed).
//   Any throw leaves nothing behind (the caller's tx rolls back; the counter bump with it).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { createBillingEvents } from '../../events/publish.js';
import { createInvoiceService } from '../invoice.service.js';
import { errCode, FY_LONG, FY_SHORT, IDS, issueInput, line, makeWorld, money, rejection, TENANT_A, USER, REQ_ID, type World } from './t06.helpers.js';

const svcOf = (w: World) => createInvoiceService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never });
const issue = async (w: World, over: Record<string, unknown> = {}, ctx = w.ctx()) => {
  const svc = svcOf(w); const input = await issueInput(ctx, over);
  return w.tx(() => svc.issue(ctx, input as never));
};
const types = (w: World) => w.db.events.map((e) => e.eventType);

describe('US-FD-03.1 happy path: one tx stores the invoice and emits each event exactly once', () => {
  it('returns the IssuedInvoiceRef; invoice row is issued/active with the tenant-pattern number, seq 1, series INV, FY 2083/84', async () => {
    const w = makeWorld();
    const ref = await issue(w);
    expect(ref).toMatchObject({ invoiceNo: `${FY_SHORT}-000001`, fiscalYearBs: FY_LONG });
    expect(ref.totals).toMatchObject({ gross: { amountPaisa: 100000 }, vat: { amountPaisa: 13000 }, net: { amountPaisa: 113000 } });
    expect(w.s.invoices).toHaveLength(1);
    expect(w.s.invoices[0]).toMatchObject({
      id: ref.invoiceId, tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, series: 'INV', fiscal_year_bs: FY_LONG, invoice_seq: 1, invoice_no: ref.invoiceNo,
      invoice_kind: 'tax_invoice', purpose: 'registration', order_id: IDS.order, patient_id: IDS.patient, is_periodic_credit_bill: false, buyer_name: 'Synthetic Buyer One',
      seller_name: 'Synthetic Lab Pvt Ltd', gross_paisa: 100000, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 100000, vat_paisa: 13000, other_tax_paisa: 0, net_paisa: 113000,
      status: 'issued', is_active: true, print_count: 0, created_by: USER, updated_by: USER,
    });
    expect(w.s.invoices[0].issued_at).toBe(ref.issuedAt);
    expect(w.s.invoices[0].quote_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(w.s.invoices[0].invoice_date_bs).toMatch(/^2083-\d{2}-\d{2}$/);
  });
  it('lines snapshot the quote (rates included), line_no from 1, kind orderable, amounts add up to the invoice', async () => {
    const w = makeWorld();
    await issue(w, { lines: [line(), line({ lineRef: 'L2', code: 'LIP', name: 'Lipid profile', unitPrice: { amountPaisa: 50000, currency: 'NPR' }, tax: { vat: 'exempt' } })] });
    expect(w.s.lines.map((l) => [l.line_no, l.line_kind, l.code, l.vat_treatment, l.vat_rate_bp ?? null, l.net_paisa])).toEqual([
      [1, 'orderable', 'CBC', 'taxable', 1300, 113000], [2, 'orderable', 'LIP', 'exempt', null, 50000]]);
    expect(w.s.lines.every((l) => l.tenant_id === TENANT_A && l.invoice_id === w.s.invoices[0].id)).toBe(true);
    expect(w.s.lines.reduce((t, l) => t + Number(l.net_paisa), 0)).toBe(Number(w.s.invoices[0].net_paisa));
  });
  it('exactly one billing.invoice.issued.v1 (key <id>:issued, seq 1, order shape, totals as integer Money) THEN exactly one billing.balance.changed.v1 (cause invoice_issued, version 1)', async () => {
    const w = makeWorld();
    const ref = await issue(w);
    expect(types(w)).toEqual(['billing.invoice.issued.v1', 'billing.balance.changed.v1']);
    const [iss, bal] = w.db.events.map((e) => e.envelope);
    expect(iss.idempotency_key).toBe(`${ref.invoiceId}:issued`);
    expect(iss.aggregate).toEqual({ type: 'invoice', id: ref.invoiceId, seq: 1 });
    expect(iss.payload).toEqual({
      invoice_id: ref.invoiceId, invoice_no: ref.invoiceNo, fiscal_year_bs: FY_LONG, invoice_kind: 'tax_invoice', order_id: IDS.order, branch_id: IDS.branch, centre_id: IDS.centre,
      issued_at: ref.issuedAt, totals: { gross: money(100000), discount: money(0), exempt: money(0), taxable: money(100000), vat: money(13000), other_tax: money(0), net: money(113000) },
    });
    expect(bal.idempotency_key).toBe(`${IDS.order}:balance:1`);
    expect(bal.payload).toMatchObject({ order_id: IDS.order, balance_version: 1, invoiced: money(113000), paid: money(0), credited: money(0), balance_due: money(113000), cause: 'invoice_issued' });
  });
  it('no PHI in either event or in the activity details: no buyer name / PAN / address / patient id', async () => {
    const w = makeWorld();
    await issue(w);
    const blob = JSON.stringify([w.db.events.map((e) => e.envelope.payload), w.s.activity.map((a) => a.details)]);
    for (const s of ['Synthetic Buyer One', '123456789', 'Synthetic Street 1', IDS.patient]) expect(blob).not.toContain(s);
  });
  it('activity: one invoice_issued row (document invoice/id/no, centre, actor, request id, occurred_at = issued_at)', async () => {
    const w = makeWorld();
    const ref = await issue(w);
    expect(w.s.activity).toHaveLength(1);
    expect(w.s.activity[0]).toMatchObject({ tenant_id: TENANT_A, action: 'invoice_issued', document_kind: 'invoice', document_id: ref.invoiceId, document_no: ref.invoiceNo,
      centre_id: IDS.centre, actor_id: USER, actor_type: 'user', request_id: REQ_ID, occurred_at: ref.issuedAt, created_by: USER });
  });
  it('20 sequential issues for 20 orders: seq 1..20 gapless, issued_at non-decreasing, 20 issued + 20 balance events, every balance event is version 1', async () => {
    const w = makeWorld(); const svc = svcOf(w); const ctx = w.ctx();
    for (let i = 0; i < 20; i++) {
      const order = `01a1a98a-ac40-7000-8000-0000000c${String(i).padStart(4, '0')}`;
      await w.tx(async () => svc.issue(ctx, await issueInput(ctx, { orderId: order }) as never));
    }
    expect(w.s.invoices.map((i) => i.invoice_seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const at = w.s.invoices.map((i) => i.issued_at); expect([...at].sort()).toEqual(at);
    expect(w.events_of('billing.invoice.issued.v1')).toHaveLength(20);
    const bal = w.events_of('billing.balance.changed.v1'); expect(bal).toHaveLength(20);
    expect(bal.every((e) => e.envelope.payload.balance_version === 1)).toBe(true);
  });
  it('a supplementary invoice on the same order: next number, second balance event at version 2 (strictly increasing)', async () => {
    const w = makeWorld();
    await issue(w);
    const second = await issue(w, { purpose: 'supplementary', lines: [line({ lineRef: 'S1', code: 'TSH', name: 'TSH', unitPrice: { amountPaisa: 20000, currency: 'NPR' } })] });
    expect(second.invoiceNo).toBe(`${FY_SHORT}-000002`);
    expect(w.events_of('billing.balance.changed.v1').map((e) => [e.envelope.payload.balance_version, e.envelope.payload.invoiced.amount_paisa])).toEqual([[1, 113000], [2, 113000 + 22600]]);
    expect(w.events_of('billing.invoice.issued.v1')).toHaveLength(2);
  });
});

describe('numbering (US-BL-01, TRD §12): allocated LAST, once, with the right key', () => {
  it('one allocate call: series INV, FY 2083/84, actor = ctx.actor.id, tenant pattern forwarded, after every read and before the first insert', async () => {
    const w = makeWorld();
    await issue(w);
    expect(w.counterCalls).toHaveLength(1);
    expect(w.counterCalls[0]).toMatchObject({ tenantId: TENANT_A, series: 'INV', fiscalYearBs: FY_LONG, actorId: USER });
    const firstInsert = w.repoCalls.findIndex((c) => c.name === 'insertInvoice');
    expect(firstInsert).toBeGreaterThan(-1);
    expect(w.counterCalls[0].atRepoCall).toBe(firstInsert); // no repo write between allocate and the invoice insert
  });
  it('branch scope: series INV:<branchCode> and the pattern with {branch} is used (US-BL-01.5)', async () => {
    const w = makeWorld({ billingSettings: { invoice_series_scope: 'branch' }, tenantSettings: { numbering: { invoiceNoPattern: '{branch}/{fy}-{seq:6}' } } });
    const ref = await issue(w, { branchCode: 'KTM' });
    expect(w.counterCalls[0].series).toBe('INV:KTM');
    expect(ref.invoiceNo).toBe(`KTM/${FY_SHORT}-000001`);
    expect(w.s.invoices[0].series).toBe('INV:KTM');
  });
  it('branch scope but the pattern lost {branch} -> 409 billing.numbering_pattern_invalid; nothing stored, no event, counter untouched (US-BL-01.5)', async () => {
    const w = makeWorld({ billingSettings: { invoice_series_scope: 'branch' } }); // default pattern has no {branch}
    const e = await errCode(issue(w, { branchCode: 'KTM' }));
    expect(e.code).toBe('billing.numbering_pattern_invalid');
    expect(w.s.invoices).toEqual([]); expect(w.db.events).toEqual([]); expect(w.s.counterNo).toBe(0);
  });
  it('counter errors pass through unchanged and leave nothing: counter_busy (retryAfterSeconds), fiscal_year_closed, fiscal-year rollover detail (US-BL-01.4, D-25)', async () => {
    for (const mk of [
      () => Object.assign(new LimsError('billing.counter_busy'), { retryAfterSeconds: 1 }),
      () => new LimsError('billing.fiscal_year_closed'),
      () => new LimsError('billing.counter_busy', 'fiscal_year_rollover'),
    ]) {
      const w = makeWorld(); w.counterFail = mk;
      const expected = mk();
      const e = await errCode(issue(w));
      expect(e.code).toBe(expected.code);
      expect((e as { retryAfterSeconds?: number }).retryAfterSeconds).toBe((expected as { retryAfterSeconds?: number }).retryAfterSeconds);
      expect(w.s.invoices).toEqual([]); expect(w.s.lines).toEqual([]); expect(w.s.activity).toEqual([]); expect(w.s.cbms).toEqual([]); expect(w.db.events).toEqual([]); expect(w.db.jobs).toEqual([]);
    }
  });
  it('US-FD-03.5 gapless: a failure AFTER allocation (event schema failure) rolls the counter back; the next invoice gets the same number', async () => {
    const w = makeWorld();
    const realInsert = w.repo.insertInvoiceLines;
    w.repo.insertInvoiceLines = async () => { throw new Error('injected: failure after the number was allocated'); };
    await rejection(issue(w));
    expect(w.counterCalls).toHaveLength(1); // it did allocate …
    expect(w.s.counterNo).toBe(0); expect(w.s.invoices).toEqual([]); expect(w.s.activity).toEqual([]); expect(w.s.cbms).toEqual([]); // … and everything rolled back
    expect(w.db.events).toEqual([]); expect(w.db.jobs).toEqual([]);
    w.repo.insertInvoiceLines = realInsert;
    const ref = await issue(w); // the same number is handed out again
    expect(ref.invoiceNo).toBe(`${FY_SHORT}-000001`); expect(w.s.invoices.map((i) => i.invoice_seq)).toEqual([1]);
  });
  it('a failure of the event publisher itself (schema/DB) after allocation also rolls everything back, event and job rows included', async () => {
    const w = makeWorld();
    w.db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    await rejection(issue(w));
    expect(w.s.counterNo).toBe(0); expect(w.s.invoices).toEqual([]); expect(w.s.lines).toEqual([]); expect(w.s.activity).toEqual([]); expect(w.s.cbms).toEqual([]);
    expect(w.db.events).toEqual([]); expect(w.db.jobs).toEqual([]);
  });
});

describe('US-FD-03.4 / contract cases 2, 6: refusals consume nothing', () => {
  it('fingerprint mismatch -> 409 common.version_conflict; counter not called, nothing stored, no event', async () => {
    const w = makeWorld();
    const e = await errCode(issue(w, { expectedFingerprint: 'f'.repeat(64) }));
    expect(e.code).toBe('common.version_conflict');
    expect(w.counterCalls).toEqual([]); expect(w.s.invoices).toEqual([]); expect(w.db.events).toEqual([]); expect(w.s.counterNo).toBe(0);
  });
  it('a second registration invoice for the same order -> common.validation_failed (unique index mapped), its number rolled back, no extra event', async () => {
    const w = makeWorld();
    await issue(w);
    const e = await errCode(issue(w));
    expect(e.code).toBe('common.validation_failed');
    expect(w.s.invoices).toHaveLength(1); expect(w.s.counterNo).toBe(1);
    expect(w.events_of('billing.invoice.issued.v1')).toHaveLength(1); expect(w.events_of('billing.balance.changed.v1')).toHaveLength(1);
  });
  it('tax config missing on a line propagates catalog.tax_config_missing (422), nothing stored', async () => {
    const w = makeWorld(); const ctx = w.ctx(); const svc = svcOf(w);
    const input = await issueInput(ctx);
    (input.lines[0] as { tax: Record<string, unknown> }).tax = { vat: 'taxable' };
    const e = await errCode(w.tx(() => svc.issue(ctx, input as never)));
    expect(e.code).toBe('catalog.tax_config_missing');
    expect(w.s.invoices).toEqual([]); expect(w.counterCalls).toEqual([]);
  });
  it('bad ids / empty lines / missing buyer name -> common.validation_failed before any counter or repo write', async () => {
    for (const over of [{ orderId: 'nope' }, { centreId: undefined }, { lines: [] }, { buyer: { name: '' } }, { purpose: 'periodic_credit' }, { purpose: 'other' }]) {
      const w = makeWorld();
      const e = await errCode(issue(w, over));
      expect(e.code, JSON.stringify(Object.keys(over))).toBe('common.validation_failed');
      expect(w.counterCalls).toEqual([]); expect(w.s.invoices).toEqual([]); expect(w.db.events).toEqual([]);
    }
  });
  it('tenant isolation: tenant id comes from ctx only; a tenantId/tenant_id smuggled in the input is ignored', async () => {
    const w = makeWorld();
    await issue(w, { tenantId: 'ffffffff-ffff-7fff-8fff-ffffffffffff', tenant_id: 'ffffffff-ffff-7fff-8fff-ffffffffffff' });
    expect(w.s.invoices[0].tenant_id).toBe(TENANT_A);
    expect(w.repoCalls.every((c) => (c.args.tenantId ?? c.args.tenant_id) === TENANT_A)).toBe(true);
    expect(w.counterCalls[0].tenantId).toBe(TENANT_A);
    expect(w.db.events.every((e) => e.tenantId === TENANT_A)).toBe(true);
  });
});

describe('US-BL-13.1 / .3 CBMS: job in the same transaction, never marked synced', () => {
  it('cbmsRealtimeRequired=true -> cbms_state pending, ONE sync job for this invoice, cbms_synced_at absent, no submission written by issue', async () => {
    const w = makeWorld();
    const ref = await issue(w);
    expect(w.s.invoices[0]).toMatchObject({ cbms_state: 'pending', cbms_attempts: 0 });
    expect(w.s.invoices[0].cbms_synced_at ?? null).toBeNull();
    expect(w.s.cbms).toEqual([{ tenantId: TENANT_A, documentKind: 'invoice', documentId: ref.invoiceId }]);
  });
  it('cbmsRealtimeRequired=false -> cbms_state not_required and no job', async () => {
    const w = makeWorld({ tenantSettings: { ird: { pan: '999999999', cbmsRealtimeRequired: false } } });
    await issue(w);
    expect(w.s.invoices[0].cbms_state).toBe('not_required'); expect(w.s.cbms).toEqual([]);
  });
  it('the job is rolled back with the transaction (failure after enqueue leaves no job)', async () => {
    const w = makeWorld();
    w.db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    await rejection(issue(w));
    expect(w.s.cbms).toEqual([]);
  });
});

describe('events are published only on success, at commit of the issuing transaction', () => {
  it('a rejected issue publishes nothing (no orphan billing.* event rows, no fan-out job)', async () => {
    const w = makeWorld(); w.counterFail = () => new LimsError('billing.counter_busy');
    await rejection(issue(w));
    expect(w.db.events).toEqual([]); expect(w.db.jobs).toEqual([]);
  });
  it('two committed issues -> fan-out jobs only for committed events (2 invoice + 2 balance events => 4 jobs)', async () => {
    const w = makeWorld();
    await issue(w); await issue(w, { orderId: IDS.order2 });
    expect(w.db.events).toHaveLength(4); expect(w.db.jobs).toHaveLength(4);
  });
});
