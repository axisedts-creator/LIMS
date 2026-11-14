// H9 POST /v1/homecollection/collections/{collection_id}/review (homecollection.visit.assign; If-Match = collection version)
import type { Handler } from '../../../core/module.js';
import { reviewHeldCollection } from '../collection.service.js';

export const handler: Handler = (req, ctx) => reviewHeldCollection(ctx, req.params, req.headers, req.body);
