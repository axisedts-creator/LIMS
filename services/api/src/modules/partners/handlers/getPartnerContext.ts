// A1 getPartnerContext — GET /v1/partners/me (partners.order.read). Order: actor type -> assertRole -> partner lookup (+ invited->active flip).
// The partner comes only from the token's membership row; nothing in req is read (US-15.1, REQ-SEC-080).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { toPartnerContextDto } from '../mappers/partner.dto.js';
import { partnerContext } from '../service/partner-context.service.js';

export const getPartnerContext: Handler = async (_req, ctx) => {
  if (ctx.actor?.type !== 'partner') throw new LimsError('auth.forbidden'); // staff/system/portal tokens never reach partner data (AB6, ST4)
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'partners.order.read' });
  const row = await partnerContext.load(ctx);
  const [profile, settings, tenant] = await Promise.all([
    ctx.ports.IdentityPort.getActor(ctx),
    ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone', 'calendarDisplay'] }), // D-119: only these keys for partner actors
    (ctx.core as { tenant(c: unknown): Promise<{ displayName: string }> }).tenant(ctx),
  ]);
  return {
    status: 200,
    body: toPartnerContextDto(row, {
      mfaEnrolled: profile.mfa.enrolled, permissions: profile.permissions,
      tenantDisplayName: tenant.displayName, calendarDisplay: settings.calendarDisplay, timezone: settings.timezone,
    }),
  };
};
