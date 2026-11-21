// T0B-SYNC-5 (LD-322, done_when 4): per tenant core task of the offline sync ledger. No retention job: the ledger is kept indefinitely (LD-407).
//   core.sync_metrics    refreshSyncGauges: conflict inbox size, recall count, backlog age per device, one read transaction.
// It is a crontab entry with tenantScope per_tenant (CORE_CRONTAB): Graphile's cron fire becomes one job per tenant (cronTick).
import { refreshSyncGauges } from '../../../api/src/core/sync/metrics.js';
import { tenantOf } from './consumer.js';
import { tenantClaims } from './deadletter.js';
import type { WorkerDeps } from './tasklist.js';

export const SYNC_METRICS = 'core.sync_metrics';
export const syncMetricsRun = (deps: WorkerDeps) => async (payload: unknown): Promise<void> => {
  const tenantId = tenantOf(payload, SYNC_METRICS);
  await deps.db.tx({ claims: tenantClaims(deps.coreActorId, tenantId), operation: SYNC_METRICS }, (tx) =>
    refreshSyncGauges(tx, deps.metrics, { tenantId, now: deps.now() }));
};
