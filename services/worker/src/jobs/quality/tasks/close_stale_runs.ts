// Task quality.close_stale_runs (02-TRD §7.3 step 7, §10.3, §14; PRD AC-06.7): cron `* * * * *` per tenant. All work is the run service on the job ctx (same tx, system actor); the task issues no SQL.
// REQ-SEC-024: the payload tenant must equal the job tenant, checked before any service call.
// §14 gauge lims_quality_qc_rejected_without_action_oldest_age_seconds{tenant_id} is set AFTER the service resolved (0 when no rejected run waits, so the alert clears); a failed tick sets nothing.
import type { TaskHandler } from '../../../core/manifest.js';
import { createRunService } from '../../../../../api/src/modules/quality/service/run.service.js';

const TASK = 'quality.close_stale_runs';
const GAUGE = 'lims_quality_qc_rejected_without_action_oldest_age_seconds';

export function createCloseStaleRunsHandler(deps: { service?: { closeStaleRuns(ctx: any): Promise<{ closed: number; rejected: number; oldestRejectedWithoutActionAgeSeconds: number }> } } = {}): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || !tenantId || payload?.tenant_id !== tenantId) throw new Error(`${TASK}: payload tenant does not match the job tenant`);
    const service = deps.service ?? (defaultService ??= createRunService());
    const res = await service.closeStaleRuns(ctx);   // errors propagate: retry, then dead letter
    (ctx as any).metrics?.set?.(GAUGE, res.oldestRejectedWithoutActionAgeSeconds, { tenant_id: tenantId });
  };
}
let defaultService: ReturnType<typeof createRunService> | undefined;

export const handle: TaskHandler = createCloseStaleRunsHandler();
