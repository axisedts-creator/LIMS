// E13 listMyProfiles, E18 updateMyProfile, E19 removeMyProfile (02-TRD §5). Order: fail closed without request context -> IdentityPort.assertRole (before any query) -> service.
// Floors: E13 engagement.self.read; E18 / E19 engagement.self.manage. Profile bodies are PII-adjacent: never cacheable.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createProfileService, type ProfileCtx, type ProfileService } from '../service/profile.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(permission: string, fn: (svc: ProfileService, ctx: ProfileCtx, req: HandlerRequest) => ReturnType<ProfileService['list']>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<ProfileCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await fn(createProfileService(), c as ProfileCtx, req);
    if (out.status === 204) return { status: 204 };
    const v = out.body?.['version'];
    return { status: out.status, body: out.body, headers: { 'cache-control': 'no-store', ...(typeof v === 'number' ? { etag: `"${v}"` } : {}) } };
  };
}

export const profileHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMyProfiles: bind('engagement.self.read', (s, ctx) => s.list(ctx)),
  updateMyProfile: bind('engagement.self.manage', (s, ctx, req) => s.update(ctx, { id: obj(req.params)['profile_id'], headers: req.headers, body: req.body })),
  removeMyProfile: bind('engagement.self.manage', (s, ctx, req) => s.remove(ctx, { id: obj(req.params)['profile_id'], headers: req.headers })),
});
