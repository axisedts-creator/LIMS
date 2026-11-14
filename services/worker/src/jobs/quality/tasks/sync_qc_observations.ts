// Task quality.sync_qc_observations (02-TRD §6.2, §10.3): cron `* * * * *` per tenant + the instruments.qc.received.v1 trigger. Runs the observation service on the job ctx (same tx, system actor).
// When the time budget is used up it enqueues the continuation under its OWN key qcsync:cont:<tenant>: unsafe_dedupe would drop a job that re-enqueues under its own running key qcsync:<tenant> (§6.2 step 6).
// REQ-SEC-024: the payload tenant must equal the job tenant, checked before any query. The payload carries nothing else and nothing else of it is read.
import type { TaskHandler } from '../../../core/manifest.js';
import { createObservationService } from '../../../../../api/src/modules/quality/service/observation.service.js';
import { createRunService } from '../../../../../api/src/modules/quality/service/run.service.js';

const TASK = 'quality.sync_qc_observations';
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';   // (identifier, payload, job_key, run_at, max_attempts) — same statement as core/fanout.ts
const MAX_ATTEMPTS = 5;                                                       // TRD §10.3

export function createSyncQcObservationsHandler(deps: { service?: { syncQcObservations(ctx: any): Promise<{ budgetExhausted: boolean }> } } = {}): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || !tenantId || payload?.tenant_id !== tenantId) throw new Error(`${TASK}: payload tenant does not match the job tenant`);
    const service = deps.service ?? (defaultService ??= createObservationService({ assembler: createRunService() }));   // T-10: the real run assembler
    const res = await service.syncQcObservations(ctx);   // errors propagate: retry, then dead letter
    if (res.budgetExhausted) await ctx.tx.query(ENQUEUE_SQL, [TASK, JSON.stringify({ tenant_id: tenantId }), `qcsync:cont:${tenantId}`, null, MAX_ATTEMPTS]);
  };
}
let defaultService: ReturnType<typeof createObservationService> | undefined;

export const handle: TaskHandler = createSyncQcObservationsHandler();
