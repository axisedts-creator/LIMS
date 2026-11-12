// H20 GET /v1/homecollection/reasons?set=<enum> (global seeds only, D-130)
import type { Handler } from '../../../core/module.js';
import { listHomecollectionReasons } from '../settings.service.js';

export const handler: Handler = (req, ctx) => listHomecollectionReasons(ctx, req.query);
