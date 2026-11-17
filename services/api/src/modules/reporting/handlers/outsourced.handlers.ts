// O1-O6 handlers (02-TRD §6.4). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from
// contracts/openapi/reporting.yaml; these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { contentDisposition } from '../../../core/storage/download.js';
import { createOutsourcedService, type OutsourcedCtx } from '../service/outsourced.service.js';

type Svc = ReturnType<typeof createOutsourcedService>;
const svc = createOutsourcedService();
function bind(fn: (s: Svc, ctx: OutsourcedCtx, req: HandlerRequest) => Promise<{ status: number; body: unknown; version?: number; headers?: Record<string, string> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<OutsourcedCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as OutsourcedCtx, req);
    const headers = { ...(out.headers ?? {}), ...(out.version === undefined ? {} : { etag: `"${out.version}"` }) };
    return { status: out.status, body: out.body, ...(Object.keys(headers).length ? { headers } : {}) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
/** If-Match: "<version>" (02-CV §4.2). Absent -> undefined (428); malformed -> 0 (400). */
export function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  return m ? Number(m[1]) : 0;
}

export const outsourcedHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  uploadOutsourcedReport: bind(async (s, ctx, req) => {
    const b = obj(req.body);
    const out = await s.upload(ctx, { orderItemId: obj(req.params)['order_item_id'], file: b['file'], externalLabName: b['external_lab_name'] });
    return { status: 201, body: out, version: out['version'] as number };
  }),
  listOutsourcedReports: bind(async (s, ctx, req) => ({ status: 200, body: await s.list(ctx, { orderItemId: obj(req.params)['order_item_id'] }) })),
  confirmOutsourcedReport: bind(async (s, ctx, req) => {
    const out = await s.confirm(ctx, { fileId: obj(req.params)['file_id'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: out, version: out['version'] as number };
  }),
  withdrawOutsourcedReport: bind(async (s, ctx, req) => {
    const out = await s.withdraw(ctx, { fileId: obj(req.params)['file_id'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: out, version: out['version'] as number };
  }),
  // REQ-SEC-083: attachment + nosniff + no-store + CSP sandbox; the filename is sanitised by the service and encoded per RFC 6266.
  downloadOutsourcedReport: bind(async (s, ctx, req) => {
    const out = await s.download(ctx, { fileId: obj(req.params)['file_id'] });
    return {
      status: 200, body: out.bytes, headers: {
        'content-type': out.contentType, 'content-disposition': contentDisposition('attachment', out.filename),
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': 'sandbox',
        'content-length': String(out.bytes.length),
      },
    };
  }),
  listOutsourcedItems: bind(async (s, ctx, req) => {
    const q = obj(req.query);
    return { status: 200, body: await s.listItems(ctx, { centreId: q['centre_id'], state: q['state'], cursor: q['cursor'], limit: q['limit'] }) };
  }),
});
