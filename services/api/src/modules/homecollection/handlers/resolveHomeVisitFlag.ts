// H8 POST /v1/homecollection/visits/{visit_id}/flags/{flag_id}/resolve (homecollection.visit.assign; If-Match = flag version)
import type { Handler } from '../../../core/module.js';
import { resolveHomeVisitFlag } from '../visit.service.js';

export const handler: Handler = (req, ctx) => resolveHomeVisitFlag(ctx, req.params, req.headers, req.body);
