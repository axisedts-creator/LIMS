// A2 GET /v1/homecollection/sync/snapshot?device_id&cursor (homecollection.sync.upload + visit.read via assertRole; 200 SnapshotDto)
import type { Handler } from '../../../core/module.js';
import { hcMetrics, timed } from '../metrics.js';
import { getSyncSnapshot } from '../snapshot.service.js';

// HC-T17: snapshot_duration_seconds{changed} (TRD §14); only successful pulls are observed (changed is unknown on failure).
export const handler: Handler = (req, ctx) =>
  timed(() => getSyncSnapshot(ctx, req.query, req.headers), (s, r) => { if (r) hcMetrics.snapshotDuration(ctx, s, (r.body as { unchanged?: boolean } | undefined)?.unchanged !== true); });
