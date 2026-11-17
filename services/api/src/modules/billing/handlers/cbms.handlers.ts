// B30 listCbmsDocuments, B31 retryCbmsDocument (02-TRD §5.2). Schema, auth, x-permission (billing.invoice.read / billing.settings.manage [privileged]) and the required
// Idempotency-Key are enforced by the core pipeline from contracts/openapi/billing.yaml; these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { RecordingStubCbmsClient } from '../cbms/RecordingStubCbmsClient.js';
import { createCbmsService, type CbmsCtx, type CbmsService } from '../service/cbms.service.js';

const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
let svc: CbmsService | undefined;
// the API never submits (the worker does, billing.cbms_sync); the client is only needed to build the service
const service = (): CbmsService => (svc ??= createCbmsService({ client: new RecordingStubCbmsClient() }));

function bind(fn: (s: CbmsService, ctx: CbmsCtx, req: HandlerRequest) => Promise<unknown>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<CbmsCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return { status: 200, body: await fn(service(), c as CbmsCtx, req) };
  };
}

export const cbmsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listCbmsDocuments: bind((s, ctx, req) => {
    const q = obj(req.query);
    return s.listDocuments(ctx, { state: q['state'], documentKind: q['document_kind'], cursor: q['cursor'], limit: q['limit'] });
  }),
  retryCbmsDocument: bind((s, ctx, req) => {
    const p = obj(req.params);
    return s.retry(ctx, { documentKind: p['document_kind'], documentId: p['document_id'] });
  }),
});
