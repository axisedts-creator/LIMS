// F19 POST /v1/frontdesk/discount-approvals/{approval_id}/reject (If-Match "<version>", Idempotency-Key required; note required)
import type { Handler } from '../../../core/module.js';
import { decide } from '../service/discount.service.js';

export const handler: Handler = (req, ctx) => decide(ctx, req.params, req.headers, req.body, 'rejected');
