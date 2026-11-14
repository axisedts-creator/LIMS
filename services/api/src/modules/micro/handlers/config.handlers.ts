// M23–M28, M39, M40 (02-TRD §5.4). Permission first (07-SECURITY S-23, D-64: reads = micro.culture.read only, writes = micro.config.manage), then the
// service. Idempotency-Key replay (M26/M27 required; M24/M28/M40 optional) is the core pipeline's; ETag / If-Match are the 02-CV §4.2 version quoting.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import * as svc from '../service/config.service.js';
import type { MicroPermission } from '../permissions.js';

const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

/** If-Match: "<version>" (02-CV §4.2). Absent -> undefined (428); malformed -> 0 (400). */
export function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const n = m ? Number(m[1]) : 0;
  return n > 2147483647 ? 0 : n;
}

const etag = (body: { version?: unknown }): Record<string, string> | undefined => (typeof body.version === 'number' ? { etag: `"${body.version}"` } : undefined);

function op(permission: MicroPermission, fn: (ctx: svc.ConfigCtx, req: HandlerRequest) => Promise<HandlerResult>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as svc.ConfigCtx & { ports?: { IdentityPort?: { assertRole(c: unknown, r: { permission: string }): Promise<unknown> } } };
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('auth.forbidden'); // fail closed: no way to ask, so no
    await identity.assertRole(c, { permission }); // first step; a rejection (auth.forbidden) passes through
    return fn(c, req);
  };
}

const READ: MicroPermission = 'micro.culture.read';
const MANAGE: MicroPermission = 'micro.config.manage';
const withTag = (body: Record<string, unknown>, status = 200): HandlerResult => ({ status, body, ...(etag(body) ? { headers: etag(body)! } : {}) });

export const configHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMicroCodedSet: op(READ, async (c, r) => ({ status: 200, body: await svc.listCodeSet(c, { params: r.params, query: r.query }) })),
  upsertMicroCode: op(MANAGE, async (c, r) => {
    const out = await svc.upsertCode(c, { params: r.params, ifMatch: ifMatch(r), body: r.body });
    return { status: 200, body: out.body, headers: { etag: `"${out.version}"` } };
  }),
  listPlatingProtocols: op(READ, async (c, r) => ({ status: 200, body: await svc.listProtocols(c, { query: r.query }) })),
  createPlatingProtocol: op(MANAGE, async (c, r) => withTag(await svc.createProtocol(c, { body: r.body }), 201)),
  versionPlatingProtocol: op(MANAGE, async (c, r) => withTag(await svc.versionProtocol(c, { params: r.params, ifMatch: ifMatch(r), body: r.body }))),
  deactivatePlatingProtocol: op(MANAGE, async (c, r) => withTag(await svc.deactivateProtocol(c, { params: r.params, ifMatch: ifMatch(r), body: r.body }))),
  getMicroSettings: op(READ, async (c) => withTag(await svc.getSettings(c))),
  updateMicroSettings: op(MANAGE, async (c, r) => withTag(await svc.updateSettings(c, { ifMatch: ifMatch(r), body: r.body }))),
});
