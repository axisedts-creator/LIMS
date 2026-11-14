// H6 POST /v1/homecollection/visits/{visit_id}/cancel (homecollection.visit.assign; If-Match required)
import type { Handler } from '../../../core/module.js';
import { cancelHomeVisit } from '../visit.service.js';

export const handler: Handler = (req, ctx) => cancelHomeVisit(ctx, req.params, req.headers, req.body);
