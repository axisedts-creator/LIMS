// Shared by the three frontdesk.order.* consumers (06 row T-06). The wrapper (core/consumer.ts) already did inbox dedupe and envelope validation.
// REQ-SEC-024 / 07-SECURITY P-11: the job's tenant is the only tenant; an envelope of another tenant (or a job without one) is refused before any query, port or event.
import { LimsError } from '../../../../../api/src/core/errors.js';
import type { ConsumerHandler, JobContext } from '../../../core/manifest.js';
import type { OrderCtx, OrderEnvelope } from '../../../../../api/src/modules/lab/service/order.service.js';

export function orderConsumer(apply: (ctx: OrderCtx, env: OrderEnvelope) => Promise<void>): ConsumerHandler {
  return async (event: OrderEnvelope & { tenant_id?: string }, ctx: JobContext) => {
    if (typeof ctx.tenantId !== 'string' || event?.tenant_id !== ctx.tenantId) throw new LimsError('common.internal');
    // JobContext.now() is an ISO string, the service wants a Date
    await apply({ ...(ctx as unknown as OrderCtx), now: () => new Date(ctx.now()) } as OrderCtx, event);
  };
}
