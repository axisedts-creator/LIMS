// PATCH /v1/homecollection/phlebotomists/{membership_id} (T0B-SALES-1, LD-321)
import type { Handler } from '../../../core/module.js';
import { updateCollectorFlags } from '../settings.service.js';

export const handler: Handler = (req, ctx) => updateCollectorFlags(ctx, req.params, req.body);
