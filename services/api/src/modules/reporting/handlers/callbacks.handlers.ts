// CB1 receiveProviderCallback / CB2 verifyProviderCallback (02-TRD §6.7; CR-C6-001 x-raw-body). Public: no tenant / actor on ctx, anonymous ctx.tx.
// Schema, rate tier and the 256 KB raw-body cap are the core pipeline's. Errors never echo input (service/callbacks.service.ts).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createCallbacksService, type CallbackCtx } from '../service/callbacks.service.js';

const svc = createCallbacksService();
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const lower = (h: unknown): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(obj(h)).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));

export const callbackHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  receiveProviderCallback: async (req: HandlerRequest, hctx: HandlerContext) =>
    svc.receive(hctx as unknown as CallbackCtx, { token: obj(req.params)['callback_token'], rawBody: (req as { rawBody?: unknown }).rawBody, headers: lower(req.headers) }),
  verifyProviderCallback: async (req: HandlerRequest, hctx: HandlerContext) =>
    svc.verify(hctx as unknown as CallbackCtx, { token: obj(req.params)['callback_token'], query: obj(req.query) }),
});
