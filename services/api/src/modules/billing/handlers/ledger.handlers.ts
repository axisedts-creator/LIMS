// B8 recordPayment, B17 getMyCashSession / closeCashSession, B11 listLedgerEntries, B16 listDues, B18 getDailyCash (02-TRD §5).
// Schema, auth and x-permission (billing.payment.record / billing.cash_report.read / billing.invoice.read) are enforced by the core pipeline from
// contracts/openapi/billing.yaml; these map request -> service and fail closed without an authenticated request context. The body never carries
// tenant, collector, capture kind or receipt choice: B8 is always a manual payment with a receipt number, by the calling cashier.
import { createEvents } from '../../../core/events/publish.js';
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { moneyOf } from '../domain/money/paisa.js';
import { createBillingEvents } from '../events/publish.js';
import type { BalanceCtx } from '../service/balance.service.js';
import { createCashService } from '../service/cash.service.js';
import { createCounterService } from '../service/counter.service.js';
import { createLedgerService } from '../service/ledger.service.js';
import { createLedgerReadService } from '../service/ledgerRead.service.js';
import { createRefundService } from '../service/refund.service.js';
import { ifMatch } from './settings.handlers.js';

export function bind(fn: (ctx: BalanceCtx, req: HandlerRequest) => Promise<HandlerResult>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BalanceCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return fn(c as BalanceCtx, req);
  };
}
export const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const etagged = (dto: { version: number }): Record<string, string> => ({ etag: `"${dto.version}"` });

let ledger: ReturnType<typeof createLedgerService> | undefined;
const ledgerService = () => (ledger ??= createLedgerService({ counter: createCounterService() as never, events: createBillingEvents(createEvents({ producer: 'billing' }) as never) }));

let refunds: ReturnType<typeof createRefundService> | undefined;
const refundService = () => (refunds ??= createRefundService({ events: createBillingEvents(createEvents({ producer: 'billing' }) as never) }));

export const ledgerHandlers:Readonly<Record<string, Handler>> = Object.freeze({
  recordPayment: bind(async (ctx, req) => {
    const key = obj(req.headers)['idempotency-key'];
    if (typeof key !== 'string' || key === '') throw new LimsError('common.idempotency_key_required');
    const orderId = obj(req.params)['order_id'];
    const b = obj(req.body);
    const r = await ledgerService().recordPayment(ctx, {
      orderId, methodCode: b['method_code'], amount: { amountPaisa: b['amount_received_paisa'], currency: 'NPR' },
      ...(b['reference'] === undefined ? {} : { reference: b['reference'] }), ...(b['invoice_id'] === undefined ? {} : { invoiceId: b['invoice_id'] }),
      captureKind: 'manual', issueReceiptNo: true,
      idempotencyKey: `${String(orderId)}:pay:${key}`, // [CONV] the client key, namespaced per order: ledger_entries.idempotency_key is unique per tenant
    });
    const bal = r.balance;
    return {
      status: 201,
      body: {
        ledger_entry: r.entry,
        balance: {
          order_id: bal.orderId, invoiced: moneyOf(bal.invoiced.amountPaisa), paid: moneyOf(bal.paid.amountPaisa), credited: moneyOf(bal.credited.amountPaisa),
          balance_due: moneyOf(bal.balanceDue.amountPaisa), balance_version: bal.balanceVersion, as_of: bal.asOf,
        },
        ...(r.receiptNo === undefined ? {} : { receipt_no: r.receiptNo }),
      },
    };
  }),
  // B9: the reversal row is the body. [CONV] service key = `<ledger_entry_id>:reverse:<Idempotency-Key>` (ledger_entries.idempotency_key is unique per tenant, like B8's `<order_id>:pay:<key>`).
  reverseLedgerEntry: bind(async (ctx, req) => {
    const key = obj(req.headers)['idempotency-key'];
    if (typeof key !== 'string' || key === '') throw new LimsError('common.idempotency_key_required');
    const entryId = obj(req.params)['ledger_entry_id'];
    const b = obj(req.body);
    const r = await ledgerService().reverseEntry(ctx, {
      ledgerEntryId: entryId, reasonCode: b['reason_code'], ...(b['reason_text'] === undefined ? {} : { reasonText: b['reason_text'] }), idempotencyKey: `${String(entryId)}:reverse:${key}`,
    });
    return { status: 201, body: r.entry };
  }),
  // B10 (no stored key: a retry is a second pending request, capped by the refundable amount; the core pipeline's x-idempotency covers replays)
  requestRefund: bind(async (ctx, req) => {
    const b = obj(req.body);
    const dto = await refundService().requestRefund(ctx, {
      orderId: obj(req.params)['order_id'], methodCode: b['method_code'], refundAmountPaisa: b['refund_amount_paisa'], reasonCode: b['reason_code'],
      ...(b['reason_text'] === undefined ? {} : { reasonText: b['reason_text'] }), ...(b['reference'] === undefined ? {} : { reference: b['reference'] }),
    });
    return { status: 201, body: dto };
  }),
  approveRefund: bind(async (ctx, req) => {
    const b = obj(req.body);
    const dto = await refundService().approveRefund(ctx, {
      refundRequestId: obj(req.params)['refund_request_id'], expectedVersion: ifMatch(req), ...(b['note'] === undefined ? {} : { note: b['note'] }),
    });
    return { status: 200, body: dto, headers: etagged(dto as { version: number }) };
  }),
  rejectRefund: bind(async (ctx, req) => {
    const dto = await refundService().rejectRefund(ctx, { refundRequestId: obj(req.params)['refund_request_id'], expectedVersion: ifMatch(req), note: obj(req.body)['note'] });
    return { status: 200, body: dto, headers: etagged(dto as { version: number }) };
  }),
  listRefundRequests: bind(async (ctx, req) => ({ status: 200, body: await refundService().listRefundRequests(ctx, req.query) })),
  listFinanceReviewItems: bind(async (ctx, req) => ({ status: 200, body: await refundService().listFinanceReviewItems(ctx, req.query) })),
  resolveFinanceReviewItem: bind(async (ctx, req) => {
    const b = obj(req.body);
    const dto = await refundService().resolveFinanceReviewItem(ctx, {
      itemId: obj(req.params)['item_id'], expectedVersion: ifMatch(req), resolutionCode: b['resolution_code'],
      ...(b['note'] === undefined ? {} : { note: b['note'] }), ...(b['refund_ledger_entry_id'] === undefined ? {} : { refundLedgerEntryId: b['refund_ledger_entry_id'] }),
    });
    return { status: 200, body: dto, headers: etagged(dto as { version: number }) };
  }),
  getMyCashSession: bind(async (ctx) => {
    const dto = await createCashService().getMyCashSession(ctx);
    return { status: 200, body: dto, headers: etagged(dto as { version: number }) };
  }),
  closeCashSession: bind(async (ctx, req) => {
    const b = obj(req.body);
    const dto = await createCashService().closeCashSession(ctx, {
      sessionId: obj(req.params)['cash_session_id'], expectedVersion: ifMatch(req), counted: b['counted'], ...(b['note'] === undefined ? {} : { note: b['note'] }),
    });
    return { status: 200, body: dto, headers: etagged(dto as { version: number }) };
  }),
  listLedgerEntries: bind(async (ctx, req) => ({ status: 200, body: await createLedgerReadService().listLedgerEntries(ctx, req.query) })),
  listDues: bind(async (ctx, req) => ({ status: 200, body: await createLedgerReadService().listDues(ctx, req.query) })),
  getDailyCash: bind(async (ctx, req) => ({ status: 200, body: await createLedgerReadService().getDailyCash(ctx, req.query) })),
});
