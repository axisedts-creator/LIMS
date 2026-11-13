// H13 GET /v1/homecollection/handovers (homecollection.handover.receive; centre scope = RLS on to_centre_id, D-125)
import type { Handler } from '../../../core/module.js';
import { listHandovers } from '../handover.service.js';

export const handler: Handler = (req, ctx) => listHandovers(ctx, req.query);
