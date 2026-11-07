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

export const SWEEP_RENDERS = 'reporting.sweep_stuck_renders';
const STUCK_RENDER_MS = 900_000;   // 15 min (02-TRD §9, E10)

/** `rendering` for > 15 min without finishing (lost enqueue, dead worker) -> the same keyed render job the assembly / retry-render enqueue, so a live job collapses.
 *  Age = rendering_started_at (set by retry-render), falling back to created_at when it is NULL. Only enqueues. */
export const sweepStuckRenders: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'sweep_stuck_renders_skipped', reason: 'bad_payload' });
    return;
  }
  const cutoff = new Date(Date.parse(ctx.now()) - STUCK_RENDER_MS).toISOString();
  const select = (age: string) => ctx.tx.query(`SELECT id, report_id FROM reporting.report_versions WHERE tenant_id = $1 AND status = 'rendering' AND ${age} LIMIT ${BATCH}`, [tenantId, cutoff]);
  const stuck = [...(await select('rendering_started_at < $2')).rows, ...(await select('rendering_started_at IS NULL AND created_at < $2')).rows] as { id: string; report_id: string }[];
  for (const r of stuck.slice(0, BATCH)) {
    await ctx.tx.query(ENQUEUE_SQL, ['reporting.render_report_version', JSON.stringify({ tenant_id: tenantId, report_id: r.report_id, report_version_id: r.id }), `render:${r.id}`, null, 5]);
  }
};

export const SWEEP_HELD = 'reporting.sweep_held_releases';

/** Rendered versions held for dues (held_basis set by the release task) in auto mode -> the keyed release task, which asks BillingPort. Hints are not authoritative, so a
 *  missed billing.balance.changed.v1 only delays a release by one tick. Only enqueues: no BillingPort call, no write. */
export const sweepHeldReleases: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'sweep_held_releases_skipped', reason: 'bad_payload' });
    return;
  }
  const s = (await ctx.tx.query('SELECT auto_release FROM reporting.settings WHERE tenant_id = $1', [tenantId])).rows[0];
  if ((s?.auto_release ?? 'when_eligible') !== 'when_eligible') return;
  const { rows } = await ctx.tx.query(`SELECT id, report_id FROM reporting.report_versions WHERE tenant_id = $1 AND status = 'rendered' AND held_basis IS NOT NULL LIMIT ${BATCH}`, [tenantId]);
  for (const r of rows as { id: string; report_id: string }[]) {
    await ctx.tx.query(ENQUEUE_SQL, ['reporting.release_if_eligible', JSON.stringify({ tenant_id: tenantId, report_id: r.report_id, report_version_id: r.id }), `release:${r.id}`, null, 10]);
  }
};

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: SWEEP_ASSEMBLY, schedule: '*/5 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
  Object.freeze({ identifier: SWEEP_RENDERS, schedule: '*/10 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
  Object.freeze({ identifier: SWEEP_HELD, schedule: '*/15 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
]);
