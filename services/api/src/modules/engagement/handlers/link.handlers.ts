// L1 issueLinkCode, L2 revokeLinkCode, L3 listPatientAppLinks, L4 revokeAppLink, E14 redeemLinkCode, E15 redeemReportLink (02-TRD §4.3.3, §5).
// Order: fail closed without request context -> IdentityPort.assertRole({permission}) (before any query; a patient actor holds none of the staff ones) -> service.
// Floors: L1 engagement.link.issue, L2 / L4 engagement.link.revoke, L3 engagement.link.read, E14 / E15 engagement.link.redeem. L1 answers are never cacheable (the 201 body holds the plaintext code, TRD §5.4).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createLinkService, type LinkCtx, type LinkService, type ReportLinkCtx } from '../service/link.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const REDEEM = 'engagement.link.redeem'; // T-L2 E14 / T-L3 E15 (patient actor): answers hold the profile of a redeemed code / link, never cacheable
const ISSUE = 'engagement.link.issue', REVOKE = 'engagement.link.revoke', READ = 'engagement.link.read';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(permission: string, run: (svc: LinkService, ctx: LinkCtx, req: HandlerRequest) => Promise<{ status: number; body?: Record<string, unknown> }>, noStore = false): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<LinkCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function') throw new LimsError('auth.unauthenticated');
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await identity.assertRole(hctx, { permission });
    const out = await run(createLinkService(), c as LinkCtx, req);
    return { status: out.status, ...(out.body ? { body: out.body } : {}), ...(noStore ? { headers: { 'cache-control': 'no-store' } } : {}) };
  };
}

export const linkHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  issueLinkCode: bind(ISSUE, (svc, ctx, req) => svc.issue(ctx, { body: req.body }), true),
  revokeLinkCode: bind(REVOKE, (svc, ctx, req) => svc.revokeCode(ctx, { id: obj(req.params)['link_code_id'], headers: req.headers })),
  listPatientAppLinks: bind(READ, (svc, ctx, req) => svc.list(ctx, { patientId: obj(req.params)['patient_id'] })),
  redeemLinkCode: bind(REDEEM, (svc, ctx, req) => svc.redeem(ctx, { body: req.body }), true),
  revokeAppLink: bind(REVOKE, (svc, ctx, req) => svc.revokeLink(ctx, { id: obj(req.params)['link_id'], headers: req.headers, body: req.body })),
  // T-L3 E15: no ctx.now() requirement (the service never reads the clock)
  redeemReportLink: async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<ReportLinkCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission: REDEEM });
    const out = await createLinkService().redeemReportLink(c as ReportLinkCtx, { body: req.body });
    return { status: out.status, body: out.body, headers: { 'Cache-Control': 'no-store' } };
  },
});
