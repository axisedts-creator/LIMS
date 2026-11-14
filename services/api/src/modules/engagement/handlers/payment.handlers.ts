// E41 createPaymentRequest, E42 getPaymentRequest (02-TRD §5). Order: fail closed without request context -> IdentityPort.assertRole(engagement.payment.create) before any query -> service (patient actors only).
// The answers carry the gateway action URL (callback token): Cache-Control no-store. The API never calls PaymentProviderPort (08 R8).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import type { OrdersCtx } from '../service/orders.service.js';
import { createPaymentService, type PaymentService } from '../service/payment.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const PERMISSION = 'engagement.payment.create';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(run: (svc: PaymentService, ctx: OrdersCtx, req: HandlerRequest) => Promise<{ status: number; body: Record<string, unknown> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<OrdersCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function') throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission: PERMISSION });
    const out = await run(createPaymentService(), c as OrdersCtx, req);
    return { status: out.status, body: out.body, headers: { 'cache-control': 'no-store' } };
  };
}

export const paymentHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createPaymentRequest: bind((svc, ctx, req) => svc.create(ctx, { orderId: obj(req.params)['order_id'], body: req.body, headers: req.headers })),
  getPaymentRequest: bind((svc, ctx, req) => svc.get(ctx, { paymentRequestId: obj(req.params)['payment_request_id'] })),
});
