// M7–M10 (T-09). Idempotency-Key replay (M7 required, M8–M10 optional) is the core pipeline's; If-Match / ETag are the 02-CV §4.2 version quoting (M8–M10 = isolate version, M7 takes none).
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import * as svc from '../service/isolate.service.js';
import type { WriteCtx } from '../service/culture.service.js';
import { ifMatch } from './config.handlers.js';

const send = (fn: (c: WriteCtx, r: HandlerRequest) => Promise<{ body: Record<string, unknown>; version?: number }>): Handler =>
  async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const out = await fn(hctx as unknown as WriteCtx, req);
    return { status: 200, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };

export const isolateHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createIsolate: send((c, r) => svc.createIsolate(c, { params: r.params, body: r.body })),
  identifyIsolate: send((c, r) => svc.identifyIsolate(c, { params: r.params, ifMatch: ifMatch(r), body: r.body })),
  describeIsolate: send((c, r) => svc.describeIsolate(c, { params: r.params, ifMatch: ifMatch(r), body: r.body })),
  withdrawIsolate: send((c, r) => svc.withdrawIsolate(c, { params: r.params, ifMatch: ifMatch(r), body: r.body })),
});
