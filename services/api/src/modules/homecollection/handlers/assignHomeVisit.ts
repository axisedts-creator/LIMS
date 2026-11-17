// H3 POST /v1/homecollection/visits/{visit_id}/assign (homecollection.visit.assign; Idempotency-Key + If-Match required)
import type { Handler } from '../../../core/module.js';
import { assignHomeVisit } from '../visit.service.js';

export const handler: Handler = (req, ctx) => assignHomeVisit(ctx, req.params, req.headers, req.body);
