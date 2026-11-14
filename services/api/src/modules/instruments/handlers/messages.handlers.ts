// E33-E36 / E42 handlers (02-TRD §7.3). bearerJwt auth, x-permission, schema, query coercion (csv -> arrays, booleans, numbers) are enforced by the core pipeline
// from contracts/openapi/instruments.yaml; this maps request -> service and fails closed without an authenticated context.
// E34: the barcode is read from the BODY only (REQ-SEC-098). E36: Cache-Control: no-store (07-SECURITY §5).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createMessagesService, type MessagesCtx } from '../service/messages.service.js';

const messages = createMessagesService();
const authed = (c: Partial<MessagesCtx> | undefined): c is MessagesCtx => typeof c?.tenantId === 'string' && typeof c.actor?.id === 'string' && !!c.tx;
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const wrap = (f: (c: MessagesCtx, req: HandlerRequest) => Promise<any>): Handler => (async (req: HandlerRequest, hctx: HandlerContext) => {
  const c = hctx as unknown as Partial<MessagesCtx>;
  if (!authed(c)) throw new LimsError('auth.unauthenticated');
  return f(c, req);
}) as Handler;

export const messagesHandlers = Object.freeze({
  listInstrumentMessages: wrap((c, req) => {
    const q = rec(req.query);
    return messages.listInstrumentMessages(c, { receivedAtFrom: q['received_at_from'], receivedAtTo: q['received_at_to'], instrumentId: q['instrument_id'], agentId: q['agent_id'], centreId: q['centre_id'],
      messageKind: q['message_kind'], latestOutcome: q['latest_outcome'], hasUnmapped: q['has_unmapped'], hasQc: q['has_qc'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'] });
  }),
  searchInstrumentMessages: wrap((c, req) => messages.searchInstrumentMessages(c, { body: req.body })),
  getInstrumentMessage: wrap((c, req) => messages.getInstrumentMessage(c, { instrumentMessageId: rec(req.params)['instrument_message_id'], previewParse: rec(req.query)['preview_parse'] })),
  getInstrumentMessageRaw: wrap(async (c, req) => {
    const r = await messages.getInstrumentMessageRaw(c, { instrumentMessageId: rec(req.params)['instrument_message_id'] });
    return { ...r, headers: { ...r.headers, 'cache-control': 'no-store' } };
  }),
  listMessageRejections: wrap((c, req) => {
    const q = rec(req.query);
    return messages.listMessageRejections(c, { receivedAtFrom: q['received_at_from'], receivedAtTo: q['received_at_to'], agentId: q['agent_id'], reason: q['reason'], cursor: q['cursor'], limit: q['limit'] });
  }),
} satisfies Record<string, Handler>);
