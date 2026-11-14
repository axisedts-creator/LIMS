// H7 POST /v1/homecollection/visits/{visit_id}/revisits (homecollection.visit.assign; Idempotency-Key required) -> 201
import type { Handler } from '../../../core/module.js';
import { createHomeRevisit } from '../visit.service.js';

export const handler: Handler = (req, ctx) => createHomeRevisit(ctx, req.params, req.headers, req.body);
