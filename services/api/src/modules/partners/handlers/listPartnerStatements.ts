// S1 listPartnerStatements — GET /v1/partners/statements (partners.statement.read; access log statement.view, CR-C13-012). Same order as P1.
// The access log carries no amounts; it is written only after a successful read (fail closed: a failing log fails the request).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { partnerContext } from '../service/partner-context.service.js';
import { listStatements } from '../service/statement.service.js';

export const listPartnerStatements: Handler = async (req, ctx) => {
  if (ctx.actor?.type !== 'partner') throw new LimsError('auth.forbidden');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'partners.statement.read' });
  const { partnerId } = await partnerContext.require(ctx);
  const body = await listStatements(ctx.tx as never, ctx.tenantId!, partnerId, (req.query ?? {}) as Record<string, unknown>);
  await ctx.audit!.access({ action: 'statement.view', entityType: 'partner_statement', outcome: 'allowed' });
  return { status: 200, body };
};
