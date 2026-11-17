// B28 createBillingExport (202), B29 getBillingExport, B29a getBillingExportContent (02-TRD §5; LD-97 wired them, LD-100 redo; 08 A13 P-2).
// Schema, auth, x-permission and Idempotency-Key presence are the core pipeline's (contracts/openapi/billing.yaml); privileged (billing.data.export) is checked in the service.
// B29a never produces a URL: the bytes come back through the core ctx.download.stream (attachment, nosniff, no-store; its access_log row is the data.export stage download).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import type { BalanceCtx } from '../service/balance.service.js';
import { createExportService, type ExportService } from '../service/export.service.js';

let svc: ExportService | undefined;
const service = (): ExportService => (svc ??= createExportService());
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(fn: (s: ExportService, ctx: BalanceCtx, hctx: HandlerContext, req: HandlerRequest) => Promise<HandlerResult>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BalanceCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return fn(service(), c as BalanceCtx, hctx, req);
  };
}
const exportId = (req: HandlerRequest) => ({ exportId: obj(req.params)['export_id'] });

export const exportHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createBillingExport: bind(async (s, ctx, _h, req) => ({ status: 202, body: await s.create(ctx, req.body) })),
  getBillingExport: bind(async (s, ctx, _h, req) => ({ status: 200, body: await s.get(ctx, exportId(req)) })),
  getBillingExportContent: bind(async (s, ctx, hctx, req) => {
    const download = (hctx as unknown as { download?: { stream?: (i: unknown) => Promise<HandlerResult> } }).download;
    if (typeof download?.stream !== 'function') throw new LimsError('common.internal'); // fail closed: no stream helper, no bytes
    return download.stream(await s.prepareDownload(ctx, exportId(req)));
  }),
});
