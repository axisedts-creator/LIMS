// H11 POST /v1/homecollection/routes/{route_id}/sequence (homecollection.visit.assign; If-Match = route version)
import type { Handler } from '../../../core/module.js';
import { resequenceHomeRoute } from '../route.service.js';

export const handler: Handler = (req, ctx) => resequenceHomeRoute(ctx, req.params, req.headers, req.body);
