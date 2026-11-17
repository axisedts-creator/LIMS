// Shared first steps of the report handlers (02-TRD §5.2): assertRole before any read (CV §10.1), then period + scope.
import type { HandlerContext, HandlerRequest } from '../../../core/module.js';
import { loadAnalyticsConfig } from '../config.js';
import { businessDateOf } from '../domain/period.js';
import { asApiError, resolvePeriod, resolveScope, type ScopeContext } from '../service/context.service.js';
import type { ReportsContext } from '../service/reports.service.js';
import type { AnalyticsPermission } from '../permissions.js';

export type ReportCtx = ReportsContext & ScopeContext & {
  now(): string;
  ports: { IdentityPort: { assertRole(ctx: never, req: { permission: AnalyticsPermission }): Promise<unknown>; getActor(ctx: never): Promise<any> } };
};
export type Query = Record<string, any>;

/** Authorise first. Nothing (core port, tx, rollup) is touched before this resolves. */
export async function authorise(ctx: HandlerContext, permission: AnalyticsPermission): Promise<ReportCtx> {
  const c = ctx as unknown as ReportCtx;
  await c.ports.IdentityPort.assertRole(c as never, { permission }).catch(asApiError); // port LimsError -> API LimsError (same code)
  return c;
}

/** Non-throwing permission probe for conditional response parts (P-10): the actor profile's permission list, after authorise(). */
export async function holds(c: ReportCtx, permission: string): Promise<boolean> {
  const actor = (await c.ports.IdentityPort.getActor(c as never).catch(asApiError)) as { permissions?: readonly string[] };
  return Array.isArray(actor?.permissions) && actor.permissions.includes(permission);
}

export const queryOf =(req: HandlerRequest): Query => (req.query && typeof req.query === 'object' ? (req.query as Query) : {});

export async function periodAndScope(c: ReportCtx, q: Query) {
  const period = resolvePeriod(q, businessDateOf(c.now() as never), loadAnalyticsConfig().maxRangeDays);
  const scope = await resolveScope(c, { centreIds: q.centre_id, branchIds: q.branch_id });
  return { period, scope, generatedAt: c.now() };
}
