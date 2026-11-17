// F11 GET /v1/frontdesk/orders/{order_id} (derived status, 03-IC §10.4 / 08 A13 D-5)
import type { Handler } from '../../../core/module.js';
import { getOrder } from '../service/order.service.js';

export const handler: Handler = (req, ctx) => getOrder(ctx, req.params);
