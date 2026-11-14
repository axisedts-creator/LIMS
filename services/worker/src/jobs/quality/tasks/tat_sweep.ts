// Task quality.tat_sweep (02-TRD §9.3, §10.3, §14; PRD AC-14.1): cron `* * * * *` per tenant, max 3 attempts (the next minute retries anyway). All work is the tat service on the job ctx (same tx, system actor);
// the task issues no SQL. REQ-SEC-024: the payload tenant must equal the job tenant, checked before any service call.
// §14 metrics are written AFTER the service resolved (a failed tick writes none): sweep duration (histogram), alerts raised {level, segment} + lag per alert, and the open-alert gauge {level, tenant_id}
// for EACH of warning / breached / escalated (0 included, so the alert clears). Labels never carry an order, item, test or specimen id.
import type { TaskHandler } from '../../../core/manifest.js';
import { createTatService, type SweepResult } from '../../../../../api/src/modules/quality/service/tat.service.js';

const TASK = 'quality.tat_sweep';

export function createTatSweepHandler(deps: { service?: { sweep(ctx: any): Promise<SweepResult> } } = {}): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || !tenantId || payload?.tenant_id !== tenantId) throw new Error(`${TASK}: payload tenant does not match the job tenant`);
    const service = deps.service ?? (defaultService ??= createTatService());
    const t0 = performance.now();
    const res = await service.sweep(ctx);   // errors propagate: retry, then dead letter
    const m = (ctx as any).metrics;
    if (!m) return;
    m.observe?.('lims_quality_tat_sweep_duration_seconds', (performance.now() - t0) / 1000);
    for (const a of res.raised) {
      m.inc?.('lims_quality_tat_alerts_total', { level: a.level, segment: a.segment });
      m.observe?.('lims_quality_tat_alert_lag_seconds', a.lagSeconds);
    }
    for (const level of ['warning', 'breached', 'escalated'] as const) m.set?.('lims_quality_tat_open_alerts', res.openAlerts[level], { level, tenant_id: tenantId });
  };
}
let defaultService: ReturnType<typeof createTatService> | undefined;

export const handle: TaskHandler = createTatSweepHandler();
