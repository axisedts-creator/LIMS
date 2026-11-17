// PG-T13 — payments.reconcile_batch (02-TRD §6.7 "Transaction boundaries" / §8.3 row 5; AC-PG-08.1-08.5, 08.9): one batch of <= 50 candidates of a phase (intents, then refunds) in id order after
// after_id. Every candidate runs in its own savepoint (ctx.db.tx, 08 A19 P-44); counts go onto the run row, the next batch is enqueued, the last batch completes the run and sets
// lims_payments_reconciliation_last_success_timestamp_seconds. The payload is untrusted (tenant from the job scope, ids validated); a batch of a failed / completed run does nothing.
import { RECONCILE_BATCH_TASK, createReconciliationService, type ReconCtx } from '../../../../../api/src/modules/payments/service/reconciliation.service.js';
import type { PaymentsDeps } from '../../../../../api/src/modules/payments/service/outcome.service.js';
import type { Ctx } from '../../../../../api/src/modules/payments/repository/shared.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const RECONCILE_BATCH = RECONCILE_BATCH_TASK;

export function createReconcileBatch(deps: PaymentsDeps, ports: Ctx['ports']): TaskHandler {
  const svc = createReconciliationService(deps);
  return async (payload, ctx) => {
    if (!ctx.tenantId) return;
    await svc.runBatch({ ...ctx, tenantId: ctx.tenantId, ports } as unknown as ReconCtx, payload);
  };
}
