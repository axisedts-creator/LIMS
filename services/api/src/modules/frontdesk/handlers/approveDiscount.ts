// F18 POST /v1/frontdesk/discount-approvals/{approval_id}/approve (If-Match "<version>", Idempotency-Key required; frontdesk.discount.approve, aal2)
import type { Handler } from '../../../core/module.js';
import { decide } from '../service/discount.service.js';

export const handler: Handler = (req, ctx) => decide(ctx, req.params, req.headers, req.body, 'approved');
