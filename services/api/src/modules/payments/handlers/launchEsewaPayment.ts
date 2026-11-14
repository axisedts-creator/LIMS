// PG-T09 — P30 launchEsewaPayment (TRD §5.2, §6.3a). Thin: the service owns every rule; the token never leaves it.
import type { Handler } from '../../../core/module.js';
import type { CallbackService, CbCtx } from '../service/callback.service.js';

export const createLaunchEsewaPayment = (svc: CallbackService): Handler => async (req, ctx) =>
  svc.launch(ctx as unknown as CbCtx, (req.params as { callback_token?: unknown } | undefined)?.callback_token);
