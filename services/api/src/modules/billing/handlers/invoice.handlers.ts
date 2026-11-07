// B1 listInvoices, B2 getInvoice, B7 getOrderBilling, B37 listInvoicePrints (02-TRD §5). Schema, auth and x-permission (billing.invoice.read) are
// enforced by the core pipeline from contracts/openapi/billing.yaml; these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import type { BalanceCtx } from '../service/balance.service.js';
import { createInvoiceReadService, type InvoiceReadService } from '../service/invoiceRead.service.js';

function bind(fn: (svc: InvoiceReadService, ctx: BalanceCtx, req: HandlerRequest) => Promise<unknown>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BalanceCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return { status: 200, body: await fn(createInvoiceReadService(), c as BalanceCtx, req) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

export const invoiceHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listInvoices: bind((s, ctx, req) => s.listInvoices(ctx, req.query)),
  getInvoice: bind((s, ctx, req) => s.getInvoice(ctx, { invoiceId: obj(req.params)['invoice_id'] })),
  getOrderBilling: bind((s, ctx, req) => s.getOrderBilling(ctx, { orderId: obj(req.params)['order_id'] })),
  listInvoicePrints: bind((s, ctx, req) => s.listInvoicePrints(ctx, { invoiceId: obj(req.params)['invoice_id'], query: req.query })),
});
