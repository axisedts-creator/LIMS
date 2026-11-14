// E16 createSelfRegistration / E17 getSelfRegistration (02-TRD §4.3.4, §5). Order: fail closed without request context -> IdentityPort.assertRole before any query -> service.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createSelfRegService, type SelfRegCtx } from '../service/selfreg.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const NO_STORE = { 'Cache-Control': 'no-store' };

async function guard(hctx: HandlerContext, permission: string): Promise<SelfRegCtx> {
  const c = hctx as unknown as Partial<SelfRegCtx> & { ports?: Ports };
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
  await c.ports.IdentityPort.assertRole(hctx, { permission });
  return c as SelfRegCtx;
}

export const selfregHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createSelfRegistration: async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const out = await createSelfRegService().createSelfRegistration(await guard(hctx, 'engagement.self.manage'), { body: req.body });
    return { status: out.status, body: out.body, headers: NO_STORE };
  },
  getSelfRegistration: async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const out = await createSelfRegService().getSelfRegistration(await guard(hctx, 'engagement.self.read'), { id: (req.params as Record<string, unknown> | undefined)?.['self_registration_id'] });
    return { status: out.status, body: out.body, headers: NO_STORE };
  },
});
