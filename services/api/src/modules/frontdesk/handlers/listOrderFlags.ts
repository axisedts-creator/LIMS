// F22 GET /v1/frontdesk/order-flags (keyset cursor; default status=open; centre scope).
import type { Handler } from '../../../core/module.js';
import { listOrderFlags } from '../service/flags.service.js';

export const handler: Handler = (req, ctx) => listOrderFlags(ctx, req.query);
