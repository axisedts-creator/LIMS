// H15 POST /v1/homecollection/handovers/{handover_id}/confirm (homecollection.handover.receive; If-Match = handover version; Idempotency-Key required)
import type { Handler } from '../../../core/module.js';
import { confirmHandover } from '../handover.service.js';

export const handler: Handler = (req, ctx) => confirmHandover(ctx, req.params, req.headers, req.body);
