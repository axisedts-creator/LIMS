// H5 POST /v1/homecollection/visits/{visit_id}/schedule (homecollection.visit.assign; If-Match required)
import type { Handler } from '../../../core/module.js';
import { scheduleHomeVisit } from '../visit.service.js';

export const handler: Handler = (req, ctx) => scheduleHomeVisit(ctx, req.params, req.headers, req.body);
