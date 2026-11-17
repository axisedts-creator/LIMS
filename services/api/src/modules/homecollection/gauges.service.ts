// HC-T17: refreshes the three per-tenant gauges of 02-TRD §14 (held_open, devices_stale_total, handover_overdue_open). Called by the worker task
// services/worker/src/jobs/homecollection/tasks/refresh_metric_gauges.ts; 0 is exported when nothing is open, so an alert on a cleared condition resolves.
import { hcMetrics } from './metrics.js';
import { countOpenFlags, countStaleDevices } from './repository/metrics.repo.js';
import type { Tx } from './repository/shared.repo.js';

const STALE_AFTER_HOURS = 2;   // TRD §14: "last_seen > 2 h"

export async function refreshHomecollectionGauges(ctx: { readonly tenantId: string; readonly tx: Tx }): Promise<void> {
  const [held, stale, overdue] = await Promise.all([
    countOpenFlags(ctx.tx, ctx.tenantId, 'held_collection'), countStaleDevices(ctx.tx, ctx.tenantId, STALE_AFTER_HOURS), countOpenFlags(ctx.tx, ctx.tenantId, 'handover_overdue')]);
  hcMetrics.heldOpen(ctx, ctx.tenantId, held);
  hcMetrics.devicesStale(ctx, ctx.tenantId, stale);
  hcMetrics.handoverOverdueOpen(ctx, ctx.tenantId, overdue);
}
