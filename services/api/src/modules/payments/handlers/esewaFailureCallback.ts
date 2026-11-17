// PG-T09 — P32 esewaFailureCallback (TRD §5.2, §6.3). Thin: the service owns every rule; the token never leaves it.
import type { Handler } from '../../../core/module.js';
import type { CallbackService, CbCtx } from '../service/callback.service.js';

export const createEsewaFailureCallback = (svc: CallbackService): Handler => async (req, ctx) =>
  svc.esewaFailure(ctx as unknown as CbCtx, (req.params as { callback_token?: unknown } | undefined)?.callback_token);
