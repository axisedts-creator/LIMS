// T0B-REGAPI-2 GET /v1/frontdesk/registrations/number-preview (LD-310 done_when 5): a read of the counters, nothing consumed.
import type { Handler } from '../../../core/module.js';
import { previewNumbers } from '../service/parity.service.js';

export const handler: Handler = (req, ctx) => previewNumbers(ctx, req.query);
