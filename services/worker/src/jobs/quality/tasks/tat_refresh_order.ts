// Task quality.tat_refresh_order (02-TRD §9.3 steps 1-4 for one order, §10.2, §10.3): enqueued by the lab.specimen.status_changed.v1 consumer, payload { tenant_id, order_id }, max 5 attempts.
// REQ-SEC-024: the payload tenant must equal the job tenant and order_id must be a uuid, both checked before any service call (the message never echoes the input). No SQL of its own, no metrics.
import type { TaskHandler } from '../../../core/manifest.js';
import { createTatService } from '../../../../../api/src/modules/quality/service/tat.service.js';

const TASK = 'quality.tat_refresh_order';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTatRefreshOrderHandler(deps: { service?: { refreshOrder(ctx: any, i: { orderId: string }): Promise<unknown> } } = {}): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || !tenantId || payload?.tenant_id !== tenantId) throw new Error(`${TASK}: payload tenant does not match the job tenant`);
    const orderId = payload.order_id;
    if (typeof orderId !== 'string' || !UUID.test(orderId)) throw new Error(`${TASK}: malformed payload`);
    const service = deps.service ?? (defaultService ??= createTatService());
    await service.refreshOrder(ctx, { orderId });   // errors propagate: retry, then dead letter
  };
}
let defaultService: ReturnType<typeof createTatService> | undefined;

export const handle: TaskHandler = createTatRefreshOrderHandler();
