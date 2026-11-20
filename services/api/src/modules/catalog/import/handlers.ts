// T0B-TESTIMPORT-1 handlers of the six T0C-TESTIMPORT-1 operations (LD-325(b): removed from the catalog pendingOperations). The core pipeline owns schema, auth,
// multipart parsing, the x-upload allowlist and Idempotency-Key; the service asserts catalog.test.manage itself. Downloads follow the attachment convention of imports.handlers.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { ifMatch } from '../handlers/masters.handlers.js';
import { createTestImportService, type Ctx, type Identity } from './service.js';

type Svc = ReturnType<typeof createTestImportService>;
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(run: (svc: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx> & { ports?: { IdentityPort?: Identity } };
    const identity = c.ports?.IdentityPort;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events || !identity) throw new LimsError('auth.unauthenticated');
    return run(createTestImportService({ identity }), c as Ctx, req);
  };
}
const attachment = (f: { fileName: string; contentType: string; bytes: Uint8Array }) =>
  ({ status: 200, body: f.bytes, headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.fileName}"` } });
const etag = (b: unknown) => ({ etag: `"${String(obj(b)['version'] ?? obj(obj(b)['batch'])['version'])}"` });

export const testImportHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  downloadCatalogImportTemplate: bind(async (s, c) => attachment(await s.downloadTemplate(c))),
  validateCatalogImport: bind(async (s, c, r) => { const out = await s.validate(c, r.body); return { ...out, headers: etag(out.body) }; }),
  commitCatalogImport: bind(async (s, c, r) => { const b = await s.commit(c, obj(r.params)['batch_id'], ifMatch(r), r.body); return { status: 201, body: b, headers: etag(b) }; }),
  listCatalogImports: bind(async (s, c, r) => ({ status: 200, body: await s.list(c, r.query) })),
  getCatalogImport: bind(async (s, c, r) => { const b = await s.get(c, obj(r.params)['batch_id']); return { status: 200, body: b, headers: etag(b) }; }),
  downloadCatalogImportErrors: bind(async (s, c, r) => attachment(await s.errorsFile(c, obj(r.params)['batch_id']))),
});
