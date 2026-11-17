// Task quality.purge_tat_items (02-TRD §10.3; 08 A17 P-18(c); 05-SCHEMA §7): cron `40 2 * * *` per tenant, max 3 attempts. The service deletes this tenant's expired tat_items without alert events / acks
// as the system actor under tat_items__delete__tenant; nothing else is deleted and the payload can widen nothing (the service gets the ctx only). REQ-SEC-024: tenant guard before any service call.
import type { TaskHandler } from '../../../core/manifest.js';
import { createTatService } from '../../../../../api/src/modules/quality/service/tat.service.js';

const TASK = 'quality.purge_tat_items';

export function createPurgeTatItemsHandler(deps: { service?: { purgeExpired(ctx: any): Promise<{ deleted: number }> } } = {}): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || !tenantId || payload?.tenant_id !== tenantId) throw new Error(`${TASK}: payload tenant does not match the job tenant`);
    const service = deps.service ?? (defaultService ??= createTatService());
    await service.purgeExpired(ctx);   // errors propagate: retry, then dead letter (the next daily run retries anyway)
  };
}
let defaultService: ReturnType<typeof createTatService> | undefined;

export const handle: TaskHandler = createPurgeTatItemsHandler();
