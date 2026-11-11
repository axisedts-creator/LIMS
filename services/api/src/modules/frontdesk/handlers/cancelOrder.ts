// F14 POST /v1/frontdesk/orders/{order_id}/cancel (If-Match "<version>", Idempotency-Key required).
import type { Handler } from '../../../core/module.js';
import { cancelOrder } from '../service/order.service.js';

export const handler: Handler = (req, ctx) => cancelOrder(ctx, req.params, req.headers, req.body);
