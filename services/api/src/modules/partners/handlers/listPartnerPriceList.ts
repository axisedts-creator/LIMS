// P1 listPartnerPriceList — GET /v1/partners/price-list (partners.price_list.read). Order: actor type -> assertRole -> partner from the token membership -> reads.
// Nothing in req.params/body or a partner_id/tenant_id query value is used for scoping (US-11.4, AB6, AB8, AB9).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { listPriceList } from '../service/catalog-projection.service.js';
import { partnerContext } from '../service/partner-context.service.js';

export const listPartnerPriceList: Handler = async (req, ctx) => {
  if (ctx.actor?.type !== 'partner') throw new LimsError('auth.forbidden'); // before any SQL
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'partners.price_list.read' });
  const { partnerId } = await partnerContext.require(ctx);
  return { status: 200, body: await listPriceList(ctx.tx as never, ctx.tenantId!, partnerId, (req.query ?? {}) as Record<string, unknown>) };
};
