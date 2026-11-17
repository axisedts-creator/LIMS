// Payments WorkerManifest (02-TRD §8, 02-CONVENTIONS §2.3). §8.2: this module consumes no events; the tasks/crons of §8.3 are added by the tasks that implement them
// (PG-T11: poll_intent, sweep_open_intents). Boot checks (TRD §9.3, "API and worker"): config is validated at import.
import { loadPaymentsConfig } from '../../../../api/src/modules/payments/config.js';
import type { PaymentsDeps } from '../../../../api/src/modules/payments/service/outcome.service.js';
import type { Ctx } from '../../../../api/src/modules/payments/repository/shared.js';
import type { TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { crontab } from './cron.js';
import { CHECK_REFUND, createCheckRefund } from './tasks/check_refund.js';
import { EXECUTE_REFUND, createExecuteRefund } from './tasks/execute_refund.js';
import { POLL_INTENT, createPollIntent } from './tasks/poll_intent.js';
import { RECONCILE_BATCH, createReconcileBatch } from './tasks/reconcile_batch.js';
import { RECONCILE_TENANT, createReconcileTenant } from './tasks/reconcile_tenant.js';
import { SWEEP_OPEN_INTENTS, createSweepOpenIntents } from './tasks/sweep_open_intents.js';

export const config = loadPaymentsConfig();

// [CONV] The runtime (KEK, gateway adapters, events/jobs ports, ledger + frontdesk ports) is supplied once at worker start, like the API's createPaymentProviderPort deps.
// Until it is bound a job fails closed (throws -> queue backoff) instead of guessing; nothing is read from the payload to compensate.
let runtime: { deps: PaymentsDeps; ports: Ctx['ports'] } | undefined;
export const bindPaymentsRuntime = (deps: PaymentsDeps, ports: Ctx['ports']): void => { runtime = { deps, ports }; };
const bound = (make: (r: NonNullable<typeof runtime>) => TaskHandler): TaskHandler => (payload, ctx) => {
  if (!runtime) throw new Error('payments worker runtime not bound');
  return make(runtime)(payload, ctx);
};

export const manifest: WorkerManifest = Object.freeze({
  module: 'payments',
  tasks: Object.freeze({
    [POLL_INTENT]: bound((r) => createPollIntent(r.deps, r.ports)),
    [SWEEP_OPEN_INTENTS]: bound((r) => createSweepOpenIntents(r.deps)),
    [RECONCILE_TENANT]: bound((r) => createReconcileTenant(r.deps, r.ports)),
    [RECONCILE_BATCH]: bound((r) => createReconcileBatch(r.deps, r.ports)),
    [EXECUTE_REFUND]: bound((r) => createExecuteRefund(r.deps, r.ports)),
    [CHECK_REFUND]: bound((r) => createCheckRefund(r.deps, r.ports)),
  }),
  maxAttempts: Object.freeze({ [POLL_INTENT]: 8, [SWEEP_OPEN_INTENTS]: 3, [RECONCILE_TENANT]: 3, [RECONCILE_BATCH]: 3, [EXECUTE_REFUND]: 1, [CHECK_REFUND]: 8 }),
  subscriptions: Object.freeze({}),
  crontab,
});
