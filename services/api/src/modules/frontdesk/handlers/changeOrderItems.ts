// F13 POST /v1/frontdesk/orders/{order_id}/items (If-Match "<version>", Idempotency-Key required).
import type { Handler } from '../../../core/module.js';
import { changeItems } from '../service/order.service.js';

export const handler: Handler = (req, ctx) => changeItems(ctx, req.params, req.headers, req.body);
