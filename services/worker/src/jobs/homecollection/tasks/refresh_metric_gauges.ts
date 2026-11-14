// homecollection.refresh_metric_gauges {tenant_id} (HC-T17, 02-TRD §14; [CONV] every 60 s, per_tenant, like the lab gauges): sets held_open / devices_stale_total / handover_overdue_open.
// Scheduling + manifest entry belong to the worker manifest task (see .orchestra/notes/HC-T17-impl.md, open point).
import type { TaskHandler } from '../../../core/manifest.js';
import { refreshHomecollectionGauges } from '../../../../../api/src/modules/homecollection/gauges.service.js';

export const refreshMetricGauges: TaskHandler = async (payload, ctx: any) => {
  if (payload?.tenant_id !== ctx.tenantId) return;
  await refreshHomecollectionGauges(ctx);
};
