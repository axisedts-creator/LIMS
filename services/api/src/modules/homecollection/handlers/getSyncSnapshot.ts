// A2 GET /v1/homecollection/sync/snapshot?device_id&cursor (homecollection.sync.upload + visit.read via assertRole; 200 SnapshotDto)
import type { Handler } from '../../../core/module.js';
import { getSyncSnapshot } from '../snapshot.service.js';

export const handler: Handler = (req, ctx) => getSyncSnapshot(ctx, req.query, req.headers);
