// M1, M2, M15, M16 (02-TRD §5). Read-only, x-idempotency none. The permission check lives in the service: M1 asserts first; M2/M15/M16 load the
// object first and assert with its centre_id (02-CV §10.1, 07-SECURITY S-01/S-02).
// M3–M6 (T-08) write: the service loads the culture FOR UPDATE first, then asserts micro.culture.work with its centre_id. Idempotency-Key replay (M3/M4/M6 required, M5 optional)
// is the core pipeline's; If-Match / ETag are the 02-CV §4.2 version quoting (M3 = culture version, M5 = plate version, M4/M6 take none).
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import * as svc from '../service/chain.service.js';
import * as write from '../service/culture.service.js';
import { ifMatch } from './config.handlers.js';

const read = (fn: (c: svc.ChainCtx, r: HandlerRequest) => Promise<Record<string, unknown>>): Handler =>
  async (req: HandlerRequest, hctx: HandlerContext) => ({ status: 200, body: await fn(hctx as unknown as svc.ChainCtx, req) });

const send = (fn: (c: write.WriteCtx, r: HandlerRequest) => Promise<{ body: Record<string, unknown>; version?: number }>): Handler =>
  async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const out = await fn(hctx as unknown as write.WriteCtx, req);
    return { status: 200, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };

export const cultureHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listCultures: read((c, r) => svc.listCultures(c, { query: r.query })),
  getCulture: read((c, r) => svc.getCulture(c, { params: r.params })),
  listCultureReportVersions: read((c, r) => svc.listReportVersions(c, { params: r.params })),
  getCultureReportVersion: read((c, r) => svc.getReportVersion(c, { params: r.params })),
  setupCulture: send((c, r) => write.setupCulture(c, { params: r.params, ifMatch: ifMatch(r), body: r.body })),
  addCulturePlate: send((c, r) => write.addCulturePlate(c, { params: r.params, body: r.body })),
  discardCulturePlate: send((c, r) => write.discardCulturePlate(c, { params: r.params, ifMatch: ifMatch(r), body: r.body })),
  recordCultureObservation: send((c, r) => write.recordCultureObservation(c, { params: r.params, body: r.body })),
});
