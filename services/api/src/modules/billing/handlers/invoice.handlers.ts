// B1 listInvoices, B2 getInvoice, B7 getOrderBilling, B37 listInvoicePrints, B3 printInvoice, B6 printCreditNote (02-TRD §5). Schema, auth and x-permission (billing.invoice.read) are
// enforced by the core pipeline from contracts/openapi/billing.yaml; these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import { createEvents } from '../../../core/events/publish.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createBillingEvents } from '../events/publish.js';
import type { BalanceCtx } from '../service/balance.service.js';
import { createCounterService } from '../service/counter.service.js';
import { createInvoiceService, type InvoiceCtx, type InvoiceService } from '../service/invoice.service.js';
import { createInvoiceReadService, type InvoiceReadService } from '../service/invoiceRead.service.js';

function bind(fn: (svc: InvoiceReadService, ctx: BalanceCtx, req: HandlerRequest) => Promise<unknown>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BalanceCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return { status: 200, body: await fn(createInvoiceReadService(), c as BalanceCtx, req) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

// B3 printInvoice / B6 printCreditNote: schema, auth, x-permission (billing.invoice.reprint) and x-idempotency are the pipeline's. Only the path id and the
// optional reason_code reach the service: the body can never steer print_no, is_copy, the clock, the tenant or the actor.
let commands: InvoiceService | undefined;
const commandService = (): InvoiceService => (commands ??= createInvoiceService({ counter: createCounterService() as never, events: createBillingEvents(createEvents({ producer: 'billing' }) as never) }));
function bindPrint(run: (svc: InvoiceService, ctx: InvoiceCtx, req: HandlerRequest) => Promise<unknown>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<InvoiceCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return { status: 200, body: await run(commandService(), c as InvoiceCtx, req) };
  };
}
const reasonOf = (req: HandlerRequest): { reasonCode?: unknown } => { const r = obj(req.body)['reason_code']; return r === undefined ? {} : { reasonCode: r }; };

export const invoiceHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listInvoices: bind((s, ctx, req) => s.listInvoices(ctx, req.query)),
  getInvoice: bind((s, ctx, req) => s.getInvoice(ctx, { invoiceId: obj(req.params)['invoice_id'] })),
  getOrderBilling: bind((s, ctx, req) => s.getOrderBilling(ctx, { orderId: obj(req.params)['order_id'] })),
  listInvoicePrints: bind((s, ctx, req) => s.listInvoicePrints(ctx, { invoiceId: obj(req.params)['invoice_id'], query: req.query })),
  printInvoice: bindPrint((s, ctx, req) => s.print(ctx, { invoiceId: obj(req.params)['invoice_id'], ...reasonOf(req) })),
  printCreditNote: bindPrint((s, ctx, req) => s.printCreditNote(ctx, { creditNoteId: obj(req.params)['credit_note_id'], ...reasonOf(req) })),
});
