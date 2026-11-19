// T0B-SYNC-5 (LD-322, done_when 3 and 4): per tenant core tasks of the offline sync ledger.
//   core.sync_retention  purgeSyncLedger: every batch in its own transaction with the tenant's system claims (as lims_worker).
//   core.sync_metrics    refreshSyncGauges: conflict inbox size, recall count, backlog age per device, one read transaction.
// Both are crontab entries with tenantScope per_tenant (CORE_CRONTAB): Graphile's cron fire becomes one job per tenant (cronTick).
import { refreshSyncGauges } from '../../../api/src/core/sync/metrics.js';
import { DEFAULT_SYNC_RETENTION_DAYS, purgeSyncLedger } from '../../../api/src/core/sync/retention.js';
import { tenantOf } from './consumer.js';
import { tenantClaims } from './deadletter.js';
import type { WorkerDeps } from './tasklist.js';

export const SYNC_RETENTION = 'core.sync_retention';
export const SYNC_METRICS = 'core.sync_metrics';
const BATCH_TIMEOUT_MS = 60_000;

export const syncRetentionRun = (deps: WorkerDeps) => async (payload: unknown): Promise<void> => {
  const tenantId = tenantOf(payload, SYNC_RETENTION);
  const claims = tenantClaims(deps.coreActorId, tenantId);
  // [CONV] no tenant setting source exists yet for the retention days: the default (180) applies to every tenant (open point in the runbook)
  const r = await purgeSyncLedger(
    { tx: (fn) => deps.db.tx({ claims, statementTimeoutMs: BATCH_TIMEOUT_MS, operation: SYNC_RETENTION }, fn) },
    { tenantId, now: deps.now(), retentionDays: DEFAULT_SYNC_RETENTION_DAYS, metrics: deps.metrics });
  deps.log.info('sync_retention_purged', { task: SYNC_RETENTION, tenant_id: tenantId, ...r });
};

export const syncMetricsRun = (deps: WorkerDeps) => async (payload: unknown): Promise<void> => {
  const tenantId = tenantOf(payload, SYNC_METRICS);
  await deps.db.tx({ claims: tenantClaims(deps.coreActorId, tenantId), operation: SYNC_METRICS }, (tx) =>
    refreshSyncGauges(tx, deps.metrics, { tenantId, now: deps.now() }));
};
