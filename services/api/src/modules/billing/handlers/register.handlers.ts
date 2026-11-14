// B24 getSalesRegister, B25 getCancelledInvoiceRegister, B26 getCreditNoteRegister, B27 getAuditTrail (02-TRD §5; LD-97 wired them, LD-100 redo).
// Schema, auth and x-permission (billing.register.read / billing.audit.read) are the core pipeline's (contracts/openapi/billing.yaml); these map the snake_case query to the
// service's camelCase input and fail closed without an authenticated request context. Tenant and actor come from ctx only.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import type { BalanceCtx } from '../service/balance.service.js';
import { createRegisterService, type RegisterService } from '../service/register.service.js';

let svc: RegisterService | undefined;
const service = (): RegisterService => (svc ??= createRegisterService());
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(fn: (s: RegisterService, ctx: BalanceCtx, q: Record<string, any>) => Promise<unknown>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BalanceCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return { status: 200, body: await fn(service(), c as BalanceCtx, obj(req.query)) };
  };
}
/** Only the keys the service knows travel on; absent keys stay absent. */
const pick = (q: Record<string, any>, map: Record<string, string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(map).filter(([k]) => q[k] !== undefined).map(([k, to]) => [to, q[k]]));
const RANGE = { limit: 'limit', cursor: 'cursor', fiscal_year_bs: 'fiscalYearBs', centre_id: 'centreId', issued_at_from: 'issuedAtFrom', issued_at_to: 'issuedAtTo' };

export const registerHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  getSalesRegister: bind((s, ctx, q) => s.sales(ctx, pick(q, RANGE))),
  getCancelledInvoiceRegister: bind((s, ctx, q) => s.cancelled(ctx, pick(q, RANGE))),
  getCreditNoteRegister: bind((s, ctx, q) => s.creditNotes(ctx, pick(q, RANGE))),
  getAuditTrail: bind((s, ctx, q) => s.auditTrail(ctx, pick(q, {
    limit: 'limit', cursor: 'cursor', actor_membership_id: 'actorMembershipId', action: 'action', occurred_at_from: 'occurredAtFrom', occurred_at_to: 'occurredAtTo',
  }))),
});
