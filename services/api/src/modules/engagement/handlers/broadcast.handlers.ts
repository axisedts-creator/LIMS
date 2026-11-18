// T0B-MSGDESK-1 (LD-321, LD-325(b)): the 11 broadcast operations of engagement.yaml (T0C-MSGDESK-1). Staff only.
// Order: request context (401) -> actor type user (403, before any SQL) -> IdentityPort.assertRole (403) -> service. ETag = "<version>" when the body has one.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createBroadcastService, type BroadcastCtx, type BroadcastService } from '../service/broadcast.service.js';

const P = { read: 'engagement.broadcast.read', manage: 'engagement.broadcast.manage', approve: 'engagement.broadcast.approve' } as const;
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };

function bind(permission: string, fn: (s: BroadcastService, ctx: BroadcastCtx, req: HandlerRequest) => Promise<{ status: number; body: Record<string, unknown> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BroadcastCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (c.actor.type !== 'user') throw new LimsError('auth.forbidden'); // partner, patient, portal, device and system never reach the broadcast desk
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await fn(createBroadcastService(), c as BroadcastCtx, req);
    const v = out.body['version'];
    return { status: out.status, body: out.body, headers: { 'Cache-Control': 'no-store', ...(typeof v === 'number' ? { etag: `"${v}"` } : {}) } };
  };
}

export const broadcastHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listBroadcastTemplates: bind(P.read, (s, c, r) => s.listTemplates(c, r.query)),
  createBroadcastTemplate: bind(P.manage, (s, c, r) => s.createTemplate(c, r.body)),
  updateBroadcastTemplate: bind(P.manage, (s, c, r) => s.updateTemplate(c, r)),
  deactivateBroadcastTemplate: bind(P.manage, (s, c, r) => s.deactivateTemplate(c, r)),
  previewBroadcastAudience: bind(P.manage, (s, c, r) => s.preview(c, r.body)),
  createBroadcast: bind(P.manage, (s, c, r) => s.create(c, r.body)),
  requestBroadcastApproval: bind(P.manage, (s, c, r) => s.requestApproval(c, r)),
  approveBroadcast: bind(P.approve, (s, c, r) => s.approve(c, r)),
  cancelBroadcast: bind(P.manage, (s, c, r) => s.cancel(c, r)),
  listBroadcasts: bind(P.read, (s, c, r) => s.list(c, r.query)),
  listBroadcastRecipients: bind(P.read, (s, c, r) => s.listRecipients(c, r)),
});
