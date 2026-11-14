// C2-T18 shared glue for the four viewer handlers (02-TRD §5.9). Schema/auth/x-permission (audit.log.read) are enforced by the core
// pipeline from contracts/openapi/identity.yaml; this maps request -> service and fails closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createAuditViewService, type AuditViewCtx } from '../service/audit-view.service.js';

type Svc = ReturnType<typeof createAuditViewService>;
export const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** [CONV] as reporting/handlers/settings.handlers.ts: until T0D-02..10 land, a context without tenant/actor/tx/audit is unauthenticated. */
export function bind(fn: (svc: Svc, ctx: AuditViewCtx, req: HandlerRequest) => Promise<unknown>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<AuditViewCtx> & { actor?: { id?: unknown } };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.audit?.access !== 'function') {
      throw new LimsError('auth.unauthenticated');
    }
    return { status: 200, body: await fn(createAuditViewService({}), c as AuditViewCtx, req) };
  };
}
