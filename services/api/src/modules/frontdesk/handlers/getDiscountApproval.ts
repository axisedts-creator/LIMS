// F17 GET /v1/frontdesk/discount-approvals/{approval_id} (requester polls own; approvers read their centres)
import type { Handler } from '../../../core/module.js';
import { get } from '../service/discount.service.js';

export const handler: Handler = (req, ctx) => get(ctx, req.params);
