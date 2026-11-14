// M19–M22 (instrument records) and M33–M38 (vocabulary maps, AST defaults) — 02-TRD §5.3, §5.4. Reads and config: permission FIRST (07-SECURITY S-23, D-64: reads = micro.culture.read,
// writes = micro.config.manage). M20–M22 load the record first (404), then assert micro.culture.work with its centre (02-CV §10.1) inside the service. Idempotency-Key replay (M20/M21/M34 required;
// M22/M35/M36/M38 optional) is the core pipeline's; ETag / If-Match are the 02-CV §4.2 version quoting.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import * as svc from '../service/instrument-record.service.js';
import type { MicroPermission } from '../permissions.js';
import { ifMatch } from './config.handlers.js';

const READ: MicroPermission = 'micro.culture.read';
const MANAGE: MicroPermission = 'micro.config.manage';

/** Permission first: no statement runs for a caller without it. */
function gated(permission: MicroPermission, fn: (c: svc.RecordCtx, r: HandlerRequest) => Promise<HandlerResult>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as svc.RecordCtx;
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('auth.forbidden');   // fail closed
    await identity.assertRole(c, { permission });
    return fn(c, req);
  };
}
const open = (fn: (c: svc.RecordCtx, r: HandlerRequest) => Promise<{ body: Record<string, unknown>; version?: number }>, status = 200): Handler =>
  async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const out = await fn(hctx as unknown as svc.RecordCtx, req);
    return { status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };
const tagged = (fn: (c: svc.RecordCtx, r: HandlerRequest) => Promise<{ body: Record<string, unknown>; version?: number }>, permission: MicroPermission, status = 200): Handler =>
  gated(permission, async (c, r) => {
    const out = await fn(c, r);
    return { status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  });

export const instrumentRecordHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMicroInstrumentRecords: gated(READ, async (c, r) => ({ status: 200, body: await svc.listRecords(c, { query: r.query }) })),
  assignMicroInstrumentRecord: open((c, r) => svc.assignRecord(c, { params: r.params, ifMatch: ifMatch(r), body: r.body })),
  applyMicroInstrumentRecord: open((c, r) => svc.applyRecord(c, { params: r.params, ifMatch: ifMatch(r), body: r.body })),
  ignoreMicroInstrumentRecord: open((c, r) => svc.ignoreRecord(c, { params: r.params, ifMatch: ifMatch(r), body: r.body })),
  listInstrumentVocabMaps: gated(READ, async (c, r) => ({ status: 200, body: await svc.listMaps(c, { query: r.query }) })),
  createInstrumentVocabMap: tagged((c, r) => svc.createMap(c, { body: r.body }), MANAGE, 201),
  updateInstrumentVocabMap: tagged((c, r) => svc.updateMap(c, { params: r.params, ifMatch: ifMatch(r), body: r.body }), MANAGE),
  deactivateInstrumentVocabMap: tagged((c, r) => svc.deactivateMap(c, { params: r.params, ifMatch: ifMatch(r), body: r.body }), MANAGE),
  listInstrumentAstDefaults: gated(READ, async (c) => ({ status: 200, body: await svc.listDefaults(c) })),
  putInstrumentAstDefault: tagged((c, r) => svc.putDefault(c, { params: r.params, ifMatch: ifMatch(r), body: r.body }), MANAGE),
});
