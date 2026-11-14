// S2 getPartnerStatement — GET /v1/partners/statements/:period_month (partners.statement.read). A month without rows is a 200 empty state (US-12.4).
// The month is validated (YYYY-MM) before any statement SQL and bound as a parameter.
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { partnerContext } from '../service/partner-context.service.js';
import { getStatement } from '../service/statement.service.js';

export const getPartnerStatement: Handler = async (req, ctx) => {
  if (ctx.actor?.type !== 'partner') throw new LimsError('auth.forbidden');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'partners.statement.read' });
  const { partnerId } = await partnerContext.require(ctx);
  const month = (req.params as Record<string, unknown> | undefined)?.['period_month'];
  return { status: 200, body: await getStatement(ctx.tx as never, ctx.tenantId!, partnerId, month, ctx.now()) };
};
