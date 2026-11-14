// R1 listReminders, R2 createReminder, R3 cancelReminder (02-TRD §5). Order: fail closed without request context -> IdentityPort.assertRole (before any query) -> service.
// Floors: R1 engagement.reminder.read; R2/R3 engagement.reminder.manage (contracts/permissions.yaml). R2 replay is the pipeline's (Idempotency-Key).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createReminderService, type ReminderCtx, type ReminderService } from '../service/reminder.service.js';

type Out = { status: number; body: Record<string, any> };
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(permission: string, fn: (svc: ReminderService, ctx: ReminderCtx, req: HandlerRequest) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<ReminderCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await fn(createReminderService(), c as ReminderCtx, req);
    const v = out.body['version'];
    return { status: out.status, body: out.body, ...(typeof v === 'number' ? { headers: { etag: `"${v}"` } } : {}) };
  };
}

export const reminderHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listReminders: bind('engagement.reminder.read', async (s, ctx, req) => ({ status: 200, body: await s.list(ctx, req.query) })),
  createReminder: bind('engagement.reminder.manage', async (s, ctx, req) => ({ status: 201, body: await s.create(ctx, { body: req.body }) })),
  cancelReminder: bind('engagement.reminder.manage', async (s, ctx, req) => ({ status: 200, body: await s.cancel(ctx, { id: obj(req.params)['reminder_id'], headers: req.headers }) })),
});
