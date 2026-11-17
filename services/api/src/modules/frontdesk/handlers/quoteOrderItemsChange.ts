// F8b POST /v1/frontdesk/orders/{order_id}/items/quote (no Idempotency-Key; read-only, prices are server-side).
import type { Handler } from '../../../core/module.js';
import { quoteItemsChange } from '../service/order.service.js';

export const handler: Handler = (req, ctx) => quoteItemsChange(ctx, req.params, req.body);
