// M11, M12 (T-10; micro.culture.work with the isolate's centre, asked by the service AFTER the isolate is read, 02-CV §10.1) and M29–M32 (D-64: reads = micro.culture.read, writes = micro.config.manage,
// asked FIRST: there is no object and no centre). Idempotency-Key replay (M11 / M12 / M30 / M31 required, M32 optional) is the core pipeline's; If-Match / ETag are the 02-CV §4.2 version quoting
// (M11 = isolate version, M31 / M32 = panel version; M12 has none: its entries carry their own `version`).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import * as svc from '../service/ast.service.js';
import type { WriteCtx } from '../service/culture.service.js';
import type { MicroPermission } from '../permissions.js';
import { ifMatch } from './config.handlers.js';

const READ: MicroPermission = 'micro.culture.read';
const MANAGE: MicroPermission = 'micro.config.manage';

type Out = { body: Record<string, unknown>; version?: number; status?: number };
const reply = (out: Out, status = 200): HandlerResult => ({ status: out.status ?? status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) });

/** Permission before anything else (config.handlers shape). */
function gated(permission: MicroPermission, fn: (c: WriteCtx, r: HandlerRequest) => Promise<HandlerResult>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as WriteCtx;
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('auth.forbidden');   // fail closed
    await identity.assertRole(c, { permission });
    return fn(c, req);
  };
}

export const astHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  assignAstPanel: (async (req: HandlerRequest, hctx: HandlerContext) => reply(await svc.assignAstPanel(hctx as unknown as WriteCtx, { params: req.params, ifMatch: ifMatch(req), body: req.body }))) as Handler,
  recordAstResults: (async (req: HandlerRequest, hctx: HandlerContext) => reply(await svc.recordAstResults(hctx as unknown as WriteCtx, { params: req.params, body: req.body }))) as Handler,
  listAstPanels: gated(READ, async (c, r) => reply({ body: await svc.listAstPanels(c, { query: r.query }) })),
  createAstPanel: gated(MANAGE, async (c, r) => reply(await svc.createAstPanel(c, { body: r.body }))),
  versionAstPanel: gated(MANAGE, async (c, r) => reply(await svc.versionAstPanel(c, { params: r.params, ifMatch: ifMatch(r), body: r.body }))),
  deactivateAstPanel: gated(MANAGE, async (c, r) => reply(await svc.deactivateAstPanel(c, { params: r.params, ifMatch: ifMatch(r), body: r.body }))),
});
