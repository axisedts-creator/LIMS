// #104–#107 handlers (02-TRD §5.2). Schema, auth, the floor x-permission and Idempotency-Key are the core pipeline's; these only map
// HTTP <-> exports.service (which asserts the per-kind permission, P-10). #106 headers per 07-SECURITY S-10.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createExportsService, type ExportsCtx } from '../service/exports.service.js';

type Svc = ReturnType<typeof createExportsService>;
type Ports = { IdentityPort?: Parameters<typeof createExportsService>[0]['identity'] };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

/** [CONV] same unauthenticated guard as imports.handlers.ts until the full HandlerContext lands (T0D-02..10). */
function bind(fn: (svc: Svc, ctx: ExportsCtx, req: HandlerRequest) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<ExportsCtx> & { ports?: Ports };
    const identity = c.ports?.IdentityPort;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function' || !identity) throw new LimsError('auth.unauthenticated');
    return fn(createExportsService({ identity }), c as ExportsCtx, req);
  };
}
const etag = (b: Record<string, unknown>) => ({ etag: `"${String(b['version'])}"` });
/** Header-safe file name: drop quotes, backslashes and control characters (no header injection from a stored name). */
const safeName = (n: string) => n.replace(/["\\\x00-\x1f\x7f]/g, '_');

export const exportsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createExport: bind(async (s, ctx, req) => {
    const b = obj(req.body);
    const out = await s.createExport(ctx, { kind: b['kind'], priceListVersionId: b['price_list_version_id'] });
    return { status: out.status, body: out.body, headers: etag(out.body) };
  }),
  listExports: bind(async (s, ctx, req) => {
    const q = obj(req.query);
    return { status: 200, body: await s.listExports(ctx, { kind: q['kind'], status: q['status'], cursor: q['cursor'], limit: q['limit'] }) };
  }),
  getExport: bind(async (s, ctx, req) => { const b = await s.getExport(ctx, obj(req.params)['export_id']); return { status: 200, body: b, headers: etag(b) }; }),
  downloadExportFile: bind(async (s, ctx, req) => {
    const f = await s.downloadExportFile(ctx, obj(req.params)['export_id']);
    return {
      status: 200, body: f.bytes,
      headers: {
        'content-type': f.contentType, 'content-disposition': `attachment; filename="${safeName(f.fileName)}"`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',                       // S-10
      },
    };
  }),
});
