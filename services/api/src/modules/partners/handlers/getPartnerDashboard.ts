// A2 getPartnerDashboard — GET /v1/partners/dashboard (partners.order.read). Order: actor type -> assertRole -> partnerContext.require -> counters.
// Read-only; nothing in req is read (the partner comes from the token's membership, US-15.1).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { getDashboard } from '../service/dashboard.service.js';
import { partnerContext } from '../service/partner-context.service.js';

export const getPartnerDashboard: Handler = async (_req, ctx) => {
  if (ctx.actor?.type !== 'partner') throw new LimsError('auth.forbidden'); // ST4
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'partners.order.read' });
  const { partnerId } = await partnerContext.require(ctx);
  return { status: 200, body: await getDashboard(ctx, partnerId) };
};
