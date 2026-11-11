// #96–#101, #103 handlers (02-TRD §5.2). Schema, auth, the floor x-permission, multipart parsing + x-upload allowlist and
// Idempotency-Key are the core pipeline's; these only map HTTP <-> imports.service (which asserts the per-kind permission, P-10).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createImportsService, type ImportsCtx } from '../service/imports.service.js';

type Svc = ReturnType<typeof createImportsService>;
type Ports = { IdentityPort?: Parameters<typeof createImportsService>[0]['identity'] };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

/** [CONV] the full HandlerContext (tenantId/actor/tx/now/ports) lands with T0D-02..10; until then a context without them is unauthenticated. */
function bind(fn: (svc: Svc, ctx: ImportsCtx, req: HandlerRequest) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<ImportsCtx> & { ports?: Ports };
    const identity = c.ports?.IdentityPort;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function' || !identity) throw new LimsError('auth.unauthenticated');
    return fn(createImportsService({ identity }), c as ImportsCtx, req);
  };
}
const attachment = (f: { fileName: string; contentType: string; bytes: Uint8Array }) =>
  ({ status: 200, body: f.bytes, headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.fileName}"` } });
const etag = (b: Record<string, unknown>) => ({ etag: `"${String(b['version'])}"` });
/** If-Match: "<version>" (02-CV §4.2). Absent -> 428; malformed -> 400. */
function ifMatch(req: HandlerRequest): number {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m) throw new LimsError('common.validation_failed');
  return Number(m[1]);
}

export const importsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  downloadImportTemplate: bind(async (s, ctx, req) => attachment(await s.downloadTemplate(ctx, obj(req.params)['kind']))),
  createImport: bind(async (s, ctx, req) => {
    // [CONV] multipart shape from the core parser: fields as strings, `file` = { filename, mimetype, data: Buffer }.
    const b = obj(req.body);
    const f = obj(b['file']);
    const out = await s.createImport(ctx, {
      kind: b['kind'], targetPriceListId: b['target_price_list_id'],
      file: { filename: f['filename'], mimeType: f['mimetype'] ?? f['mimeType'], bytes: f['data'] ?? f['bytes'] },
    });
    return { status: out.status, body: out.body, headers: etag(out.body) };
  }),
  listImports: bind(async (s, ctx, req) => {
    const q = obj(req.query);
    return { status: 200, body: await s.listImports(ctx, { kind: q['kind'], status: q['status'], cursor: q['cursor'], limit: q['limit'] }) };
  }),
  getImport: bind(async (s, ctx, req) => { const b = await s.getImport(ctx, obj(req.params)['import_id']); return { status: 200, body: b, headers: etag(b) }; }),
  listImportIssues: bind(async (s, ctx, req) => {
    const q = obj(req.query);
    return { status: 200, body: await s.listImportIssues(ctx, obj(req.params)['import_id'], { severity: q['severity'], cursor: q['cursor'], limit: q['limit'] }) };
  }),
  downloadImportReport: bind(async (s, ctx, req) => attachment(await s.downloadImportReport(ctx, obj(req.params)['import_id']))),
  discardImport: bind(async (s, ctx, req) => {
    const b = await s.discardImport(ctx, obj(req.params)['import_id'], ifMatch(req));
    return { status: 200, body: b, headers: etag(b) };
  }),
  commitImport: bind(async (s, ctx, req) => {
    const b = await s.commitImport(ctx, obj(req.params)['import_id'], ifMatch(req), req.body);
    return { status: 202, body: b, headers: etag(b) };
  }),
});
