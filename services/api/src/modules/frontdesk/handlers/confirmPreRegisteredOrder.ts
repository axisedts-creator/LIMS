// F12 POST /v1/frontdesk/orders/{order_id}/confirm (If-Match "<version>", Idempotency-Key required). Same registration/invoice path as F9, one request tx.
import type { Handler } from '../../../core/module.js';
import { confirm } from '../service/registration.service.js';

export const handler: Handler = (req, ctx) => confirm(ctx, req.params, req.headers, req.body);
