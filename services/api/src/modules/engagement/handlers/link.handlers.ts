// E15 redeemReportLink (02-TRD §4.3.3, §5). Order: fail closed without request context -> IdentityPort.assertRole(engagement.link.redeem) before any query -> service.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createLinkService, type LinkCtx } from '../service/link.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };

export const linkHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  redeemReportLink: async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<LinkCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission: 'engagement.link.redeem' });
    const out = await createLinkService().redeemReportLink(c as LinkCtx, { body: req.body });
    return { status: out.status, body: out.body, headers: { 'Cache-Control': 'no-store' } };
  },
});
