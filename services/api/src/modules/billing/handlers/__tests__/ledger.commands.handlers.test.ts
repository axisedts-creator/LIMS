// BL-T08 command handlers: B8 recordPayment, B17 getMyCashSession / closeCashSession (contract tests of the request -> service mapping; services are mocked here, their logic is
// tested in service/__tests__/ledger.payment.test.ts and cash.service.test.ts). Schema, auth and x-permission (billing.payment.record) are enforced by the core pipeline.
// Spec: 02-TRD §5 B8 (201 {ledger_entry, balance, receipt_no}), B17; openapi RecordPaymentRequest/RecordPaymentResult/CashSessionDto/CloseCashSessionRequest; REQ-SEC-050/051/099.
// Fails now: handlers/index.ts maps these operationIds to the BL-T01 stub (common.service_unavailable).
// ASSUMED: handlers call createLedgerService(...).recordPayment(ctx, input) and createCashService(...).getMyCashSession(ctx) / .closeCashSession(ctx, {sessionId, expectedVersion, counted, note})
//   (same factory style as invoice.handlers.ts / settings.handlers.ts); If-Match handling as settings.handlers.ts (absent -> undefined, malformed -> 0, "<n>" -> n; ETag `"<version>"` on CashSessionDto).
//   recordPayment's result carries `entry` (LedgerEntryDto) in addition to the port fields - see ledger.payment.test.ts header.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';

const h = vi.hoisted(() => ({
  pay: [] as any[], close: [] as any[], get: [] as any[],
  payResult: undefined as any, payError: undefined as any, cashResult: undefined as any, closeError: undefined as any,
}));
vi.mock('../../service/ledger.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createLedgerService: () => ({ recordPayment: async (ctx: any, input: any) => { h.pay.push({ ctx, input }); if (h.payError) throw h.payError; return h.payResult; } }),
}));
vi.mock('../../service/cash.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createCashService: () => ({
    getMyCashSession: async (ctx: any) => { h.get.push({ ctx }); return h.cashResult; },
    closeCashSession: async (ctx: any, input: any) => { h.close.push({ ctx, input }); if (h.closeError) throw h.closeError; return h.cashResult; },
  }),
}));
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const ORDER = V7('000000050001'), INV = V7('000000a00001'), SESSION = V7('0000000d0001'), CENTRE = V7('000000020002'), MEMBER = V7('000000030001');
const M = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const NPR = (n: number) => ({ amountPaisa: n, currency: 'NPR' });
const hctx = (extra: Record<string, unknown> = {}) => ({ operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...makeCtxFor()('A'), ...extra }) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
const run = (op: string, r: unknown, c: unknown) => (handlers as any)[op](r, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

const entryDto = { id: V7('000000900001'), entry_kind: 'payment', capture_kind: 'manual', order_id: ORDER, method_code: 'card', amount: M(125000), receipt_no: 'RC-083/84-000001', created_at: '2026-11-08T06:00:01.000Z', business_date_bs: '2083-07-22' };
const balance = { orderId: ORDER, invoiced: NPR(225000), paid: NPR(225000), credited: NPR(0), balanceDue: NPR(0), balanceVersion: 3, asOf: '2026-11-08T06:00:01.000Z' };
const sessionDto = { id: SESSION, opened_by: { membership_id: MEMBER, display_name: 'Synthetic Cashier' }, centre_id: CENTRE, status: 'closed', opened_at: '2026-11-08T05:00:00.000Z', closed_at: '2026-11-08T06:00:00.000Z',
  rows: [{ method_code: 'cash', expected: M(1050000), counted: M(1045000), variance: M(-5000) }], note: 'n', version: 2 };

beforeEach(() => { h.pay.length = 0; h.close.length = 0; h.get.length = 0; h.payError = undefined; h.closeError = undefined; h.payResult = { ledgerEntryId: entryDto.id, receiptNo: 'RC-083/84-000001', duplicate: false, exceedsDue: false, balance, entry: entryDto }; h.cashResult = sessionDto; });

describe('fail closed without an authenticated request context (REQ-SEC-099): not the BL-T01 503 stub', () => {
  for (const op of ['recordPayment', 'getMyCashSession', 'closeCashSession']) {
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated and the service is never called`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      const e = await fail(run(op, req({ params: { order_id: ORDER, cash_session_id: SESSION }, headers: { 'idempotency-key': 'k', 'if-match': '"1"' }, body: { method_code: 'cash', amount_received_paisa: 1, counted: [] } }), bare));
      expect(e.code).toBe('auth.unauthenticated'); expect(h.pay.length + h.close.length + h.get.length).toBe(0);
    });
  }
});

describe('B8 recordPayment', () => {
  const body = { method_code: 'card', amount_received_paisa: 125000, reference: 'POS-AB12', invoice_id: INV };
  const r = (over: Record<string, unknown> = {}, headers: Record<string, unknown> = { 'idempotency-key': 'K-1' }) => req({ params: { order_id: ORDER }, headers, body: { ...body, ...over } });

  it('201 RecordPaymentResult: ledger_entry = LedgerEntryDto, balance = OrderBalanceDto (snake_case Money), receipt_no', async () => {
    const out = await run('recordPayment', r(), hctx());
    expect(out.status).toBe(201);
    expect(Object.keys(out.body).sort()).toEqual(['balance', 'ledger_entry', 'receipt_no']);
    expect(out.body.ledger_entry).toEqual(entryDto);
    expect(out.body.receipt_no).toBe('RC-083/84-000001');
    expect(out.body.balance).toEqual({ order_id: ORDER, invoiced: M(225000), paid: M(225000), credited: M(0), balance_due: M(0), balance_version: 3, as_of: '2026-11-08T06:00:01.000Z' });
  });
  it('maps the request: path order_id, body method/amount/reference/invoice_id, Idempotency-Key header; captureKind manual; issueReceiptNo true; amount as integer Money', async () => {
    await run('recordPayment', r(), hctx());
    expect(h.pay).toHaveLength(1);
    expect(h.pay[0].input).toMatchObject({ orderId: ORDER, invoiceId: INV, methodCode: 'card', amount: NPR(125000), reference: 'POS-AB12', captureKind: 'manual', issueReceiptNo: true });
    expect(typeof h.pay[0].input.idempotencyKey).toBe('string'); expect(h.pay[0].input.idempotencyKey).toContain('K-1');
  });
  it('body cannot steer attribution: tenant_id, capture_kind, collected_by_membership_id, created_by, issue_receipt_no in the body never reach the service', async () => {
    await run('recordPayment', r({ tenant_id: V7('0000000000ff'), capture_kind: 'home_collection', collected_by_membership_id: MEMBER, created_by: MEMBER, issue_receipt_no: false, cash_session_id: SESSION }), hctx());
    const i = h.pay[0].input;
    expect(i.captureKind).toBe('manual'); expect(i.issueReceiptNo).toBe(true);
    for (const k of ['tenantId', 'tenant_id', 'collectedByMembershipId', 'createdBy', 'cashSessionId', 'capture_kind']) expect(Object.keys(i), k).not.toContain(k);
    expect(h.pay[0].ctx.tenantId).toBe(makeCtxFor()('A').tenantId);
  });
  it('invoice_id and reference are optional: omitted keys are absent (not undefined/null strings)', async () => {
    await run('recordPayment', req({ params: { order_id: ORDER }, headers: { 'idempotency-key': 'K-2' }, body: { method_code: 'cash', amount_received_paisa: 5000 } }), hctx());
    const i = h.pay[0].input;
    expect(i).toMatchObject({ methodCode: 'cash', amount: NPR(5000) }); expect(i.invoiceId).toBeUndefined(); expect(i.reference).toBeUndefined();
  });
  it('missing Idempotency-Key -> refused before the service (common.idempotency_key_required or common.validation_failed)', async () => {
    const e = await fail(run('recordPayment', r({}, {}), hctx()));
    expect(['common.idempotency_key_required', 'common.validation_failed']).toContain(e.code); expect(h.pay).toHaveLength(0);
  });
  it('service errors pass through unchanged (billing.payment_exceeds_due 422, billing.order_not_invoiced 409, billing.counter_busy)', async () => {
    for (const code of ['billing.payment_exceeds_due', 'billing.order_not_invoiced', 'billing.counter_busy']) {
      h.payError = new LimsError(code as never);
      expect((await fail(run('recordPayment', r(), hctx()))).code).toBe(code);
    }
  });
  it('a replayed payment (duplicate:true) returns the same ledger_entry / receipt_no as the original (2xx)', async () => {
    h.payResult = { ...h.payResult, duplicate: true };
    const out = await run('recordPayment', r(), hctx());
    expect([200, 201]).toContain(out.status); expect(out.body.ledger_entry.id).toBe(entryDto.id); expect(out.body.receipt_no).toBe('RC-083/84-000001');
  });
});

describe('B17 getMyCashSession / closeCashSession', () => {
  it('getMyCashSession: 200 CashSessionDto from the service with ETag "<version>"', async () => {
    const out = await run('getMyCashSession', req(), hctx());
    expect(out.status).toBe(200); expect(out.body).toEqual(sessionDto); expect(out.headers?.etag).toBe('"2"');
    expect(h.get).toHaveLength(1);
  });
  it('closeCashSession: path id + If-Match "<n>" + body counted/note reach the service; 200 + ETag', async () => {
    const counted = [{ method_code: 'cash', amount_paisa: 1045000 }];
    const out = await run('closeCashSession', req({ params: { cash_session_id: SESSION }, headers: { 'idempotency-key': 'c-1', 'if-match': '"1"' }, body: { counted, note: 'n' } }), hctx());
    expect(out.status).toBe(200); expect(out.body).toEqual(sessionDto); expect(out.headers?.etag).toBe('"2"');
    expect(h.close[0].input).toMatchObject({ sessionId: SESSION, expectedVersion: 1, counted, note: 'n' });
  });
  it('If-Match absent -> expectedVersion undefined (service answers 428); malformed -> 0 (service answers 400); never a guessed version', async () => {
    const base = { params: { cash_session_id: SESSION }, body: { counted: [] } };
    await run('closeCashSession', req({ ...base, headers: { 'idempotency-key': 'c-2' } }), hctx());
    await run('closeCashSession', req({ ...base, headers: { 'idempotency-key': 'c-3', 'if-match': 'abc' } }), hctx());
    await run('closeCashSession', req({ ...base, headers: { 'idempotency-key': 'c-4', 'if-match': '*' } }), hctx());
    expect(h.close.map((c) => c.input.expectedVersion)).toEqual([undefined, 0, 0]);
  });
  it('body cannot steer the session owner: membership_id / tenant_id in the body never reach the service; owner check stays in the service (ctx actor)', async () => {
    await run('closeCashSession', req({ params: { cash_session_id: SESSION }, headers: { 'idempotency-key': 'c-5', 'if-match': '"1"' }, body: { counted: [], membership_id: MEMBER, tenant_id: V7('0000000000ff') } }), hctx());
    for (const k of ['membershipId', 'membership_id', 'tenantId', 'tenant_id']) expect(Object.keys(h.close[0].input), k).not.toContain(k);
  });
  it('service errors pass through (common.immutable_record, auth.forbidden, common.version_conflict)', async () => {
    for (const code of ['common.immutable_record', 'auth.forbidden', 'common.version_conflict']) {
      h.closeError = new LimsError(code as never);
      expect((await fail(run('closeCashSession', req({ params: { cash_session_id: SESSION }, headers: { 'idempotency-key': 'c-6', 'if-match': '"1"' }, body: { counted: [] } }), hctx()))).code).toBe(code);
    }
  });
});
