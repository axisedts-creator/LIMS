// PG-T13 — payments.reconcile_tenant (02-TRD §6.7 / §8.3 row 4; AC-PG-08.1, 08.6, 08.8): the nightly per-tenant tick. Skips a tenant with reconciliation_enabled = false, fails a stalled
// run (no update for 2 h), inserts the cron run row (business_date = tenant business date at started_at minus 1 day) and enqueues ONLY the first batch — no gateway call happens here.
// The payload is untrusted: the job's own tenant scope decides, a payload naming another tenant does nothing.
import { createReconciliationService, type ReconCtx } from '../../../../../api/src/modules/payments/service/reconciliation.service.js';
import type { PaymentsDeps } from '../../../../../api/src/modules/payments/service/outcome.service.js';
import type { Ctx } from '../../../../../api/src/modules/payments/repository/shared.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const RECONCILE_TENANT = 'payments.reconcile_tenant';

export function createReconcileTenant(deps: PaymentsDeps, ports: Ctx['ports']): TaskHandler {
  const svc = createReconciliationService(deps);
  return async (payload, ctx) => {
    if (!ctx.tenantId || payload?.['tenant_id'] !== ctx.tenantId) return;
    await svc.startCronRun({ ...ctx, tenantId: ctx.tenantId, ports } as unknown as ReconCtx);
  };
}
