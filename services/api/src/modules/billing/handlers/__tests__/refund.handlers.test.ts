// BL-T11 handlers (contract tests of request -> service mapping; services are mocked, their logic is in service/__tests__/{ledger.reversal,refund.service,financeReview.service}.test.ts):
// B9 reverseLedgerEntry, B10 requestRefund, B10a approveRefund, B10b rejectRefund, B10c listRefundRequests, B36 listFinanceReviewItems / resolveFinanceReviewItem.
// Schema, auth, aal2 and x-permission are enforced by the core pipeline from contracts/openapi/billing.yaml (see ../../__tests__/contract/refund.permissions.static.test.ts); these map request -> service and
// fail closed without an authenticated request context. Spec: 02-TRD §5; openapi ReverseLedgerEntryRequest / RefundRequestCreate / ApproveRefundRequest / RejectRefundRequest / ResolveFinanceReviewItemRequest.
// Fails now: handlers/index.ts maps these operationIds to the BL-T01 stub (common.service_unavailable).
// ASSUMED: handlers call createLedgerService(...).reverseEntry(ctx,{ledgerEntryId,reasonCode,reasonText?,idempotencyKey}) -> {entry,...}; createRefundService(...).{requestRefund,approveRefund,rejectRefund,listRefundRequests,
//   listFinanceReviewItems,resolveFinanceReviewItem} with the inputs of refund.service.test.ts; If-Match as ifMatch() in settings.handlers.ts (absent -> undefined, malformed -> 0, "<n>" -> n);
//   [CONV] B9 service idempotencyKey = `<ledger_entry_id>:reverse:<Idempotency-Key header>` (ledger_entries.idempotency_key is unique per tenant, like B8's `<order_id>:pay:<key>`); B9 -> 201 body = the reversal LedgerEntryDto;
//   B10 -> 201 RefundRequestDto; B10a/B10b/B36-resolve -> 200 + ETag `"<version>"`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';

const h = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; ctx: any; input: any }>, result: undefined as any, error: undefined as any }));
const rec = (fn: string) => async (ctx: any, input: any) => { h.calls.push({ fn, ctx, input }); if (h.error) throw h.error; return h.result; };
vi.mock('../../service/ledger.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createLedgerService: () => ({ recordPayment: rec('recordPayment'), reverseEntry: rec('reverseEntry') }),
}));
vi.mock('../../service/refund.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createRefundService: () => ({
    requestRefund: rec('requestRefund'), approveRefund: rec('approveRefund'), rejectRefund: rec('rejectRefund'), listRefundRequests: rec('listRefundRequests'),
    listFinanceReviewItems: rec('listFinanceReviewItems'), resolveFinanceReviewItem: rec('resolveFinanceReviewItem'),
  }),
}));
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const ORDER = V7('000000050001'), ENTRY = V7('000000900001'), RQ = V7('0000000e0001'), ITEM = V7('0000000f0001'), REFUND_ENTRY = V7('0000000c0050');
const M = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const hctx = (extra: Record<string, unknown> = {}) => ({ operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...makeCtxFor()('A'), ...extra }) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
const run = (op: string, r: unknown, c: unknown = hctx()) => (handlers as any)[op](r, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

const entryDto = { id: ENTRY, entry_kind: 'reversal', capture_kind: 'manual', order_id: ORDER, method_code: 'cash', amount: M(-225000), reverses_entry_id: V7('0000000c0001'), created_at: '2026-11-08T06:00:01.000Z', business_date_bs: '2083-07-22' };
const rqDto = { id: RQ, order_id: ORDER, method_code: 'cash', refund_amount: M(225000), reason_code: 'SYN_REASON', status: 'pending', requested_by: { membership_id: V7('000000030001'), display_name: 'Staff user' }, requested_at: '2026-11-08T06:00:00.000Z', version: 1 };
const itemDto = { id: ITEM, order_id: ORDER, kind: 'home_payment_exceeds_due', status: 'resolved', created_at: '2026-11-08T06:00:00.000Z', version: 2 };
beforeEach(() => { h.calls.length = 0; h.error = undefined; h.result = undefined; });
const only = () => { expect(h.calls).toHaveLength(1); return h.calls[0]!; };

describe('fail closed without an authenticated request context (REQ-SEC-099): not the BL-T01 503 stub', () => {
  for (const op of ['reverseLedgerEntry', 'requestRefund', 'approveRefund', 'rejectRefund', 'listRefundRequests', 'listFinanceReviewItems', 'resolveFinanceReviewItem']) {
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated and no service is called`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      const e = await fail(run(op, req({ params: { ledger_entry_id: ENTRY, order_id: ORDER, refund_request_id: RQ, item_id: ITEM }, headers: { 'idempotency-key': 'k', 'if-match': '"1"' }, body: { reason_code: 'R', method_code: 'cash', refund_amount_paisa: 1, note: 'n', resolution_code: 'other' } }), bare));
      expect(e.code).toBe('auth.unauthenticated');
      expect(h.calls).toHaveLength(0);
    });
  }
});

describe('B9 reverseLedgerEntry', () => {
  const r = (headers: Record<string, unknown> = { 'idempotency-key': 'K-1' }, body: Record<string, unknown> = { reason_code: 'SYN_REVERSAL', reason_text: 'Synthetic mis-keyed' }) => req({ params: { ledger_entry_id: ENTRY }, headers, body });
  it('201 with the reversal LedgerEntryDto as body; maps path id, reason_code/reason_text and the namespaced Idempotency-Key', async () => {
    h.result = { entry: entryDto, balance: {}, duplicate: false };
    const out = await run('reverseLedgerEntry', r());
    expect(out.status).toBe(201);
    expect(out.body).toEqual(entryDto);
    expect(only()).toMatchObject({ fn: 'reverseEntry', input: { ledgerEntryId: ENTRY, reasonCode: 'SYN_REVERSAL', reasonText: 'Synthetic mis-keyed', idempotencyKey: `${ENTRY}:reverse:K-1` } });
  });
  it('reason_text is optional and omitted when absent', async () => {
    h.result = { entry: entryDto, balance: {}, duplicate: false };
    await run('reverseLedgerEntry', r(undefined, { reason_code: 'SYN_REVERSAL' }));
    expect(only().input).not.toHaveProperty('reasonText');
  });
  it('missing / empty Idempotency-Key -> common.idempotency_key_required, service not called', async () => {
    for (const headers of [{}, { 'idempotency-key': '' }]) {
      expect((await fail(run('reverseLedgerEntry', r(headers)))).code).toBe('common.idempotency_key_required');
    }
    expect(h.calls).toHaveLength(0);
  });
  it('tenant and actor come from the request context only: a tenant_id / collected_by in the body is not forwarded', async () => {
    h.result = { entry: entryDto, balance: {}, duplicate: false };
    await run('reverseLedgerEntry', r(undefined, { reason_code: 'R', tenant_id: 'evil', collected_by_membership_id: 'evil', amount_paisa: 1 }));
    expect(JSON.stringify(only().input)).not.toContain('evil');
    expect(only().input).not.toHaveProperty('amountPaisa');
    expect(only().ctx.tenantId).toBeDefined();
  });
  it('service errors pass through unchanged (billing.ledger_reversal_invalid)', async () => {
    h.error = new LimsError('billing.ledger_reversal_invalid');
    expect((await fail(run('reverseLedgerEntry', r()))).code).toBe('billing.ledger_reversal_invalid');
  });
});

describe('B10 requestRefund', () => {
  const body = { method_code: 'cash', refund_amount_paisa: 225000, reason_code: 'SYN_REASON', reason_text: 'Synthetic', reference: 'PAYOUT-1' };
  it('201 RefundRequestDto; maps path order_id and the body to the service input (integer paisa)', async () => {
    h.result = rqDto;
    const out = await run('requestRefund', req({ params: { order_id: ORDER }, headers: { 'idempotency-key': 'K-2' }, body }));
    expect(out.status).toBe(201);
    expect(out.body).toEqual(rqDto);
    expect(only()).toMatchObject({ fn: 'requestRefund', input: { orderId: ORDER, methodCode: 'cash', refundAmountPaisa: 225000, reasonCode: 'SYN_REASON', reasonText: 'Synthetic', reference: 'PAYOUT-1' } });
  });
  it('optional reason_text / reference are omitted when absent; requester / tenant / status in the body are not forwarded', async () => {
    h.result = rqDto;
    await run('requestRefund', req({ params: { order_id: ORDER }, headers: { 'idempotency-key': 'K-2' }, body: { method_code: 'cash', refund_amount_paisa: 5, reason_code: 'R', requested_by_membership_id: 'evil', status: 'approved' } }));
    const i = only().input;
    expect(i).not.toHaveProperty('reasonText'); expect(i).not.toHaveProperty('reference');
    expect(JSON.stringify(i)).not.toContain('evil'); expect(JSON.stringify(i)).not.toContain('approved');
  });
  it('service errors pass through (billing.ledger_reversal_invalid, common.feature_disabled)', async () => {
    for (const code of ['billing.ledger_reversal_invalid', 'common.feature_disabled'] as const) {
      h.error = new LimsError(code);
      expect((await fail(run('requestRefund', req({ params: { order_id: ORDER }, body })))).code).toBe(code);
    }
  });
});

describe('B10a approveRefund / B10b rejectRefund', () => {
  it('approve: 200 RefundRequestDto + ETag; maps path id, If-Match "3" -> expectedVersion 3, optional note', async () => {
    h.result = { ...rqDto, status: 'approved', version: 3, ledger_entry: { ...entryDto, entry_kind: 'refund' } };
    const out = await run('approveRefund', req({ params: { refund_request_id: RQ }, headers: { 'if-match': '"3"' }, body: { note: 'Synthetic ok' } }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual(h.result);
    expect(out.headers).toEqual({ etag: '"3"' });
    expect(only()).toMatchObject({ fn: 'approveRefund', input: { refundRequestId: RQ, expectedVersion: 3, note: 'Synthetic ok' } });
  });
  it('approve: no body -> no note; absent If-Match -> expectedVersion undefined (the service/pipeline decides); malformed -> 0', async () => {
    h.result = { ...rqDto, status: 'approved', version: 2 };
    await run('approveRefund', req({ params: { refund_request_id: RQ } }));
    expect(only().input.expectedVersion).toBeUndefined(); expect(only().input).not.toHaveProperty('note');
    h.calls.length = 0;
    await run('approveRefund', req({ params: { refund_request_id: RQ }, headers: { 'if-match': 'abc' } }));
    expect(only().input.expectedVersion).toBe(0);
  });
  it('approve: billing.refund_self_approval_forbidden from the service is returned unchanged (no 2xx)', async () => {
    h.error = new LimsError('billing.refund_self_approval_forbidden');
    expect((await fail(run('approveRefund', req({ params: { refund_request_id: RQ }, headers: { 'if-match': '"1"' } })))).code).toBe('billing.refund_self_approval_forbidden');
  });
  it('reject: 200 + ETag; maps path id, If-Match and the required note', async () => {
    h.result = { ...rqDto, status: 'rejected', version: 2 };
    const out = await run('rejectRefund', req({ params: { refund_request_id: RQ }, headers: { 'if-match': '"1"' }, body: { note: 'Synthetic: no' } }));
    expect(out.status).toBe(200);
    expect(out.headers).toEqual({ etag: '"2"' });
    expect(only()).toMatchObject({ fn: 'rejectRefund', input: { refundRequestId: RQ, expectedVersion: 1, note: 'Synthetic: no' } });
  });
});

describe('B10c listRefundRequests / B36 finance review items', () => {
  it('B10c: 200, the query goes to the service as given (status, order_id, cursor, limit), body = the service page', async () => {
    h.result = { data: [rqDto], page: { limit: 20 } };
    const query = { status: 'pending', order_id: ORDER, cursor: 'c', limit: 20 };
    const out = await run('listRefundRequests', req({ query }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual(h.result);
    expect(only()).toMatchObject({ fn: 'listRefundRequests', input: query });
  });
  it('B36 list: 200, query passthrough', async () => {
    h.result = { data: [], page: { limit: 50 } };
    const out = await run('listFinanceReviewItems', req({ query: { status: 'open' } }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual(h.result);
    expect(only()).toMatchObject({ fn: 'listFinanceReviewItems', input: { status: 'open' } });
  });
  it('B36 resolve: 200 FinanceReviewItem + ETag; maps path item_id, If-Match, resolution_code, note, refund_ledger_entry_id', async () => {
    h.result = itemDto;
    const out = await run('resolveFinanceReviewItem', req({ params: { item_id: ITEM }, headers: { 'if-match': '"1"' }, body: { resolution_code: 'refunded', note: 'Synthetic', refund_ledger_entry_id: REFUND_ENTRY } }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual(itemDto);
    expect(out.headers).toEqual({ etag: '"2"' });
    expect(only()).toMatchObject({ fn: 'resolveFinanceReviewItem', input: { itemId: ITEM, expectedVersion: 1, resolutionCode: 'refunded', note: 'Synthetic', refundLedgerEntryId: REFUND_ENTRY } });
  });
  it('B36 resolve: optional note / refund_ledger_entry_id omitted when absent', async () => {
    h.result = itemDto;
    await run('resolveFinanceReviewItem', req({ params: { item_id: ITEM }, headers: { 'if-match': '"1"' }, body: { resolution_code: 'kept_as_advance' } }));
    expect(only().input).not.toHaveProperty('note'); expect(only().input).not.toHaveProperty('refundLedgerEntryId');
  });
});
