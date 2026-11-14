// F10 GET /v1/frontdesk/orders (keyset cursor, derived status per row)
import type { Handler } from '../../../core/module.js';
import { listOrders } from '../service/order.service.js';

export const handler: Handler = (req, ctx) => listOrders(ctx, req.query);
