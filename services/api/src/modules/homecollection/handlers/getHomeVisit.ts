// H2 GET /v1/homecollection/visits/{visit_id}
import type { Handler } from '../../../core/module.js';
import { getHomeVisit } from '../service/visitRead.service.js';

export const handler: Handler = (req, ctx) => getHomeVisit(ctx, req.params);
