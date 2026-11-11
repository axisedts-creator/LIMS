// F23 POST /v1/frontdesk/order-flags/{flag_id}/resolve (If-Match "<version>", Idempotency-Key required; resolved once, then common.immutable_record).
import type { Handler } from '../../../core/module.js';
import { resolveOrderFlag } from '../service/flags.service.js';

export const handler: Handler = (req, ctx) => resolveOrderFlag(ctx, req.params, req.headers, req.body);
