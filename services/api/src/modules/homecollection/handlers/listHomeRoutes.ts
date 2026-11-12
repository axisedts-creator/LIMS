// H10 GET /v1/homecollection/routes
import type { Handler } from '../../../core/module.js';
import { listHomeRoutes } from '../service/visitRead.service.js';

export const handler: Handler = (req, ctx) => listHomeRoutes(ctx, req.query);
