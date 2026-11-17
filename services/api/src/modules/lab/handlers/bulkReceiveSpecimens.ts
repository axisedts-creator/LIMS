// #8 POST /v1/lab/specimens/bulk-receive (Idempotency-Key required, enforced by core; S4; AC-04.1; LD-25 entry_mode)
import type { Handler } from '../../../core/module.js';
import { bulkReceiveSpecimens } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => bulkReceiveSpecimens(ctx, req.body);
