// reporting crontab (02-TRD §9). sweep_assembly: reports with needs_assembly older than 2 min -> keyed assembly job (covers lost debounce races).
// Only enqueues; the keyed job `assemble:<report_id>` is the same one the consumers use, so a duplicate collapses in the queue.
import type { CronEntry, TaskHandler } from '../../core/manifest.js';
import { ENQUEUE_SQL } from '../../core/fanout.js';

export const SWEEP_ASSEMBLY = 'reporting.sweep_assembly';
const STALE_MS = 120_000;
const BATCH = 200;   // ponytail: one tick enqueues <= 200 reports; the rest follow on the next tick (5 min). Raise if backlogs outlast that.

export const sweepAssembly: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'sweep_assembly_skipped', reason: 'bad_payload' });
    return;
  }
  const cutoff = new Date(Date.parse(ctx.now()) - STALE_MS).toISOString();
  const { rows } = await ctx.tx.query(
    `SELECT id FROM reporting.reports WHERE tenant_id = $1 AND needs_assembly = true AND needs_assembly_since < $2 ORDER BY needs_assembly_since LIMIT ${BATCH}`,
    [tenantId, cutoff]);
  for (const r of rows as { id: string }[]) {
    await ctx.tx.query(ENQUEUE_SQL, ['reporting.assemble_report', JSON.stringify({ tenant_id: tenantId, report_id: r.id }), `assemble:${r.id}`, null, 10]);
  }
};

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: SWEEP_ASSEMBLY, schedule: '*/5 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
]);
