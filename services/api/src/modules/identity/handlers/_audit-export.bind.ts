// C2-T19 shared glue for the four export handlers (02-TRD §5.9). Schema/auth/x-permission (audit.log.export) and Idempotency-Key are enforced
// by the core pipeline from contracts/openapi/identity.yaml; this maps request -> service and fails closed without a request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createAuditExportService, type AuditExportCtx } from '../service/audit-export.service.js';

type Svc = ReturnType<typeof createAuditExportService>;

/** [CONV] as _audit-view.bind.ts: a context without tenant / actor / tx is unauthenticated; the service result is returned unchanged. */
export function bind(fn: (svc: Svc, ctx: AuditExportCtx, req: HandlerRequest) => Promise<unknown>): Handler {
  return (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<AuditExportCtx> & { actor?: { id?: unknown } };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return fn(createAuditExportService(), c as AuditExportCtx, req);
  }) as Handler;
}
export const exportIdOf = (req: HandlerRequest) => ({ exportId: (req.params as Record<string, unknown> | undefined)?.['export_id'] });
