// A4 POST /v1/homecollection/sync/ack (homecollection.sync.upload; 204)
import type { Handler } from '../../../core/module.js';
import { ackSync } from '../snapshot.service.js';

export const handler: Handler = (req, ctx) => ackSync(ctx, req.headers, req.body);
