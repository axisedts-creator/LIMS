// E20 listMyOrders, E21 getMyOrder (02-TRD §5, §9.1). Order: fail closed without request context -> IdentityPort.assertRole(engagement.self.read) before any query -> service (patient actors only).
// Answers hold PHI: Cache-Control no-store. E21 sends the ETag; a matching If-None-Match is a bodiless 304 (the service answers 404 first for an order the caller cannot see).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createOrdersService, type OrdersCtx, type OrdersService } from '../service/orders.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const PERMISSION = 'engagement.self.read';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(run: (svc: OrdersService, ctx: OrdersCtx, req: HandlerRequest) => Promise<{ status: number; body?: Record<string, unknown>; etag?: string }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<OrdersCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function') throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission: PERMISSION });
    const out = await run(createOrdersService(), c as OrdersCtx, req);
    return { status: out.status, ...(out.body ? { body: out.body } : {}), headers: { ...(out.etag ? { etag: out.etag } : {}), ...(out.status === 304 ? {} : { 'cache-control': 'no-store' }) } };
  };
}

export const ordersHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMyOrders: bind((svc, ctx, req) => svc.list(ctx, { query: req.query })),
  getMyOrder: bind((svc, ctx, req) => svc.get(ctx, { orderId: obj(req.params)['order_id'], headers: req.headers })),
});
