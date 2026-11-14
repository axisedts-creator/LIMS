// Task quality.reprocess_pending_observations (02-TRD §6.4, §10.3; 06 row T-11). Enqueued (never scheduled) by map #12 ({instrument_id}) and plan / target activation #18 / #23 ({plan_id}).
// All work is the observation service on the job ctx (same tx, system actor); the task issues no SQL and enqueues nothing.
// REQ-SEC-024: the payload tenant must equal the job tenant, and the scope must be exactly one UUID, both checked before any query or service call. Only the validated id is forwarded.
import type { TaskHandler } from '../../../core/manifest.js';
import { createObservationService } from '../../../../../api/src/modules/quality/service/observation.service.js';
import { createRunService } from '../../../../../api/src/modules/quality/service/run.service.js';

const TASK = 'quality.reprocess_pending_observations';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createReprocessPendingObservationsHandler(deps: { service?: { reprocessPending(ctx: any, scope: { instrument_id?: string; plan_id?: string }): Promise<unknown> } } = {}): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || !tenantId || payload?.tenant_id !== tenantId) throw new Error(`${TASK}: payload tenant does not match the job tenant`);
    const { instrument_id: i, plan_id: p } = payload as Record<string, unknown>;
    const ids = [['instrument_id', i], ['plan_id', p]].filter(([, v]) => v !== undefined);
    const [key, id] = ids[0] ?? [];
    if (ids.length !== 1 || typeof id !== 'string' || !UUID.test(id)) throw new Error(`${TASK}: payload needs exactly one of instrument_id / plan_id (uuid)`);
    const service = deps.service ?? (defaultService ??= createObservationService({ assembler: createRunService() }));   // T-10: the real run assembler
    await service.reprocessPending(ctx, { [key as string]: id });   // errors propagate: retry, then dead letter
  };
}
let defaultService: ReturnType<typeof createObservationService> | undefined;

export const handle: TaskHandler = createReprocessPendingObservationsHandler();
