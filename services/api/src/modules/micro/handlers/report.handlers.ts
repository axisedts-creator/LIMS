// M14 (T-15). Idempotency-Key (required) replay is the core pipeline's; there is no If-Match: the culture row is locked FOR UPDATE in the service (02-TRD §5 intro).
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import type { WriteCtx } from '../service/culture.service.js';
import * as svc from '../service/report.service.js';

export const reportHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  submitCultureReport: (async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> =>
    ({ status: 201, body: await svc.submitCultureReport(hctx as unknown as WriteCtx, { params: req.params, body: req.body }) })) as Handler,
});
