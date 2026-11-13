// S12 listBookableItems, S13 upsertBookableItem, S14 syncBookableItems (02-TRD §5). Order: fail closed without request context -> IdentityPort.assertRole (before any query or port call) -> service.
// Floor for all three: engagement.bookable_item.manage (contracts/permissions.yaml). S13 replay is the pipeline's (Idempotency-Key).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createBookableService, type BookableCtx, type BookableService } from '../service/bookable.service.js';

const MANAGE = 'engagement.bookable_item.manage';
type Out = { status: number; body: Record<string, any> };
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(fn: (svc: BookableService, ctx: BookableCtx, req: HandlerRequest) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BookableCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission: MANAGE });
    const out = await fn(createBookableService(), c as BookableCtx, req);
    const v = out.body['version'];
    return { status: out.status, body: out.body, ...(typeof v === 'number' ? { headers: { etag: `"${v}"` } } : {}) };
  };
}

export const bookableHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listBookableItems: bind(async (s, ctx, req) => ({ status: 200, body: await s.list(ctx, req.query) })),
  upsertBookableItem: bind(async (s, ctx, req) => ({ status: 200, body: await s.upsert(ctx, { orderableId: obj(req.params)['orderable_id'], body: req.body, headers: req.headers }) })),
  syncBookableItems: bind(async (s, ctx) => ({ status: 202, body: await s.enqueueSync(ctx) })),
});
