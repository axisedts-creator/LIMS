// core.retention_purge (02-TRD §7.6; AC-0D-5.16; 08 A25 D-200). Each app.purge_*() runs in its OWN transaction; the 90-day
// predicates and the 4-minute loop cap live in the DEFINER functions, which return (deleted, capped).
import { platformClaims } from './deadletter.js';
import type { WorkerDeps } from './tasklist.js';

export const PURGE_TABLES = ['idempotency_keys', 'event_log', 'event_inboxes', 'dead_letters', 'ratelimit_counters'] as const;
export const RETENTION_TIMEOUT_MS = 300_000;

export const retentionRun = (deps: WorkerDeps) => async (): Promise<void> => {
  let failed = 0;
  for (const table of PURGE_TABLES) {
    try {
      const row = await deps.db.tx(
        { claims: platformClaims(deps.coreActorId), statementTimeoutMs: RETENTION_TIMEOUT_MS, operation: 'core.retention_purge' },
        async (tx) => (await tx.query(`SELECT deleted, capped FROM app.purge_${table}()`, [])).rows[0]);
      const deleted = Number(row?.deleted ?? 0);
      deps.metrics.inc('lims_core_retention_purged_total', { table }, deleted);
      if (row?.capped === true) deps.metrics.inc('lims_core_retention_purge_capped_total', { table });
      deps.log.info('retention_purged', { task: 'core.retention_purge', table, deleted, capped: row?.capped === true });
    } catch {
      failed += 1;                                                        // rolled back alone; the other purges still run
      deps.log.error('retention_purge_failed', { task: 'core.retention_purge', table });
    }
  }
  if (failed > 0) throw new Error(`core.retention_purge: ${failed} purge function(s) failed`);
};
