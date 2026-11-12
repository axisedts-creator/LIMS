// M41–M45, M49 (02-TRD §5). Permission FIRST (07-SECURITY S-10: micro.breakpoint.manage is privileged, so aal2 is enforced inside IdentityPort.assertRole;
// M41/M43 = micro.culture.read only, D-64), before any body validation, storage or SQL; then the service. Idempotency-Key replay on M42 is the core pipeline's.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { TEMPLATE_CSV } from '../mappers/breakpoint.mappers.js';
import * as svc from '../service/breakpoint.service.js';
import type { MicroPermission } from '../permissions.js';

const READ: MicroPermission = 'micro.culture.read';
const MANAGE: MicroPermission = 'micro.breakpoint.manage';
const etag = (body: Record<string, unknown>): Record<string, string> | undefined => (typeof body['version'] === 'number' ? { etag: `"${body['version']}"` } : undefined);

function op(permission: MicroPermission, fn: (ctx: svc.BreakpointCtx, req: HandlerRequest) => Promise<HandlerResult>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as svc.BreakpointCtx & { ports?: { IdentityPort?: { assertRole(c: unknown, r: { permission: string }): Promise<unknown> } } };
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('auth.forbidden'); // fail closed: no way to ask, so no
    await identity.assertRole(c, { permission });          // first step; a rejection (auth.forbidden / auth.mfa_required) passes through
    return fn(c, req);
  };
}

export const breakpointHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listBreakpointSets: op(READ, async (c, r) => ({ status: 200, body: await svc.listSets(c, { query: r.query }) })),
  createBreakpointImport: op(MANAGE, async (c, r) => {
    const out = await svc.createImport(c, { body: r.body });
    return { status: 201, body: out.body, headers: { etag: `"${out.version}"` } };
  }),
  getBreakpointSet: op(READ, async (c, r) => { const body = await svc.getSet(c, { params: r.params }); return { status: 200, body, ...(etag(body) ? { headers: etag(body)! } : {}) }; }),
  listBreakpointImportIssues: op(MANAGE, async (c, r) => ({ status: 200, body: await svc.listIssues(c, { params: r.params, query: r.query }) })),
  listBreakpointRows: op(MANAGE, async (c, r) => ({ status: 200, body: await svc.listRows(c, { params: r.params, query: r.query }) })),
  downloadBreakpointTemplate: op(MANAGE, async () => ({
    status: 200, body: TEMPLATE_CSV,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="breakpoint-template.csv"', 'cache-control': 'no-store' },
  })),
});
