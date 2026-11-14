// #6 POST /v1/lab/specimens/bulk-dispatch (Idempotency-Key required, enforced by core; S3; AC-03.3; LD-25 entry_mode)
import type { Handler } from '../../../core/module.js';
import { bulkDispatchSpecimens } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => bulkDispatchSpecimens(ctx, req.body);
