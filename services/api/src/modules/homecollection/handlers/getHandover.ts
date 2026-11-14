// H14 GET /v1/homecollection/handovers/{handover_id} (homecollection.handover.receive on to_centre_id; reads handovers + handover_items only, D-125)
import type { Handler } from '../../../core/module.js';
import { getHandover } from '../handover.service.js';

export const handler: Handler = (req, ctx) => getHandover(ctx, req.params);
