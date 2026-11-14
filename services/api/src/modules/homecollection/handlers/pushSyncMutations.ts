// A3 POST /v1/homecollection/sync/mutations (homecollection.sync.upload; 200 PushResponse)
import type { Handler } from '../../../core/module.js';
import { pushSyncMutations } from '../sync.service.js';

export const handler: Handler = (req, ctx) => pushSyncMutations(ctx, req.headers, req.body);
