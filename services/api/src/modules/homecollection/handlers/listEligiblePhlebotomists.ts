// H12 GET /v1/homecollection/phlebotomists
import type { Handler } from '../../../core/module.js';
import { listEligiblePhlebotomists } from '../service/visitRead.service.js';

export const handler: Handler = (req, ctx) => listEligiblePhlebotomists(ctx, req.query);
