// #5 POST /v1/lab/specimens/bulk-collect (Idempotency-Key required, enforced by core; per-id outcome; AC-03.1; LD-25 entry_mode)
import type { Handler } from '../../../core/module.js';
import { bulkCollectSpecimens } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => bulkCollectSpecimens(ctx, req.body);
