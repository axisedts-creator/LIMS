// H1 GET /v1/homecollection/visits
import type { Handler } from '../../../core/module.js';
import { listHomeVisits } from '../service/visitRead.service.js';

export const handler: Handler = (req, ctx) => listHomeVisits(ctx, req.query);
