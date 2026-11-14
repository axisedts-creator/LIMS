// PG-T09 — P31 esewaSuccessCallback (TRD §5.2, §6.3). Thin: the service owns every rule; the token and `data` never leave it.
import type { Handler } from '../../../core/module.js';
import type { CallbackService, CbCtx } from '../service/callback.service.js';

export const createEsewaSuccessCallback = (svc: CallbackService): Handler => async (req, ctx) =>
  svc.esewaSuccess(ctx as unknown as CbCtx, (req.params as { callback_token?: unknown } | undefined)?.callback_token, (req.query ?? {}) as Record<string, unknown>);
