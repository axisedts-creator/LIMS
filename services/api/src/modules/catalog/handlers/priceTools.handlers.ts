// T0B-PRICETOOLS-1 handlers of the seven T0C-PRICETOOLS-1 operations (LD-321; LD-325(b): removed from the catalog pendingOperations). The core pipeline owns schema, auth, multipart,
// the x-upload allowlist and Idempotency-Key; the service asserts catalog.price_list.manage / .read itself before it reads anything. Fail closed without a request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { Ctx } from '../service/masters.service.js';
import { createPriceToolsService, type Identity } from '../service/priceTools.service.js';

type Svc = ReturnType<typeof createPriceToolsService>;
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(run: (s: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx> & { ports?: { IdentityPort?: Identity } };
    const identity = c.ports?.IdentityPort;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof identity?.assertRole !== 'function') throw new LimsError('auth.unauthenticated');
    return run(createPriceToolsService({ identity }), c as Ctx, req);
  };
}

export const priceToolsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  downloadPriceListTemplate: bind(async (s, c, r) => {
    const f = await s.template(c, r.query);
    return { status: 200, body: f.bytes, headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.fileName}"` } };
  }),
  dryRunPriceListImport: bind(async (s, c, r) => ({ status: 201, body: await s.dryRun(c, obj(r.params)['price_list_id'], r.body) })),
  commitPriceListImport: bind(async (s, c, r) => s.commit(c, obj(r.params)['batch_id'], r.body)),
  listPriceListImportBatches: bind(async (s, c, r) => ({ status: 200, body: await s.listBatches(c, r.query) })),
  bulkUpdatePriceListDraft: bind(async (s, c, r) => ({ status: 200, body: await s.bulk(c, obj(r.params)['price_list_version_id'], r.body) })),
  copyPriceList: bind(async (s, c, r) => ({ status: 201, body: await s.copy(c, obj(r.params)['price_list_id'], r.body) })),
  comparePriceLists: bind(async (s, c, r) => ({ status: 200, body: await s.compare(c, r.query) })),
});
