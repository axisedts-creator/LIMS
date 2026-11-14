// E45 listMyNotifications (engagement.self.read), E46 markMyNotificationsRead (engagement.self.manage) (02-TRD §5, §7). Order: fail closed without request context
// -> IdentityPort.assertRole (before any query) -> service. Inbox rows are account data: never cacheable.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createNotificationService, type NotificationCtx, type NotificationService } from '../service/notification.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

function bind(permission: string, fn: (svc: NotificationService, ctx: NotificationCtx, req: HandlerRequest) => Promise<unknown>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<NotificationCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    return { status: 200, body: await fn(createNotificationService(), c as NotificationCtx, req), headers: { 'Cache-Control': 'no-store' } };
  };
}

export const notificationHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMyNotifications: bind('engagement.self.read', (s, ctx, req) => s.list(ctx, obj(req.query))),
  markMyNotificationsRead: bind('engagement.self.manage', (s, ctx, req) => s.markRead(ctx, { body: req.body })),
});
