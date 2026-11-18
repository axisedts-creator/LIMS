// T0B-CONTENT-1 (LD-313, LD-325 b; contract T0C-CONTENT-1): listPortalContent, createPortalContent, updatePortalContent, deactivatePortalContent, reorderPortalContent,
// listMyPortalContent, listProfileImages, setProfileImage, clearProfileImage. Order: fail closed without request context -> IdentityPort.assertRole (before any query) -> service.
// Staff answers: Cache-Control no-store, ETag = version. listMyPortalContent: [CONV] done_when (3) "short, public" cache wins over the contract's CacheControlNoStore
// (conflict raised to the lead in T0B-CONTENT-1-tests.md): public, max-age=60, Vary: Authorization (tenant comes from the credential). The answer holds no personal data.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createContentService, type ContentCtx, type ContentService } from '../service/content.service.js';

const READ = 'engagement.content.read', MANAGE = 'engagement.content.manage', SELF = 'engagement.self.read';
const PUBLIC_CACHE = { 'cache-control': 'public, max-age=60', vary: 'Authorization' };
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
type Out = { status: number; body?: Record<string, unknown> };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(permission: string, run: (s: ContentService, ctx: ContentCtx, req: HandlerRequest) => Promise<Out>, headers: Record<string, string> = { 'cache-control': 'no-store' }): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<ContentCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await run(createContentService(), c as ContentCtx, req);
    const v = out.body?.['version'];
    return { status: out.status, ...(out.body ? { body: out.body } : {}), headers: { ...headers, ...(typeof v === 'number' ? { etag: `"${v}"` } : {}) } };
  };
}
const ok = (body: Record<string, unknown>): Out => ({ status: 200, body });

export const contentHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listPortalContent: bind(READ, async (s, ctx, req) => ok(await s.list(ctx, req.query))),
  createPortalContent: bind(MANAGE, async (s, ctx, req) => ({ status: 201, body: await s.create(ctx, req.body) })),
  updatePortalContent: bind(MANAGE, async (s, ctx, req) => ok(await s.update(ctx, { id: obj(req.params)['content_id'], headers: req.headers, body: req.body }))),
  deactivatePortalContent: bind(MANAGE, async (s, ctx, req) => ok(await s.deactivate(ctx, { id: obj(req.params)['content_id'], headers: req.headers }))),
  reorderPortalContent: bind(MANAGE, async (s, ctx, req) => ok(await s.reorder(ctx, req.body))),
  listMyPortalContent: bind(SELF, async (s, ctx, req) => ok(await s.listPublic(ctx, req.query)), PUBLIC_CACHE),
  listProfileImages: bind(READ, async (s, ctx, req) => ok(await s.listImages(ctx, req.query))),
  setProfileImage: bind(MANAGE, async (s, ctx, req) => ok(await s.setImage(ctx, { kind: obj(req.params)['profile_kind'], profileId: obj(req.params)['profile_id'], body: req.body }))),
  clearProfileImage: bind(MANAGE, async (s, ctx, req) => { await s.clearImage(ctx, { kind: obj(req.params)['profile_kind'], profileId: obj(req.params)['profile_id'] }); return { status: 204 }; }),
});
