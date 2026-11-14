// F16 GET /v1/frontdesk/discount-approvals (approver inbox; frontdesk.discount.approve, aal2)
import type { Handler } from '../../../core/module.js';
import { list } from '../service/discount.service.js';

export const handler: Handler = (req, ctx) => list(ctx, req.query);
