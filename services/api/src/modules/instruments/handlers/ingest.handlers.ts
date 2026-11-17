// E04 submitMessageBatch handler (02-TRD §7.2). deviceToken auth, x-permission, schema, the 4 MiB body limit and the required
// Idempotency-Key are enforced by the core pipeline from contracts/openapi/instruments.yaml; this maps request -> service and fails
// closed without an authenticated device context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createIngestService, type IngestCtx } from '../service/ingest.service.js';

const ingest = createIngestService();

export const ingestHandlers = Object.freeze({
  submitMessageBatch: (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<IngestCtx>;
    if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return ingest.submitMessageBatch(c as IngestCtx, { body: req.body });
  }) as Handler,
} satisfies Record<string, Handler>);
