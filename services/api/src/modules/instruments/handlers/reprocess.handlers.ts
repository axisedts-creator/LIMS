// E38 / E39 handlers (02-TRD §7.3). bearerJwt auth, x-permission, body schema are enforced by the core pipeline from contracts/openapi/instruments.yaml;
// this maps request -> service and fails closed without an authenticated context. The re-match barcode is read from the BODY only (REQ-SEC-098).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createReprocessService, type ReprocessCtx } from '../service/reprocess.service.js';

const reprocess = createReprocessService();
const authed = (c: Partial<ReprocessCtx> | undefined): c is ReprocessCtx => typeof c?.tenantId === 'string' && typeof c.actor?.id === 'string' && !!c.tx;
const params = (req: HandlerRequest): Record<string, unknown> => (typeof req.params === 'object' && req.params !== null ? (req.params as Record<string, unknown>) : {});
const wrap = (f: (c: ReprocessCtx, req: HandlerRequest) => Promise<any>): Handler => (async (req: HandlerRequest, hctx: HandlerContext) => {
  const c = hctx as unknown as Partial<ReprocessCtx>;
  if (!authed(c)) throw new LimsError('auth.unauthenticated');
  return f(c, req);
}) as Handler;

export const reprocessHandlers = Object.freeze({
  reprocessInstrumentMessage: wrap((c, req) => reprocess.reprocessInstrumentMessage(c, { instrumentMessageId: params(req)['instrument_message_id'], body: req.body })),
  rematchInstrumentRecord: wrap((c, req) => reprocess.rematchInstrumentRecord(c, { recordId: params(req)['record_id'], body: req.body })),
} satisfies Record<string, Handler>);
