// F15 POST /v1/frontdesk/discount-approvals (Idempotency-Key required; frontdesk.discount.apply)
import type { Handler } from '../../../core/module.js';
import { request } from '../service/discount.service.js';

export const handler: Handler = (req, ctx) => request(ctx, req.body);
