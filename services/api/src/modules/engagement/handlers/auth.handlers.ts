// E1 getPatientAppConfig, E2 requestPatientOtp (02-TRD §5). Pre-auth patient context: x-permission engagement.auth.challenge, tiers and schema validation are the pipeline's.
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createAuthService, type AuthCtx } from '../service/auth.service.js';

const NO_STORE = { 'cache-control': 'no-store' }; // the challenge token is a credential

export const authHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  getPatientAppConfig: async (_req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> =>
    ({ status: 200, body: await createAuthService().getAppConfig(ctx as unknown as AuthCtx) }),
  requestPatientOtp: async (req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> => {
    const out = await createAuthService().requestOtp(ctx as unknown as AuthCtx, req.body);
    return { status: out.status, body: out.body, headers: NO_STORE };
  },
  verifyPatientOtp: async (req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> => {
    const out = await createAuthService().verifyOtp(ctx as unknown as AuthCtx, req.body);
    return { status: out.status, body: out.body, headers: NO_STORE }; // the body holds the session token
  },
});
