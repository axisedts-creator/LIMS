// BL-T10 contract + fixture checks.
//  (1) US-BL-04.4 permission gating: the core pipeline enforces x-permission / privileged (aal2) from these files, so the AC is proved here at the source of truth:
//      cancelInvoice (B4) and issuePartialCreditNote (B5) both require `billing.invoice.cancel`, which is privileged and granted to `finance` only (front_desk -> 403 auth.forbidden;
//      finance at aal1 -> 403 auth.mfa_required is the core privileged rule). Both are Idempotency-Key required, and the documented error codes are the ones the services throw.
//  (2) US-BL-04.2/.3 + 05.2 error table: codes and HTTP statuses in contracts/errors.yaml.
//  (3) US-BL-02.3: no PUT/PATCH/DELETE route exists under invoices / credit-notes / ledger-entries.
//  (4) the BL-T10 fixtures (t10.helpers.ts) behave like the DB rules they model — this file PASSES now; it keeps the other BL-T10 suites honest.
// Not covered here (no module-level pipeline in a unit test): the actual 403s from the core pipeline for a front_desk / aal1 caller — that is core's privileged-operation test.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createInvoiceService } from '../invoice.service.js';
import { IDS, makeT10World, TENANT_A } from './t10.helpers.js';
import { errCode, issueInput, line } from './t06.helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const yaml = (p: string): any => parse(readFileSync(join(root, p), 'utf8'));
const openapi = yaml('contracts/openapi/billing.yaml');
const op = (path: string, method: string) => openapi.paths[path][method];
const walk = (n: any, out: any[] = []): any[] => { if (Array.isArray(n)) n.forEach((x) => walk(x, out)); else if (n && typeof n === 'object') { out.push(n); Object.values(n).forEach((x) => walk(x, out)); } return out; };

describe('US-BL-04.4 / REQ-SEC-062/067: B4 and B5 are privileged finance-only operations', () => {
  const perm = walk(yaml('contracts/permissions.yaml')).find((o) => o.code === 'billing.invoice.cancel');
  it('billing.invoice.cancel is privileged (aal2 + membership re-validation) and granted to finance ONLY', () => {
    expect(perm).toBeDefined();
    expect(perm.privileged).toBe(true);
    expect(perm.roles).toEqual(['finance']);
  });
  for (const [id, path] of [['cancelInvoice', '/v1/billing/invoices/{invoice_id}/cancel'], ['issuePartialCreditNote', '/v1/billing/invoices/{invoice_id}/credit-notes']] as const)
    it(`${id}: POST ${path}, x-permission billing.invoice.cancel, tenant context, Idempotency-Key required, documents the service errors`, () => {
      const o = op(path, 'post');
      expect([o.operationId, o['x-permission'], o['x-context'], o['x-idempotency']]).toEqual([id, 'billing.invoice.cancel', 'tenant', 'required']);
      expect(o['x-error-codes']).toEqual(expect.arrayContaining(['billing.invoice_already_cancelled', 'billing.cancel_reason_required', 'billing.counter_busy', 'common.validation_failed',
        'common.not_found', 'auth.forbidden', 'common.version_conflict', 'common.precondition_required']));
      expect(Object.keys(openapi.paths[path])).toEqual(['post']);                       // nothing else on the route
    });
  it('listCreditNoteTasks (B35): GET /v1/billing/credit-note-tasks needs billing.invoice.read (not privileged), status defaults to open', () => {
    const o = op('/v1/billing/credit-note-tasks', 'get');
    expect([o.operationId, o['x-permission']]).toEqual(['listCreditNoteTasks', 'billing.invoice.read']);
    expect(o.parameters.find((p: any) => p.name === 'status').schema.default).toBe('open');
    expect(walk(yaml('contracts/permissions.yaml')).find((p) => p.code === 'billing.invoice.read').privileged).toBe(false);
  });
  it('request bodies: B4 {reason_code, reason_text<=500}; B5 {lines 1..200 {invoice_line_id, amount_paisa>=1}, reason_code, reason_text, resolves_task_ids<=50}; no unknown fields', () => {
    const s = openapi.components.schemas;
    expect([s.CancelInvoiceRequest.additionalProperties, s.CancelInvoiceRequest.required, s.CancelInvoiceRequest.properties.reason_text.maxLength]).toEqual([false, ['reason_code'], 500]);
    const p = s.PartialCreditNoteRequest;
    expect([p.additionalProperties, p.required.sort(), p.properties.lines.minItems, p.properties.lines.maxItems, p.properties.lines.items.properties.amount_paisa.minimum, p.properties.resolves_task_ids.maxItems])
      .toEqual([false, ['lines', 'reason_code'], 1, 200, 1, 50]);
  });
});

describe('error table (contracts/errors.yaml)', () => {
  const errors = walk(yaml('contracts/errors.yaml')).filter((o) => typeof o.code === 'string');
  const http = (c: string) => errors.find((e) => e.code === c)?.http;
  it('billing.invoice_already_cancelled 409, billing.cancel_reason_required 422, common.validation_failed 400 only (08 A13 P-1), common.not_found 404, billing.counter_busy 409/503-class as registered', () => {
    expect([http('billing.invoice_already_cancelled'), http('billing.cancel_reason_required'), http('common.validation_failed'), http('common.not_found')]).toEqual([409, 422, 400, 404]);
    expect(http('billing.counter_busy')).toBeDefined();
  });
});

describe('US-BL-02.3: no edit / delete route for fiscal documents', () => {
  it('nothing but GET/POST under /v1/billing/invoices|credit-notes|ledger-entries (no PUT/PATCH/DELETE)', () => {
    const bad = Object.entries(openapi.paths).filter(([p]) => /^\/v1\/billing\/(invoices|credit-notes|ledger-entries)/.test(p))
      .flatMap(([p, item]: [string, any]) => Object.keys(item).filter((m) => ['put', 'patch', 'delete'].includes(m)).map((m) => `${m} ${p}`));
    expect(bad).toEqual([]);
  });
});

describe('BL-T10 fixtures model the DB rules (so the other suites fail only for the right reason)', () => {
  const svc = (w: ReturnType<typeof makeT10World>) => createInvoiceService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never });
  async function one() {
    const w = makeT10World(); const ctx = w.ctx(); const input = await issueInput(ctx, { lines: [line()] });
    const ref = await w.tx(() => svc(w).issue(ctx, input as never));
    return { w, ref };
  }
  it('an issued invoice gets version 1, credited_total 0, cancellation columns NULL; INV and CN counters are separate and roll back with the tx', async () => {
    const { w, ref } = await one();
    expect(w.s.invoices[0]).toMatchObject({ id: ref.invoiceId, version: 1, credited_total_paisa: 0, cancelled_at: null, credit_note_id: null, cbms_cancel_state: null });
    expect(w.x().counters).toEqual({ INV: 1 });
    await expect(w.tx(async () => { await w.counter.allocate({}, { series: 'CN' }); throw new Error('x'); })).rejects.toThrow('x');
    expect(w.x().counters).toEqual({ INV: 1 });
    expect(await w.counter.allocate({}, { series: 'CN' })).toMatchObject({ lastNo: 1 });
  });
  it('the fake DB refuses what the real one refuses: cancelling twice, un-crediting, a zero-value or unbalanced credit note line, a second cancellation note for one invoice', async () => {
    const { w, ref } = await one(); const base = { tenantId: TENANT_A, invoiceId: ref.invoiceId, userId: 'u' };
    const cancelArgs = { ...base, cancelledAt: 'x', cancelledBy: 'u', reasonCode: 'c', creditNoteId: 'n', creditedTotalPaisa: 113000, cbmsCancelState: 'pending' };
    await (w.repo as any).markInvoiceCancelled({}, cancelArgs);
    expect((await errCode((w.repo as any).markInvoiceCancelled({}, cancelArgs))).detail).toBe('billing.invoices');
    const w2 = (await one()).w;
    expect((await errCode((w2.repo as any).markInvoiceCancelled({}, { ...cancelArgs, invoiceId: w2.s.invoices[0].id, cbmsCancelState: 'synced' }))).message).toBe('immutable_row');
    expect((await errCode((w2.repo as any).addInvoiceCredit({}, { tenantId: TENANT_A, invoiceId: w2.s.invoices[0].id, creditedTotalPaisa: 113001, userId: 'u' }))).message).toBe('invoices__credited__ck');
    const ln = { tenant_id: TENANT_A, credit_note_id: 'n', invoice_line_id: 'l', gross_paisa: 100, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 100, vat_paisa: 13, other_tax_paisa: 0, net_paisa: 113 };
    await (w2.repo as any).insertCreditNoteLines({}, [ln]);
    for (const bad of [{ net_paisa: 0 }, { net_paisa: 114 }, { gross_paisa: 101 }]) expect((await errCode((w2.repo as any).insertCreditNoteLines({}, [{ ...ln, ...bad }]))).message).toBe('credit_note_lines__amounts__ck');
    const note = { tenant_id: TENANT_A, invoice_id: ref.invoiceId, kind: 'cancellation', series: 'CN', fiscal_year_bs: '2083/84', credit_note_seq: 1, issued_at: '2026-11-08T06:00:05.000Z', net_paisa: 113 };
    await (w2.repo as any).insertCreditNote({}, note);
    expect((await errCode((w2.repo as any).insertCreditNote({}, { ...note, credit_note_seq: 2 }))).constraint).toBe('credit_notes__tenant_id_invoice_cancellation__p_uq');
    expect((await errCode((w2.repo as any).insertCreditNote({}, { ...note, kind: 'partial', credit_note_seq: 1 }))).message).toBe('chronology_violation');
  });
  it('readOrderTotals reports credited = sum of credit notes of the order; the order id of IDS is what the services use', async () => {
    const { w } = await one();
    w.x().creditNotes.push({ tenant_id: TENANT_A, order_id: IDS.order, net_paisa: 500 });
    expect((await (w.repo as any).readOrderTotals({}, { tenantId: TENANT_A, orderId: IDS.order })).credited_paisa).toBe('500');
  });
});
