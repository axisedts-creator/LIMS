// M1, M2, M15, M16 (02-TRD §5). Read-only, x-idempotency none. The permission check lives in the service: M1 asserts first; M2/M15/M16 load the
// object first and assert with its centre_id (02-CV §10.1, 07-SECURITY S-01/S-02).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import * as svc from '../service/chain.service.js';

const read = (fn: (c: svc.ChainCtx, r: HandlerRequest) => Promise<Record<string, unknown>>): Handler =>
  async (req: HandlerRequest, hctx: HandlerContext) => ({ status: 200, body: await fn(hctx as unknown as svc.ChainCtx, req) });

export const cultureHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listCultures: read((c, r) => svc.listCultures(c, { query: r.query })),
  getCulture: read((c, r) => svc.getCulture(c, { params: r.params })),
  listCultureReportVersions: read((c, r) => svc.listReportVersions(c, { params: r.params })),
  getCultureReportVersion: read((c, r) => svc.getReportVersion(c, { params: r.params })),
});
