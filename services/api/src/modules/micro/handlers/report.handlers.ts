// M14 (T-15). Idempotency-Key (required) replay is the core pipeline's; there is no If-Match: the culture row is locked FOR UPDATE in the service (02-TRD §5 intro).
// M17 reopenCulture, M18 cancelCulture (T-16): If-Match (02-CV §4.2) + optional Idempotency-Key (core pipeline); 200 with ETag "<new version>".
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import type { WriteCtx } from '../service/culture.service.js';
import * as svc from '../service/report.service.js';
import { ifMatch } from './config.handlers.js';

const versioned = (fn: typeof svc.reopenCulture): Handler => (async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
  const out = await fn(hctx as unknown as WriteCtx, { params: req.params, ifMatch: ifMatch(req), body: req.body });
  return { status: 200, body: out.body, headers: { etag: `"${out.version}"` } };
}) as Handler;

export const reportHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  submitCultureReport: (async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> =>
    ({ status: 201, body: await svc.submitCultureReport(hctx as unknown as WriteCtx, { params: req.params, body: req.body }) })) as Handler,
  reopenCulture: versioned(svc.reopenCulture),
  cancelCulture: versioned(svc.cancelCulture),
});
