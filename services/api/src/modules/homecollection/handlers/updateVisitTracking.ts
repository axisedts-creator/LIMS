// PUT /v1/homecollection/visits/{visit_id}/tracking (homecollection.sync.upload; 200)
import type { Handler } from '../../../core/module.js';
import { updateVisitTracking } from '../tracking.service.js';

export const handler: Handler = (req, ctx) => updateVisitTracking(ctx, req.params, req.body);
