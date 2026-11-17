// M1, M2, C1-C3 handlers (02-TRD §6.5). Schema, auth and x-permission are enforced by the core pipeline from contracts/openapi/reporting.yaml
// (all five are x-idempotency none); these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createMessagingAdminService, type MessagingAdminService, type MessagingCtx } from '../service/messaging-admin.service.js';
import { ifMatch } from './outsourced.handlers.js';

const svc = createMessagingAdminService();
type Out = { status: number; body: unknown; version?: number; headers?: Record<string, string> };
function bind(fn: (s: MessagingAdminService, ctx: MessagingCtx, req: HandlerRequest) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<MessagingCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as MessagingCtx, req);
    const headers = { ...(out.headers ?? {}), ...(out.version === undefined ? {} : { etag: `"${out.version}"` }) };
    return { status: out.status, body: out.body, ...(Object.keys(headers).length ? { headers } : {}) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

export const messagingAdminHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMessageTemplates: bind(async (s, ctx) => ({ status: 200, body: await s.listMessageTemplates(ctx) })),
  upsertMessageTemplateText: bind(async (s, ctx, req) => {
    const p = obj(req.params);
    const out = await s.upsertMessageTemplateText(ctx, { templateCode: p['template_code'], channel: p['channel'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: out, version: out['version'] as number };
  }),
  listChannelAccounts: bind(async (s, ctx) => ({ status: 200, body: await s.listChannelAccounts(ctx) })),
  upsertChannelAccount: bind(async (s, ctx, req) => {
    const out = await s.upsertChannelAccount(ctx, { channel: obj(req.params)['channel'], body: req.body });
    return { status: 200, body: out, version: out['version'] as number };
  }),
  // The callback URL is shown once: no-store, and never replayed (x-idempotency none, 08 A13 P-8 E1).
  rotateChannelCallbackToken: bind(async (s, ctx, req) => ({
    status: 201, body: await s.rotateChannelCallbackToken(ctx, { channel: obj(req.params)['channel'], expectedVersion: ifMatch(req) }),
    headers: { 'cache-control': 'no-store' },
  })),
});
