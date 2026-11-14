// E06 submitAttachment / E37 downloadInstrumentAttachment handlers (02-TRD §7.2). deviceToken / bearer auth, x-permission, schema, x-upload allowlist, the 15 MB body
// limit and the required Idempotency-Key are enforced by the core pipeline from contracts/openapi/instruments.yaml; this maps request -> service and fails closed
// without an authenticated context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createAttachmentsService, type AttachmentsCtx } from '../service/attachments.service.js';

const attachments = createAttachmentsService();
const authed = (c: Partial<AttachmentsCtx> | undefined): c is AttachmentsCtx => typeof c?.tenantId === 'string' && typeof c.actor?.id === 'string' && !!c.tx;

/** The `metadata` part: an object, or the JSON string a real multipart parser hands over. */
function metadataPart(v: unknown): Record<string, unknown> {
  let m = v;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { throw new LimsError('common.validation_failed'); } }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new LimsError('common.validation_failed');
  return m as Record<string, unknown>;
}

export const attachmentsHandlers = Object.freeze({
  submitAttachment: (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<AttachmentsCtx>;
    if (!authed(c)) throw new LimsError('auth.unauthenticated');
    const body = (req.body ?? {}) as Record<string, any>;
    const metadata = metadataPart(body['metadata']);
    const f = body['file'];
    if (typeof f !== 'object' || f === null || typeof f.filename !== 'string' || typeof f.mimetype !== 'string' || !(f.data instanceof Uint8Array)) throw new LimsError('common.validation_failed');
    return attachments.submitAttachment(c, { metadata, file: { filename: f.filename, mimeType: f.mimetype, bytes: f.data } });   // [CONV] core multipart part shape { filename, mimetype, data }
  }) as Handler,
  downloadInstrumentAttachment: (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<AttachmentsCtx>;
    if (!authed(c)) throw new LimsError('auth.unauthenticated');
    return attachments.downloadInstrumentAttachment(c, { instrumentMessageId: (req.params as Record<string, unknown> | undefined)?.['instrument_message_id'] });
  }) as Handler,
} satisfies Record<string, Handler>);
