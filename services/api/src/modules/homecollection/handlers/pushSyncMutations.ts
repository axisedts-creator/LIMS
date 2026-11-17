// A3 POST /v1/homecollection/sync/mutations (homecollection.sync.upload; 200 PushResponse)
import type { Handler } from '../../../core/module.js';
import { hcMetrics, timed } from '../metrics.js';
import { pushSyncMutations } from '../sync.service.js';

// HC-T17: one push_duration observation per push (TRD §14), also when the push fails.
export const handler: Handler = (req, ctx) => timed(() => pushSyncMutations(ctx, req.headers, req.body), (s) => hcMetrics.pushDuration(ctx, s));
