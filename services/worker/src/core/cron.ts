// Crontab assembly in code (REQ-ARCH-042; 02-TRD §7.2 tenantScope, §7.6; AC-0D-5.15; 08 A13 P-6, A23.1).
// Items are Graphile-style ({task, match, identifier, options}); bootstrap passes them through parseCronItems (SP-2: the text
// crontab rejects '.' in identifiers). A per_tenant item fires its own task with Graphile's `_cron` payload and no tenant_id; the
// task wrapper turns that into cronTick() [CONV] (app.enqueue_job rejects a per_tenant job without matching tenant claims, so only
// Graphile's cron can create such a job).
import { platformClaims } from './deadletter.js';
import { ENQUEUE_SQL } from './fanout.js';
import type { CronEntry } from './manifest.js';
import type { WorkerDeps } from './tasklist.js';

export interface CronItem { readonly task: string; readonly identifier: string; readonly match: string; readonly options: { readonly backfillPeriod: number; readonly maxAttempts?: number } }
export interface ScheduledEntry extends CronEntry { readonly module: string }

export const CORE_CRONTAB: readonly ScheduledEntry[] = [
  { module: 'core', identifier: 'core.retention_purge', schedule: '30 21 * * *', tenantScope: 'platform', maxAttempts: 5 },   // 03:15 Asia/Kathmandu
  { module: 'core', identifier: 'core.queue_depth_probe', schedule: '* * * * *', tenantScope: 'platform' },
];

export const cronItems = (entries: readonly ScheduledEntry[]): CronItem[] => entries.map((e) => ({
  task: e.identifier, identifier: e.identifier, match: e.schedule,
  options: { backfillPeriod: 0, ...(e.maxAttempts !== undefined ? { maxAttempts: e.maxAttempts } : {}) },
}));

/** True for the payload Graphile's cron gives a job it creates (has `_cron`, no tenant_id). */
export const isCronFire = (payload: any): payload is { _cron: { ts: string } } =>
  !!payload && typeof payload === 'object' && payload._cron && typeof payload._cron.ts === 'string' && payload.tenant_id === undefined;

const TENANTS_SQL = 'SELECT tenant_id FROM app.cron_tenant_ids() AS t(tenant_id)';

/** One schedule tick of a crontab entry. per_tenant: one job per active/suspended tenant, each in its own transaction. */
export function makeCronTick(deps: WorkerDeps, entries: readonly ScheduledEntry[]) {
  const byId = new Map(entries.map((e) => [e.identifier, e]));
  return async (identifier: string, tick: Date): Promise<void> => {
    const e = byId.get(identifier);
    if (!e) throw new Error(`cronTick: '${identifier}' is not a crontab entry`);
    if (Number.isNaN(tick.getTime())) throw new Error('cronTick: invalid tick');
    const minute = tick.toISOString().slice(0, 16);                       // YYYY-MM-DDTHH:mm UTC
    const max = e.maxAttempts ?? null;
    const core = platformClaims(deps.coreActorId);
    if (e.tenantScope === 'platform') {
      await deps.db.tx({ claims: e.module === 'core' ? core : platformClaims(deps.systemActorOf(e.module)), operation: 'core.cron_tick' }, (tx) =>
        tx.query(ENQUEUE_SQL, [identifier, '{}', `${identifier}:${minute}`, null, max]));
      return;
    }
    const rows = await deps.db.tx({ claims: core, operation: 'core.cron_tick' }, async (tx) => (await tx.query(TENANTS_SQL)).rows);
    const actor = deps.systemActorOf(e.module);
    let failed = 0;
    for (const r of rows) {
      const tenantId = String(r.tenant_id ?? r.cron_tenant_ids);
      try {
        await deps.db.tx({ claims: core, operation: 'core.cron_tick' }, (tx) => deps.withTenantScope(tx, tenantId, actor, () =>
          tx.query(ENQUEUE_SQL, [identifier, JSON.stringify({ tenant_id: tenantId }), `${identifier}:${tenantId}:${minute}`, null, max])));
      } catch {
        failed += 1;
        deps.log.warn('cron_tenant_enqueue_failed', { task: identifier, tenant_id: tenantId });
      }
    }
    // Rethrow so Graphile retries the tick; already enqueued tenants dedupe on job_key.
    if (failed > 0) throw new Error(`cronTick ${identifier}: ${failed} tenant enqueue(s) failed`);
  };
}

const DEPTH_SQL = 'SELECT task_identifier, ready, locked, failed FROM app.queue_depth()';

/** core.queue_depth_probe -> lims_queue_depth{task} (ready count; counts only, never payloads or keys). */
export const queueDepthRun = (deps: WorkerDeps) => async (): Promise<void> => {
  const rows = await deps.db.tx({ claims: platformClaims(deps.coreActorId), operation: 'core.queue_depth_probe' }, async (tx) => (await tx.query(DEPTH_SQL)).rows);
  for (const r of rows) deps.metrics.set('lims_queue_depth', Number(r.ready), { task: String(r.task_identifier) });
};
