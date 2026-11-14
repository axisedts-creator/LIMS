// E48-E51 (patient) and N1-N4 (staff) (02-TRD §5, §7). Order: fail closed without request context -> IdentityPort.assertRole (before any query) -> service.
// Floors: E48/E50 engagement.self.read, E49/E51 engagement.enquiry.create, N1/N2 engagement.enquiry.read, N3/N4 engagement.enquiry.respond. Thread data is account data: never cacheable.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createEnquiryService, type EnquiryCtx, type EnquiryService } from '../service/enquiry.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

function bind(permission: string, fn: (svc: EnquiryService, ctx: EnquiryCtx, req: HandlerRequest) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<EnquiryCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await fn(createEnquiryService(), c as EnquiryCtx, req);
    return { status: out.status, body: out.body, headers: { 'Cache-Control': 'no-store' } } as HandlerResult;
  };
}
const id = (req: HandlerRequest): unknown => obj(req.params)['enquiry_id'];

export const enquiryHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMyEnquiries: bind('engagement.self.read', (s, ctx, req) => s.listMine(ctx, obj(req.query))),
  createMyEnquiry: bind('engagement.enquiry.create', (s, ctx, req) => s.create(ctx, { body: req.body })),
  getMyEnquiry: bind('engagement.self.read', (s, ctx, req) => s.getMine(ctx, { id: id(req) })),
  replyMyEnquiry: bind('engagement.enquiry.create', (s, ctx, req) => s.replyMine(ctx, { id: id(req), headers: req.headers, body: req.body })),
  listEnquiries: bind('engagement.enquiry.read', (s, ctx, req) => s.list(ctx, obj(req.query))),
  getEnquiry: bind('engagement.enquiry.read', (s, ctx, req) => s.get(ctx, { id: id(req) })),
  replyEnquiry: bind('engagement.enquiry.respond', (s, ctx, req) => s.replyStaff(ctx, { id: id(req), headers: req.headers, body: req.body })),
  closeEnquiry: bind('engagement.enquiry.respond', (s, ctx, req) => s.close(ctx, { id: id(req), headers: req.headers })),
});
