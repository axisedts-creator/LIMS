// T0B-PRINTCFG-1 handlers (LD-316, LD-325(b)): the five T0C-PRINTCFG-1 operations. Request context first (fail closed, echoing nothing), staff only, then the service.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createPrintProfileService, type PrintProfileCtx } from '../service/printProfile.service.js';

const svc = createPrintProfileService();
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
function staff(hctx: HandlerContext): PrintProfileCtx {
  const c = hctx as unknown as Partial<PrintProfileCtx>;
  if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (c.actor.type !== 'user') throw new LimsError('auth.forbidden');
  return c as PrintProfileCtx;
}

export const printProfileHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listPrintProfiles: async (req: HandlerRequest, hctx: HandlerContext) => ({ status: 200, body: await svc.listPrintProfiles(staff(hctx), obj(req.query)) }),
  upsertPrintProfile: async (req: HandlerRequest, hctx: HandlerContext) => ({ status: 200, body: await svc.upsertPrintProfile(staff(hctx), req.body) }),
  previewPrintProfile: async (req: HandlerRequest, hctx: HandlerContext) => ({ status: 202, body: await svc.previewPrintProfile(staff(hctx), req.body) }),
  listSignatoryProfiles: async (_req: HandlerRequest, hctx: HandlerContext) => ({ status: 200, body: await svc.listSignatoryProfiles(staff(hctx)) }),
  upsertSignatoryProfile: async (req: HandlerRequest, hctx: HandlerContext) =>
    ({ status: 200, body: await svc.upsertSignatoryProfile(staff(hctx), obj(req.params)['user_id'], req.body) }),
});
