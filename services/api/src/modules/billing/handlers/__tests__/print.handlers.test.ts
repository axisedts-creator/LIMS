// BL-T09 handlers: B3 printInvoice, B6 printCreditNote (request -> service mapping; the service logic is tested in service/__tests__/print.service.test.ts).
// Schema, auth, x-permission (billing.invoice.reprint) and x-idempotency: required (replay never reaches the handler) are enforced by the core pipeline from contracts/openapi/billing.yaml.
// Spec: 02-TRD §5 B3/B6 (200 InvoicePrint / CreditNotePrint), openapi PrintInvoiceRequest { reason_code? }, 07-SECURITY REQ-SEC-099.
// Fails now: handlers/index.ts maps both operationIds to the BL-T01 stub (common.service_unavailable).
// ASSUMED: handlers call createInvoiceService(...).print(ctx, { invoiceId, reasonCode? }) / .printCreditNote(ctx, { creditNoteId, reasonCode? }) and return { status: 200, body: <service result unchanged> }.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';

const h = vi.hoisted(() => ({ print: [] as any[], printCn: [] as any[], result: undefined as any, error: undefined as any }));
vi.mock('../../service/invoice.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createInvoiceService: () => ({
    print: async (ctx: any, input: any) => { h.print.push({ ctx, input }); if (h.error) throw h.error; return h.result; },
    printCreditNote: async (ctx: any, input: any) => { h.printCn.push({ ctx, input }); if (h.error) throw h.error; return h.result; },
  }),
}));
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const INV = V7('0000000a0001'), CN = V7('0000000c0001');
const hctx = (extra: Record<string, unknown> = {}) => ({ operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...makeCtxFor()('A'), ...extra }) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
const run = (op: string, r: unknown, c: unknown) => (handlers as any)[op](r, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const printed = { print_no: 2, copy_mark: 'Copy of Original / प्रतिलिपि', document: { id: INV, invoice_no: '083/84-000001', print_no: 2, copy_mark: 'Copy of Original / प्रतिलिपि' } };

beforeEach(() => { h.print.length = 0; h.printCn.length = 0; h.error = undefined; h.result = printed; });

describe('fail closed without an authenticated request context (REQ-SEC-099): not the BL-T01 503 stub', () => {
  for (const [op, params] of [['printInvoice', { invoice_id: INV }], ['printCreditNote', { credit_note_id: CN }]] as const) {
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated and the service is never called`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      const e = await fail(run(op, req({ params, body: {} }), bare));
      expect(e.code).toBe('auth.unauthenticated');
      expect(h.print.length + h.printCn.length).toBe(0);
    });
  }
});

describe('B3 printInvoice', () => {
  it('200 and the InvoicePrint body unchanged (print_no, copy_mark, document)', async () => {
    const out = await run('printInvoice', req({ params: { invoice_id: INV }, body: { reason_code: 'reprint' } }), hctx());
    expect(out.status).toBe(200);
    expect(out.body).toEqual(printed);
  });
  it('maps path invoice_id and body reason_code to the service; ctx is the request context (tenant/actor/tx from the pipeline)', async () => {
    const c = hctx();
    await run('printInvoice', req({ params: { invoice_id: INV }, body: { reason_code: 'printer_fault' } }), c);
    expect(h.print).toHaveLength(1);
    expect(h.print[0].input).toEqual({ invoiceId: INV, reasonCode: 'printer_fault' });
    expect(h.print[0].ctx.tenantId).toBe(makeCtxFor()('A').tenantId);
    expect(h.printCn).toHaveLength(0);
  });
  it('reason_code is optional: an empty or absent body -> the key is absent (not undefined / null)', async () => {
    await run('printInvoice', req({ params: { invoice_id: INV }, body: {} }), hctx());
    await run('printInvoice', req({ params: { invoice_id: INV } }), hctx());
    for (const c of h.print) expect(Object.keys(c.input)).toEqual(['invoiceId']);
  });
  it('the body cannot steer the count, the clock, the tenant or the actor: print_no, print_count, is_copy, printed_at, tenant_id, created_by never reach the service', async () => {
    await run('printInvoice', req({ params: { invoice_id: INV }, body: { reason_code: 'reprint', print_no: 1, print_count: 0, is_copy: false, printed_at: '2020-01-01T00:00:00Z', tenant_id: V7('0000000000ff'), created_by: V7('000000030009') } }), hctx());
    expect(Object.keys(h.print[0].input).sort()).toEqual(['invoiceId', 'reasonCode']);
  });
  it('service errors pass through unchanged (common.not_found, auth.forbidden, common.validation_failed)', async () => {
    for (const code of ['common.not_found', 'auth.forbidden', 'common.validation_failed']) {
      h.error = new LimsError(code as never);
      expect((await fail(run('printInvoice', req({ params: { invoice_id: INV }, body: {} }), hctx()))).code).toBe(code);
    }
  });
});

describe('B6 printCreditNote', () => {
  it('200 and the CreditNotePrint body unchanged; maps credit_note_id + reason_code to printCreditNote (not print)', async () => {
    const out = await run('printCreditNote', req({ params: { credit_note_id: CN }, body: { reason_code: 'customer_copy' } }), hctx());
    expect(out.status).toBe(200);
    expect(out.body).toEqual(printed);
    expect(h.printCn).toHaveLength(1);
    expect(h.printCn[0].input).toEqual({ creditNoteId: CN, reasonCode: 'customer_copy' });
    expect(h.print).toHaveLength(0);
  });
  it('reason_code optional; body cannot steer print_no / tenant', async () => {
    await run('printCreditNote', req({ params: { credit_note_id: CN }, body: { print_no: 1, tenant_id: V7('0000000000ff') } }), hctx());
    expect(Object.keys(h.printCn[0].input)).toEqual(['creditNoteId']);
  });
  it('service errors pass through unchanged', async () => {
    h.error = new LimsError('common.not_found');
    expect((await fail(run('printCreditNote', req({ params: { credit_note_id: CN } }), hctx()))).code).toBe('common.not_found');
  });
});
